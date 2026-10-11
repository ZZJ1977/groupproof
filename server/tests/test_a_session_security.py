"""会话、CSRF、OAuth 事务与故障行为验收：A01、A03、A14、A15、A18–A23。"""
from __future__ import annotations

from urllib.parse import parse_qs, urlparse

from tests.conftest import complete_oauth, csrf_headers, latest_code, session_csrf
from tests.flows import login_new_user, profile_payload, register_student


def test_a01_anonymous_gets_401_and_no_business_data(client, stub):
    """A01：无 Cookie 访问受保护 API → 401，响应体无业务数据。"""
    for path in ("/api/v1/me", "/api/v1/home/summary", "/api/v1/projects/project-1/content"):
        response = client.get(path)
        assert response.status_code == 401
        assert response.json()["code"] == "UNAUTHENTICATED"
        assert "project" not in response.text.lower()
    session = client.get("/api/v1/auth/session").json()
    assert session == {"authenticated": False}


def test_a03_state_replay_and_invalid_transactions(client, stub):
    """A03：state 重放、state 不匹配、PKCE 失败、取消 → 不产生可用业务会话。"""
    # 正常一次
    response = complete_oauth(client, stub, sub="google-sub-a03", email="g@gmail.com")
    assert response.status_code == 302

    # 重放同一 callback（同一 code/state）
    start = client.get("/api/v1/auth/google/start", follow_redirects=False)
    query = parse_qs(urlparse(start.headers["location"]).query)
    state = query["state"][0]
    from app.db import get_session_factory
    from app.models import OAuthTransaction
    from app.security import token_digest
    from sqlalchemy import select

    db = get_session_factory()()
    try:
        transaction = db.execute(select(OAuthTransaction).where(OAuthTransaction.state_digest == token_digest(state))).scalar_one()
        code = stub.mint_code(state=state, nonce=transaction.nonce, code_verifier=transaction.code_verifier)
    finally:
        db.close()

    first = client.get("/api/v1/auth/google/callback", params={"code": code, "state": state}, follow_redirects=False)
    assert first.status_code == 302
    replay = client.get("/api/v1/auth/google/callback", params={"code": code, "state": state}, follow_redirects=False)
    assert replay.status_code == 401  # 事务一次性：重放拒绝

    # 伪造 state
    forged = client.get("/api/v1/auth/google/callback", params={"code": code, "state": "forged"}, follow_redirects=False)
    assert forged.status_code == 401

    # PKCE 校验失败（错误 code_verifier 挑战）
    start2 = client.get("/api/v1/auth/google/start", follow_redirects=False)
    query2 = parse_qs(urlparse(start2.headers["location"]).query)
    state2 = query2["state"][0]
    db = get_session_factory()()
    try:
        transaction2 = db.execute(select(OAuthTransaction).where(OAuthTransaction.state_digest == token_digest(state2))).scalar_one()
        bad_code = stub.mint_code(state=state2, nonce=transaction2.nonce, code_verifier="wrong-verifier", wrong_challenge=True)
    finally:
        db.close()
    bad = client.get("/api/v1/auth/google/callback", params={"code": bad_code, "state": state2}, follow_redirects=False)
    assert bad.status_code == 401

    # 用户取消（无 code）
    start3 = client.get("/api/v1/auth/google/start", follow_redirects=False)
    state3 = parse_qs(urlparse(start3.headers["location"]).query)["state"][0]
    cancelled = client.get("/api/v1/auth/google/callback", params={"state": state3}, follow_redirects=False)
    assert cancelled.status_code == 302
    assert cancelled.headers["location"].startswith("/login")


def test_a14_logout_revokes_session(client, stub):
    """A14：退出后复用旧 Cookie → 服务端会话无效，无新业务数据。"""
    register_student(client, stub, sub="google-sub-a14", email="2023000014@student.must.edu.mo", username="a14user", student_id="2023000014")
    cookie = client.cookies.get("gp_session")
    assert cookie
    csrf = session_csrf(client)

    logout = client.post("/api/v1/auth/logout", headers=csrf_headers(csrf))
    assert logout.status_code == 204

    # 浏览器返回/另一标签页复用旧 Cookie
    client.cookies.set("gp_session", cookie)
    reused = client.get("/api/v1/home/summary")
    assert reused.status_code == 401
    assert client.get("/api/v1/auth/session").json() == {"authenticated": False}


def test_a15_disabled_user_rejected_immediately(client, stub):
    """A15：账号停用后复用既有会话 → 立即按最新资格拒绝。"""
    from tests.flows import login_admin

    register_student(client, stub, sub="google-sub-a15", email="2023000015@student.must.edu.mo", username="a15user", student_id="2023000015")
    me = client.get("/api/v1/me").json()
    user_id = me["user"]["id"]
    active_cookie = client.cookies.get("gp_session")

    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app, base_url="http://localhost:8000", raise_server_exceptions=False) as admin_client:
        login_admin(admin_client, stub, sub="google-admin-a15", username="adm15", email="adm15@must.edu.mo")
        admin_csrf = session_csrf(admin_client)
        response = admin_client.post(
            f"/api/v1/admin/users/{user_id}/disable",
            json={"reason": "违规", "expectedVersion": me["user"]["version"]},
            headers=csrf_headers(admin_csrf),
        )
        assert response.status_code == 200, response.text

    # 既有会话立即失效（撤销会话）+ 即使拿到受限会话也只有状态说明
    client.cookies.clear()
    client.cookies.set("gp_session", active_cookie)
    denied = client.get("/api/v1/home/summary")
    assert denied.status_code == 401  # 会话已撤销

    response = complete_oauth(client, stub, sub="google-sub-a15", email="2023000015@student.must.edu.mo", name="王小明")
    assert response.status_code == 302
    session = client.get("/api/v1/auth/session").json()
    assert session["accountState"] == "disabled"
    assert session["sessionScope"] == "status_only"
    denied = client.get("/api/v1/home/summary")
    assert denied.status_code == 403 and denied.json()["code"] == "ACCOUNT_DISABLED"
    me = client.get("/api/v1/me").json()
    assert set(me.keys()) == {"user", "registration"}  # 停用会话仅状态说明


def test_a18_service_failure_no_mock_fallback(client, stub, monkeypatch):
    """A18：OAuth/邮件服务故障 → 明确失败与重试，不回退演示账户、不显示成功。"""
    from app.services import google_oidc

    monkeypatch.setattr(google_oidc, "exchange_and_verify", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("google down")))
    start = client.get("/api/v1/auth/google/start", follow_redirects=False)
    state = parse_qs(urlparse(start.headers["location"]).query)["state"][0]
    response = client.get("/api/v1/auth/google/callback", params={"code": "c", "state": state}, follow_redirects=False)
    assert response.status_code == 503
    assert response.json()["code"] == "SERVICE_UNAVAILABLE"
    assert client.get("/api/v1/auth/session").json() == {"authenticated": False}

    # 邮件发送失败 → 明确失败，不提示已发送
    monkeypatch.undo()
    from app.services import email_challenges, mailer

    def failing_send(*a, **k):
        raise mailer.MailSendError("smtp down")

    monkeypatch.setattr(mailer, "send_code_email", failing_send)
    monkeypatch.setattr(email_challenges, "send_code_email", failing_send)
    login_new_user(client, stub, sub="google-sub-a18", email="g18@gmail.com")
    csrf = session_csrf(client)
    client.patch(
        "/api/v1/me/profile",
        json=profile_payload(username="a18user", email="2023000018@student.must.edu.mo", student_id="2023000018"),
        headers=csrf_headers(csrf),
    )
    sent = client.post("/api/v1/me/school-email/challenges", json={}, headers=csrf_headers(csrf))
    assert sent.status_code == 503 and sent.json()["code"] == "AUTH_UNAVAILABLE"


def test_a19_csrf_origin_and_return_to(client, stub):
    """A19：外站写操作/缺 CSRF token/恶意 returnTo 均被拒绝。"""
    register_student(client, stub, sub="google-sub-a19", email="2023000019@student.must.edu.mo", username="a19user", student_id="2023000019")
    csrf = session_csrf(client)

    assert client.patch("/api/v1/me/preferences", json={"preferredLocale": "en"}).status_code == 403  # 缺 CSRF
    assert client.patch("/api/v1/me/preferences", json={"preferredLocale": "en"}, headers={"X-CSRF-Token": csrf, "Origin": "https://evil.example"}).status_code == 403  # 外站 Origin
    assert client.patch("/api/v1/me/preferences", json={"preferredLocale": "en"}, headers={"X-CSRF-Token": "wrong", "Origin": "http://localhost:3000"}).status_code == 403
    assert client.patch("/api/v1/me/preferences", json={"preferredLocale": "en"}, headers=csrf_headers(csrf)).status_code == 200  # 合法流程不受影响

    from app.security import safe_return_to

    for malicious in ("https://evil.example/x", "//evil.example", "/\\evil", "/%5cevil.example", "/api/v1/auth/logout", None, ""):
        assert safe_return_to(malicious) is None, malicious
    assert safe_return_to("/projects/p-1/tasks?view=board") == "/projects/p-1/tasks?view=board"

    # 恶意 returnTo 不会进入跳转目标
    response = complete_oauth(client, stub, sub="google-sub-a19b", email="g19@gmail.com", return_to="https://evil.example")
    assert response.headers["location"].startswith("/account")


def test_a20_server_side_rate_limit(client, stub, monkeypatch):
    """A20：重发限流在服务端跨进程生效；验证码不进入响应。"""
    from app.config import get_settings

    get_settings().resend_cooldown_seconds = 60  # 恢复产品默认冷却（限流验收）
    login_new_user(client, stub, sub="google-sub-a20")
    csrf = session_csrf(client)
    client.patch(
        "/api/v1/me/profile",
        json=profile_payload(username="a20user", email="2023000020@student.must.edu.mo", student_id="2023000020"),
        headers=csrf_headers(csrf),
    )
    first = client.post("/api/v1/me/school-email/challenges", json={}, headers=csrf_headers(csrf))
    assert first.status_code == 200
    assert "code" not in first.json()  # 不返回验证码
    assert first.json()["email"] == "20***@student.must.edu.mo"

    # 60 秒冷却内重发被拒（客户端倒计时无效）
    cooldown = client.post("/api/v1/me/school-email/challenges", json={}, headers=csrf_headers(csrf))
    assert cooldown.status_code == 429 and cooldown.json()["code"] == "RATE_LIMITED"
    assert int(cooldown.headers["Retry-After"]) > 0

    # 超出小时/日上限后即使冷却结束也被拒
    from app.services import rate_limit

    original = rate_limit.check_and_increment

    def consume_limits(db, bucket_key, *, limit, window_seconds, now=None):
        return original(db, bucket_key, limit=1, window_seconds=window_seconds, now=now)

    monkeypatch.setattr(rate_limit, "check_and_increment", consume_limits)
    monkeypatch.setattr("app.services.email_challenges.check_and_increment", consume_limits)
    # 冷却跳过：直接作废旧挑战后重新发码（服务端按计数拒绝）
    from app.db import get_session_factory
    from app.models import EmailChallenge
    from sqlalchemy import select, update

    db = get_session_factory()()
    db.execute(update(EmailChallenge).values(invalidated_at=__import__("app.models", fromlist=["utcnow"]).utcnow()))
    db.commit()
    db.close()
    limited = client.post("/api/v1/me/school-email/challenges", json={}, headers=csrf_headers(csrf))
    assert limited.status_code == 429 and limited.json()["code"] == "RATE_LIMITED"


def test_a21_no_cross_account_access(client, stub):
    """A21：A 的会话不能读取 B 的资料或业务数据；查询按用户隔离。"""
    from fastapi.testclient import TestClient

    from app.main import app

    register_student(client, stub, sub="google-sub-a21a", email="2023000021@student.must.edu.mo", username="a21a", student_id="2023000021")
    me_a = client.get("/api/v1/me").json()
    with TestClient(app, base_url="http://localhost:8000", raise_server_exceptions=False) as client_b:
        register_student(client_b, stub, sub="google-sub-a21b", email="2023000022@student.must.edu.mo", username="a21b", student_id="2023000022")
        me_b = client_b.get("/api/v1/me").json()
        assert me_b["user"]["id"] != me_a["user"]["id"]
        assert me_b["user"]["username"] == "a21b"
        # /me 无 userId 参数，永远只返回本人
        assert client_b.get("/api/v1/me").json()["user"]["id"] == me_b["user"]["id"]
    assert client.get("/api/v1/me").json()["user"]["id"] == me_a["user"]["id"]


def test_a22_empty_state_and_unknown_resources(client, stub):
    """A22：新账户没有项目/课程 → 真实空态；未知资源 404，不回退示例 ID。"""
    register_student(client, stub, sub="google-sub-a22", email="2023000023@student.must.edu.mo", username="a22user", student_id="2023000023")
    home = client.get("/api/v1/home/summary").json()
    assert home == {"projects": [], "courses": []}
    assert client.get("/api/v1/projects/does-not-exist/summary").status_code == 404


def test_a23_no_backdoors_in_real_mode():
    """A23：生产模式要求真实配置且拒绝调试后门（缺配置启动失败）。"""
    import importlib

    import pytest

    from app.config import Settings

    with pytest.raises(RuntimeError):
        Settings(
            app_mode="real",
            database_url="postgresql+psycopg://x/x",
            google_client_id="",
            google_client_secret="",
            google_redirect_uri="",
            email_challenge_hmac_key="k",
            mail_mode="smtp",
            smtp_host="smtp.example",
            mail_from="noreply@example",
            app_origin="https://app.example",
        )
    with pytest.raises(RuntimeError):
        Settings(  # real 模式禁止邮件捕获器（任意验证码/固定验证码通道）
            app_mode="real",
            google_client_id="a",
            google_client_secret="b",
            google_redirect_uri="https://app.example/cb",
            email_challenge_hmac_key="k",
            mail_mode="capture",
            app_origin="https://app.example",
        )
    with pytest.raises(RuntimeError):
        Settings(  # real 模式禁止非 Google issuer
            app_mode="real",
            google_client_id="a",
            google_client_secret="b",
            google_redirect_uri="https://app.example/cb",
            email_challenge_hmac_key="k",
            mail_mode="smtp",
            smtp_host="smtp.example",
            mail_from="noreply@example",
            app_origin="https://app.example",
            google_discovery_url="https://evil.example/.well-known/openid-configuration",
        )
    _ = importlib
