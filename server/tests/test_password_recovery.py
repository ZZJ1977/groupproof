"""密码找回/重置与历史账户边界：E13–E17、E15。"""
from __future__ import annotations

from datetime import timedelta

from sqlalchemy import select

from tests.conftest import csrf_headers, latest_reset_token, session_csrf
from tests.flows import GOOD_PASSWORD, ORIGIN, register_via_email


def forgot(client, email):
    return client.post("/api/v1/auth/password/forgot", json={"email": email, "locale": "zh-Hans"}, headers=ORIGIN)


def reset(client, token, new_password=GOOD_PASSWORD + "-v2"):
    return client.post("/api/v1/auth/password/reset", json={"token": token, "newPassword": new_password}, headers=ORIGIN)


def login_password(client, identifier, password=GOOD_PASSWORD):
    return client.post("/api/v1/auth/password/login", json={"identifier": identifier, "password": password}, headers=ORIGIN)


def test_e13_forgot_uniform_response(client, stub, db_session):
    """E13：存在/不存在账户的找回请求返回相同安全反馈。"""
    register_via_email(client, "e13@example.com", "e13user")
    client.post("/api/v1/auth/logout", headers=csrf_headers(session_csrf(client)))
    existing = forgot(client, "e13@example.com")
    missing = forgot(client, "nobody-here@example.com")
    assert existing.status_code == missing.status_code == 200
    assert existing.json() == missing.json() == {"status": "sent"}
    # 不存在账户不发信（捕获器中无该收件人）
    from app.models import EmailOutbox

    rows = db_session.execute(select(EmailOutbox).where(EmailOutbox.to_email == "nobody-here@example.com")).scalars().all()
    assert rows == []


def test_e14_reset_token_single_use_and_version_bound(client, stub, db_session):
    """E14：恢复凭据单次消费、过期/重放/版本变化拒绝；成功后旧密码、旧会话与其他凭据失效。"""
    from datetime import timedelta

    from app.models import EmailChallenge, Session, utcnow

    register_via_email(client, "e14@example.com", "e14user")
    client.post("/api/v1/auth/logout", headers=csrf_headers(session_csrf(client)))
    assert login_password(client, "e14user").status_code == 200  # 建立一个现存会话
    stale_session_cookie = client.cookies.get("gp_session")

    forgot(client, "e14@example.com")
    token = latest_reset_token("e14@example.com")

    # 未提交前：原密码与会话保持可用（E15）
    assert login_password(client, "e14user").status_code == 200

    # 错误令牌拒绝
    assert reset(client, "not-a-real-token").status_code == 400

    ok = reset(client, token)
    assert ok.status_code == 200, ok.text

    # 旧密码失效、新密码可登录
    assert login_password(client, "e14user").status_code == 401
    assert login_password(client, "e14user", GOOD_PASSWORD + "-v2").status_code == 200

    # 旧会话被撤销（重置前建立的会话 Cookie 失效）
    client.cookies.clear()
    client.cookies.set("gp_session", stale_session_cookie)
    assert client.get("/api/v1/auth/session").json() == {"authenticated": False}

    # 重放同一令牌拒绝
    assert reset(client, token).status_code == 400

    # 其他恢复凭据被撤销：再次找回后旧令牌在新令牌签发后失效
    client.cookies.clear()
    forgot(client, "e14@example.com")
    token2 = latest_reset_token("e14@example.com")
    assert token2 != token
    client.post("/api/v1/auth/password/reset", json={"token": token2, "newPassword": GOOD_PASSWORD + "-v3"}, headers=ORIGIN)
    assert reset(client, token2, GOOD_PASSWORD + "-v4").status_code == 400  # 单次消费


def test_e14_expired_token_rejected(client, stub, db_session):
    from app.models import EmailChallenge, utcnow

    register_via_email(client, "e14b@example.com", "e14buser")
    client.post("/api/v1/auth/logout", headers=csrf_headers(session_csrf(client)))
    forgot(client, "e14b@example.com")
    token = latest_reset_token("e14b@example.com")

    # 让恢复凭据过期（模拟时间流逝）
    for row in db_session.execute(select(EmailChallenge).where(EmailChallenge.purpose == "password_recovery")).scalars():
        row.expires_at = utcnow() - timedelta(seconds=1)
    db_session.commit()

    expired = reset(client, token)
    assert expired.status_code == 400 and expired.json()["params"].get("reason") == "reset_token_expired"


def test_e15_forgot_only_does_not_change_password(client, stub):
    """E15：只请求找回不提交凭据 → 原密码与当前会话保持可用。"""
    register_via_email(client, "e15@example.com", "e15user")
    csrf = session_csrf(client)
    forgot(client, "e15@example.com")
    # 会话仍在、原密码仍可登录
    assert client.get("/api/v1/auth/session").json()["authenticated"] is True
    client.post("/api/v1/auth/logout", headers=csrf_headers(csrf))
    assert login_password(client, "e15user").status_code == 200


def test_e17_unverified_legacy_email_cannot_be_taken_over(client, stub, db_session):
    """E17：历史未验证登录邮箱不能被第三人用于新注册/找回接管旧账户。"""
    from app.models import PasswordCredential, User
    from app.security import hash_password_legacy

    user = User(id="u-legacy-3", username="legacy3", username_normalized="legacy3", account_status="enabled")
    db_session.add(user)
    db_session.add(
        PasswordCredential(
            user_id=user.id,
            login_email="legacy3@example.com",
            login_email_normalized="legacy3@example.com",
            password_hash=hash_password_legacy(GOOD_PASSWORD),
            password_algo="bcrypt",
        )
    )
    db_session.commit()

    # 找回：未验证登录邮箱不发放恢复凭据（静默，无枚举）
    response = forgot(client, "legacy3@example.com")
    assert response.status_code == 200 and response.json() == {"status": "sent"}
    from app.models import EmailChallenge, EmailOutbox

    assert db_session.execute(select(EmailChallenge).where(EmailChallenge.purpose == "password_recovery")).scalars().all() == []
    assert db_session.execute(select(EmailOutbox)).scalars().all() == []

    # 新注册同邮箱：建档时邮箱唯一约束拒绝，不接管旧账户
    from tests.conftest import latest_code
    from tests.flows import start_email_registration

    created = start_email_registration(client, "legacy3@example.com")
    tx_id = created.json()["id"]
    client.post(f"/api/v1/auth/email/registrations/{tx_id}/verify", json={"code": latest_code("legacy3@example.com")}, headers=ORIGIN)
    takeover = client.post(
        f"/api/v1/auth/email/registrations/{tx_id}/complete",
        json={"username": "attacker1", "password": GOOD_PASSWORD},
        headers=ORIGIN,
    )
    assert takeover.status_code == 409 and takeover.json()["code"] == "EMAIL_CONFLICT"
    fresh = db_session.execute(select(User).where(User.id == "u-legacy-3")).scalar_one()
    assert fresh.username_normalized == "legacy3"  # 旧账户未被改写


def test_password_reset_mail_unavailable_uniform(client, stub, monkeypatch):
    """邮件整体不可用时：任何邮箱的找回请求都得到一致的不可用反馈（不跳过验证）。"""
    from app.services import password_recovery

    monkeypatch.setattr(password_recovery, "send_template", lambda *a, **k: (_ for _ in ()).throw(password_recovery.MailSendError("down")))
    register_via_email(client, "e15b@example.com", "e15buser")
    client.post("/api/v1/auth/logout", headers=csrf_headers(session_csrf(client)))
    response = forgot(client, "e15b@example.com")
    assert response.status_code == 503 and response.json()["code"] == "MAIL_UNAVAILABLE"
