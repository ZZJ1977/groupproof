"""GroupProof 身份与账户服务（FastAPI）。

FastAPI 是身份与授权事实的唯一服务端来源：
- 会话、注册资格、资源权限逐请求独立校验；
- 核心依赖（数据库/密钥）缺失启动失败或 readiness 拒绝；可选提供方（Google/邮件）故障只关闭对应入口；
- 错误按层级分类记录（脱敏），响应携带 requestId 便于定位。
"""
from __future__ import annotations

import logging
import sys
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from .config import config_source_summary, get_settings
from .errors import AppError, app_error_handler
from .routers import admin, auth, business, me
from .services import acceptance

# 脱敏日志：只记录错误类别、requestId 与安全摘要，不记录密码/验证码/令牌/连接串
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [groupproof] %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("groupproof")

settings = get_settings()
logger.info("配置来源（脱敏）：%s", config_source_summary())


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 启动即检查数据库可达与迁移存在；失败给出可定位日志（不静默降级）
    try:
        from .db import get_engine

        with get_engine().connect() as connection:
            connection.execute(text("SELECT 1"))
            version = connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one_or_none()
        logger.info("数据库就绪，迁移版本：%s", version or "（未迁移）")
        if not version:
            logger.warning("目标数据库尚未执行迁移，请运行：cd server && alembic upgrade head")
    except Exception as exc:  # noqa: BLE001
        logger.error("启动时数据库检查失败（%s）：%s", type(exc).__name__, str(exc)[:200])
    yield


app = FastAPI(
    title="GroupProof Identity Service",
    version="1.0.0",
    docs_url="/docs" if not settings.is_real else None,
    lifespan=lifespan,
)
app.add_exception_handler(AppError, app_error_handler)


@app.middleware("http")
async def request_id_middleware(request: Request, call_next):
    request.state.request_id = uuid.uuid4().hex[:16]
    response = await call_next(request)
    response.headers["X-Request-Id"] = request.state.request_id
    return response


@app.get("/healthz")
def healthz() -> dict:
    """liveness：只证明进程存活，不代表注册可用。"""
    return {"ok": True, "mode": settings.app_mode}


@app.get("/readyz")
def readyz(request: Request) -> JSONResponse:
    """readiness：数据库连接、迁移与核心密钥；详细原因仅日志可见。"""
    checks: dict[str, bool] = {}
    try:
        from .db import get_engine

        with get_engine().connect() as connection:
            connection.execute(text("SELECT 1"))
            version = connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one_or_none()
        checks["database"] = True
        checks["migrations"] = bool(version)
    except Exception as exc:  # noqa: BLE001
        logger.error("readiness 数据库检查失败 requestId=%s %s: %s", request.state.request_id, type(exc).__name__, str(exc)[:200])
        checks["database"] = False
        checks["migrations"] = False
    checks["core_secrets"] = bool(settings.email_challenge_hmac_key) and (not settings.is_real or settings.app_origin.startswith("https://"))
    ok = all(checks.values())
    if not ok:
        logger.error("readiness 未通过 requestId=%s checks=%s", request.state.request_id, checks)
    return JSONResponse(
        {"ok": ok, "checks": checks, "requestId": request.state.request_id},
        status_code=200 if ok else 503,
        headers={"Cache-Control": "private, no-store"},
    )


@app.get("/api/v1/auth/capabilities")
def capabilities() -> JSONResponse:
    """通道能力：只返回各入口 enabled/available，不暴露密钥或内部地址。"""
    return JSONResponse(
        {
            "google": {"enabled": settings.auth_google_enabled, "available": settings.google_available},
            "password": {"enabled": settings.auth_password_enabled, "available": settings.auth_password_enabled},
            "emailSignup": {"enabled": settings.auth_email_signup_enabled, "available": settings.email_signup_available},
            "passwordReset": {"enabled": settings.auth_password_reset_enabled, "available": settings.password_reset_available},
            "schoolEmailVerification": {"enabled": True, "available": settings.mail_available},
            # 验收密令（仅非 real）：告知前端测试入口/测试验证码是否可用
            "acceptanceTest": {"enabled": acceptance.enabled()},
        },
        headers={"Cache-Control": "private, no-store"},
    )


app.include_router(auth.router)
app.include_router(me.router)
app.include_router(admin.router)
app.include_router(business.router)


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception) -> JSONResponse:
    """未预期错误：按层级分类记录脱敏堆栈，返回通用错误与请求编号，不回传内部细节。"""
    request_id = getattr(request.state, "request_id", None)
    if isinstance(exc, SQLAlchemyError):
        # 存储/迁移/事务类：受控 503，日志分类
        logger.error("存储错误 requestId=%s %s: %s", request_id, type(exc).__name__, str(exc)[:300])
        code, status = "SERVICE_UNAVAILABLE", 503
    else:
        logger.exception("未预期错误 requestId=%s", request_id)
        code, status = "INTERNAL_ERROR", 500
    return JSONResponse(
        {"code": code, "params": {}, "requestId": request_id},
        status_code=status,
        headers={"Cache-Control": "private, no-store"},
    )
