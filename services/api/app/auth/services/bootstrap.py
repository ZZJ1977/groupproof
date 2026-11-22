"""受控初始化：初始管理员开通（可审计，不提供公开的管理员注册入口）。

仅限部署负责人在服务端执行；支持绑定 Google 身份和/或账号密码凭据，并完成资料与学校邮箱验证记录。
支持幂等执行：当目标用户已存在时，将其提升为启用状态的管理员并补齐凭据与验证绑定。
"""

from __future__ import annotations

from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from ..config import get_settings
from ..models import AuthIdentity, PasswordCredential, SchoolEmailBinding, User, utcnow
from ..security import (
    check_email_format,
    email_domain_allowed,
    hash_password,
    new_token,
    normalize_username,
    validate_name,
    validate_password,
    validate_username,
)
from ..services import audit


def bootstrap_admin(
    db: DbSession,
    *,
    name: str,
    username: str,
    school_email: str,
    google_subject: str | None = None,
    google_issuer: str = "https://accounts.google.com",
    password: str | None = None,
    login_email: str | None = None,
) -> User:
    if not google_subject and not password:
        raise ValueError("bootstrap_requires_google_or_password")

    cleaned_name = validate_name(name)
    cleaned_username = validate_username(username)
    norm_username = normalize_username(cleaned_username)
    norm_school_email = check_email_format(school_email)
    if not email_domain_allowed(norm_school_email, "teacher"):
        settings = get_settings()
        raise ValueError(
            f"school_email domain must match TEACHER_EMAIL_DOMAIN ({settings.teacher_email_domain})"
        )

    norm_login_email = check_email_format(login_email) if login_email else norm_school_email
    now = utcnow()

    user: User | None = None
    if google_subject:
        existing_identity = db.scalar(
            select(AuthIdentity).where(
                AuthIdentity.provider == "google",
                AuthIdentity.issuer == google_issuer,
                AuthIdentity.subject == google_subject,
            )
        )
        if existing_identity is not None:
            user = db.get(User, existing_identity.user_id)
    if user is None:
        existing_binding = db.scalar(
            select(SchoolEmailBinding).where(
                SchoolEmailBinding.school_email_normalized == norm_school_email
            )
        )
        if existing_binding is not None:
            user = db.get(User, existing_binding.user_id)
    if user is None:
        existing_cred = db.scalar(
            select(PasswordCredential).where(
                PasswordCredential.login_email_normalized == norm_login_email
            )
        )
        if existing_cred is not None:
            user = db.get(User, existing_cred.user_id)
    if user is None:
        user = db.scalar(select(User).where(User.username_normalized == norm_username))

    if user is None:
        email_taken = db.scalar(select(User.id).where(User.email == norm_school_email))
        user = User(
            id=uuid4(),
            name=cleaned_name,
            username=cleaned_username,
            username_normalized=norm_username,
            # users.email 仅为业务展示/检索镜像；学校邮箱验证事实保存在 school_email_bindings
            email=None if email_taken else norm_school_email,
            roles=["admin"],
            account_status="enabled",
            email_verified_at=now,
        )
        db.add(user)
        db.flush()
    else:
        user.name = cleaned_name
        if user.username_normalized != norm_username:
            conflict = db.scalar(
                select(User.id).where(User.username_normalized == norm_username, User.id != user.id)
            )
            if conflict is None:
                user.username = cleaned_username
                user.username_normalized = norm_username
        user.roles = ["admin"]
        user.account_status = "enabled"
        user.disabled_at = None
        user.disabled_reason = None
        if user.email_verified_at is None:
            user.email_verified_at = now
        db.flush()

    if google_subject:
        ident = db.scalar(
            select(AuthIdentity).where(
                AuthIdentity.provider == "google",
                AuthIdentity.issuer == google_issuer,
                AuthIdentity.subject == google_subject,
            )
        )
        if ident is None:
            db.add(
                AuthIdentity(
                    id=new_token()[:32],
                    provider="google",
                    issuer=google_issuer,
                    subject=google_subject,
                    user_id=user.id,
                    created_at=now,
                )
            )

    if password is not None:
        valid_pw = validate_password(password)
        pw_hash = hash_password(valid_pw)
        cred = db.get(PasswordCredential, user.id)
        if cred is None:
            db.add(
                PasswordCredential(
                    user_id=user.id,
                    login_email=login_email.strip() if login_email else school_email.strip(),
                    login_email_normalized=norm_login_email,
                    login_email_verified_at=now,
                    verification_evidence_ref="bootstrap_admin",
                    credential_version=1,
                    password_hash=pw_hash,
                    password_algo="argon2id",
                    created_at=now,
                    password_changed_at=now,
                )
            )
        else:
            cred.login_email = login_email.strip() if login_email else school_email.strip()
            cred.login_email_normalized = norm_login_email
            cred.login_email_verified_at = cred.login_email_verified_at or now
            cred.password_hash = pw_hash
            cred.password_algo = "argon2id"
            cred.credential_version += 1
            cred.password_changed_at = now

    binding = db.get(SchoolEmailBinding, user.id)
    if binding is None:
        db.add(
            SchoolEmailBinding(
                user_id=user.id,
                school_email=school_email.strip(),
                school_email_normalized=norm_school_email,
                verified_at=now,
                verification_method="documented_manual_review",
            )
        )
    else:
        binding.school_email = school_email.strip()
        binding.school_email_normalized = norm_school_email
        binding.verified_at = binding.verified_at or now
        binding.verification_method = binding.verification_method or "documented_manual_review"
        binding.pending_school_email = None
        binding.pending_school_email_normalized = None
        binding.pending_requested_at = None

    audit.record(
        db,
        "admin.bootstrapped",
        actor_id="system",
        target_user_id=user.id,
        changed_fields=["roles"],
    )
    db.commit()
    db.refresh(user)
    return user
