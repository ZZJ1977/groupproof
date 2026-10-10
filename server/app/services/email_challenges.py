"""学校邮箱验证码挑战（§6.4）：HMAC 存储、一次性消费、限流、重发作废。

真实验证码只经邮件通道发出；不存在任何调试读取验证码的接口。
"""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from ..config import get_settings
from ..errors import AppError
from ..models import EmailChallenge, SchoolEmailBinding, User, utcnow
from ..security import code_hmac, new_code, new_token
from . import audit
from .mailer import MailSendError, send_code_email
from .rate_limit import RateLimitExceeded, check_and_increment

PURPOSES = ("school_email_verify", "change_authorization", "login_email_verification")


def _invalidate_active(db: DbSession, user_id: str, purpose: str) -> None:
    for item in db.execute(
        select(EmailChallenge).where(EmailChallenge.user_id == user_id, EmailChallenge.purpose == purpose)
    ).scalars():
        if item.consumed_at is None and item.invalidated_at is None:
            item.invalidated_at = utcnow()


def create_challenge(
    db: DbSession,
    user: User,
    *,
    to_email: str,
    to_email_normalized: str,
    purpose: str,
    request_ip: str | None,
    change_target_email_normalized: str | None = None,
) -> EmailChallenge:
    settings = get_settings()
    now = utcnow()
    if purpose not in PURPOSES:
        raise AppError("VALIDATION_ERROR", 400, field_errors={"purpose": "invalid_purpose"})
    # 账号及邮箱各最多 5 次/小时、20 次/日；IP 另行较宽限制
    for key, limit, window in (
        (f"send:user:{user.id}", settings.code_send_per_hour, 3600),
        (f"send:user-day:{user.id}", settings.code_send_per_day, 86400),
        (f"send:email:{to_email_normalized}", settings.code_send_per_hour, 3600),
        (f"send:email-day:{to_email_normalized}", settings.code_send_per_day, 86400),
    ):
        try:
            check_and_increment(db, key, limit=limit, window_seconds=window, now=now)
        except RateLimitExceeded as exc:
            audit.record(db, "email_challenge.rate_limited", actor_id=user.id, result="failure")
            raise AppError("RATE_LIMITED", 429, retry_after_seconds=exc.retry_after_seconds) from exc
    if request_ip:
        try:
            check_and_increment(db, f"send:ip:{request_ip}", limit=30, window_seconds=3600, now=now)
        except RateLimitExceeded as exc:
            raise AppError("RATE_LIMITED", 429, retry_after_seconds=exc.retry_after_seconds) from exc

    previous = db.execute(
        select(EmailChallenge).where(
            EmailChallenge.user_id == user.id,
            EmailChallenge.purpose == purpose,
            EmailChallenge.consumed_at.is_(None),
            EmailChallenge.invalidated_at.is_(None),
        )
    ).scalars().all()
    for item in previous:
        if item.resend_available_at > now:
            raise AppError(
                "RATE_LIMITED",
                429,
                retry_after_seconds=int((item.resend_available_at - now).total_seconds()) + 1,
            )

    # 重发、更改目标邮箱、取消换绑时作废旧 challenge
    _invalidate_active(db, user.id, purpose)

    code = new_code()
    challenge = EmailChallenge(
        id=new_token()[:32],
        user_id=user.id,
        email=to_email,
        email_normalized=to_email_normalized,
        purpose=purpose,
        change_target_email_normalized=change_target_email_normalized,
        code_hmac=code_hmac(code),
        expires_at=now + timedelta(seconds=settings.code_ttl_seconds),
        attempts=0,
        resend_available_at=now + timedelta(seconds=settings.resend_cooldown_seconds),
    )
    from sqlalchemy.exc import IntegrityError

    try:
        with db.begin_nested():  # 并发重发：部分唯一索引保证只有一个当前挑战
            db.add(challenge)
            db.flush()
    except IntegrityError as exc:
        raise AppError("RATE_LIMITED", 429, retry_after_seconds=settings.resend_cooldown_seconds) from exc
    try:
        send_code_email(to_email, code)
        challenge.send_status = "accepted"
    except MailSendError:
        challenge.send_status = "failed"
        audit.record(db, "email_challenge.send_failed", actor_id=user.id, result="failure")
        db.flush()
        raise AppError("AUTH_UNAVAILABLE", 503, params={"service": "mail"}) from None
    audit.record(db, "email_challenge.sent", actor_id=user.id, changed_fields=["purpose:" + purpose])
    db.flush()
    return challenge


def consume_challenge(
    db: DbSession,
    user: User,
    *,
    challenge_id: str,
    code: str,
    purpose: str,
    expected_email_normalized: str,
) -> EmailChallenge:
    """原子校验并消费：绑定 userId + 精确邮箱 + 用途 + challengeId，只能消费一次。"""
    settings = get_settings()
    now = utcnow()
    item = db.execute(
        select(EmailChallenge)
        .where(EmailChallenge.id == challenge_id, EmailChallenge.user_id == user.id)
        .with_for_update()  # 并发重复消费：行锁保证只能消费一次
    ).scalar_one_or_none()
    if item is None or item.purpose != purpose or item.email_normalized != expected_email_normalized:
        audit.record(db, "email_challenge.consume_failed", actor_id=user.id, result="failure")
        db.commit()  # 失败审计需要落库
        raise AppError("CHALLENGE_INVALID", 400)
    if item.consumed_at is not None or item.invalidated_at is not None:
        raise AppError("CHALLENGE_INVALID", 400)
    if item.expires_at <= now:
        raise AppError("CODE_EXPIRED", 400)
    if item.attempts >= settings.code_max_attempts:
        raise AppError("CODE_EXPIRED", 400, params={"reason": "too_many_attempts"})
    item.attempts += 1
    if not verify_code(item.code_hmac, code):
        audit.record(db, "email_challenge.consume_failed", actor_id=user.id, result="failure")
        db.commit()  # 错误次数与失败审计必须持久（不随请求回滚）
        raise AppError("INVALID_CODE", 400)
    item.consumed_at = now  # 同一事务内一次性消费，并发重复消费由行锁保证
    db.flush()
    return item


def verify_code(digest: str, code: str) -> bool:
    from ..security import verify_code_hmac

    return verify_code_hmac(code, digest)


def bind_verified_email(db: DbSession, user: User, challenge: EmailChallenge) -> SchoolEmailBinding:
    """验证码消费、学校邮箱绑定与资格更新在同一事务提交（调用方负责整体事务）。"""
    return bind_verified_target(db, user, email=challenge.email, email_normalized=challenge.email_normalized)


def bind_verified_target(db: DbSession, user: User, *, email: str, email_normalized: str) -> SchoolEmailBinding:
    """学校邮箱绑定落库（真实验证码与验收密令共用同一路径，不伪造验证状态）。"""
    now = utcnow()
    binding = user.email_binding
    if binding is None:
        binding = SchoolEmailBinding(user_id=user.id)
        db.add(binding)
        user.email_binding = binding
    previous_email = binding.school_email_normalized
    binding.school_email = email
    binding.school_email_normalized = email_normalized
    binding.verified_at = now
    binding.verification_method = "email_code"
    binding.pending_school_email = None
    binding.pending_school_email_normalized = None
    binding.pending_requested_at = None
    binding.change_authorized_until = None
    binding.change_authorized_target = None
    if previous_email and previous_email != email_normalized:
        from .accounts import _revoke_teacher_if_basis_changed, _supersede_checks

        _supersede_checks(db, user)
        _revoke_teacher_if_basis_changed(db, user)
        user.version += 1
    audit.record(db, "school_email.verified", actor_id=user.id, changed_fields=["schoolEmail"])
    db.flush()
    return binding
