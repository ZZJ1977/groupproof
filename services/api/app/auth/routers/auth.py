"""认证、会话与 Google OIDC 回调（§7.6 接口表）。"""

from __future__ import annotations

import hmac
from uuid import uuid4

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session as DbSession

from ..config import Settings, get_settings
from ..db import get_db
from ..envelope import EnvelopeRoute, JSONResponse
from ..errors import AppError
from ..guard import AuthContext, check_csrf, read_session, require_session
from ..models import (
    AuthIdentity,
    OAuthTransaction,
    PasswordCredential,
    SchoolEmailBinding,
    User,
    utcnow,
)
from ..security import (
    hash_password,
    needs_rehash,
    new_token,
    normalize_email,
    normalize_login_identifier,
    safe_return_to,
    verify_password,
)
from ..services import (
    acceptance,
    audit,
    google_oidc,
    pre_registration,
)
from ..services import password_recovery as recovery
from ..services import (
    sessions as sessions_service,
)
from ..services.rate_limit import RateLimitExceeded, check_and_increment
from ..services.registration import can_enter_workspace, derive_facts

router = APIRouter(prefix="/api/v1/auth", tags=["auth"], route_class=EnvelopeRoute)


def _facts_with_checks(db: DbSession, user: User) -> dict:
    from ..models import AcademicIdentityCheck, PasswordCredential, TeacherApplication

    checks = list(
        db.execute(
            select(AcademicIdentityCheck).where(AcademicIdentityCheck.user_id == user.id)
        ).scalars()
    )
    applications = list(
        db.execute(
            select(TeacherApplication).where(TeacherApplication.user_id == user.id)
        ).scalars()
    )
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
        "user": {
            "id": user.id,
            "name": user.name,
            "preferredLocale": user.preferred_locale or "zh-Hans",
        },
        "accountState": facts["accountState"],
        "loginEmailVerified": facts.get("loginEmailVerified", True),
        "identityConfirmed": facts["identityConfirmed"],
        "securityComplete": facts["securityComplete"],
        "requiredCompletedCount": facts["requiredCompletedCount"],
        "canEnterWorkspace": can_enter_workspace(facts, context.session.auth_method),
        "nextAction": next_action,
        "csrfToken": context.session.csrf_token,
    }


def set_session_cookie(
    response: Response, raw_token: str, issued: sessions_service.IssuedSession
) -> None:
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
def google_start(
    request: Request, returnTo: str | None = None, db: DbSession = Depends(get_db)
) -> RedirectResponse:
    settings = get_settings()
    # 入口可见（google_available）与实际可用（google_configured）分开：
    # 未配置凭据时点按钮不发起外部请求，整页跳转场景下统一回登录页提示服务暂不可用
    if not settings.google_available or not settings.google_configured:
        return _google_failure(db, settings, "unavailable", reason="not_configured")
    state, transaction = google_oidc.create_transaction(db, safe_return_to(returnTo))
    try:
        url = google_oidc.build_authorize_url(state, transaction.nonce, transaction.code_verifier)
    except Exception:  # noqa: BLE001 - discovery/provider failures return to login as unavailable
        db.rollback()
        return _google_failure(db, settings, "unavailable", reason="provider_unavailable")
    db.commit()
    response = RedirectResponse(url, status_code=302)
    response.set_cookie(
        settings.oauth_cookie_name,
        state,
        max_age=settings.oauth_transaction_ttl,
        httponly=True,
        secure=settings.is_real,
        samesite="lax",
        path="/",
    )
    response.headers["Cache-Control"] = "private, no-store"
    return response


@router.get("/google/callback")
def google_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    db: DbSession = Depends(get_db),
) -> RedirectResponse:
    settings = get_settings()
    # Google 侧回调错误：用户拒绝授权按“取消”处理，其余按登录失败处理
    if error == "access_denied":
        return _google_failure(db, settings, "cancelled", reason="access_denied")
    if error:
        return _google_failure(db, settings, "failed", reason="provider_error")
    browser_state = request.cookies.get(settings.oauth_cookie_name)
    if not state or not browser_state or not hmac.compare_digest(state, browser_state):
        return _google_failure(db, settings, "failed", reason="oauth_browser_binding")
    try:
        transaction = google_oidc.consume_transaction(db, state)
    except AppError:
        return _google_failure(db, settings, "failed", reason="state_invalid")
    except Exception:  # noqa: BLE001 - 数据库不可用统一回登录页提示稍后重试
        return _google_failure(db, settings, "unavailable", reason="database_unavailable")
    if not code:
        return _google_failure(db, settings, "cancelled", reason="code_missing")
    try:
        identity = google_oidc.exchange_and_verify(transaction, code)
    except AppError as exc:
        # 401 类（state/nonce/签名/audience）→ 登录失败；503 类（Google/数据库）→ 稍后重试
        if exc.status == 401:
            return _google_failure(
                db, settings, "failed", reason=str(exc.params.get("reason") or "verify_failed")
            )
        return _google_failure(db, settings, "unavailable", reason="service_unavailable")
    except Exception:  # noqa: BLE001 - 服务故障不回退 Mock，统一提示稍后重试
        return _google_failure(db, settings, "unavailable", reason="service_unavailable")

    # 关联事务：只建绑定行，不建用户、不轮换会话
    if transaction.purpose == "link":
        return _complete_google_link(db, settings, request, transaction, identity)

    # provider/issuer/sub 查绑定；找不到则事务创建待注册 User + AuthIdentity
    # （唯一约束保证并发只建一个）
    identity_row = db.execute(
        select(AuthIdentity).where(
            AuthIdentity.provider == "google",
            AuthIdentity.issuer == identity.issuer,
            AuthIdentity.subject == identity.subject,
        )
    ).scalar_one_or_none()
    user: User | None = identity_row.user if identity_row else None
    if user is None:
        # 已验证邮箱冲突：不自动建号，提示先用密码登录再在账户安全中关联（防邮箱被占时接管账号）
        if identity.email_verified and identity.email:
            try:
                email_normalized = normalize_email(identity.email)
            except ValueError:
                email_normalized = ""
            if email_normalized and _verified_account_conflict(db, email_normalized):
                return _google_failure(
                    db,
                    settings,
                    "account_exists",
                    reason="verified_email_conflict",
                    event="auth.google.account_exists",
                )
        # users.email 仅为业务展示/检索镜像（全局唯一约束），身份事实保存在 auth_identities；
        # 镜像被其他账号占用（含未验证邮箱）时放弃镜像，照常建号，不合并账户
        mirror_email = identity.email
        if mirror_email:
            taken = db.execute(
                select(User.id).where(User.email == mirror_email)
            ).scalar_one_or_none()
            if taken is not None:
                mirror_email = None
        user = User(
            id=uuid4(),
            name=(identity.name or None) and identity.name.strip()[:80],
            email=mirror_email,
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
            audit.record(
                db, "auth.registered", actor_id=user.id, changed_fields=["users", "auth_identities"]
            )
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
    response.delete_cookie(
        settings.oauth_cookie_name, path="/", secure=settings.is_real, httponly=True, samesite="lax"
    )
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
def password_register(
    request: Request, body: PasswordRegisterIn, db: DbSession = Depends(get_db)
) -> JSONResponse:
    """旧无验证建档路径已关闭（E07）：必须先完成登录邮箱归属验证（三步注册）才能创建账户。"""
    if not _origin_allowed(request):
        raise AppError("FORBIDDEN", 403, params={"reason": "origin"})
    audit.record(db, "auth.password_register.closed_path", result="failure")
    raise AppError(
        "REGISTRATION_CLOSED",
        410,
        params={"reason": "email_verification_required", "use": "/api/v1/auth/email/registrations"},
    )


@router.post("/password/login")
def password_login(
    request: Request, body: PasswordLoginIn, db: DbSession = Depends(get_db)
) -> JSONResponse:
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
            raise AppError(
                "RATE_LIMITED", 429, retry_after_seconds=exc.retry_after_seconds
            ) from exc

    credential = None
    user = None
    if kind == "email":
        credential = db.execute(
            select(PasswordCredential).where(
                PasswordCredential.login_email_normalized == normalized
            )
        ).scalar_one_or_none()
        user = credential.user if credential else None
    else:
        user = db.execute(
            select(User).where(User.username_normalized == normalized)
        ).scalar_one_or_none()
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
    response = JSONResponse(
        session_payload(AuthContext(user, issued.record, facts)),
        headers={"Cache-Control": "private, no-store"},
    )
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
        "resendAvailableAt": (
            tx.resend_available_at.isoformat() if tx.resend_available_at else None
        ),
    }


def _mask(email: str) -> str:
    local, _, domain = email.partition("@")
    return (local[:2] + "***" if len(local) > 2 else "***") + "@" + domain


@router.post("/email/registrations")
def create_email_registration(
    request: Request, body: EmailRegistrationIn, db: DbSession = Depends(get_db)
) -> JSONResponse:
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
            db,
            email=body.email,
            locale=body.locale,
            browser_token=token,
            request_ip=request.client.host if request.client else None,
        )
    except AppError as exc:
        # 失败响应也携带浏览器绑定 Cookie，用户可直接重发（不丢失事务上下文）
        err_response = JSONResponse(
            error_payload(exc, request),
            status_code=exc.status,
            headers={"Cache-Control": "private, no-store"},
        )
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
def resend_email_registration(
    tx_id: str, request: Request, body: EmailRegistrationIn, db: DbSession = Depends(get_db)
) -> JSONResponse:
    if not _origin_allowed(request):
        raise AppError("FORBIDDEN", 403, params={"reason": "origin"})
    token, _is_new = _reg_browser_token(request, None)
    tx = pre_registration.resend_code(
        db,
        tx_id,
        browser_token=token,
        locale=body.locale,
        request_ip=request.client.host if request.client else None,
    )
    db.commit()
    return JSONResponse(_tx_payload(tx), headers={"Cache-Control": "private, no-store"})


@router.post("/email/registrations/{tx_id}/verify")
def verify_email_registration(
    tx_id: str, request: Request, body: EmailRegistrationVerifyIn, db: DbSession = Depends(get_db)
) -> JSONResponse:
    if not _origin_allowed(request):
        raise AppError("FORBIDDEN", 403, params={"reason": "origin"})
    token, _is_new = _reg_browser_token(request, None)
    tx = pre_registration.verify_code(db, tx_id, code=body.code, browser_token=token)
    db.commit()
    return JSONResponse(
        {
            "verified": True,
            "email": _mask(tx.email),
            "creationGrantExpiresAt": tx.creation_grant_expires_at.isoformat(),
        },
        headers={"Cache-Control": "private, no-store"},
    )


@router.post("/email/registrations/{tx_id}/complete")
def complete_email_registration(
    tx_id: str, request: Request, body: EmailRegistrationCompleteIn, db: DbSession = Depends(get_db)
) -> JSONResponse:
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
            {"status": "already_completed"},
            status_code=200,
            headers={"Cache-Control": "private, no-store"},
        )
    user.last_login_at = utcnow()
    facts = _facts_with_checks(db, user)
    issued = pre_registration.issue_onboarding_session(db, user, facts)
    db.commit()
    response = JSONResponse(
        session_payload(AuthContext(user, issued.record, facts)),
        status_code=201,
        headers={"Cache-Control": "private, no-store"},
    )
    set_session_cookie(response, issued.raw_token, issued)
    return response


# ---------- 密码找回/重置（E13–E15） ----------


@router.post("/password/forgot")
def password_forgot(
    request: Request, body: PasswordForgotIn, db: DbSession = Depends(get_db)
) -> JSONResponse:
    if not _origin_allowed(request):
        raise AppError("FORBIDDEN", 403, params={"reason": "origin"})
    recovery.request_reset(
        db,
        email=body.email,
        locale=body.locale,
        request_ip=request.client.host if request.client else None,
    )
    return JSONResponse(
        {"status": "sent"},  # 与账户是否存在无关的统一安全反馈
        headers={"Cache-Control": "private, no-store"},
    )


@router.post("/password/reset")
def password_reset(
    request: Request, body: PasswordResetIn, db: DbSession = Depends(get_db)
) -> JSONResponse:
    if not _origin_allowed(request):
        raise AppError("FORBIDDEN", 403, params={"reason": "origin"})
    recovery.consume_and_reset(db, token=body.token, new_password=body.newPassword)
    db.commit()
    return JSONResponse({"status": "reset"}, headers={"Cache-Control": "private, no-store"})


def _error_redirect(reason: str) -> RedirectResponse:
    response = RedirectResponse(f"/login?error={reason}", status_code=302)
    response.headers["Cache-Control"] = "private, no-store"
    return response


def _google_failure(
    db: DbSession,
    settings: Settings,
    error_param: str,
    *,
    reason: str,
    event: str = "auth.google.failed",
    redirect_to: str | None = None,
) -> RedirectResponse:
    """Google 登录失败统一出口：审计原因（不含 token）、清除 state Cookie、跳回登录页。"""
    try:
        audit.record(db, event, result="failure", changed_fields=[f"reason:{reason}"])
        db.commit()
    except Exception:  # noqa: BLE001 - 数据库不可用时也要把浏览器送回登录页
        db.rollback()
    response = (
        _error_redirect(error_param) if redirect_to is None else RedirectResponse(redirect_to, 302)
    )
    response.delete_cookie(
        settings.oauth_cookie_name,
        path="/",
        secure=settings.is_real,
        httponly=True,
        samesite="lax",
    )
    return response


def _verified_account_conflict(db: DbSession, email_normalized: str) -> bool:
    """已验证登录邮箱或已验证学校邮箱占用检测；未验证邮箱不算冲突。"""
    login_hit = db.execute(
        select(PasswordCredential.user_id).where(
            PasswordCredential.login_email_normalized == email_normalized,
            PasswordCredential.login_email_verified_at.is_not(None),
        )
    ).scalar_one_or_none()
    if login_hit is not None:
        return True
    school_hit = db.execute(
        select(SchoolEmailBinding.user_id).where(
            SchoolEmailBinding.school_email_normalized == email_normalized,
            SchoolEmailBinding.verified_at.is_not(None),
        )
    ).scalar_one_or_none()
    return school_hit is not None


def _complete_google_link(
    db: DbSession,
    settings: Settings,
    request: Request,
    transaction: OAuthTransaction,
    identity: google_oidc.GoogleIdentity,
) -> RedirectResponse:
    """purpose=link 的回调：绑定到发起事务的用户，不建用户、不轮换会话。"""
    context = read_session(request, db)
    if context is None or transaction.user_id is None or context.user.id != transaction.user_id:
        return _google_failure(
            db,
            settings,
            "failed",
            reason="link_session_mismatch",
            redirect_to="/account/security?error=failed",
        )
    identity_row = db.execute(
        select(AuthIdentity).where(
            AuthIdentity.provider == "google",
            AuthIdentity.issuer == identity.issuer,
            AuthIdentity.subject == identity.subject,
        )
    ).scalar_one_or_none()
    if identity_row is not None and identity_row.user_id != context.user.id:
        # 该 Google 身份已绑定其他账号：不合并、不泄露对方资料
        return _google_failure(
            db,
            settings,
            "identity_linked_elsewhere",
            reason="identity_linked_elsewhere",
            redirect_to="/account/security?error=identity_linked_elsewhere",
        )
    if identity_row is None:
        db.add(
            AuthIdentity(
                id=new_token()[:32],
                provider="google",
                issuer=identity.issuer,
                subject=identity.subject,
                user_id=context.user.id,
                google_email=identity.email,
                last_authenticated_at=utcnow(),
            )
        )
    audit.record(
        db, "auth.google.linked", actor_id=context.user.id, changed_fields=["auth_identities"]
    )
    db.commit()
    response = RedirectResponse("/account/security?linked=google", status_code=302)
    response.delete_cookie(
        settings.oauth_cookie_name, path="/", secure=settings.is_real, httponly=True, samesite="lax"
    )
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
        # 会话轮换（受限转 full / 权限版本变化）：必须把新 Cookie 写回浏览器，
        # 旧 Cookie/旧 CSRF 均已失效
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
