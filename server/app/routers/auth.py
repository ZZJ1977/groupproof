"""认证、会话与 Google OIDC 回调（§7.6 接口表）。"""
from __future__ import annotations

import hmac

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session as DbSession

from ..config import get_settings
from ..db import get_db
from ..errors import AppError
from ..guard import AuthContext, read_session, require_session, check_csrf
from fastapi.responses import JSONResponse
from ..models import AuthIdentity, PasswordCredential, SchoolEmailBinding, User, utcnow
from ..security import (
    check_email_format,
    hash_password,
    needs_rehash,
    new_token,
    normalize_login_identifier,
    normalize_username,
    safe_return_to,
    validate_password,
    validate_username,
    verify_password,
)
from ..services import acceptance, audit, google_oidc, pre_registration, sessions as sessions_service
from ..services import password_recovery as recovery
from ..services.rate_limit import RateLimitExceeded, check_and_increment
from ..services.registration import can_enter_workspace, derive_facts

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


def _facts_with_checks(db: DbSession, user: User) -> dict:
    from ..models import AcademicIdentityCheck, PasswordCredential, TeacherApplication

    checks = list(db.execute(select(AcademicIdentityCheck).where(AcademicIdentityCheck.user_id == user.id)).scalars())
    applications = list(db.execute(select(TeacherApplication).where(TeacherApplication.user_id == user.id)).scalars())
    credential = db.get(PasswordCredential, user.id)
    return derive_facts(user, user.email_binding, checks, applications, credential)


def session_payload(context: AuthContext) -> dict:
    user = context.user
    facts = context.facts
    next_action = dict(facts["nextAction"])
    # 未验证登录邮箱的密码/未知来源会话：引导补验，不得借 active 状态进入业务
    if context.session.auth_method != "google" and not facts.get("loginEmailVerified", True):
        next_action = {"type": "verify_login_email", "href": "/account/security"}
    return {
        "authenticated": True,
        "sessionScope": context.session.scope,
        "authMethod": context.session.auth_method,
        "user": {"id": user.id, "name": user.name, "preferredLocale": user.preferred_locale or "zh-Hans"},
        "accountState": facts["accountState"],
        "loginEmailVerified": facts.get("loginEmailVerified", True),
        "identityConfirmed": facts["identityConfirmed"],
        "securityComplete": facts["securityComplete"],
        "requiredCompletedCount": facts["requiredCompletedCount"],
        "canEnterWorkspace": can_enter_workspace(facts, context.session.auth_method),
        "nextAction": next_action,
        "csrfToken": context.session.csrf_token,
    }


def set_session_cookie(response: Response, raw_token: str, issued: sessions_service.IssuedSession) -> None:
    settings = get_settings()
    max_age = int((issued.record.absolute_expires_at - utcnow()).total_seconds())
    response.set_cookie(
        settings.session_cookie_name,
        raw_token,
        max_age=max(max_age, 0),
        httponly=True,
        secure=settings.is_real,
        samesite="lax",
        path="/",
    )


@router.get("/google/start")
def google_start(request: Request, returnTo: str | None = None, db: DbSession = Depends(get_db)) -> RedirectResponse:
    settings = get_settings()
    if not settings.google_available:
        raise AppError("AUTH_UNAVAILABLE", 503, params={"service": "google_oauth"})
    state, transaction = google_oidc.create_transaction(db, safe_return_to(returnTo))
    db.commit()
    url = google_oidc.build_authorize_url(state, transaction.nonce, transaction.code_verifier)
    response = RedirectResponse(url, status_code=302)
    response.set_cookie(
        settings.oauth_cookie_name, state, max_age=settings.oauth_transaction_ttl,
        httponly=True, secure=settings.is_real, samesite="lax", path="/",
    )
    response.headers["Cache-Control"] = "private, no-store"
    return response


@router.get("/google/callback")
def google_callback(request: Request, code: str | None = None, state: str | None = None, db: DbSession = Depends(get_db)) -> RedirectResponse:
    settings = get_settings()
    browser_state = request.cookies.get(settings.oauth_cookie_name)
    if not state or not browser_state or not hmac.compare_digest(state, browser_state):
        raise AppError("UNAUTHENTICATED", 401, params={"reason": "oauth_browser_binding"})
    transaction = google_oidc.consume_transaction(db, state)
    if not code:
        audit.record(db, "auth.google.cancelled", result="failure")
        db.commit()
        response = _error_redirect("cancelled")
        response.delete_cookie(settings.oauth_cookie_name, path="/", secure=settings.is_real, httponly=True, samesite="lax")
        return response
    try:
        identity = google_oidc.exchange_and_verify(transaction, code)
    except AppError:
        raise
    except Exception as exc:  # noqa: BLE001 - 服务故障不回退 Mock，返回可重试的服务不可用
        raise AppError("SERVICE_UNAVAILABLE", 503, params={"service": "google_oauth"}) from exc

    # provider/issuer/sub 查绑定；找不到则事务创建待注册 User + AuthIdentity（唯一约束保证并发只建一个）
    identity_row = db.execute(
        select(AuthIdentity).where(
            AuthIdentity.provider == "google",
            AuthIdentity.issuer == identity.issuer,
            AuthIdentity.subject == identity.subject,
        )
    ).scalar_one_or_none()
    user: User | None = identity_row.user if identity_row else None
    if user is None:
        user = User(
            id=new_token()[:32],
            name=(identity.name or None) and identity.name.strip()[:80],
            account_status="enabled",
        )
        identity_row = AuthIdentity(
            id=new_token()[:32],
            provider="google",
            issuer=identity.issuer,
            subject=identity.subject,
            user_id=user.id,
            google_email=identity.email,
            last_authenticated_at=utcnow(),
        )
        user.identities = [identity_row]
        try:
            # 并发首次登录：唯一约束保证单条用户/身份记录，失败仅回滚本次插入
            with db.begin_nested():
                db.add(user)
                db.flush()
        except IntegrityError:
            identity_row = db.execute(
                select(AuthIdentity).where(
                    AuthIdentity.provider == "google",
                    AuthIdentity.issuer == identity.issuer,
                    AuthIdentity.subject == identity.subject,
                )
            ).scalar_one_or_none()
            if identity_row is None:
                raise AppError("AUTH_UNAVAILABLE", 503, params={"service": "database"})
            user = identity_row.user
        else:
            audit.record(db, "auth.registered", actor_id=user.id, changed_fields=["users", "auth_identities"])
    else:
        identity_row.last_authenticated_at = utcnow()
        identity_row.google_email = identity.email or identity_row.google_email

    user.last_login_at = utcnow()
    facts = _facts_with_checks(db, user)
    # 会话轮换：任何新认证都签发新会话；停用用户最多取得 status_only
    issued = sessions_service.issue_session(db, user, facts, auth_method="google")
    audit.record(db, "auth.login", actor_id=user.id, changed_fields=["session"])
    db.commit()

    target = safe_return_to(transaction.return_to) or facts["nextAction"]["href"]
    response = RedirectResponse(target, status_code=302)
    response.delete_cookie(settings.oauth_cookie_name, path="/", secure=settings.is_real, httponly=True, samesite="lax")
    response.headers["Cache-Control"] = "private, no-store"
    set_session_cookie(response, issued.raw_token, issued)
    return response


def _origin_allowed(request: Request) -> bool:
    """匿名 POST（注册/登录）的 Origin 校验：存在 Origin 时必须与站点源一致。"""
    from ..config import get_settings

    origin = request.headers.get("origin")
    return origin is None or origin == get_settings().app_origin


class PasswordRegisterIn(BaseModel):
    username: str
    email: str
    password: str


class PasswordLoginIn(BaseModel):
    identifier: str
    password: str


class EmailRegistrationIn(BaseModel):
    email: str
    locale: str | None = None


class EmailRegistrationVerifyIn(BaseModel):
    code: str


class EmailRegistrationCompleteIn(BaseModel):
    username: str
    password: str


class PasswordForgotIn(BaseModel):
    email: str
    locale: str | None = None


class PasswordResetIn(BaseModel):
    token: str
    newPassword: str


# 假哈希（未知账户时做等价校验，减少明显时序差异，E13）
_DUMMY_HASH = hash_password("timing-equalization-dummy-password")


@router.post("/password/register")
def password_register(request: Request, body: PasswordRegisterIn, db: DbSession = Depends(get_db)) -> JSONResponse:
    """旧无验证建档路径已关闭（E07）：必须先完成登录邮箱归属验证（三步注册）才能创建账户。"""
    if not _origin_allowed(request):
        raise AppError("FORBIDDEN", 403, params={"reason": "origin"})
    audit.record(db, "auth.password_register.closed_path", result="failure")
    raise AppError("REGISTRATION_CLOSED", 410, params={"reason": "email_verification_required", "use": "/api/v1/auth/email/registrations"})


@router.post("/password/login")
def password_login(request: Request, body: PasswordLoginIn, db: DbSession = Depends(get_db)) -> JSONResponse:
    """账号密码登录：用户名或登录邮箱 + 密码；失败一律返回通用错误，不泄露账户是否存在。"""
    if not _origin_allowed(request):
        raise AppError("FORBIDDEN", 403, params={"reason": "origin"})
    ip = request.client.host if request.client else None
    now = utcnow()
    try:
        kind, normalized = normalize_login_identifier(body.identifier)
    except ValueError:
        kind, normalized = "username", (body.identifier or "").strip().lower()
    # 服务端限流（跨进程）：按标识与 IP 限制暴力猜测
    for key, limit in ((f"login:id:{normalized}", 5), (f"login:ip:{ip or 'unknown'}", 20)):
        try:
            check_and_increment(db, key, limit=limit, window_seconds=900, now=now)
        except RateLimitExceeded as exc:
            audit.record(db, "auth.password_login.rate_limited", result="failure")
            raise AppError("RATE_LIMITED", 429, retry_after_seconds=exc.retry_after_seconds) from exc

    credential = None
    user = None
    if kind == "email":
        credential = db.execute(select(PasswordCredential).where(PasswordCredential.login_email_normalized == normalized)).scalar_one_or_none()
        user = credential.user if credential else None
    else:
        user = db.execute(select(User).where(User.username_normalized == normalized)).scalar_one_or_none()
        credential = db.get(PasswordCredential, user.id) if user else None

    if user is None or credential is None:
        verify_password(body.password or "", _DUMMY_HASH)  # 未知账户等价校验
        audit.record(db, "auth.password_login", result="failure")
        db.commit()
        raise AppError("INVALID_CREDENTIALS", 401)
    if not verify_password(body.password or "", credential.password_hash):
        audit.record(db, "auth.password_login", result="failure")
        db.commit()
        raise AppError("INVALID_CREDENTIALS", 401)

    # 历史 bcrypt 凭据成功验证后升级为 Argon2id（不丢账户、不静默截断）
    if needs_rehash(credential.password_hash):
        credential.password_hash = hash_password(body.password)
        credential.password_algo = "argon2id"

    user.last_login_at = utcnow()
    facts = _facts_with_checks(db, user)
    issued = sessions_service.issue_session(
        db, user, facts, auth_method="password", credential_version=credential.credential_version
    )
    audit.record(db, "auth.password_login", actor_id=user.id, changed_fields=["session"])
    db.commit()
    response = JSONResponse(session_payload(AuthContext(user, issued.record, facts)), headers={"Cache-Control": "private, no-store"})
    set_session_cookie(response, issued.raw_token, issued)
    return response


# ---------- 独立邮箱注册（E02–E10）：邮箱归属验证 → 限时一次性建档 ----------


def _set_reg_cookie(response: Response, token: str) -> None:
    from ..config import get_settings

    settings = get_settings()
    response.set_cookie(
        settings.pre_registration_cookie_name,
        token,
        max_age=3600,
        httponly=True,
        secure=settings.is_real,
        samesite="lax",
        path="/",
    )


def _reg_browser_token(request: Request, response: Response | None = None) -> tuple[str, bool]:
    """浏览器事务绑定（HttpOnly 短期 Cookie）；无则生成并随响应下发。"""
    from ..config import get_settings

    settings = get_settings()
    token = request.cookies.get(settings.pre_registration_cookie_name)
    if token:
        return token, False
    token = new_token()
    return token, True


def _tx_payload(tx) -> dict:
    return {
        "id": tx.id,
        "email": _mask(tx.email),
        "status": tx.send_status,
        "expiresAt": tx.expires_at.isoformat(),
        "resendAvailableAt": (tx.resend_available_at.isoformat() if tx.resend_available_at else None),
    }


def _mask(email: str) -> str:
    local, _, domain = email.partition("@")
    return (local[:2] + "***" if len(local) > 2 else "***") + "@" + domain


@router.post("/email/registrations")
def create_email_registration(request: Request, body: EmailRegistrationIn, db: DbSession = Depends(get_db)) -> JSONResponse:
    from ..errors import error_payload

    if not _origin_allowed(request):
        raise AppError("FORBIDDEN", 403, params={"reason": "origin"})
    # 验收密令（仅非 real；部署前删除）：直接开通全新测试账户并返回会话，前端直达信息完善页
    if acceptance.token_ok(body.email):
        user, issued = acceptance.create_test_account(db)
        db.commit()
        payload = session_payload(AuthContext(user, issued.record, issued.facts))
        payload["testEntry"] = True
        payload["username"] = user.username  # 验收提示用（退出重登的登录名）
        response = JSONResponse(payload, headers={"Cache-Control": "private, no-store"})
        set_session_cookie(response, issued.raw_token, issued)
        return response
    token, is_new = _reg_browser_token(request, None)
    try:
        tx = pre_registration.create_registration(
            db, email=body.email, locale=body.locale, browser_token=token, request_ip=request.client.host if request.client else None
        )
    except AppError as exc:
        # 失败响应也携带浏览器绑定 Cookie，用户可直接重发（不丢失事务上下文）
        err_response = JSONResponse(error_payload(exc, request), status_code=exc.status, headers={"Cache-Control": "private, no-store"})
        if is_new:
            _set_reg_cookie(err_response, token)
        return err_response
    audit.record(db, "pre_registration.created", changed_fields=["email"])
    db.commit()
    response = JSONResponse(_tx_payload(tx), headers={"Cache-Control": "private, no-store"})
    if is_new:
        _set_reg_cookie(response, token)
    return response


@router.post("/email/registrations/{tx_id}/resend")
def resend_email_registration(tx_id: str, request: Request, body: EmailRegistrationIn, db: DbSession = Depends(get_db)) -> JSONResponse:
    if not _origin_allowed(request):
        raise AppError("FORBIDDEN", 403, params={"reason": "origin"})
    token, _is_new = _reg_browser_token(request, None)
    tx = pre_registration.resend_code(db, tx_id, browser_token=token, locale=body.locale, request_ip=request.client.host if request.client else None)
    db.commit()
    return JSONResponse(_tx_payload(tx), headers={"Cache-Control": "private, no-store"})


@router.post("/email/registrations/{tx_id}/verify")
def verify_email_registration(tx_id: str, request: Request, body: EmailRegistrationVerifyIn, db: DbSession = Depends(get_db)) -> JSONResponse:
    if not _origin_allowed(request):
        raise AppError("FORBIDDEN", 403, params={"reason": "origin"})
    token, _is_new = _reg_browser_token(request, None)
    tx = pre_registration.verify_code(db, tx_id, code=body.code, browser_token=token)
    db.commit()
    return JSONResponse(
        {"verified": True, "email": _mask(tx.email), "creationGrantExpiresAt": tx.creation_grant_expires_at.isoformat()},
        headers={"Cache-Control": "private, no-store"},
    )


@router.post("/email/registrations/{tx_id}/complete")
def complete_email_registration(tx_id: str, request: Request, body: EmailRegistrationCompleteIn, db: DbSession = Depends(get_db)) -> JSONResponse:
    if not _origin_allowed(request):
        raise AppError("FORBIDDEN", 403, params={"reason": "origin"})
    token, _is_new = _reg_browser_token(request, None)
    user, created = pre_registration.complete_registration(
        db, tx_id, username=body.username, password=body.password, browser_token=token
    )
    if not created:
        # E10：同一事务重复提交 → “已完成，请登录”安全结果，不重复创建
        db.commit()
        return JSONResponse(
            {"status": "already_completed"}, status_code=200, headers={"Cache-Control": "private, no-store"}
        )
    user.last_login_at = utcnow()
    facts = _facts_with_checks(db, user)
    issued = pre_registration.issue_onboarding_session(db, user, facts)
    db.commit()
    response = JSONResponse(
        session_payload(AuthContext(user, issued.record, facts)), status_code=201, headers={"Cache-Control": "private, no-store"}
    )
    set_session_cookie(response, issued.raw_token, issued)
    return response


# ---------- 密码找回/重置（E13–E15） ----------


@router.post("/password/forgot")
def password_forgot(request: Request, body: PasswordForgotIn, db: DbSession = Depends(get_db)) -> JSONResponse:
    if not _origin_allowed(request):
        raise AppError("FORBIDDEN", 403, params={"reason": "origin"})
    recovery.request_reset(db, email=body.email, locale=body.locale, request_ip=request.client.host if request.client else None)
    return JSONResponse(
        {"status": "sent"},  # 与账户是否存在无关的统一安全反馈
        headers={"Cache-Control": "private, no-store"},
    )


@router.post("/password/reset")
def password_reset(request: Request, body: PasswordResetIn, db: DbSession = Depends(get_db)) -> JSONResponse:
    if not _origin_allowed(request):
        raise AppError("FORBIDDEN", 403, params={"reason": "origin"})
    recovery.consume_and_reset(db, token=body.token, new_password=body.newPassword)
    db.commit()
    return JSONResponse({"status": "reset"}, headers={"Cache-Control": "private, no-store"})


def _error_redirect(reason: str) -> RedirectResponse:
    response = RedirectResponse(f"/login?error={reason}", status_code=302)
    response.headers["Cache-Control"] = "private, no-store"
    return response


@router.get("/session")
def get_session(request: Request, db: DbSession = Depends(get_db)) -> dict:
    context = read_session(request, db)
    if context is None:
        return {"authenticated": False}
    return session_payload(context)


@router.post("/session/refresh")
def refresh_session(request: Request, db: DbSession = Depends(get_db)) -> JSONResponse:
    context = require_session(request, db)
    check_csrf(request, context)
    issued, facts = sessions_service.refresh_session(db, context.session, context.user)
    audit.record(db, "auth.session_refresh", actor_id=context.user.id)
    db.commit()
    response = JSONResponse(
        session_payload(AuthContext(context.user, issued.record, facts)),
        headers={"Cache-Control": "private, no-store"},
    )
    if issued.raw_token:
        # 会话轮换（受限转 full / 权限版本变化）：必须把新 Cookie 写回浏览器，旧 Cookie/旧 CSRF 均已失效
        set_session_cookie(response, issued.raw_token, issued)
    return response


@router.post("/logout")
def logout(request: Request, db: DbSession = Depends(get_db)) -> Response:
    settings = get_settings()
    context = read_session(request, db)
    response = Response(status_code=204)
    response.headers["Cache-Control"] = "private, no-store"
    if context is not None:
        check_csrf(request, context)  # 有会话时校验 CSRF；无会话安全幂等返回 204
        sessions_service.revoke_session(db, context.session, "logout")
        audit.record(db, "auth.logout", actor_id=context.user.id)
        db.commit()
    response.delete_cookie(settings.session_cookie_name, path="/")
    return response
