"""密码找回/重置（E13–E15）。

- 只对存在且登录邮箱已验证的密码凭据发放恢复凭据；纯 Google 账户不适用；
- 请求本身不改密码、不撤会话、不停用/解禁账户；存在/不存在账户响应形态一致（防枚举）；
- 恢复凭据 ≥256 位随机、20 分钟限时、单次消费，绑定用户 + 当前已验证登录邮箱 + 凭据版本，只存摘要；
- 成功重置：原子消费 → 更新哈希（Argon2id）→ 凭据版本+1 → 撤销全部会话与其他恢复凭据 → 审计 → 通知。
"""
from __future__ import annotations

from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from ..config import get_settings
from ..errors import AppError
from ..models import EmailChallenge, PasswordCredential, User, utcnow
from ..security import code_hmac, hash_password, new_token, validate_password
from . import audit
from .mailer import MailSendError, send_template
from .rate_limit import RateLimitExceeded, check_and_increment
from .sessions import revoke_all_for_user

PURPOSE = "password_recovery"


def _invalidate_recovery(db: DbSession, user_id: str) -> None:
    for item in db.execute(select(EmailChallenge).where(EmailChallenge.user_id == user_id, EmailChallenge.purpose == PURPOSE)).scalars():
        if item.consumed_at is None and item.invalidated_at is None:
            item.invalidated_at = utcnow()


def request_reset(db: DbSession, *, email: str, locale: str | None, request_ip: str | None) -> None:
    """统一安全反馈：不区分账户是否存在；仅符合条件者真正发信。"""
    settings = get_settings()
    if not settings.password_reset_available:
        # 邮件整体不可用：对任何邮箱返回一致的不可用反馈（不跳过验证）
        raise AppError("MAIL_UNAVAILABLE", 503, params={"reason": "reset_disabled_or_mail_unavailable"})
    now = utcnow()
    try:
        normalized = email.strip().lower()
    except Exception:  # noqa: BLE001
        normalized = ""
    for key, limit, window in (
        (f"reset:email:{normalized}", settings.code_send_per_hour, 3600),
        (f"reset:ip:{request_ip or 'unknown'}", 30, 3600),
    ):
        try:
            check_and_increment(db, key, limit=limit, window_seconds=window, now=now)
        except RateLimitExceeded as exc:
            raise AppError("RATE_LIMITED", 429, retry_after_seconds=exc.retry_after_seconds) from exc

    credential = db.execute(select(PasswordCredential).where(PasswordCredential.login_email_normalized == normalized)).scalar_one_or_none()
    user = credential.user if credential else None
    eligible = bool(
        credential
        and user
        and user.account_status != "disabled"
        and credential.login_email_verified_at is not None  # 未验证登录邮箱不能用于找回（E17）
    )
    if not eligible:
        audit.record(db, "password_recovery.requested_ineligible", result="failure", changed_fields=[])
        db.commit()
        return  # 与成功请求同形态返回，不泄露账户存在性

    token = new_token() + new_token()  # ≥256 位
    _invalidate_recovery(db, user.id)
    challenge = EmailChallenge(
        id=new_token()[:32],
        user_id=user.id,
        email=credential.login_email,
        email_normalized=normalized,
        purpose=PURPOSE,
        code_hmac=code_hmac(token),  # 只存恢复令牌摘要
        credential_version=credential.credential_version,
        expires_at=now + timedelta(seconds=settings.password_reset_ttl_seconds),
        attempts=0,
        resend_available_at=now,
        send_status="pending",
    )
    db.add(challenge)
    db.flush()
    reset_url = f"{settings.app_origin.rstrip('/')}/reset-password#token={token}"
    try:
        send_template("password_recovery_link", credential.login_email, user.preferred_locale or locale, resetUrl=reset_url)
        challenge.send_status = "accepted"
    except MailSendError:
        challenge.send_status = "failed"
        db.commit()
        raise AppError("MAIL_UNAVAILABLE", 503, params={"reason": "mail_send_failed"}) from None
    audit.record(db, "password_recovery.sent", actor_id=user.id, target_user_id=user.id, changed_fields=["purpose:password_recovery"])
    db.commit()


def consume_and_reset(db: DbSession, *, token: str, new_password: str) -> None:
    settings = get_settings()
    now = utcnow()
    digest = code_hmac((token or "").strip())
    challenge = db.execute(select(EmailChallenge).where(EmailChallenge.purpose == PURPOSE).with_for_update()).scalars().all()
    item = next((c for c in challenge if c.code_hmac == digest), None)
    if item is None or item.consumed_at is not None or item.invalidated_at is not None:
        raise AppError("CHALLENGE_INVALID", 400, params={"reason": "reset_token_invalid"})
    if item.expires_at <= now:
        raise AppError("CODE_EXPIRED", 400, params={"reason": "reset_token_expired"})

    credential = db.get(PasswordCredential, item.user_id, with_for_update=True)
    user = db.get(User, item.user_id)
    if credential is None or user is None:
        raise AppError("CHALLENGE_INVALID", 400, params={"reason": "no_credential"})
    # 凭据版本绑定：改密/先前重置后旧恢复凭据失效（E14）
    if item.credential_version is not None and item.credential_version != credential.credential_version:
        raise AppError("CHALLENGE_INVALID", 400, params={"reason": "credential_version_changed"})

    try:
        password_value = validate_password(new_password)
    except ValueError as exc:
        raise AppError("VALIDATION_ERROR", 400, field_errors={"newPassword": str(exc)}) from None

    credential.password_hash = hash_password(password_value)
    credential.password_algo = "argon2id"
    credential.credential_version += 1
    credential.password_changed_at = now
    item.consumed_at = now  # 单次消费
    _invalidate_recovery(db, user.id)  # 撤销其他恢复凭据
    revoke_all_for_user(db, user.id, "password_reset")  # 撤销旧会话
    audit.record(db, "password_recovery.reset", actor_id=user.id, target_user_id=user.id, changed_fields=["passwordHash", "credentialVersion"])
    db.flush()
    _ = settings
    # 完成后通知已验证邮箱（尽力而为；失败不回滚重置）
    try:
        send_template("password_changed_notice", credential.login_email, user.preferred_locale)
    except MailSendError:
        audit.record(db, "password_recovery.notice_failed", actor_id=user.id, result="failure")
