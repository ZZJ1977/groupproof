"""注册前验证事务（E02–E06）：先证明登录邮箱归属，再限时一次性建档。

- 验证前不创建永久用户/密码凭据、不占用用户名；
- 验证码与建档资格均限时、一次性、绑定浏览器事务，服务端限流；
- 建档在单事务内锁行 + 唯一约束兜底并发；失败整体回滚。
"""
from __future__ import annotations

from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session as DbSession

from ..config import get_settings
from ..errors import AppError
from ..models import PasswordCredential, PreRegistrationRequest, User, utcnow
from ..security import (
    check_email_format,
    code_hmac,
    hash_password,
    new_code,
    new_token,
    token_digest,
    validate_password,
    validate_username,
    normalize_username,
)
from . import audit
from .mailer import MailSendError, send_template
from .rate_limit import RateLimitExceeded, check_and_increment


def _browser_ok(tx: PreRegistrationRequest, browser_token: str | None) -> bool:
    return bool(browser_token) and tx.browser_token_digest == token_digest(browser_token)


def create_registration(db: DbSession, *, email: str, locale: str | None, browser_token: str, request_ip: str | None) -> PreRegistrationRequest:
    settings = get_settings()
    if not settings.email_signup_available:
        raise AppError("MAIL_UNAVAILABLE", 503, params={"reason": "signup_disabled_or_mail_unavailable"})
    try:
        normalized = check_email_format(email)  # 登录邮箱允许 QQ 等普通邮箱；学校资格另在个人中心验证
    except ValueError:
        # 邮箱格式错误必须是可恢复的字段错误，不得 500
        raise AppError("VALIDATION_ERROR", 400, field_errors={"email": "invalid_email"}) from None
    now = utcnow()
    for key, limit, window in (
        (f"reg:email:{normalized}", settings.code_send_per_hour, 3600),
        (f"reg:email-day:{normalized}", settings.code_send_per_day, 86400),
        (f"reg:ip:{request_ip or 'unknown'}", 30, 3600),
    ):
        try:
            check_and_increment(db, key, limit=limit, window_seconds=window, now=now)
        except RateLimitExceeded as exc:
            raise AppError("RATE_LIMITED", 429, retry_after_seconds=exc.retry_after_seconds) from exc

    code = new_code()
    tx = PreRegistrationRequest(
        id=new_token()[:32],
        email=email.strip(),
        email_normalized=normalized,
        locale=locale,
        browser_token_digest=token_digest(browser_token),
        code_hmac=code_hmac(code),
        generation=1,
        expires_at=now + timedelta(seconds=settings.code_ttl_seconds),
        resend_available_at=now + timedelta(seconds=settings.resend_cooldown_seconds),
        send_status="pending",
    )
    db.add(tx)
    db.commit()  # 先持久化事务与限流事实，再调用发件服务（失败也不丢失可重发的事务）
    _dispatch_code(db, tx, code, locale)
    return tx


def _dispatch_code(db: DbSession, tx: PreRegistrationRequest, code: str, locale: str | None) -> None:
    try:
        send_template("registration_code", tx.email, locale, code=code)
        tx.send_status = "accepted"
    except MailSendError as exc:
        tx.send_status = "failed"
        db.commit()  # 发件状态与真实结果一致地持久化
        # 发件失败明确报错（不显示已发送成功、不跳过验证）；事务保留可重发
        raise AppError("MAIL_UNAVAILABLE", 503, params={"reason": "mail_send_failed"}) from exc
    db.flush()


def resend_code(db: DbSession, tx_id: str, *, browser_token: str | None, locale: str | None, request_ip: str | None) -> PreRegistrationRequest:
    settings = get_settings()
    now = utcnow()
    tx = db.execute(select(PreRegistrationRequest).where(PreRegistrationRequest.id == tx_id).with_for_update()).scalar_one_or_none()
    if tx is None or tx.completed_at is not None or tx.invalidated_at is not None:
        raise AppError("NOT_FOUND", 404)
    if not _browser_ok(tx, browser_token):
        raise AppError("FORBIDDEN", 403, params={"reason": "browser_binding"})
    if tx.resend_available_at and tx.resend_available_at > now:
        raise AppError("RATE_LIMITED", 429, retry_after_seconds=int((tx.resend_available_at - now).total_seconds()) + 1)
    for key, limit, window in (
        (f"reg:email:{tx.email_normalized}", settings.code_send_per_hour, 3600),
        (f"reg:email-day:{tx.email_normalized}", settings.code_send_per_day, 86400),
        (f"reg:ip:{request_ip or 'unknown'}", 30, 3600),
    ):
        try:
            check_and_increment(db, key, limit=limit, window_seconds=window, now=now)
        except RateLimitExceeded as exc:
            raise AppError("RATE_LIMITED", 429, retry_after_seconds=exc.retry_after_seconds) from exc

    code = new_code()
    tx.code_hmac = code_hmac(code)  # 重发替换旧验证码（旧码失效）
    tx.generation += 1
    tx.attempts = 0
    tx.expires_at = now + timedelta(seconds=settings.code_ttl_seconds)
    tx.resend_available_at = now + timedelta(seconds=settings.resend_cooldown_seconds)
    _invalidate_grant(tx)
    _dispatch_code(db, tx, code, locale)
    return tx


def verify_code(db: DbSession, tx_id: str, *, code: str, browser_token: str | None) -> PreRegistrationRequest:
    settings = get_settings()
    now = utcnow()
    tx = db.execute(select(PreRegistrationRequest).where(PreRegistrationRequest.id == tx_id).with_for_update()).scalar_one_or_none()
    if tx is None or tx.invalidated_at is not None:
        raise AppError("NOT_FOUND", 404)
    if not _browser_ok(tx, browser_token):
        raise AppError("FORBIDDEN", 403, params={"reason": "browser_binding"})
    if tx.completed_at is not None:
        raise AppError("INVALID_STATE", 409, params={"reason": "already_completed"})
    if tx.code_consumed_at is not None:
        raise AppError("CHALLENGE_INVALID", 400)
    if tx.expires_at <= now:
        raise AppError("CODE_EXPIRED", 400)
    if tx.attempts >= settings.code_max_attempts:
        raise AppError("CODE_EXPIRED", 400, params={"reason": "too_many_attempts"})

    tx.attempts += 1
    if tx.code_hmac != code_hmac(code.strip()):
        db.commit()  # 错误次数持久化（不随外围事务回滚丢失）
        raise AppError("INVALID_CODE", 400)

    # 原子消费验证码，签发限时一次性建档资格（≥256 位随机，只存摘要）
    grant = new_token() + new_token()  # 512 位熵
    tx.code_consumed_at = now
    tx.creation_grant_digest = token_digest(grant)
    tx.creation_grant_expires_at = now + timedelta(seconds=settings.pre_registration_ttl_seconds)
    audit.record(db, "pre_registration.code_verified", actor_id=None, target_user_id=None, changed_fields=["creationGrant"])
    db.flush()
    return tx


def complete_registration(
    db: DbSession,
    tx_id: str,
    *,
    username: str,
    password: str,
    browser_token: str | None,
) -> tuple[User, bool]:
    """单事务建档：锁行 → 核对资格/期限 → 唯一性 → 插入 user+credential → 消费资格 → 建受限会话。

    返回 (user, created)；同一事务已完成时返回 (user, False)（幂等安全结果，不重复创建）。
    """
    tx = db.execute(select(PreRegistrationRequest).where(PreRegistrationRequest.id == tx_id).with_for_update()).scalar_one_or_none()
    if tx is None or tx.invalidated_at is not None:
        raise AppError("NOT_FOUND", 404)
    if not _browser_ok(tx, browser_token):
        raise AppError("FORBIDDEN", 403, params={"reason": "browser_binding"})
    if tx.completed_at is not None and tx.result_user_id:
        # E10：建档成功但响应丢失 → 同一浏览器得到“已完成，请登录”，不创建第二账户
        user = db.get(User, tx.result_user_id)
        if user is not None:
            return user, False
    if tx.code_consumed_at is None or not tx.creation_grant_digest or not tx.creation_grant_expires_at:
        raise AppError("CHALLENGE_INVALID", 400, params={"reason": "no_creation_grant"})
    if tx.creation_grant_expires_at <= utcnow():
        raise AppError("CODE_EXPIRED", 400, params={"reason": "creation_grant_expired"})

    try:
        name_value = validate_username(username)
    except ValueError:
        raise AppError("VALIDATION_ERROR", 400, field_errors={"username": "invalid_username"}) from None
    try:
        password_value = validate_password(password)
    except ValueError as exc:
        raise AppError("VALIDATION_ERROR", 400, field_errors={"password": str(exc)}) from None

    if db.execute(select(User).where(User.username_normalized == normalize_username(name_value))).scalar_one_or_none() is not None:
        raise AppError("USERNAME_CONFLICT", 409, field_errors={"username": "username_taken"})

    now = utcnow()
    user = User(
        id=new_token()[:32],
        username=name_value,
        username_normalized=normalize_username(name_value),
        account_status="enabled",
    )
    credential = PasswordCredential(
        user_id=user.id,
        login_email=tx.email,
        login_email_normalized=tx.email_normalized,
        login_email_verified_at=now,  # 邮箱归属已证明（本次注册前验证）
        verification_evidence_ref=tx.id,
        credential_version=1,
        password_hash=hash_password(password_value),
        password_algo="argon2id",
    )
    try:
        # 用户 + 凭据 + 资格消费同一事务；唯一约束兜底并发（E05/E06）
        with db.begin_nested():
            db.add(user)
            db.add(credential)
            db.flush()
    except IntegrityError:
        raise AppError("EMAIL_CONFLICT", 409, field_errors={"email": "email_taken"}) from None

    tx.creation_grant_digest = None  # 建档资格一次性消费
    tx.completed_at = now
    tx.result_user_id = user.id
    audit.record(db, "auth.email_registered", actor_id=user.id, target_user_id=user.id, changed_fields=["users", "password_credentials"])
    db.flush()
    return user, True


def _invalidate_grant(tx: PreRegistrationRequest) -> None:
    tx.creation_grant_digest = None
    tx.creation_grant_expires_at = None


def invalidate_transaction(db: DbSession, tx_id: str, *, browser_token: str | None) -> None:
    """更换邮箱/取消：作废事务与建档资格。"""
    tx = db.execute(select(PreRegistrationRequest).where(PreRegistrationRequest.id == tx_id).with_for_update()).scalar_one_or_none()
    if tx is None:
        return
    if not _browser_ok(tx, browser_token):
        raise AppError("FORBIDDEN", 403, params={"reason": "browser_binding"})
    tx.invalidated_at = utcnow()
    _invalidate_grant(tx)
    db.flush()


def cleanup_expired(db: DbSession, older_than_hours: int = 24) -> int:
    """留存策略：过期 24 小时后移除邮箱与验证码材料，仅保留必要审计/限流记录。"""
    cutoff = utcnow() - timedelta(hours=older_than_hours)
    rows = db.execute(
        select(PreRegistrationRequest).where(PreRegistrationRequest.expires_at < cutoff, PreRegistrationRequest.completed_at.is_(None))
    ).scalars().all()
    for row in rows:
        row.email = "***"
        row.email_normalized = f"redacted-{row.id}"
        row.code_hmac = None
        row.creation_grant_digest = None
        row.invalidated_at = row.invalidated_at or utcnow()
    db.flush()
    return len(rows)


# 建档会话签发复用 sessions 服务（auth_method=password）
def issue_onboarding_session(db: DbSession, user: User, facts: dict):
    from .sessions import issue_session

    return issue_session(db, user, facts, auth_method="password", credential_version=1)
