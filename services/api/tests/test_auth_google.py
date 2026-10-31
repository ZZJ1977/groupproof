"""Google OIDC 登录 / 关联 / 解除端到端测试（PLAN 六、4）。

GOOGLE_DISCOVERY_URL 指向隔离测试 OIDC 提供方（oidc_stub），仅测试使用，
不连接真实 Google；真实联调见 docs/design/screenshots/google-login-*。
"""

from __future__ import annotations

import os
import re
import uuid
from collections.abc import Generator
from datetime import timedelta
from urllib.parse import parse_qs, urlparse

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

from oidc_stub import StubProvider  # noqa: E402

from app.api.auth import get_current_user  # noqa: E402
from app.api.errors import install_exception_handlers  # noqa: E402
from app.auth.config import get_settings  # noqa: E402
from app.auth.errors import AppError  # noqa: E402
from app.auth.models import AuthIdentity, User, utcnow  # noqa: E402
from app.auth.security import new_token, token_digest  # noqa: E402
from app.auth.services import google_oidc  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402

APP_ORIGIN = "http://localhost:3000"
CALLBACK = "/api/v1/auth/google/callback"
PASSWORD = "correct-horse-battery-staple-42"


# --- 测试 OIDC 提供方（会话级，一次启动）---


@pytest.fixture(scope="module")
def oidc_provider() -> Generator[StubProvider, None, None]:
    provider = StubProvider()
    provider.start()
    yield provider
    provider.stop()


def _configure(monkeypatch, provider: StubProvider, **overrides: str) -> None:
    """以环境变量 + 缓存刷新注入隔离 Google 配置（仅测试使用 stub 发现地址）。"""
    values = {
        "APP_MODE": "dev",
        "APP_ORIGIN": APP_ORIGIN,
        "AUTH_GOOGLE_ENABLED": "true",
        "GOOGLE_CLIENT_ID": "test-client-id",
        "GOOGLE_CLIENT_SECRET": "test-secret",
        "GOOGLE_REDIRECT_URI": APP_ORIGIN + CALLBACK,
        "GOOGLE_DISCOVERY_URL": provider.discovery_url,
        "GOOGLE_EXPECTED_ISSUER": provider.issuer,
        "MAIL_MODE": "capture",
        "EMAIL_CHALLENGE_HMAC_KEY": "test-hmac-key",
        # httpx 会经 macOS 系统代理转发回环流量（stub 端口）导致 502；测试内绕过代理直连
        "NO_PROXY": "127.0.0.1,localhost",
        "no_proxy": "127.0.0.1,localhost",
    }
    values.update(overrides)
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    get_settings.cache_clear()


@pytest.fixture()
def client(oidc_provider: StubProvider, monkeypatch) -> Generator[TestClient, None, None]:
    if not os.getenv("DATABASE_URL"):
        pytest.skip("set DATABASE_URL to run PostgreSQL integration tests")
    _configure(monkeypatch, oidc_provider)
    google_oidc.reset_discovery_cache()
    with SessionLocal() as session:
        # 限流计数跨运行持久化：测试前清空，保证可重复执行
        session.execute(text("DELETE FROM auth_rate_limits"))
        session.commit()
    with TestClient(app) as test_client:
        yield test_client
    google_oidc.reset_discovery_cache()
    get_settings.cache_clear()


# --- 工具 ---


def _unique(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}"


def _start_login(client: TestClient) -> str:
    """走 google_start，返回 state（同时 Cookie gp_oauth_state 已进入客户端）。"""
    response = client.get("/api/v1/auth/google/start", follow_redirects=False)
    assert response.status_code == 302
    query = parse_qs(urlparse(response.headers["location"]).query)
    assert query["redirect_uri"][0] == APP_ORIGIN + CALLBACK
    return query["state"][0]


def test_google_start_provider_unavailable_redirects_to_retry(client: TestClient, monkeypatch):
    def unavailable(*_args, **_kwargs):
        raise AppError("AUTH_UNAVAILABLE", 503, params={"service": "google"})

    monkeypatch.setattr(google_oidc, "build_authorize_url", unavailable)

    response = client.get("/api/v1/auth/google/start", follow_redirects=False)

    assert response.status_code == 302
    assert response.headers["location"] == "/login?error=unavailable"


def _mint_code(
    provider: StubProvider, state: str, *, nonce: str | None = None, **identity: object
) -> str:
    """从 OAuth 事务取出 nonce/PKCE，按 stub 授权结果打包测试 code；nonce 可覆盖制造错配。"""
    with SessionLocal() as session:
        row = session.execute(
            text("SELECT nonce, code_verifier FROM oauth_transactions WHERE state_digest = :d"),
            {"d": token_digest(state)},
        ).one()
    return provider.mint_code(
        state=state,
        nonce=nonce if nonce is not None else str(row.nonce),
        code_verifier=str(row.code_verifier),
        **identity,
    )


def _callback(
    client: TestClient, code: str | None = None, state: str | None = None, error: str | None = None
):
    params = {
        key: value for key, value in {"code": code, "state": state, "error": error}.items() if value
    }
    return client.get(CALLBACK, params=params, follow_redirects=False)


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
    """完成登录邮箱注册，返回 (login_email, username)；密码统一 PASSWORD。"""
    login_email = f"{_unique('reg')}@test.example"
    started = client.post(
        "/api/v1/auth/email/registrations", json={"email": login_email, "locale": "en"}
    )
    assert started.status_code in (200, 202)
    tx_id = started.json()["data"]["id"]
    verified = client.post(
        f"/api/v1/auth/email/registrations/{tx_id}/verify", json={"code": _latest_code(login_email)}
    )
    assert verified.status_code == 200
    username = _unique("user")
    completed = client.post(
        f"/api/v1/auth/email/registrations/{tx_id}/complete",
        json={"username": username, "password": PASSWORD},
    )
    assert completed.status_code in (200, 201)
    return login_email, username


def _password_login(client: TestClient, username: str) -> str:
    client.post("/api/v1/auth/logout")
    login = client.post(
        "/api/v1/auth/password/login", json={"identifier": username, "password": PASSWORD}
    )
    assert login.status_code == 200
    return login.json()["data"]["csrfToken"]


def _csrf(client: TestClient) -> str:
    return client.get("/api/v1/auth/session").json()["data"]["csrfToken"]


def _count(sql: str) -> int:
    with SessionLocal() as session:
        return int(session.execute(text(sql)).scalar_one())


def _audit_count(event_type: str) -> int:
    return _count(f"SELECT count(*) FROM auth_audit_events WHERE event_type = '{event_type}'")


def _seed_google_identity(provider: StubProvider, sub: str) -> str:
    """直接落库一个已被其他账号占用的 Google 身份，返回占用者 user_id。"""
    with SessionLocal() as session:
        user = User(
            id=uuid.uuid4(),
            name="占用者",
            email=f"{_unique('taken')}@test.example",
            account_status="enabled",
        )
        session.add(user)
        session.add(
            AuthIdentity(
                id=new_token()[:32],
                provider="google",
                issuer=provider.issuer,
                subject=sub,
                user_id=user.id,
                google_email=f"{_unique('taken')}@gmail.test",
                last_authenticated_at=utcnow(),
            )
        )
        session.commit()
        return str(user.id)


# --- 1/2. 首次登录建号 + 再次登录命中同一用户 ---


def test_google_first_login_creates_user_identity_and_session(client: TestClient, oidc_provider):
    before_users = _count("SELECT count(*) FROM users")
    state = _start_login(client)
    code = _mint_code(oidc_provider, state, sub=_unique("sub"), email=f"{_unique('g')}@gmail.test")

    response = _callback(client, code=code, state=state)
    assert response.status_code == 302
    assert response.headers["location"] == "/account/profile"  # 注册进度：先完善资料
    assert "gp_session" in response.headers.get("set-cookie", "")
    assert _count("SELECT count(*) FROM users") == before_users + 1
    assert _count("SELECT count(*) FROM auth_identities") >= 1


def test_google_second_login_hits_same_user(client: TestClient, oidc_provider):
    sub = _unique("sub")
    state = _start_login(client)
    code = _mint_code(oidc_provider, state, sub=sub, email=f"{_unique('g')}@gmail.test")
    assert _callback(client, code=code, state=state).status_code == 302

    users_before = _count("SELECT count(*) FROM users")
    identities_before = _count("SELECT count(*) FROM auth_identities")
    state2 = _start_login(client)
    code2 = _mint_code(oidc_provider, state2, sub=sub, email=f"{_unique('g')}@gmail.test")
    response = _callback(client, code=code2, state=state2)

    assert response.status_code == 302
    assert _count("SELECT count(*) FROM users") == users_before
    assert _count("SELECT count(*) FROM auth_identities") == identities_before


# --- 3. state 缺失 / 不匹配 / 过期 / 重放 ---


def test_state_missing_redirects_to_failed(client: TestClient):
    response = _callback(client, code="whatever")
    assert response.status_code == 302
    assert response.headers["location"] == "/login?error=failed"


def test_state_mismatch_redirects_to_failed(client: TestClient, oidc_provider):
    state = _start_login(client)
    code = _mint_code(oidc_provider, state, sub=_unique("sub"))
    response = _callback(client, code=code, state="tampered-" + state)
    assert response.status_code == 302
    assert response.headers["location"] == "/login?error=failed"


def test_state_expired_redirects_to_failed(client: TestClient, oidc_provider):
    state = _start_login(client)
    code = _mint_code(oidc_provider, state, sub=_unique("sub"))
    with SessionLocal() as session:
        session.execute(
            text("UPDATE oauth_transactions SET expires_at = :t WHERE state_digest = :d"),
            {"t": utcnow() - timedelta(seconds=1), "d": token_digest(state)},
        )
        session.commit()
    response = _callback(client, code=code, state=state)
    assert response.status_code == 302
    assert response.headers["location"] == "/login?error=failed"


def test_state_replay_redirects_to_failed(client: TestClient, oidc_provider):
    sub = _unique("sub")
    state = _start_login(client)
    code = _mint_code(oidc_provider, state, sub=sub)
    assert _callback(client, code=code, state=state).status_code == 302

    # 重放同一 state：事务已消费，必须失败
    client.cookies.set("gp_oauth_state", state)
    code2 = _mint_code(oidc_provider, state, sub=sub)
    response = _callback(client, code=code2, state=state)
    assert response.status_code == 302
    assert response.headers["location"] == "/login?error=failed"


# --- 4. nonce / aud / issuer 校验失败 ---


def test_nonce_mismatch_redirects_to_failed(client: TestClient, oidc_provider):
    state = _start_login(client)
    code = _mint_code(oidc_provider, state, sub=_unique("sub"), nonce="evil-nonce")
    response = _callback(client, code=code, state=state)
    assert response.status_code == 302
    assert response.headers["location"] == "/login?error=failed"


def test_audience_mismatch_redirects_to_failed(client: TestClient, oidc_provider, monkeypatch):
    state = _start_login(client)
    code = _mint_code(oidc_provider, state, sub=_unique("sub"))
    # stub 签发的 aud 固定为 test-client-id；换成别的 client_id 触发 audience_mismatch
    _configure(monkeypatch, oidc_provider, GOOGLE_CLIENT_ID="another-client-id")
    response = _callback(client, code=code, state=state)
    assert response.status_code == 302
    assert response.headers["location"] == "/login?error=failed"


def test_issuer_mismatch_redirects_to_failed(client: TestClient, oidc_provider, monkeypatch):
    state = _start_login(client)
    code = _mint_code(oidc_provider, state, sub=_unique("sub"))
    _configure(monkeypatch, oidc_provider, GOOGLE_EXPECTED_ISSUER="https://evil.example")
    response = _callback(client, code=code, state=state)
    assert response.status_code == 302
    assert response.headers["location"] == "/login?error=failed"


# --- 5. 用户在 Google 页面取消 ---


def test_access_denied_redirects_to_cancelled(client: TestClient, oidc_provider):
    state = _start_login(client)
    response = _callback(client, state=state, error="access_denied")
    assert response.status_code == 302
    assert response.headers["location"] == "/login?error=cancelled"


# --- 6. 已验证邮箱冲突不建号 ---


def test_verified_email_conflict_blocks_signup(client: TestClient, oidc_provider):
    login_email, _username = _register_account(client)
    users_before = _count("SELECT count(*) FROM users")
    audit_before = _audit_count("auth.google.account_exists")

    state = _start_login(client)
    code = _mint_code(
        oidc_provider,
        state,
        sub=_unique("sub"),
        email=login_email,
        email_verified=True,
    )
    response = _callback(client, code=code, state=state)

    assert response.status_code == 302
    assert response.headers["location"] == "/login?error=account_exists"
    assert _count("SELECT count(*) FROM users") == users_before
    assert _audit_count("auth.google.account_exists") == audit_before + 1


def test_unverified_email_conflict_still_creates_account(client: TestClient, oidc_provider):
    login_email, _username = _register_account(client)
    users_before = _count("SELECT count(*) FROM users")

    state = _start_login(client)
    code = _mint_code(
        oidc_provider,
        state,
        sub=_unique("sub"),
        email=login_email,
        email_verified=False,
    )
    response = _callback(client, code=code, state=state)

    assert response.status_code == 302
    assert response.headers["location"] == "/account/profile"
    assert _count("SELECT count(*) FROM users") == users_before + 1


# --- 7. 关联 Google：成功 / 近期认证过期 / sub 已被他人绑定 ---


def test_link_google_identity_from_account_security(client: TestClient, oidc_provider):
    _login_email, username = _register_account(client)
    csrf = _password_login(client, username)
    me = client.get("/api/v1/me").json()["data"]
    user_id = me["user"]["id"]
    users_before = _count("SELECT count(*) FROM users")
    audit_before = _audit_count("auth.google.linked")

    started = client.post(
        "/api/v1/me/identities/google/link",
        json={},
        headers={"X-CSRF-Token": csrf},
    )
    assert started.status_code == 200
    authorize_url = started.json()["data"]["authorizeUrl"]
    state = parse_qs(urlparse(authorize_url).query)["state"][0]
    code = _mint_code(oidc_provider, state, sub=_unique("sub"), email=f"{_unique('g')}@gmail.test")

    response = _callback(client, code=code, state=state)
    assert response.status_code == 302
    assert response.headers["location"] == "/account/security?linked=google"
    # 只建绑定：不建新用户、不轮换会话
    assert _count("SELECT count(*) FROM users") == users_before
    assert "gp_session" not in response.headers.get("set-cookie", "")
    assert (
        _count(
            f"SELECT count(*) FROM auth_identities "
            f"WHERE user_id = '{user_id}' AND provider = 'google'"
        )
        == 1
    )
    assert _audit_count("auth.google.linked") == audit_before + 1


def test_link_google_identity_requires_enabled_provider(
    client: TestClient, oidc_provider, monkeypatch
):
    _login_email, username = _register_account(client)
    csrf = _password_login(client, username)
    _configure(monkeypatch, oidc_provider, AUTH_GOOGLE_ENABLED="false")

    response = client.post(
        "/api/v1/me/identities/google/link",
        json={},
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "AUTH_UNAVAILABLE"


def test_link_requires_recent_auth(client: TestClient, oidc_provider):
    _login_email, username = _register_account(client)
    csrf = _password_login(client, username)
    with SessionLocal() as session:
        session.execute(
            text("UPDATE users SET last_login_at = :t WHERE username_normalized = :u"),
            {"t": utcnow() - timedelta(hours=2), "u": username.lower()},
        )
        session.commit()

    started = client.post(
        "/api/v1/me/identities/google/link",
        json={},
        headers={"X-CSRF-Token": csrf},
    )
    assert started.status_code == 403
    assert started.json()["error"]["code"] == "REAUTH_REQUIRED"


def test_link_rejects_identity_bound_to_other_user(client: TestClient, oidc_provider):
    _login_email, username = _register_account(client)
    csrf = _password_login(client, username)
    taken_sub = _unique("sub")
    other_user_id = _seed_google_identity(oidc_provider, taken_sub)

    started = client.post(
        "/api/v1/me/identities/google/link",
        json={},
        headers={"X-CSRF-Token": csrf},
    )
    assert started.status_code == 200
    state = parse_qs(urlparse(started.json()["data"]["authorizeUrl"]).query)["state"][0]
    code = _mint_code(oidc_provider, state, sub=taken_sub)

    response = _callback(client, code=code, state=state)
    assert response.status_code == 302
    assert response.headers["location"] == "/account/security?error=identity_linked_elsewhere"
    assert (
        _count(
            f"SELECT count(*) FROM auth_identities "
            f"WHERE subject = '{taken_sub}' AND user_id != '{other_user_id}'"
        )
        == 0
    )


# --- 8. 解除 Google：纯 Google 不可解 / 有密码可解 ---


def test_unlink_rejected_when_google_is_only_sign_in(client: TestClient, oidc_provider):
    state = _start_login(client)
    code = _mint_code(oidc_provider, state, sub=_unique("sub"), email=f"{_unique('g')}@gmail.test")
    assert _callback(client, code=code, state=state).status_code == 302

    response = client.request(
        "DELETE", "/api/v1/me/identities/google", headers={"X-CSRF-Token": _csrf(client)}
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "LAST_SIGN_IN_METHOD"
    me = client.get("/api/v1/me").json()["data"]
    assert me["user"]["googleEmailBound"] is True


def test_unlink_succeeds_with_password_login(client: TestClient, oidc_provider):
    _login_email, username = _register_account(client)
    csrf = _password_login(client, username)
    sub = _unique("sub")
    with SessionLocal() as session:
        me_user_id = client.get("/api/v1/me").json()["data"]["user"]["id"]
        session.add(
            AuthIdentity(
                id=new_token()[:32],
                provider="google",
                issuer=oidc_provider.issuer,
                subject=sub,
                user_id=uuid.UUID(me_user_id),
                google_email=f"{_unique('g')}@gmail.test",
                last_authenticated_at=utcnow(),
            )
        )
        session.commit()
    audit_before = _audit_count("auth.google.unlinked")

    response = client.request(
        "DELETE", "/api/v1/me/identities/google", headers={"X-CSRF-Token": csrf}
    )
    assert response.status_code == 200
    assert response.json()["data"]["googleEmailBound"] is False
    assert _count(f"SELECT count(*) FROM auth_identities WHERE subject = '{sub}'") == 0
    assert _audit_count("auth.google.unlinked") == audit_before + 1


# --- 9. 新 Google 用户在完成资料/学校邮箱验证前不得进入业务 ---


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


def test_new_google_user_blocked_by_registration_gate(client: TestClient, oidc_provider):
    state = _start_login(client)
    code = _mint_code(oidc_provider, state, sub=_unique("sub"), email=f"{_unique('g')}@gmail.test")
    assert _callback(client, code=code, state=state).status_code == 302

    business_client = TestClient(_business_app())
    for cookie in client.cookies.jar:
        business_client.cookies.set(cookie.name, cookie.value)
    blocked = business_client.get("/whoami")
    assert blocked.status_code == 403
    assert blocked.json()["error"]["code"] == "REGISTRATION_REQUIRED"
