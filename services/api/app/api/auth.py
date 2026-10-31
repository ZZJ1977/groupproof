"""业务模块的当前用户依赖（PLAN 二、3：团队业务接口使用真实会话取得用户和权限）。

- 生产：只认 Cookie 会话（app.auth guard 逐请求校验会话、注册资格与账号状态）；
- 隔离开发/测试：保留显式开启的演示头（ENABLE_DEMO_AUTH=true）用于本地联调；
- 未完成学校验证/未具备密码凭据的账号不能绕过验证进入业务（会话范围与注册事实同口径）。
"""

from __future__ import annotations

import os
from uuid import UUID

from fastapi import Depends, Header, Request
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import User
from app.db.session import get_session


def demo_auth_enabled() -> bool:
    """Keep the temporary identity header unavailable outside explicit local runs."""

    return (
        os.getenv("APP_ENV", "production").lower() in {"development", "test"}
        and os.getenv("ENABLE_DEMO_AUTH", "false").lower() == "true"
    )


def get_current_user(
    request: Request,
    demo_user_id: UUID | None = Header(default=None, alias="X-Demo-User-Id"),
    session: Session = Depends(get_session),
) -> User:
    """真实会话用户；隔离开发/测试可显式开启演示头。"""

    if demo_auth_enabled() and demo_user_id is not None:
        user = session.get(User, demo_user_id)
        if user is None:
            raise ApiError(401, "UNAUTHENTICATED", "Authentication is required.")
        if user.status != "active":
            raise ApiError(403, "ACCOUNT_INACTIVE", "The account is not active.")
        return user

    from app.auth.guard import read_session
    from app.auth.services import sessions as sessions_service

    context = read_session(request, session)
    if context is None:
        raise ApiError(401, "UNAUTHENTICATED", "Authentication is required.")
    if context.user.status == "disabled" or context.facts["accountState"] == "disabled":
        raise ApiError(403, "ACCOUNT_INACTIVE", "The account is not active.")
    # 业务访问要求 full 会话范围：注册事实齐全且登录邮箱已验证（与 can_enter_workspace 同口径）
    effective_scope = sessions_service.cap_scope(
        session, context.user, context.session.scope, context.session.auth_method
    )
    if context.facts["accountState"] != "active" or effective_scope != "full":
        raise ApiError(
            403,
            "REGISTRATION_REQUIRED",
            "Complete the required registration steps first.",
            details={"accountState": context.facts["accountState"]},
        )
    return context.user
