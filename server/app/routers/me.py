"""个人中心接口：本人资料、学校邮箱挑战/验证/换绑、教师申请、偏好（§7.6）。"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from ..config import get_settings
from ..db import get_db
from ..errors import AppError
from ..guard import AuthContext, check_csrf, require_session
from ..models import AcademicIdentityCheck, TeacherApplication
from ..models import utcnow
from ..security import check_email_format, email_domain_allowed
from ..services import acceptance, accounts, email_challenges, sessions as sessions_service
from ..services import audit  # noqa: F401  (change_password 审计)
from ..services.registration import can_enter_workspace, derive_facts, student_id_rule_note

router = APIRouter(prefix="/api/v1", tags=["me"])


class ProfilePatch(BaseModel):
    name: str | None = None
    username: str | None = None
    studentId: str | None = None
    college: str | None = None
    requestedIdentity: str | None = None
    schoolEmail: str | None = None
    expectedVersion: int


class SchoolEmailChange(BaseModel):
    schoolEmail: str
    expectedVersion: int


class ChallengeCreate(BaseModel):
    purpose: str = "school_email_verify"


class ChallengeVerify(BaseModel):
    challengeId: str
    code: str


class ChangeAuthorizationVerify(BaseModel):
    challengeId: str
    code: str


class TeacherApplicationIn(BaseModel):
    expectedVersion: int
    materials: dict[str, Any] | None = None


class PreferencesPatch(BaseModel):
    preferredLocale: str


class PasswordChange(BaseModel):
    currentPassword: str
    newPassword: str


def _mask_email(email: str | None) -> str | None:
    if not email:
        return None
    local, _, domain = email.partition("@")
    return (local[:2] + "***" if len(local) > 2 else "***") + "@" + domain


def _me_payload(context: AuthContext, db: DbSession) -> dict:
    user = context.user
    facts = context.facts
    binding = user.email_binding
    from ..models import PasswordCredential

    has_password = db.get(PasswordCredential, user.id) is not None
    apps = list(db.execute(select(TeacherApplication).where(TeacherApplication.user_id == user.id)).scalars())
    latest = max(apps, key=lambda a: a.created_at) if apps else None
    return {
        "user": {
            "id": user.id,
            "name": user.name,
            "username": user.username,
            "studentId": user.student_id,
            "college": user.college,
            "requestedIdentity": user.requested_identity,
            "roles": list(user.roles or []),  # 只读：实际角色由服务端授予
            "preferredLocale": user.preferred_locale or "zh-Hans",
            "version": user.version,
            "googleEmailBound": bool(user.identities),
            "passwordLoginEnabled": has_password,
        },
        "schoolEmail": {
            "verifiedEmail": _mask_email(binding.school_email if binding else None),
            "verifiedAt": binding.verified_at.isoformat() if binding and binding.verified_at else None,
            "pendingEmail": _mask_email(binding.pending_school_email if binding else None),
            "verified": facts["schoolEmailVerified"],
        },
        "registration": {
            **{
                key: facts[key]
                for key in (
                    "profileComplete",
                    "profileFieldErrors",
                    "schoolEmailVerified",
                    "identityConfirmed",
                    "securityComplete",
                    "requiredCompletedCount",
                    "loginEmailVerified",
                    "teacherReviewStatus",
                    "academicIdentityStatus",
                    "verificationBasis",
                    "accountState",
                    "nextAction",
                )
            },
            # 会话级准入（与 guard 门禁同口径）：身份未确认/停用/认证依据不完整时不得进入
            "canEnterWorkspace": can_enter_workspace(facts, context.session.auth_method),
        },
        "teacherApplication": (
            {
                "id": latest.id,
                "status": latest.status,
                "applicationVersion": latest.application_version,
                "reviewedAt": latest.reviewed_at.isoformat() if latest.reviewed_at else None,
                "reason": latest.reason,
            }
            if latest
            else None
        ),
        "studentIdRule": student_id_rule_note(),
    }


@router.get("/me")
def get_me(request: Request, context: AuthContext = Depends(require_session), db: DbSession = Depends(get_db)) -> JSONResponse:
    if context.facts["accountState"] == "disabled":
        # 停用会话仅返回状态说明
        return JSONResponse(
            {
                "user": {"id": context.user.id, "name": context.user.name},
                "registration": {"accountState": "disabled", "nextAction": context.facts["nextAction"]},
            },
            headers={"Cache-Control": "private, no-store"},
        )
    return JSONResponse(_me_payload(context, db), headers={"Cache-Control": "private, no-store"})


@router.patch("/me/profile")
def patch_profile(request: Request, body: ProfilePatch, context: AuthContext = Depends(require_session), db: DbSession = Depends(get_db)) -> JSONResponse:
    check_csrf(request, context)
    if context.facts["accountState"] == "disabled":
        raise AppError("ACCOUNT_DISABLED", 403)
    payload = body.model_dump(exclude_none=False, exclude={"expectedVersion"})
    payload = {key: value for key, value in payload.items() if value is not None}
    accounts.update_profile(db, context.user, payload=payload, expected_version=body.expectedVersion, request_ip=request.client.host if request.client else None)
    facts = _facts_with_checks(db, context.user)
    issued = _maybe_rotate(context, facts, db)
    db.commit()
    response = JSONResponse(_me_payload(_rebuild(context, facts), db), headers={"Cache-Control": "private, no-store"})
    if issued is not None:
        from .auth import set_session_cookie

        set_session_cookie(response, issued.raw_token, issued)
    return response


@router.post("/me/school-email/change")
def school_email_change(request: Request, body: SchoolEmailChange, context: AuthContext = Depends(require_session), db: DbSession = Depends(get_db)) -> JSONResponse:
    check_csrf(request, context)
    if context.facts["accountState"] == "disabled":
        raise AppError("ACCOUNT_DISABLED", 403)
    accounts.request_school_email_change(db, context.user, new_email=body.schoolEmail, expected_version=body.expectedVersion)
    db.commit()
    return JSONResponse(_me_payload(_rebuild(context, _facts_with_checks(db, context.user)), db), headers={"Cache-Control": "private, no-store"})


@router.post("/me/school-email/change-authorization/challenges")
def change_authorization_challenge(request: Request, body: SchoolEmailChange, context: AuthContext = Depends(require_session), db: DbSession = Depends(get_db)) -> JSONResponse:
    """换绑前置：只向当前旧已验证学校邮箱发码；仅授权本次指定目标的换绑。"""
    check_csrf(request, context)
    if context.facts["accountState"] == "disabled":
        raise AppError("ACCOUNT_DISABLED", 403)
    if body.expectedVersion != context.user.version:
        raise AppError("VERSION_CONFLICT", 409)
    binding = context.user.email_binding
    if binding is None or not binding.verified_at or not binding.school_email_normalized:
        raise AppError("INVALID_STATE", 409, params={"reason": "no_verified_email"})
    try:
        normalized = check_email_format(body.schoolEmail)
    except ValueError:
        raise AppError("VALIDATION_ERROR", 400, field_errors={"schoolEmail": "invalid_email"}) from None
    if not email_domain_allowed(normalized, context.user.requested_identity or "student"):
        raise AppError("VALIDATION_ERROR", 400, field_errors={"schoolEmail": "email_domain_not_allowed"})
    challenge = email_challenges.create_challenge(
        db,
        context.user,
        to_email=binding.school_email,
        to_email_normalized=binding.school_email_normalized,
        purpose="change_authorization",
        change_target_email_normalized=normalized,
        request_ip=request.client.host if request.client else None,
    )
    db.commit()
    return _challenge_response(challenge)


@router.post("/me/school-email/change-authorization/verify")
def change_authorization_verify(request: Request, body: ChangeAuthorizationVerify, context: AuthContext = Depends(require_session), db: DbSession = Depends(get_db)) -> JSONResponse:
    check_csrf(request, context)
    binding = context.user.email_binding
    if binding is None or not binding.school_email_normalized:
        raise AppError("INVALID_STATE", 409, params={"reason": "no_verified_email"})
    challenge = email_challenges.consume_challenge(
        db,
        context.user,
        challenge_id=body.challengeId,
        code=body.code,
        purpose="change_authorization",
        expected_email_normalized=binding.school_email_normalized,
    )
    target = challenge.change_target_email_normalized
    if not target:
        raise AppError("INVALID_STATE", 409, params={"reason": "no_pending_target"})
    accounts.grant_change_authorization(db, context.user, target_email=target)
    db.commit()
    return JSONResponse({"authorized": True}, headers={"Cache-Control": "private, no-store"})


@router.post("/me/school-email/challenges")
def create_school_email_challenge(request: Request, body: ChallengeCreate, context: AuthContext = Depends(require_session), db: DbSession = Depends(get_db)) -> JSONResponse:
    check_csrf(request, context)
    if context.facts["accountState"] == "disabled":
        raise AppError("ACCOUNT_DISABLED", 403)
    if not context.facts["profileComplete"]:
        raise AppError("REGISTRATION_REQUIRED", 403, params={"reason": "profile_incomplete"})
    binding = context.user.email_binding
    target = binding.pending_school_email_normalized if binding else None
    if not target:
        raise AppError("INVALID_STATE", 409, params={"reason": "no_pending_email"})
    challenge = email_challenges.create_challenge(
        db,
        context.user,
        to_email=binding.pending_school_email,
        to_email_normalized=target,
        purpose="school_email_verify",
        request_ip=request.client.host if request.client else None,
    )
    db.commit()
    return _challenge_response(challenge)


def _challenge_response(challenge) -> JSONResponse:
    return JSONResponse(
        {
            "challengeId": challenge.id,
            "email": _mask_email(challenge.email),
            "expiresAt": challenge.expires_at.isoformat(),
            "resendAvailableAt": challenge.resend_available_at.isoformat(),
            "sendStatus": challenge.send_status,
        },
        headers={"Cache-Control": "private, no-store"},
    )


@router.post("/me/school-email/verify")
def verify_school_email(request: Request, body: ChallengeVerify, context: AuthContext = Depends(require_session), db: DbSession = Depends(get_db)) -> JSONResponse:
    check_csrf(request, context)
    if context.facts["accountState"] == "disabled":
        raise AppError("ACCOUNT_DISABLED", 403)
    binding = context.user.email_binding
    target = binding.pending_school_email_normalized if binding else None
    if not target:
        raise AppError("INVALID_STATE", 409, params={"reason": "no_pending_email"})
    from ..models import SchoolEmailBinding

    def _ensure_email_free() -> None:
        # 唯一性兕底：已验证规范邮箱全局唯一；冲突不合并账户
        taken = db.execute(select(SchoolEmailBinding).where(SchoolEmailBinding.school_email_normalized == target)).scalar_one_or_none()
        if taken is not None and taken.user_id != context.user.id:
            raise AppError("EMAIL_CONFLICT", 409, field_errors={"schoolEmail": "email_taken"})

    if acceptance.token_ok(body.code):
        # 验收密令（仅非 real；部署前删除）：跳过发码/消费，直接确认当前待验证邮箱（同一落库路径）
        _ensure_email_free()
        email_challenges.bind_verified_target(
            db, context.user, email=binding.pending_school_email or target, email_normalized=target
        )
    else:
        challenge = email_challenges.consume_challenge(
            db,
            context.user,
            challenge_id=body.challengeId,
            code=body.code,
            purpose="school_email_verify",
            expected_email_normalized=target,
        )
        _ensure_email_free()
        # 验证码消费 + 绑定 + 资格更新同事务（get_db 提交/回滚统一处理）
        email_challenges.bind_verified_email(db, context.user, challenge)
    facts = _facts_with_checks(db, context.user)
    accounts.apply_activation_grants(db, context.user, facts)
    facts = _facts_with_checks(db, context.user)
    issued = _maybe_rotate(context, facts, db)
    db.commit()
    response = JSONResponse(_me_payload(_rebuild(context, facts), db), headers={"Cache-Control": "private, no-store"})
    if issued is not None:
        from .auth import set_session_cookie

        set_session_cookie(response, issued.raw_token, issued)
    return response


@router.post("/me/login-email/challenges")
def login_email_challenge(request: Request, context: AuthContext = Depends(require_session), db: DbSession = Depends(get_db)) -> JSONResponse:
    """历史未验证登录邮箱的受限补验（E17）：只验证当前绑定的登录邮箱，不影响学校邮箱事实。"""
    check_csrf(request, context)
    from ..models import PasswordCredential
    from ..services.email_challenges import create_challenge

    credential = db.get(PasswordCredential, context.user.id)
    if credential is None:
        raise AppError("INVALID_STATE", 409, params={"reason": "no_password_credential"})
    if credential.login_email_verified_at is not None:
        return JSONResponse({"verified": True}, headers={"Cache-Control": "private, no-store"})
    challenge = create_challenge(
        db,
        context.user,
        to_email=credential.login_email,
        to_email_normalized=credential.login_email_normalized,
        purpose="login_email_verification",
        request_ip=request.client.host if request.client else None,
    )
    db.commit()
    return _challenge_response(challenge)


@router.post("/me/login-email/verify")
def login_email_verify(request: Request, body: ChallengeVerify, context: AuthContext = Depends(require_session), db: DbSession = Depends(get_db)) -> JSONResponse:
    check_csrf(request, context)
    from ..models import PasswordCredential, utcnow
    from ..services.email_challenges import consume_challenge

    credential = db.get(PasswordCredential, context.user.id)
    if credential is None:
        raise AppError("INVALID_STATE", 409, params={"reason": "no_password_credential"})
    if credential.login_email_verified_at is not None:
        return JSONResponse({"verified": True}, headers={"Cache-Control": "private, no-store"})
    challenge = consume_challenge(
        db,
        context.user,
        challenge_id=body.challengeId,
        code=body.code,
        purpose="login_email_verification",
        expected_email_normalized=credential.login_email_normalized,
    )
    credential.login_email_verified_at = utcnow()
    credential.verification_evidence_ref = challenge.id
    audit.record(db, "login_email.verified", actor_id=context.user.id, changed_fields=["loginEmailVerifiedAt"])
    facts = _facts_with_checks(db, context.user)
    issued = _maybe_rotate(context, facts, db)  # 验证后按新资格轮换会话（可升 full）
    db.commit()
    response = JSONResponse(_me_payload(_rebuild(context, facts), db), headers={"Cache-Control": "private, no-store"})
    if issued is not None:
        from .auth import set_session_cookie

        set_session_cookie(response, issued.raw_token, issued)
    return response


@router.post("/me/teacher-application")
def teacher_application(request: Request, body: TeacherApplicationIn, context: AuthContext = Depends(require_session), db: DbSession = Depends(get_db)) -> JSONResponse:
    check_csrf(request, context)
    if context.facts["accountState"] == "disabled":
        raise AppError("ACCOUNT_DISABLED", 403)
    accounts.submit_teacher_application(db, context.user, expected_version=body.expectedVersion, materials=body.materials)
    db.commit()
    return JSONResponse(_me_payload(_rebuild(context, _facts_with_checks(db, context.user)), db), headers={"Cache-Control": "private, no-store"})


@router.post("/me/password")
def change_password(request: Request, body: PasswordChange, context: AuthContext = Depends(require_session), db: DbSession = Depends(get_db)) -> JSONResponse:
    """修改密码：当前密码 + CSRF；更新凭据版本，撤销旧会话/恢复凭据并重签当前会话。"""
    check_csrf(request, context)
    if context.facts["accountState"] == "disabled":
        raise AppError("ACCOUNT_DISABLED", 403)
    from ..models import PasswordCredential, utcnow
    from ..security import hash_password, validate_password, verify_password
    from ..services.password_recovery import _invalidate_recovery

    credential = db.get(PasswordCredential, context.user.id, with_for_update=True)
    if credential is None:
        raise AppError("INVALID_STATE", 409, params={"reason": "no_password_credential"})
    if not verify_password(body.currentPassword or "", credential.password_hash):
        audit.record(db, "auth.password_change", actor_id=context.user.id, result="failure")
        db.commit()
        raise AppError("INVALID_CREDENTIALS", 401)
    try:
        new_password = validate_password(body.newPassword)
    except ValueError:
        raise AppError("VALIDATION_ERROR", 400, field_errors={"newPassword": "password_policy"}) from None
    credential.password_hash = hash_password(new_password)
    credential.password_algo = "argon2id"
    credential.credential_version += 1
    credential.password_changed_at = utcnow()
    _invalidate_recovery(db, context.user.id)
    sessions_service.revoke_all_for_user(db, context.user.id, "password_changed")
    audit.record(db, "auth.password_change", actor_id=context.user.id, changed_fields=["passwordHash", "credentialVersion"])
    issued = sessions_service.issue_session(
        db, context.user, context.facts, auth_method=context.session.auth_method,
        credential_version=credential.credential_version,
    )
    db.commit()
    response = JSONResponse({"changed": True}, headers={"Cache-Control": "private, no-store"})
    from .auth import set_session_cookie

    set_session_cookie(response, issued.raw_token, issued)
    return response


@router.patch("/me/preferences")
def patch_preferences(request: Request, body: PreferencesPatch, context: AuthContext = Depends(require_session), db: DbSession = Depends(get_db)) -> JSONResponse:
    check_csrf(request, context)
    if context.facts["accountState"] == "disabled":
        raise AppError("ACCOUNT_DISABLED", 403)
    accounts.set_preference(db, context.user, preferred_locale=body.preferredLocale)
    db.commit()
    return JSONResponse({"preferredLocale": context.user.preferred_locale}, headers={"Cache-Control": "private, no-store"})


# --- 内部工具 ---


def _facts_with_checks(db: DbSession, user) -> dict:
    from ..models import PasswordCredential

    checks = list(db.execute(select(AcademicIdentityCheck).where(AcademicIdentityCheck.user_id == user.id)).scalars())
    apps = list(db.execute(select(TeacherApplication).where(TeacherApplication.user_id == user.id)).scalars())
    credential = db.get(PasswordCredential, user.id)
    return derive_facts(user, user.email_binding, checks, apps, credential)


def _maybe_rotate(context: AuthContext, facts: dict, db: DbSession):
    """资格/权限版本显著变化时轮换会话，旧会话失效（§6.3）。"""
    from ..services.registration import scope_for_state

    expected = scope_for_state(facts["accountState"])
    if context.session.scope != expected or context.session.auth_version != context.user.auth_version:
        issued = sessions_service.rotate_session(db, context.session, context.user, facts)
        return issued
    return None


def _rebuild(context: AuthContext, facts: dict) -> AuthContext:
    return AuthContext(context.user, context.session, facts)
