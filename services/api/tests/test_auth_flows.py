"""统一认证端到端流测试（PLAN 二、5、五）：注册 → 会话 → 业务访问门禁。

只使用隔离开发配置与邮件捕获器（MAIL_MODE=capture），不连接任何真实邮件服务。
"""

from __future__ import annotations

import os
import re
import uuid
from collections.abc import Generator

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text

os.environ.setdefault("APP_MODE", "dev")
os.environ["MAIL_MODE"] = "capture"
os.environ["EMAIL_CHALLENGE_HMAC_KEY"] = "test-hmac-key"
os.environ["APP_ORIGIN"] = "http://localhost:3000"
os.environ["CODE_SEND_PER_HOUR"] = "1000"
os.environ["CODE_SEND_PER_DAY"] = "1000"

from app.api.auth import get_current_user  # noqa: E402
from app.api.errors import install_exception_handlers  # noqa: E402
from app.auth.config import get_settings  # noqa: E402
from app.db.models import User  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402

PASSWORD = "correct-horse-battery-staple-42"


@pytest.fixture()
def client() -> Generator[TestClient, None, None]:
    if not os.getenv("DATABASE_URL"):
        pytest.skip("set DATABASE_URL to run PostgreSQL integration tests")
    get_settings.cache_clear()
    with SessionLocal() as session:
        # 限流计数跨运行持久化：测试前清空，保证可重复执行
        session.execute(text("DELETE FROM auth_rate_limits"))
        session.commit()
    with TestClient(app) as test_client:
        yield test_client
    get_settings.cache_clear()


def _unique(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}"


def _latest_code(email: str) -> str:
    with SessionLocal() as session:
        bodies = list(
            session.execute(
                text("SELECT body FROM email_outbox WHERE to_email = :email ORDER BY id DESC"),
                {"email": email},
            ).scalars()
        )
    for body in bodies:
        match = re.search(r"\b(\d{6})\b", body or "")
        if match:
            return match.group(1)
    raise AssertionError(f"no captured code for {email}")


def _register_account(client: TestClient) -> tuple[str, str]:
    """完成邮箱注册前验证 + 建档，返回 (username, password)。"""
    login_email = f"{_unique('reg')}@test.example"
    started = client.post(
        "/api/v1/auth/email/registrations", json={"email": login_email, "locale": "en"}
    )
    assert started.status_code in (200, 202)
    tx_id = started.json()["data"]["id"]
    assert started.json()["meta"]["request_id"]

    verified = client.post(
        f"/api/v1/auth/email/registrations/{tx_id}/verify", json={"code": _latest_code(login_email)}
    )
    assert verified.status_code == 200
    assert verified.json()["data"]["verified"] is True

    username = _unique("user")
    completed = client.post(
        f"/api/v1/auth/email/registrations/{tx_id}/complete",
        json={"username": username, "password": PASSWORD},
    )
    assert completed.status_code in (200, 201)
    payload = completed.json()["data"]
    assert payload["authenticated"] is True
    assert payload["sessionScope"] == "onboarding"
    assert payload["csrfToken"]
    return username, PASSWORD


def test_capabilities_report_restricted_mail_without_public_switch(client: TestClient) -> None:
    response = client.get("/api/v1/auth/capabilities")
    assert response.status_code == 200
    body = response.json()
    assert body["meta"]["request_id"]
    data = body["data"]
    assert data["password"]["enabled"] is True
    assert data["google"]["enabled"] is True  # 开关默认开
    assert data["google"]["available"] is True  # 入口先显示（用户决策）；实际登录需 GOOGLE_* 凭据
    # capture 模式（隔离环境）允许完整邮件流程；真实公开发信需 MAIL_PUBLIC_ENABLED
    assert data["emailSignup"]["available"] is True


def test_registration_session_and_registration_state(client: TestClient) -> None:
    _register_account(client)

    me = client.get("/api/v1/me")
    assert me.status_code == 200
    payload = me.json()["data"]
    # 未完成资料/学校邮箱验证前停留在注册流程内，不得进入业务
    assert payload["registration"]["accountState"] in {"profile_required", "email_required"}
    assert payload["registration"]["canEnterWorkspace"] is False


def test_password_login_and_error_envelope(client: TestClient) -> None:
    username, password = _register_account(client)

    client.post("/api/v1/auth/logout")  # 清除注册会话
    login = client.post(
        "/api/v1/auth/password/login", json={"identifier": username, "password": password}
    )
    assert login.status_code == 200
    assert login.json()["data"]["authenticated"] is True

    wrong = client.post(
        "/api/v1/auth/password/login",
        json={"identifier": username, "password": "wrong-password-000"},
    )
    assert wrong.status_code == 401
    error = wrong.json()
    assert error["error"]["code"] == "INVALID_CREDENTIALS"
    assert error["meta"]["request_id"]
    # 登录失败不泄露账户是否存在
    assert not (error["error"].get("details") or {}).get("user")


def test_me_write_requires_csrf_token(client: TestClient) -> None:
    _register_account(client)

    denied = client.patch("/api/v1/me/preferences", json={"preferredLocale": "en"})
    assert denied.status_code == 403
    assert denied.json()["error"]["code"] == "FORBIDDEN"

    session_payload = client.get("/api/v1/auth/session").json()["data"]
    allowed = client.patch(
        "/api/v1/me/preferences",
        json={"preferredLocale": "en"},
        headers={"X-CSRF-Token": session_payload["csrfToken"]},
    )
    assert allowed.status_code == 200
    assert allowed.json()["data"]["preferredLocale"] == "en"


def _business_app() -> FastAPI:
    """模拟团队主应用的业务路由：真实会话依赖 + 统一错误封装 + 请求上下文。"""
    business_app = FastAPI()
    install_exception_handlers(business_app)

    @business_app.middleware("http")
    async def request_context(request, call_next):
        request.state.request_id = "test-request-id"
        return await call_next(request)

    @business_app.get("/whoami")
    def whoami(user: User = Depends(get_current_user)) -> dict:
        return {"id": str(user.id)}

    return business_app


def test_business_access_requires_full_session(client: TestClient) -> None:
    business_app = _business_app()

    business_client = TestClient(business_app)
    anonymous = business_client.get("/whoami")
    assert anonymous.status_code == 401

    _register_account(client)
    for cookie in client.cookies.jar:
        business_client.cookies.set(cookie.name, cookie.value)
    blocked = business_client.get("/whoami")
    assert blocked.status_code == 403
    assert blocked.json()["error"]["code"] == "REGISTRATION_REQUIRED"


def test_full_registration_activates_business_access(client: TestClient) -> None:
    _register_account(client)
    session_payload = client.get("/api/v1/auth/session").json()["data"]
    csrf = session_payload["csrfToken"]
    version = client.get("/api/v1/me").json()["data"]["user"]["version"]

    username = _unique("student")
    school_email = f"{_unique('s')}@student.must.edu.mo"
    updated = client.patch(
        "/api/v1/me/profile",
        json={
            "name": "Test Student",
            "username": username,
            "studentId": f"S{uuid.uuid4().hex[:8]}",
            "college": "FST",
            "requestedIdentity": "student",
            "schoolEmail": school_email,
            "expectedVersion": version,
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert updated.status_code == 200

    challenge = client.post(
        "/api/v1/me/school-email/challenges",
        json={"purpose": "school_email_verify"},
        headers={"X-CSRF-Token": csrf},
    )
    assert challenge.status_code == 200
    challenge_id = challenge.json()["data"]["challengeId"]

    verified = client.post(
        "/api/v1/me/school-email/verify",
        json={"challengeId": challenge_id, "code": _latest_code(school_email)},
        headers={"X-CSRF-Token": csrf},
    )
    assert verified.status_code == 200
    payload = verified.json()["data"]
    assert payload["registration"]["accountState"] == "active"
    assert payload["registration"]["canEnterWorkspace"] is True

    business_app = _business_app()

    business_client = TestClient(business_app)
    for cookie in client.cookies.jar:
        business_client.cookies.set(cookie.name, cookie.value)
    allowed = business_client.get("/whoami")
    assert allowed.status_code == 200
