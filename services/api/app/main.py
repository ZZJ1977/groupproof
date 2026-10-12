from pathlib import Path
from uuid import uuid4

from alembic.config import Config
from alembic.script import ScriptDirectory
from fastapi import FastAPI, Request, Response
from sqlalchemy import text

from app.api.errors import install_exception_handlers
from app.api.examples import router as examples_router
from app.auth.config import config_source_summary as auth_config_summary
from app.auth.errors import AppError as AuthAppError
from app.auth.errors import app_error_handler as auth_app_error_handler
from app.auth.routers import admin as auth_admin_router
from app.auth.routers import auth as auth_router
from app.auth.routers import c_admin as auth_c_admin_router
from app.auth.routers import capabilities as auth_capabilities_router
from app.auth.routers import me as auth_me_router
from app.db.session import engine
from app.modules.a.router import router as a_router
from app.modules.b.router import router as b_router
from app.modules.c.router import router as c_router
from app.modules.d.router import router as d_router
from app.modules.tasks.router import router as tasks_router

app = FastAPI(
    title="GroupProof API",
    version="0.2.0",
    description="Modular API with a PostgreSQL project example and shared response contract.",
)


@app.middleware("http")
async def request_context(request: Request, call_next):
    request.state.request_id = str(uuid4())
    response = await call_next(request)
    response.headers["X-Request-Id"] = request.state.request_id
    # Authenticated business responses and errors must not be shared by caches.
    if request.url.path.startswith("/api/v1/"):
        response.headers["Cache-Control"] = "private, no-store"
    return response


install_exception_handlers(app)
# 认证模块错误契约（code/params/fieldErrors）渲染为团队统一错误封装
app.add_exception_handler(AuthAppError, auth_app_error_handler)

# 启动输出脱敏后的认证配置来源（不含凭据）
import logging  # noqa: E402

logging.getLogger("groupproof.auth").info("认证配置（脱敏）：%s", auth_config_summary())


@app.get("/healthz", tags=["system"])
def healthz() -> dict[str, str]:
    return {"service": "api", "status": "ok"}


@app.get("/readyz", tags=["system"])
def readyz(response: Response) -> dict[str, str]:
    """Only accept traffic after the unified database reaches this image's migration head."""
    api_root = Path(__file__).resolve().parents[1]
    config = Config(str(api_root / "alembic.ini"))
    config.set_main_option("script_location", str(api_root / "migrations"))
    expected = set(ScriptDirectory.from_config(config).get_heads())
    try:
        with engine.connect() as connection:
            actual = set(
                connection.execute(text("SELECT version_num FROM alembic_version")).scalars()
            )
        if actual == expected:
            return {"service": "api", "status": "ready"}
    except Exception:
        pass
    response.status_code = 503
    return {"service": "api", "status": "not_ready"}


app.include_router(a_router)
app.include_router(b_router)
app.include_router(c_router)
app.include_router(d_router)
app.include_router(examples_router)
app.include_router(tasks_router)
# 统一认证（PLAN）：注册/登录/会话/学校邮箱验证/教师审核/密码恢复；响应适配团队统一封装
app.include_router(auth_capabilities_router.router)
app.include_router(auth_router.router)
app.include_router(auth_me_router.router)
app.include_router(auth_admin_router.router)
app.include_router(auth_c_admin_router.router)
