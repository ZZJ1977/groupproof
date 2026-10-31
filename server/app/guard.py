"""请求级鉴权依赖（§6.5）：业务请求独立校验 会话 + 注册资格 + 资源权限。

页面跳转/按钮隐藏不构成鉴权；每个请求都从数据库读取当前事实。
"""
from __future__ import annotations

from dataclasses import dataclass

from fastapi import Depends, Request
from sqlalchemy.orm import Session as DbSession

from .config import get_settings
from .db import get_db
from .errors import AppError
from .models import AcademicIdentityCheck, Session, TeacherApplication, User
from .security import csrf_and_origin_ok
from .services import sessions as sessions_service
from .services.registration import derive_facts


@dataclass
class AuthContext:
    user: User
    session: Session
    facts: dict


STATE_ERROR = {
    "disabled": "ACCOUNT_DISABLED",
    "profile_required": "REGISTRATION_REQUIRED",
    "email_required": "REGISTRATION_REQUIRED",
    "review_required": "REGISTRATION_REQUIRED",
    "review_pending": "TEACHER_REVIEW_PENDING",
    "review_rejected": "TEACHER_REVIEW_REJECTED",
}


def read_session(request: Request, db: DbSession) -> AuthContext | None:
    settings = get_settings()
    raw = request.cookies.get(settings.session_cookie_name)
    record = sessions_service.lookup_session(db, raw)
    if record is None:
        return None
    user = db.get(User, record.user_id)
    if user is None:
        return None
    if record.auth_version != user.auth_version:
        # 旧版本会话不再代表当前资格
        return None
    sessions_service.touch_session(db, record)
    facts = sessions_service.current_facts(db, user)
    return AuthContext(user=user, session=record, facts=facts)


def require_session(request: Request, db: DbSession = Depends(get_db)) -> AuthContext:
    context = read_session(request, db)
    if context is None:
        raise AppError("UNAUTHENTICATED", 401)
    return context


def require_active_user(request: Request, db: DbSession = Depends(get_db)) -> AuthContext:
    context = require_session(request, db)
    state = context.facts["accountState"]
    # 会话 scope 仍按当前认证依据重算：未验证登录邮箱的密码/旧会话不得借 active 状态放行
    effective_scope = sessions_service.cap_scope(db, context.user, context.session.scope, context.session.auth_method)
    if state != "active" or effective_scope != "full":
        raise AppError(STATE_ERROR.get(state, "REGISTRATION_REQUIRED"), 403, params={"accountState": state})
    return context


def require_admin(request: Request, db: DbSession = Depends(get_db)) -> AuthContext:
    context = require_active_user(request, db)
    if "admin" not in (context.user.roles or []):
        raise AppError("FORBIDDEN", 403)
    return context


def check_csrf(request: Request, context: AuthContext) -> None:
    if request.method in ("GET", "HEAD", "OPTIONS"):
        return
    if not csrf_and_origin_ok(request.headers.get("origin"), request.headers.get("x-csrf-token"), context.session.csrf_token):
        raise AppError("FORBIDDEN", 403, params={"reason": "csrf"})
