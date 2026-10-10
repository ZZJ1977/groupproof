"""RegistrationFacts：从当前事实派生注册资格（§3.2 / §7.3）。

派生优先级严格采用：disabled → profile → email → review → active。
禁止客户端提交 isRegistered/active/teacherStatus 等字段直接放行。
"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from ..config import get_settings
from ..models import (
    AcademicIdentityCheck,
    EmailChallenge,
    SchoolEmailBinding,
    TeacherApplication,
    User,
    utcnow,
)
from ..security import (
    check_email_format,
    email_domain_allowed,
    student_id_valid,
    validate_name,
    validate_username,
)

ACCOUNT_STATES = (
    "anonymous",
    "disabled",
    "profile_required",
    "email_required",
    "review_required",
    "review_pending",
    "review_rejected",
    "active",
)

NEXT_ACTIONS = {
    "disabled": {"type": "view_account_status", "href": "/account/status"},
    "profile_required": {"type": "complete_profile", "href": "/account/profile"},
    "email_required": {"type": "verify_school_email", "href": "/account/email"},
    "review_required": {"type": "submit_teacher_application", "href": "/account/status"},
    "review_pending": {"type": "view_account_status", "href": "/account/status"},
    "review_rejected": {"type": "view_account_status", "href": "/account/status"},
    "active": {"type": "enter_workspace", "href": "/home"},
}


# --- 三层检查之一：格式与完整性（返回稳定字段错误码，前端按码翻译）---


def profile_field_errors(
    *,
    name: str | None,
    username: str | None,
    student_id: str | None,
    requested_identity: str | None,
    school_email: str | None,
) -> dict[str, str]:
    errors: dict[str, str] = {}
    try:
        validate_name(name or "")
    except ValueError:
        errors["name"] = "invalid_name"
    try:
        validate_username(username or "")
    except ValueError:
        errors["username"] = "invalid_username"
    if requested_identity not in ("student", "teacher"):
        errors["requestedIdentity"] = "invalid_identity"
    normalized_email = None
    if not school_email:
        errors["schoolEmail"] = "email_required"
    else:
        try:
            normalized_email = check_email_format(school_email)
        except ValueError:
            errors["schoolEmail"] = "invalid_email"
        if normalized_email and requested_identity in ("student", "teacher"):
            if not email_domain_allowed(normalized_email, requested_identity):
                errors["schoolEmail"] = "email_domain_not_allowed"
    if requested_identity == "student":
        if not (student_id or "").strip():
            errors["studentId"] = "student_id_required"
        elif not student_id_valid(student_id or "", normalized_email):
            errors["studentId"] = "invalid_student_id"
    return errors


def review_basis(user: User, binding: SchoolEmailBinding | None) -> dict[str, Any]:
    """教师审核所依据的资料快照字段；依赖字段变化会使旧审核结论失效。"""
    return {
        "name": (user.name or "").strip(),
        "requestedIdentity": user.requested_identity,
        "schoolEmailNormalized": binding.school_email_normalized if binding else None,
    }


def academic_identity_status(user: User, checks: list[AcademicIdentityCheck]) -> str:
    mine = [c for c in checks if c.user_id == user.id]
    active = [c for c in mine if c.superseded_at is None]
    if active:
        latest = max(active, key=lambda c: c.checked_at)
        return "verified" if latest.result == "passed" else "rejected"
    if mine:
        return "stale"
    return "unverified"


def derive_facts(
    user: User,
    binding: SchoolEmailBinding | None,
    checks: list[AcademicIdentityCheck],
    applications: list[TeacherApplication],
    credential=None,
) -> dict[str, Any]:
    now = utcnow()
    target_email = None
    if binding:
        target_email = binding.pending_school_email_normalized or binding.school_email_normalized
    roles = user.roles or []
    managed_admin = "admin" in roles  # 受控初始化开通的管理身份，按其开通规则准入
    effective_identity = user.requested_identity or ("teacher" if managed_admin else None)
    errors = profile_field_errors(
        name=user.name,
        username=user.username,
        student_id=user.student_id,
        requested_identity=effective_identity,
        school_email=target_email,
    )
    if managed_admin:
        errors.pop("requestedIdentity", None)
        errors.pop("studentId", None)
    profile_complete = not errors
    email_verified = bool(binding and binding.verified_at and binding.school_email_normalized)

    # 教师审核：绑定当前资料快照；依赖字段变化后旧批准不再有效
    teacher_review_status: str | None = None
    teacher_review_current = False
    if user.requested_identity == "teacher" and profile_complete and email_verified:
        basis = review_basis(user, binding)
        mine = sorted((a for a in applications if a.user_id == user.id), key=lambda a: a.created_at)
        latest = mine[-1] if mine else None
        if latest is None:
            teacher_review_status = "review_required"
        elif latest.snapshot == basis:
            teacher_review_status = {"pending": "review_pending", "approved": "approved", "rejected": "review_rejected"}[latest.status]
            teacher_review_current = latest.status == "approved"
        else:
            # 依据资料已变化：旧结论过时，需重新提交（旧批准不沿用）
            teacher_review_status = "review_required"

    if user.account_status == "disabled":
        account_state = "disabled"
    elif not profile_complete:
        account_state = "profile_required"
    elif not email_verified:
        account_state = "email_required"
    elif user.requested_identity == "teacher" and not managed_admin:
        account_state = {
            "approved": "active",
            "review_pending": "review_pending",
            "review_rejected": "review_rejected",
            "review_required": "review_required",
        }[teacher_review_status or "review_required"]
    else:
        account_state = "active"

    # 身份确认（学生/教师）：学生=后端准入条件满足；教师=有效审核批准（提交申请/状态页/客户端选择均不算）。
    # account_state 只有在这些后端事实成立时才可能为 active，不得由客户端字段直接放行。
    identity_confirmed = account_state == "active"
    # 账号安全（可选阶段，不计入必填进度）：密码账户=可用密码凭据 + 登录邮箱已实际验证（含注册时已满足）；
    # 纯 Google 账户沿用其可信认证事实，不强制创建密码；不要求再改一次密码或绑定 Google。
    if credential is not None:
        security_complete = credential.login_email_verified_at is not None
    else:
        security_complete = bool(user.identities)
    required_completed_count = int(profile_complete) + int(email_verified) + int(identity_confirmed)

    basis: list[dict[str, Any]] = []
    # 认证依据按实际方式记录，不把密码认证伪装为 Google 认证
    if user.identities:
        basis.append({"kind": "google_auth", "at": user.last_login_at.isoformat() if user.last_login_at else None})
    if credential is not None:
        basis.append(
            {
                "kind": "password_auth",
                "at": credential.login_email_verified_at.isoformat() if credential.login_email_verified_at else None,
                "loginEmailVerified": credential.login_email_verified_at is not None,
            }
        )
    if email_verified and binding:
        basis.append(
            {
                "kind": "school_email_control",
                "at": binding.verified_at.isoformat() if binding.verified_at else None,
                "method": binding.verification_method,
                "schoolEmailDomain": (binding.school_email_normalized or "").rsplit("@", 1)[-1],
            }
        )
    if teacher_review_current:
        approved_candidates = [a for a in applications if a.user_id == user.id and a.status == "approved"]
        if approved_candidates:
            approved = max(approved_candidates, key=lambda a: a.created_at)
            basis.append({"kind": "teacher_approval", "at": approved.reviewed_at.isoformat() if approved.reviewed_at else None, "method": "admin_review"})

    return {
        "profileComplete": profile_complete,
        "profileFieldErrors": errors,
        "schoolEmailVerified": email_verified,
        "identityConfirmed": identity_confirmed,
        "securityComplete": security_complete,
        "requiredCompletedCount": required_completed_count,
        "loginEmailVerified": bool(credential is None or credential.login_email_verified_at is not None),
        "teacherReviewStatus": teacher_review_status,
        "academicIdentityStatus": academic_identity_status(user, checks),
        "verificationBasis": basis,
        "accountState": account_state,
        "nextAction": dict(NEXT_ACTIONS[account_state]),
        "targetSchoolEmailSet": bool(target_email),
    }


def scope_for_state(account_state: str) -> str:
    if account_state == "active":
        return "full"
    if account_state == "disabled":
        return "status_only"
    return "onboarding"


def can_enter_workspace(facts: dict, auth_method: str | None) -> bool:
    """当前会话能否取得 full 业务范围（与 guard.require_active_user / sessions.cap_scope 同口径）。

    账号安全为可选阶段，不额外增加准入要求；但未验证登录邮箱的密码/未知来源凭据
    不得借 active 状态取得 full 会话（历史账户保护），已验证 Google 身份不受影响。
    """
    return facts["accountState"] == "active" and (
        auth_method == "google" or facts.get("loginEmailVerified", True)
    )


def active_challenge(challenges: list[EmailChallenge], purpose: str, now: datetime) -> EmailChallenge | None:
    for item in sorted(challenges, key=lambda c: c.created_at, reverse=True):
        if item.purpose != purpose:
            continue
        if item.consumed_at or item.invalidated_at:
            continue
        return item
    return None


def student_id_rule_note() -> dict[str, Any]:
    settings = get_settings()
    return {
        "pattern": settings.student_id_pattern,
        "emailPrefixRule": settings.student_id_email_rule,
        "confirmedBySchool": False,
    }
