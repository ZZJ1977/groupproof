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


def _start_registration(client: TestClient, login_email: str) -> str:
    started = client.post(
        "/api/v1/auth/email/registrations", json={"email": login_email, "locale": "en"}
    )
    assert started.status_code == 200
    assert started.json()["meta"]["request_id"]
    return started.json()["data"]["id"]


def _verify_registration(client: TestClient, tx_id: str, login_email: str) -> None:
    verified = client.post(
        f"/api/v1/auth/email/registrations/{tx_id}/verify", json={"code": _latest_code(login_email)}
    )
    assert verified.status_code == 200
    assert verified.json()["data"]["verified"] is True


def _profile_input(identity: str = "student") -> dict:
    return {
        "name": "中文姓名",
        "requestedIdentity": identity,
        "studentId": _unique("s") if identity == "student" else None,
        "college": "FST",
        "password": PASSWORD,
        "confirmPassword": PASSWORD,
    }


def _register_account(client: TestClient, identity: str = "student") -> tuple[str, str]:
    domain = "student.must.edu.mo" if identity == "student" else "must.edu.mo"
    login_email = f"{_unique('reg')}@{domain}"
    tx_id = _start_registration(client, login_email)
    _verify_registration(client, tx_id, login_email)
    completed = client.post(
        f"/api/v1/auth/email/registrations/{tx_id}/complete",
        json=_profile_input(identity),
    )
    assert completed.status_code == 201
    payload = completed.json()["data"]
    assert payload["authenticated"] is True
    assert payload["sessionScope"] == ("full" if identity == "student" else "onboarding")
    assert payload["csrfToken"]
    return login_email, PASSWORD


@pytest.mark.parametrize("domain", ["example.com", "student.must.edu.mo.example.com"])
def test_registration_requires_a_school_address_before_sending(client: TestClient, domain: str):
    email = f"{_unique('reg')}@{domain}"
    response = client.post("/api/v1/auth/email/registrations", json={"email": email})
    assert response.status_code == 400
    assert response.json()["error"]["details"]["fieldErrors"] == {"email": "school_email_domain"}


def test_registration_profile_requires_verification_and_the_same_browser(client: TestClient):
    email = f"{_unique('reg')}@student.must.edu.mo"
    started = client.post("/api/v1/auth/email/registrations", json={"email": email})
    assert started.status_code == 200
    assert started.json()["data"]["status"] == "captured"
    route = "/api/v1/auth/email/registrations/" + started.json()["data"]["id"]
    assert client.get(route + "/profile").status_code == 400
    assert client.post(route + "/complete", json=_profile_input()).status_code == 400

    _verify_registration(client, started.json()["data"]["id"], email)
    with TestClient(app) as other_browser:
        assert other_browser.get(route + "/profile").status_code == 403
        assert other_browser.post(route + "/complete", json=_profile_input()).status_code == 403
    details = client.get(route + "/profile")
    assert details.status_code == 200
    assert "no-store" in details.headers["Cache-Control"]
    assert details.json()["data"] == {"email": email, "allowedIdentities": ["student"]}
    session = client.get("/api/v1/auth/session")
    assert session.json()["data"]["authenticated"] is False


def test_registration_form_recovers_from_field_errors_and_completes_once(client: TestClient):
    email = f"{_unique('reg')}@student.must.edu.mo"
    tx_id = _start_registration(client, email)
    _verify_registration(client, tx_id, email)
    complete_path = f"/api/v1/auth/email/registrations/{tx_id}/complete"
    bad = client.post(
        complete_path,
        json={
            **_profile_input("teacher"),
            "password": "too few",
            "confirmPassword": "does not match",
        },
    )
    assert bad.status_code == 400
    fields = bad.json()["error"]["details"]["fieldErrors"]
    assert fields["schoolEmail"] == "email_domain_not_allowed"
    assert fields["password"] == "password_policy"
    assert fields["confirmPassword"] == "password_mismatch"

    form = {**_profile_input(), "password": "8 chars!", "confirmPassword": "8 chars!"}
    assert client.post(complete_path, json=form).status_code == 201
    repeated = client.post(complete_path, json=form)
    assert repeated.status_code == 200
    assert repeated.json()["data"] == {"status": "already_completed"}
    assert "set-cookie" not in repeated.headers


def test_registration_profile_cannot_use_expired_verification(client: TestClient):
    email = f"{_unique('reg')}@student.must.edu.mo"
    tx_id = _start_registration(client, email)
    _verify_registration(client, tx_id, email)
    with SessionLocal() as db:
        db.execute(
            text(
                "UPDATE pre_registration_requests SET creation_grant_expires_at = "
                "now() - interval '1 minute' WHERE id = :tx_id"
            ),
            {"tx_id": tx_id},
        )
        db.commit()
    route = f"/api/v1/auth/email/registrations/{tx_id}"
    for response in [
        client.get(route + "/profile"),
        client.post(route + "/complete", json=_profile_input()),
    ]:
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "CODE_EXPIRED"


def test_collaboration_profile_accounts_can_be_saved_updated_and_cleared(client: TestClient):
    email = f"{_unique('reg')}@must.edu.mo"
    tx_id = _start_registration(client, email)
    _verify_registration(client, tx_id, email)
    completed = client.post(
        f"/api/v1/auth/email/registrations/{tx_id}/complete",
        json={
            **_profile_input("teacher"),
            "githubUsername": " @Demo-Teacher ",
            "feishuAccount": " 李老师 ",
        },
    )
    assert completed.status_code == 201
    assert completed.json()["data"]["accountState"] == "review_required"
    csrf = completed.json()["data"]["csrfToken"]
    user = client.get("/api/v1/me").json()["data"]["user"]
    assert user["githubUsername"] == "demo-teacher"
    assert user["feishuAccount"] == "李老师"
    with SessionLocal() as db:
        assert (
            db.scalar(
                text("SELECT login FROM a_github_user_links WHERE user_id = :user_id"),
                {"user_id": user["id"]},
            )
            is None
        )

    updated = client.patch(
        "/api/v1/me/profile",
        json={"expectedVersion": user["version"], "githubUsername": "", "feishuAccount": "lark42"},
        headers={"X-CSRF-Token": csrf},
    )
    assert updated.status_code == 200
    assert updated.json()["data"]["registration"]["accountState"] == "review_required"
    current = client.get("/api/v1/me").json()["data"]["user"]
    assert current["githubUsername"] is None
    assert current["githubLogin"] is None
    assert current["feishuAccount"] == "lark42"

    cleared = client.patch(
        "/api/v1/me/profile",
        json={"expectedVersion": current["version"], "feishuAccount": None},
        headers={"X-CSRF-Token": csrf},
    )
    assert cleared.status_code == 200
    assert cleared.json()["data"]["user"]["feishuAccount"] is None


def test_active_student_can_update_and_clear_feishu_account(client: TestClient):
    _register_account(client, "student")
    session = client.get("/api/v1/auth/session").json()["data"]
    csrf = session["csrfToken"]
    me_before = client.get("/api/v1/me").json()["data"]
    assert me_before["registration"]["accountState"] == "active"
    assert me_before["user"]["feishuAccount"] is None
    assert me_before["user"]["githubLogin"] is None

    saved = client.patch(
        "/api/v1/me/profile",
        json={"expectedVersion": me_before["user"]["version"], "feishuAccount": "  ou_demo12345  "},
        headers={"X-CSRF-Token": csrf},
    )
    assert saved.status_code == 200
    saved_data = saved.json()["data"]
    assert saved_data["registration"]["accountState"] == "active"
    assert saved_data["user"]["feishuAccount"] == "ou_demo12345"

    cleared = client.patch(
        "/api/v1/me/profile",
        json={"expectedVersion": saved_data["user"]["version"], "feishuAccount": None},
        headers={"X-CSRF-Token": csrf},
    )
    assert cleared.status_code == 200
    assert cleared.json()["data"]["user"]["feishuAccount"] is None
    assert cleared.json()["data"]["registration"]["accountState"] == "active"


def test_collaboration_profile_fields_reject_invalid_accounts_before_saving(client: TestClient):
    email = f"{_unique('reg')}@student.must.edu.mo"
    tx_id = _start_registration(client, email)
    _verify_registration(client, tx_id, email)
    complete_path = f"/api/v1/auth/email/registrations/{tx_id}/complete"
    invalid = {"githubUsername": "https://github.example/demo", "feishuAccount": "account\n"}
    expected_errors = {
        "githubUsername": "invalid_github_username",
        "feishuAccount": "invalid_feishu_account",
    }
    rejected = client.post(complete_path, json={**_profile_input(), **invalid})
    assert rejected.status_code == 400
    assert rejected.json()["error"]["details"]["fieldErrors"] == expected_errors

    # The verified grant can be retried and older clients can omit both fields.
    completed = client.post(complete_path, json=_profile_input())
    assert completed.status_code == 201
    user = client.get("/api/v1/me").json()["data"]["user"]
    assert user["githubUsername"] is None
    assert user["feishuAccount"] is None
    rejected = client.patch(
        "/api/v1/me/profile",
        json={"expectedVersion": user["version"], **invalid},
        headers={"X-CSRF-Token": completed.json()["data"]["csrfToken"]},
    )
    assert rejected.status_code == 400
    assert rejected.json()["error"]["details"]["fieldErrors"] == expected_errors


def test_registration_rejects_duplicate_email_and_student_id(client: TestClient):
    email = f"{_unique('reg')}@student.must.edu.mo"
    tx_id = _start_registration(client, email)
    _verify_registration(client, tx_id, email)
    form = _profile_input()
    assert (
        client.post(f"/api/v1/auth/email/registrations/{tx_id}/complete", json=form).status_code
        == 201
    )

    for next_email, next_form, expected_field in [
        (email, _profile_input(), {"schoolEmail": "email_taken"}),
        (f"{_unique('reg')}@student.must.edu.mo", form, {"studentId": "student_id_taken"}),
    ]:
        with TestClient(app) as browser:
            tx_id = _start_registration(browser, next_email)
            _verify_registration(browser, tx_id, next_email)
            conflict = browser.post(
                f"/api/v1/auth/email/registrations/{tx_id}/complete", json=next_form
            )
            assert conflict.status_code == 409
            assert conflict.json()["error"]["details"]["fieldErrors"] == expected_field
            assert browser.get("/api/v1/auth/session").json()["data"]["authenticated"] is False


def test_capabilities_report_restricted_mail_without_public_switch(client: TestClient) -> None:
    response = client.get("/api/v1/auth/capabilities")
    assert response.status_code == 200
    body = response.json()
    assert body["meta"]["request_id"]
    data = body["data"]
    assert data["password"]["enabled"] is True
    assert data["google"]["enabled"] is True  # 开关默认开
    # 入口可见性 = 开关开启且 GOOGLE_* 凭据齐全；测试环境未配置凭据，因此不显示
    assert data["google"]["available"] is False
    # capture 模式（隔离环境）允许完整邮件流程；真实公开发信需 MAIL_PUBLIC_ENABLED
    assert data["emailSignup"]["available"] is True


def test_registration_session_and_registration_state(client: TestClient) -> None:
    _register_account(client)

    me = client.get("/api/v1/me")
    assert me.status_code == 200
    payload = me.json()["data"]
    assert payload["registration"]["accountState"] == "active"
    assert payload["registration"]["canEnterWorkspace"] is True
    assert payload["registration"]["schoolEmailVerified"] is True
    assert payload["registration"]["loginEmailVerified"] is True


def test_password_login_and_error_envelope(client: TestClient) -> None:
    login_email, password = _register_account(client)

    client.post("/api/v1/auth/logout")  # 清除注册会话
    login = client.post(
        "/api/v1/auth/password/login", json={"identifier": login_email, "password": password}
    )
    assert login.status_code == 200
    assert login.json()["data"]["authenticated"] is True

    wrong = client.post(
        "/api/v1/auth/password/login",
        json={"identifier": login_email, "password": "wrong-password-000"},
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

    _register_account(client, "teacher")
    state = client.get("/api/v1/auth/session").json()["data"]
    assert state["accountState"] == "review_required"
    assert state["nextAction"]["href"] == "/account/status"
    for cookie in client.cookies.jar:
        business_client.cookies.set(cookie.name, cookie.value)
    blocked = business_client.get("/whoami")
    assert blocked.status_code == 403
    assert blocked.json()["error"]["code"] == "REGISTRATION_REQUIRED"


def test_full_registration_activates_business_access(client: TestClient) -> None:
    _register_account(client)
    business_app = _business_app()

    business_client = TestClient(business_app)
    for cookie in client.cookies.jar:
        business_client.cookies.set(cookie.name, cookie.value)
    allowed = business_client.get("/whoami")
    assert allowed.status_code == 200
