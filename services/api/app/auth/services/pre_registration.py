"""学校邮箱注册：先证明邮箱归属，再限时一次性建档。

- 验证前不创建永久用户/密码凭据、不占用用户名；
- 验证码与建档资格均限时、一次性、绑定浏览器事务，服务端限流；
- 建档在单事务内锁行 + 唯一约束兜底并发；失败整体回滚。
"""

from __future__ import annotations

from datetime import timedelta
from typing import Literal
from uuid import uuid4

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session as DbSession

from ..config import get_settings
from ..errors import AppError
from ..models import AuthIdentity, PasswordCredential, PreRegistrationRequest, User, utcnow
from ..security import (
    check_email_format,
    code_hmac,
    email_domain_allowed,
    hash_password,
    new_code,
    new_token,
    token_digest,
    validate_password,
)
from . import audit
from .email_challenges import bind_verified_target
from .mailer import MailSendError, send_template
from .rate_limit import RateLimitExceeded, check_and_increment
from .registration import normalize_collaboration_accounts, profile_field_errors

RegistrationIdentity = Literal["student", "teacher"]


def _browser_ok(tx: PreRegistrationRequest, browser_token: str | None) -> bool:
    return bool(browser_token) and tx.browser_token_digest == token_digest(browser_token)


def school_identities(email: str) -> list[RegistrationIdentity]:
    identities: tuple[RegistrationIdentity, ...] = ("student", "teacher")
    return [identity for identity in identities if email_domain_allowed(email, identity)]


def _require_school_address(email: str) -> None:
    if not school_identities(email):
        raise AppError("VALIDATION_ERROR", 400, field_errors={"email": "school_email_domain"})


def create_registration(
    db: DbSession, *, email: str, locale: str | None, browser_token: str, request_ip: str | None
) -> PreRegistrationRequest:
    settings = get_settings()
    if not settings.email_signup_available:
        raise AppError(
            "MAIL_UNAVAILABLE", 503, params={"reason": "signup_disabled_or_mail_unavailable"}
        )
    try:
        normalized = check_email_format(email)
    except ValueError:
        # 邮箱格式错误必须是可恢复的字段错误，不得 500
        raise AppError("VALIDATION_ERROR", 400, field_errors={"email": "invalid_email"}) from None
    _require_school_address(normalized)
    now = utcnow()
    for key, limit, window in (
        (f"reg:email:{normalized}", settings.code_send_per_hour, 3600),
        (f"reg:email-day:{normalized}", settings.code_send_per_day, 86400),
        (f"reg:ip:{request_ip or 'unknown'}", 30, 3600),
    ):
        try:
            check_and_increment(db, key, limit=limit, window_seconds=window, now=now)
        except RateLimitExceeded as exc:
            raise AppError(
                "RATE_LIMITED", 429, retry_after_seconds=exc.retry_after_seconds
            ) from exc

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


def _dispatch_code(
    db: DbSession, tx: PreRegistrationRequest, code: str, locale: str | None
) -> None:
    try:
        send_template("registration_code", tx.email, locale, code=code)
        tx.send_status = "captured" if get_settings().mail_mode == "capture" else "accepted"
    except MailSendError as exc:
        tx.send_status = "failed"
        db.commit()  # 发件状态与真实结果一致地持久化
        # 发件失败明确报错（不显示已发送成功、不跳过验证）；事务保留可重发
        raise AppError("MAIL_UNAVAILABLE", 503, params={"reason": "mail_send_failed"}) from exc
    db.flush()


def resend_code(
    db: DbSession,
    tx_id: str,
    *,
    browser_token: str | None,
    locale: str | None,
    request_ip: str | None,
) -> PreRegistrationRequest:
    settings = get_settings()
    if not settings.email_signup_available:
        raise AppError(
            "MAIL_UNAVAILABLE", 503, params={"reason": "signup_disabled_or_mail_unavailable"}
        )
    now = utcnow()
    tx = db.execute(
        select(PreRegistrationRequest).where(PreRegistrationRequest.id == tx_id).with_for_update()
    ).scalar_one_or_none()
    if tx is None or tx.completed_at is not None or tx.invalidated_at is not None:
        raise AppError("NOT_FOUND", 404)
    if not _browser_ok(tx, browser_token):
        raise AppError("FORBIDDEN", 403, params={"reason": "browser_binding"})
    _require_school_address(tx.email_normalized)
    if tx.resend_available_at and tx.resend_available_at > now:
        raise AppError(
            "RATE_LIMITED",
            429,
            retry_after_seconds=int((tx.resend_available_at - now).total_seconds()) + 1,
        )
    for key, limit, window in (
        (f"reg:email:{tx.email_normalized}", settings.code_send_per_hour, 3600),
        (f"reg:email-day:{tx.email_normalized}", settings.code_send_per_day, 86400),
        (f"reg:ip:{request_ip or 'unknown'}", 30, 3600),
    ):
        try:
            check_and_increment(db, key, limit=limit, window_seconds=window, now=now)
        except RateLimitExceeded as exc:
            raise AppError(
                "RATE_LIMITED", 429, retry_after_seconds=exc.retry_after_seconds
            ) from exc

    code = new_code()
    tx.code_hmac = code_hmac(code)  # 重发替换旧验证码（旧码失效）
    tx.generation += 1
    tx.attempts = 0
    tx.expires_at = now + timedelta(seconds=settings.code_ttl_seconds)
    tx.resend_available_at = now + timedelta(seconds=settings.resend_cooldown_seconds)
    _invalidate_grant(tx)
    _dispatch_code(db, tx, code, locale)
    return tx


def verify_code(
    db: DbSession, tx_id: str, *, code: str, browser_token: str | None
) -> PreRegistrationRequest:
    settings = get_settings()
    now = utcnow()
    tx = db.execute(
        select(PreRegistrationRequest).where(PreRegistrationRequest.id == tx_id).with_for_update()
    ).scalar_one_or_none()
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
    audit.record(
        db,
        "pre_registration.code_verified",
        actor_id=None,
        target_user_id=None,
        changed_fields=["creationGrant"],
    )
    db.flush()
    return tx


def _require_creation_grant(tx: PreRegistrationRequest) -> None:
    if (
        tx.completed_at is not None
        or tx.code_consumed_at is None
        or not tx.creation_grant_digest
        or not tx.creation_grant_expires_at
    ):
        raise AppError("CHALLENGE_INVALID", 400, params={"reason": "no_creation_grant"})
    if tx.creation_grant_expires_at <= utcnow():
        raise AppError("CODE_EXPIRED", 400, params={"reason": "creation_grant_expired"})


def read_registration_profile(
    db: DbSession, tx_id: str, *, browser_token: str | None
) -> PreRegistrationRequest:
    tx = db.get(PreRegistrationRequest, tx_id)
    if tx is None or tx.invalidated_at is not None:
        raise AppError("NOT_FOUND", 404)
    if not _browser_ok(tx, browser_token):
        raise AppError("FORBIDDEN", 403, params={"reason": "browser_binding"})
    _require_creation_grant(tx)
    _require_school_address(tx.email_normalized)
    return tx


def complete_registration(
    db: DbSession,
    tx_id: str,
    *,
    name: str,
    requested_identity: RegistrationIdentity,
    student_id: str | None,
    college: str | None,
    password: str,
    confirm_password: str,
    browser_token: str | None,
    github_username: str | None = None,
    feishu_account: str | None = None,
) -> tuple[User, bool]:
    """在同一事务内创建资料、密码凭据及已验证的学校邮箱，并消费建档资格。

    返回 (user, created)；同一事务已完成时返回 (user, False)（幂等安全结果，不重复创建）。
    """
    tx = db.execute(
        select(PreRegistrationRequest).where(PreRegistrationRequest.id == tx_id).with_for_update()
    ).scalar_one_or_none()
    if tx is None or tx.invalidated_at is not None:
        raise AppError("NOT_FOUND", 404)
    if not _browser_ok(tx, browser_token):
        raise AppError("FORBIDDEN", 403, params={"reason": "browser_binding"})
    if tx.completed_at is not None and tx.result_user_id:
        # E10：建档成功但响应丢失 → 同一浏览器得到“已完成，请登录”，不创建第二账户
        user = db.get(User, tx.result_user_id)
        if user is not None:
            return user, False
    _require_creation_grant(tx)

    user_id = uuid4()
    # 资料兼容内部用户名字段。新用户登录使用学校邮箱。
    username = f"u-{user_id.hex[:30]}"
    student_id = (student_id or "").strip() if requested_identity == "student" else None
    college = (college or "").strip()
    errors = profile_field_errors(
        name=name,
        username=username,
        student_id=student_id,
        requested_identity=requested_identity,
        school_email=tx.email,
    )
    if len(student_id or "") > 80:
        errors["studentId"] = "invalid_student_id"
    if len(college) > 160:
        errors["college"] = "college_too_long"
    if password != confirm_password:
        errors["confirmPassword"] = "password_mismatch"
    try:
        validate_password(password)
    except ValueError as exc:
        errors["password"] = str(exc)
    if errors:
        raise AppError("VALIDATION_ERROR", 400, field_errors=errors)

    github_username, feishu_account = normalize_collaboration_accounts(
        github_username, feishu_account
    )

    # OIDC 用户的镜像邮箱可能为空。显式核对已有 Google 身份，避免注册第二个账号。
    google_owner = db.scalar(
        select(AuthIdentity.user_id)
        .where(func.lower(AuthIdentity.google_email) == tx.email_normalized)
        .limit(1)
    )
    if google_owner is not None:
        raise AppError("EMAIL_CONFLICT", 409, field_errors={"schoolEmail": "email_taken"})

    now = utcnow()
    user = User(
        id=user_id,
        name=name.strip(),
        username=username,
        username_normalized=username,
        requested_identity=requested_identity,
        student_id=student_id,
        college=college or None,
        github_username=github_username,
        feishu_account=feishu_account,
        # users.email 仅为业务展示/检索镜像；登录邮箱与学校邮箱的验证事实分别保存在认证表
        email=tx.email_normalized,
        account_status="enabled",
    )
    credential = PasswordCredential(
        user_id=user.id,
        login_email=tx.email,
        login_email_normalized=tx.email_normalized,
        login_email_verified_at=tx.code_consumed_at,
        verification_evidence_ref=tx.id,
        credential_version=1,
        password_hash=hash_password(password),
        password_algo="argon2id",
    )
    try:
        # 用户 + 凭据 + 资格消费同一事务；唯一约束兜底并发（E05/E06）
        with db.begin_nested():
            db.add(user)
            db.add(credential)
            bind_verified_target(db, user, email=tx.email, email_normalized=tx.email_normalized)
            db.flush()
    except IntegrityError as exc:
        constraint = getattr(getattr(exc.orig, "diag", None), "constraint_name", None)
        if constraint == "uq_users_student_id":
            raise AppError(
                "VALIDATION_ERROR", 409, field_errors={"studentId": "student_id_taken"}
            ) from None
        if constraint in {
            "users_email_key",
            "uq_users_email",
            "uq_school_email_verified",
            "password_credentials_login_email_normalized_key",
            "uq_password_credentials_login_email",
        }:
            raise AppError(
                "EMAIL_CONFLICT", 409, field_errors={"schoolEmail": "email_taken"}
            ) from None
        raise

    tx.creation_grant_digest = None  # 建档资格一次性消费
    tx.completed_at = now
    tx.result_user_id = user.id
    audit.record(
        db,
        "auth.email_registered",
        actor_id=user.id,
        target_user_id=user.id,
        changed_fields=["users", "password_credentials", "school_email_bindings"],
    )
    db.flush()
    return user, True


def _invalidate_grant(tx: PreRegistrationRequest) -> None:
    tx.creation_grant_digest = None
    tx.creation_grant_expires_at = None


def invalidate_transaction(db: DbSession, tx_id: str, *, browser_token: str | None) -> None:
    """更换邮箱/取消：作废事务与建档资格。"""
    tx = db.execute(
        select(PreRegistrationRequest).where(PreRegistrationRequest.id == tx_id).with_for_update()
    ).scalar_one_or_none()
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
    rows = (
        db.execute(
            select(PreRegistrationRequest).where(
                PreRegistrationRequest.expires_at < cutoff,
                PreRegistrationRequest.completed_at.is_(None),
            )
        )
        .scalars()
        .all()
    )
    for row in rows:
        row.email = "***"
        row.email_normalized = f"redacted-{row.id}"
        row.code_hmac = None
        row.creation_grant_digest = None
        row.invalidated_at = row.invalidated_at or utcnow()
    db.flush()
    return len(rows)


# 建档会话签发复用 sessions 服务（auth_method=password）
def issue_registration_session(db: DbSession, user: User, facts: dict):
    from .sessions import issue_session

    return issue_session(db, user, facts, auth_method="password", credential_version=1)
