"""服务端可撤销会话：签发、轮换、撤销、期限与当前资格重查（§6.3）。

会话层记录认证方式（password/google）；未验证登录邮箱的密码凭据不得借该凭据
取得 full 业务会话（历史凭据同样受限），已验证 Google 身份不受另一条未验证密码凭据影响。
"""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.orm import Session as DbSession

from ..config import get_settings
from ..models import Session, User, utcnow
from ..security import new_token, token_digest
from .registration import derive_facts, scope_for_state


class IssuedSession:
    def __init__(self, record: Session, raw_token: str, facts: dict) -> None:
        self.record = record
        self.raw_token = raw_token
        self.facts = facts


def _limits(scope: str, is_admin: bool) -> tuple[int, int]:
    settings = get_settings()
    if is_admin:
        return settings.session_admin_idle, settings.session_admin_absolute
    if scope == "full":
        return settings.session_full_idle, settings.session_full_absolute
    return settings.session_onboarding_idle, settings.session_onboarding_absolute


def _credential_unverified(db: DbSession, user: User) -> bool:
    from ..models import PasswordCredential

    credential = db.get(PasswordCredential, user.id)
    return credential is not None and credential.login_email_verified_at is None


def cap_scope(db: DbSession, user: User, scope: str, auth_method: str | None) -> str:
    """未验证登录邮箱的密码/未知来源会话最多 onboarding；google 会话不受影响。"""
    if auth_method == "google":
        return scope
    if _credential_unverified(db, user):
        return "onboarding" if scope == "full" else scope
    return scope


def issue_session(
    db: DbSession,
    user: User,
    facts: dict,
    *,
    auth_method: str | None = None,
    credential_version: int | None = None,
) -> IssuedSession:
    scope = cap_scope(db, user, scope_for_state(facts["accountState"]), auth_method)
    is_admin = "admin" in (user.roles or []) and scope == "full"
    idle, absolute = _limits(scope, is_admin)
    now = utcnow()
    raw = new_token()
    record = Session(
        id=new_token()[:32],
        token_digest=token_digest(raw),
        csrf_token=new_token(),
        user_id=user.id,
        scope=scope,
        auth_method=auth_method,
        credential_version=credential_version,
        auth_version=user.auth_version,
        created_at=now,
        last_seen_at=now,
        expires_at=now + timedelta(seconds=idle),
        absolute_expires_at=now + timedelta(seconds=absolute),
    )
    db.add(record)
    return IssuedSession(record, raw, facts)


def rotate_session(db: DbSession, old: Session, user: User, facts: dict) -> IssuedSession:
    """首次认证、受限转 active、敏感权限变化时轮换；旧会话立即失效（保留认证方式）。"""
    old.revoked_at = utcnow()
    old.revoke_reason = "rotated"
    return issue_session(db, user, facts, auth_method=old.auth_method, credential_version=old.credential_version)


def revoke_session(db: DbSession, record: Session, reason: str) -> None:
    if record.revoked_at is None:
        record.revoked_at = utcnow()
        record.revoke_reason = reason


def revoke_all_for_user(db: DbSession, user_id: str, reason: str) -> None:
    db.execute(
        update(Session)
        .where(Session.user_id == user_id, Session.revoked_at.is_(None))
        .values(revoked_at=utcnow(), revoke_reason=reason)
    )


def lookup_session(db: DbSession, raw_token: str | None, now: datetime | None = None) -> Session | None:
    if not raw_token:
        return None
    now = now or utcnow()
    record = db.execute(select(Session).where(Session.token_digest == token_digest(raw_token))).scalar_one_or_none()
    if record is None:
        return None
    if record.revoked_at is not None:
        return None
    if record.absolute_expires_at <= now or record.expires_at <= now:
        return None
    return record


def touch_session(db: DbSession, record: Session) -> None:
    idle, _abs = _limits(record.scope, _is_admin(record.user_id, db) and record.scope == "full")
    now = utcnow()
    record.last_seen_at = now
    # 闲置期限滚动，但绝不越过绝对期限
    record.expires_at = min(now + timedelta(seconds=idle), record.absolute_expires_at)


def _is_admin(user_id: str, db: DbSession) -> bool:
    user = db.get(User, user_id)
    return bool(user and "admin" in (user.roles or []))


def current_facts(db: DbSession, user: User) -> dict:
    from ..models import AcademicIdentityCheck, PasswordCredential, TeacherApplication

    binding = user.email_binding
    checks = list(db.execute(select(AcademicIdentityCheck).where(AcademicIdentityCheck.user_id == user.id)).scalars())
    applications = list(db.execute(select(TeacherApplication).where(TeacherApplication.user_id == user.id)).scalars())
    credential = db.get(PasswordCredential, user.id)
    return derive_facts(user, binding, checks, applications, credential)


def refresh_session(db: DbSession, record: Session, user: User) -> tuple[IssuedSession, dict]:
    """重查当前资格并按需轮换；不能延长绝对期限或自授角色。"""
    facts = current_facts(db, user)
    expected = cap_scope(db, user, scope_for_state(facts["accountState"]), record.auth_method)
    if record.scope != expected or record.auth_version != user.auth_version:
        issued = rotate_session(db, record, user, facts)
        return issued, facts
    touch_session(db, record)
    return IssuedSession(record, "", facts), facts
