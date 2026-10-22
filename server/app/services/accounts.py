"""账户资料、学校邮箱换绑、教师申请与停用（§5.2 / §7.4）。

- 严格字段白名单：客户端不能写 role/verified/审核结果/verification 时间；
- 核验依赖字段（姓名/学号/学校邮箱）变更 → 依赖核验结论过时并保留历史（D07）；
- 教师审核依据变更 → 撤销旧教师资格并重新审核（§5.2）。
"""
from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from ..config import get_settings
from ..errors import AppError
from ..models import AcademicIdentityCheck, SchoolEmailBinding, TeacherApplication, User, utcnow
from ..security import (
    check_email_format,
    email_domain_allowed,
    normalize_email,
    normalize_username,
    validate_name,
    validate_username,
    within_recent_auth,
)
from ..security import new_token
from . import audit
from .registration import profile_field_errors, review_basis

PROFILE_FIELDS = ("name", "username", "studentId", "college", "requestedIdentity", "schoolEmail")


def _bump(user: User) -> None:
    user.version += 1


def _supersede_checks(db: DbSession, user: User) -> None:
    """修改被核验字段：仅使依赖结论过时，保留旧记录与快照版本。"""
    now = utcnow()
    for check in db.execute(select(AcademicIdentityCheck).where(AcademicIdentityCheck.user_id == user.id)).scalars():
        if check.superseded_at is None:
            check.superseded_at = now


def _revoke_teacher_if_basis_changed(db: DbSession, user: User) -> None:
    binding = user.email_binding
    basis = review_basis(user, binding)
    apps = list(db.execute(select(TeacherApplication).where(TeacherApplication.user_id == user.id)).scalars())
    approved_current = any(a.status == "approved" and a.snapshot == basis for a in apps)
    if "teacher" in (user.roles or []) and not approved_current:
        user.roles = [role for role in user.roles if role != "teacher"]
        user.auth_version += 1  # 敏感权限变化：旧会话不再代表该资格
        audit.record(db, "teacher.role_revoked_basis_changed", actor_id=user.id, changed_fields=["roles"])


def update_profile(
    db: DbSession,
    user: User,
    *,
    payload: dict[str, Any],
    expected_version: int,
    request_ip: str | None = None,
) -> None:
    from .email_challenges import _invalidate_active  # 同模块内部作废旧挑战

    if expected_version != user.version:
        raise AppError("VERSION_CONFLICT", 409)
    unknown = set(payload) - set(PROFILE_FIELDS)
    if unknown:
        # 严格白名单：忽略/拒绝额外字段（role、verified 等）
        raise AppError("VALIDATION_ERROR", 400, field_errors={key: "field_not_allowed" for key in sorted(unknown)})

    name = payload.get("name", user.name)
    username = payload.get("username", user.username)
    student_id = payload.get("studentId", user.student_id)
    requested_identity = payload.get("requestedIdentity", user.requested_identity)
    if "requestedIdentity" in payload and user.roles:
        # 身份激活后不能在通用资料表单自由切换学生/教师
        if user.requested_identity and payload["requestedIdentity"] != user.requested_identity and (
            set(user.roles) & {"student", "teacher"}
        ):
            raise AppError("INVALID_STATE", 409, params={"reason": "identity_locked"})

    binding = user.email_binding
    target_email = payload.get("schoolEmail") or (binding.pending_school_email if binding else None) or (binding.school_email if binding else None)
    managed_admin = "admin" in (user.roles or [])
    effective_identity = requested_identity or ("teacher" if managed_admin else None)
    errors = profile_field_errors(
        name=name,
        username=username,
        student_id=student_id,
        requested_identity=effective_identity,
        school_email=target_email,
    )
    if managed_admin:
        errors.pop("requestedIdentity", None)
        errors.pop("studentId", None)
    # 学校邮箱在资料接口仅用于首次注册/首次注册内更正；已验证用户换绑走 /me/school-email/change
    if "schoolEmail" in payload and binding and binding.verified_at:
        errors["schoolEmail"] = "use_change_flow"
    if errors:
        raise AppError("VALIDATION_ERROR", 400, field_errors=errors)

    # 一致性与唯一性：规范用户名唯一（数据库唯一约束兜底）
    normalized_username = normalize_username(username or "")
    existing = db.execute(select(User).where(User.username_normalized == normalized_username)).scalar_one_or_none()
    if existing is not None and existing.id != user.id:
        raise AppError("USERNAME_CONFLICT", 409, field_errors={"username": "username_taken"})

    identity_basis_changed = False
    if (user.name or "").strip() != (name or "").strip() or (user.student_id or "").strip() != (student_id or "").strip():
        identity_basis_changed = True
    user.name = validate_name(name or "")
    user.username = validate_username(username or "")
    user.username_normalized = normalized_username
    user.student_id = (student_id or "").strip() or None
    if "college" in payload:
        user.college = (payload.get("college") or "").strip() or None
    if requested_identity and not user.requested_identity:
        user.requested_identity = requested_identity
    elif requested_identity:
        user.requested_identity = requested_identity

    if "schoolEmail" in payload:
        try:
            normalized = check_email_format(payload["schoolEmail"])
        except ValueError:
            raise AppError("VALIDATION_ERROR", 400, field_errors={"schoolEmail": "invalid_email"}) from None
        if not email_domain_allowed(normalized, user.requested_identity or "student"):
            raise AppError("VALIDATION_ERROR", 400, field_errors={"schoolEmail": "email_domain_not_allowed"})
        if binding is None:
            binding = SchoolEmailBinding(user_id=user.id)
            db.add(binding)
            user.email_binding = binding
        first_registration_correction = binding.verified_at is None and binding.pending_school_email_normalized is not None
        binding.pending_school_email = payload["schoolEmail"].strip()
        binding.pending_school_email_normalized = normalized
        binding.pending_requested_at = utcnow()
        if first_registration_correction:
            # 首次注册内更正地址：作废原挑战，回到邮箱待验证状态（无旧已验证邮箱可保留）
            _invalidate_active(db, user.id, "school_email_verify")
        identity_basis_changed = True

    if identity_basis_changed:
        _supersede_checks(db, user)
    _revoke_teacher_if_basis_changed(db, user)
    _bump(user)
    audit.record(
        db,
        "profile.updated",
        actor_id=user.id,
        changed_fields=[key for key in payload if key in PROFILE_FIELDS],
    )
    db.flush()


def request_school_email_change(db: DbSession, user: User, *, new_email: str, expected_version: int) -> str:
    """独立换绑流程：保存待验证地址并作废旧挑战；不覆盖原已验证邮箱（A16）。"""
    if expected_version != user.version:
        raise AppError("VERSION_CONFLICT", 409)
    binding = user.email_binding
    if binding is None or not binding.verified_at:
        raise AppError("INVALID_STATE", 409, params={"reason": "no_verified_email"})
    try:
        normalized = check_email_format(new_email)
    except ValueError:
        raise AppError("VALIDATION_ERROR", 400, field_errors={"schoolEmail": "invalid_email"}) from None
    if not email_domain_allowed(normalized, user.requested_identity or "student"):
        raise AppError("VALIDATION_ERROR", 400, field_errors={"schoolEmail": "email_domain_not_allowed"})
    # 敏感换绑前置：近 10 分钟重新认证，或旧邮箱对指定目标的一次性确认
    authorized = within_recent_auth(user.last_login_at, utcnow())
    if not authorized:
        if binding.change_authorized_until and binding.change_authorized_until > utcnow() and binding.change_authorized_target == normalized:
            authorized = True
    if not authorized:
        raise AppError("REAUTH_REQUIRED", 403)
    taken = db.execute(select(SchoolEmailBinding).where(SchoolEmailBinding.school_email_normalized == normalized)).scalar_one_or_none()
    if taken is not None and taken.user_id != user.id:
        # 已被其他账户绑定：可恢复冲突提示，不合并账户、不泄露对方资料
        raise AppError("EMAIL_CONFLICT", 409, field_errors={"schoolEmail": "email_taken"})
    binding.pending_school_email = new_email.strip()
    binding.pending_school_email_normalized = normalized
    binding.pending_requested_at = utcnow()
    binding.change_authorized_until = None
    binding.change_authorized_target = None
    from .email_challenges import _invalidate_active

    _invalidate_active(db, user.id, "school_email_verify")
    audit.record(db, "school_email.change_requested", actor_id=user.id, changed_fields=["pendingSchoolEmail"])
    _bump(user)
    db.flush()
    return normalized


def grant_change_authorization(db: DbSession, user: User, *, target_email: str) -> str:
    """旧邮箱确认签发的一次性换绑授权：只授权本次指定目标，10 分钟有效。"""
    binding = user.email_binding
    if binding is None or not binding.verified_at or not binding.school_email_normalized:
        raise AppError("INVALID_STATE", 409, params={"reason": "no_verified_email"})
    try:
        normalized = check_email_format(target_email)
    except ValueError:
        raise AppError("VALIDATION_ERROR", 400, field_errors={"schoolEmail": "invalid_email"}) from None
    if not email_domain_allowed(normalized, user.requested_identity or "student"):
        raise AppError("VALIDATION_ERROR", 400, field_errors={"schoolEmail": "email_domain_not_allowed"})
    settings = get_settings()
    binding.change_authorized_until = utcnow() + timedelta(seconds=600)
    binding.change_authorized_target = normalized
    audit.record(db, "school_email.change_authorized", actor_id=user.id, changed_fields=["changeAuthorizedUntil"])
    db.flush()
    return normalized


def submit_teacher_application(db: DbSession, user: User, *, expected_version: int, materials: dict[str, Any] | None) -> TeacherApplication:
    if expected_version != user.version:
        raise AppError("VERSION_CONFLICT", 409)
    binding = user.email_binding
    if user.requested_identity != "teacher":
        raise AppError("INVALID_STATE", 409, params={"reason": "not_teacher_identity"})
    if not binding or not binding.verified_at:
        raise AppError("INVALID_STATE", 409, params={"reason": "email_not_verified"})
    open_app = db.execute(
        select(TeacherApplication).where(TeacherApplication.user_id == user.id, TeacherApplication.status == "pending")
    ).scalar_one_or_none()
    current_basis = review_basis(user, binding)
    if open_app is not None:
        if open_app.snapshot == current_basis:
            return open_app  # 禁止重复申请形成多条活动记录（同资料幂等）
        # 依据资料已变化：重新提交绑定当前版本快照（旧审核不能批准后来更改的资料）
        open_app.snapshot = current_basis
        open_app.application_version = user.version
        _bump(user)
        audit.record(db, "teacher_application.resubmitted", actor_id=user.id, changed_fields=["teacherReviewStatus"])
        db.flush()
        return open_app
    app = TeacherApplication(
        id=new_token()[:32],
        user_id=user.id,
        application_version=user.version,
        snapshot=current_basis,
        status="pending",
        reason=None,
    )
    db.add(app)
    _bump(user)
    audit.record(db, "teacher_application.submitted", actor_id=user.id, changed_fields=["teacherReviewStatus"])
    db.flush()
    _ = materials  # 申请材料如需附件由对象存储服务接收；此处仅记录引用级别信息
    return app


def review_teacher_application(
    db: DbSession,
    app: TeacherApplication,
    *,
    reviewer: User,
    decision: str,
    reason: str | None,
    expected_version: int,
) -> TeacherApplication:
    if expected_version != app.application_version:
        raise AppError("VERSION_CONFLICT", 409, params={"reason": "application_changed"})
    if app.status != "pending":
        raise AppError("INVALID_STATE", 409, params={"reason": "already_reviewed"})
    user = db.get(User, app.user_id)
    if user is None:
        raise AppError("NOT_FOUND", 404)
    binding = user.email_binding
    if app.snapshot != review_basis(user, binding):
        raise AppError("VERSION_CONFLICT", 409, params={"reason": "basis_changed"})
    now = utcnow()
    app.status = "approved" if decision == "approve" else "rejected"
    app.reviewer_id = reviewer.id
    app.reviewed_at = now
    app.reason = reason
    if decision == "approve":
        roles = list(user.roles or [])
        if "teacher" not in roles:
            roles.append("teacher")
        user.roles = roles
        user.auth_version += 1  # 批准与权限版本、审计同步提交
        audit.record(db, "teacher_application.approved", actor_id=reviewer.id, target_user_id=user.id, changed_fields=["roles"])
    else:
        audit.record(db, "teacher_application.rejected", actor_id=reviewer.id, target_user_id=user.id, changed_fields=["teacherReviewStatus"])
    db.flush()
    return app


def disable_user(db: DbSession, user: User, *, admin: User, reason: str | None, expected_version: int) -> None:
    if expected_version != user.version:
        raise AppError("VERSION_CONFLICT", 409)
    user.account_status = "disabled"
    user.disabled_reason = reason
    user.disabled_at = utcnow()
    user.auth_version += 1
    _bump(user)
    from .sessions import revoke_all_for_user

    revoke_all_for_user(db, user.id, "account_disabled")  # 停用即撤销已有会话
    audit.record(db, "user.disabled", actor_id=admin.id, target_user_id=user.id, changed_fields=["accountStatus"])


def set_preference(db: DbSession, user: User, *, preferred_locale: str) -> None:
    from ..security import normalize_locale

    normalized = normalize_locale(preferred_locale)
    if normalized is None:
        raise AppError("VALIDATION_ERROR", 400, field_errors={"preferredLocale": "unsupported_locale"})
    user.preferred_locale = normalized
    audit.record(db, "preferences.updated", actor_id=user.id, changed_fields=["preferredLocale"])
    db.flush()


def apply_activation_grants(db: DbSession, user: User, facts: dict[str, Any]) -> None:
    """学生注册条件满足后由服务端授予学生资格（角色只能由服务端流程写入）。"""
    if facts["accountState"] == "active" and user.requested_identity == "student" and "student" not in (user.roles or []):
        user.roles = list(user.roles or []) + ["student"]
        audit.record(db, "role.granted_student", actor_id=user.id, changed_fields=["roles"])
        db.flush()


def normalize_email_util(value: str) -> str:
    return normalize_email(value)
