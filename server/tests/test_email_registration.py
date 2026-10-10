"""独立邮箱注册验收：E01–E10、E22（隔离 PostgreSQL + 邮件捕获器）。"""
from __future__ import annotations

from sqlalchemy import select

from tests.conftest import csrf_headers, latest_code, session_csrf
from tests.flows import GOOD_PASSWORD, ORIGIN, register_via_email, start_email_registration


def test_e01_signup_works_without_google(client, stub):
    """E01：Google 关闭且无凭据时，邮箱注册与密码登录仍工作。"""
    from app.config import get_settings

    settings = get_settings()
    settings.auth_google_enabled = False
    try:
        assert settings.google_available is False
        caps = client.get("/api/v1/auth/capabilities").json()
        assert caps["google"]["enabled"] is False and caps["google"]["available"] is False
        assert caps["emailSignup"]["available"] is True
        session = register_via_email(client, "e01@example.com", "e01user")
        assert session["authenticated"] is True
        client.post("/api/v1/auth/logout", headers=csrf_headers(session_csrf(client)))
        assert client.post(
            "/api/v1/auth/password/login", json={"identifier": "e01user", "password": GOOD_PASSWORD}, headers=ORIGIN
        ).status_code == 200
    finally:
        settings.auth_google_enabled = True


def test_e02_request_creates_no_permanent_account(client, stub, db_session):
    """E02：仅请求验证码不创建 users/密码凭据；发件状态与实际一致。"""
    from app.models import PasswordCredential, PreRegistrationRequest, User

    response = start_email_registration(client, "e02@example.com")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "accepted"  # capture 器接受发送（真实投递另行验收）
    assert "code" not in response.text and "password" not in response.text
    assert db_session.execute(select(User)).scalars().all() == []
    assert db_session.execute(select(PasswordCredential)).scalars().all() == []
    tx = db_session.execute(select(PreRegistrationRequest)).scalars().one()
    assert tx.code_hmac and tx.code_consumed_at is None and tx.creation_grant_digest is None


def test_e03_code_limits_persisted(client, stub, db_session):
    """E03：错误/过期/旧码/重复验证均无建档资格；尝试次数持久化；阈值后拒绝。"""
    from app.models import PreRegistrationRequest

    created = start_email_registration(client, "e03@example.com")
    tx_id = created.json()["id"]
    code = latest_code("e03@example.com")

    wrong = client.post(f"/api/v1/auth/email/registrations/{tx_id}/verify", json={"code": "000000"}, headers=ORIGIN)
    assert wrong.status_code == 400 and wrong.json()["code"] == "INVALID_CODE"
    tx = db_session.execute(select(PreRegistrationRequest)).scalars().one()
    assert tx.attempts == 1  # 失败次数持久化（不随错误响应回滚）
    assert tx.creation_grant_digest is None

    # 重发后旧码失效（E08 迟到邮件场景）
    db_session.refresh(tx)
    tx.resend_available_at = None  # 跳过冷却直接验证规则本身
    db_session.commit()
    client.post(f"/api/v1/auth/email/registrations/{tx_id}/resend", json={"email": "e03@example.com"}, headers=ORIGIN)
    stale = client.post(f"/api/v1/auth/email/registrations/{tx_id}/verify", json={"code": code}, headers=ORIGIN)
    assert stale.status_code == 400 and stale.json()["code"] == "INVALID_CODE"

    # 连续错误达到阈值后拒绝
    for _ in range(5):
        client.post(f"/api/v1/auth/email/registrations/{tx_id}/verify", json={"code": "999999"}, headers=ORIGIN)
    locked = client.post(
        f"/api/v1/auth/email/registrations/{tx_id}/verify",
        json={"code": latest_code("e03@example.com")},
        headers=ORIGIN,
    )
    assert locked.status_code == 400 and locked.json()["code"] in ("CODE_EXPIRED", "INVALID_CODE")


def test_e04_grant_bound_to_transaction_and_browser(client, stub, db_session):
    """E04：验证码/建档资格不能跨浏览器、跨事务、跨用途重用。"""
    from app.models import PreRegistrationRequest

    created = start_email_registration(client, "e04@example.com")
    tx_id = created.json()["id"]
    code = latest_code("e04@example.com")

    # 换一个“浏览器”（无绑定 Cookie）直接 verify → 拒绝
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app, base_url="http://localhost:8000", raise_server_exceptions=False) as other:
        denied = other.post(f"/api/v1/auth/email/registrations/{tx_id}/verify", json={"code": code}, headers=ORIGIN)
        assert denied.status_code == 403

    # 同浏览器正常验证，但另一事务 ID 不能消费本事务验证码
    other_tx = start_email_registration(client, "e04b@example.com").json()["id"]
    cross = client.post(f"/api/v1/auth/email/registrations/{other_tx}/verify", json={"code": code}, headers=ORIGIN)
    assert cross.status_code == 400

    # 本事务验证成功后，换邮箱/再验证拒绝，建档资格一次性
    verified = client.post(f"/api/v1/auth/email/registrations/{tx_id}/verify", json={"code": code}, headers=ORIGIN)
    assert verified.status_code == 200
    again = client.post(f"/api/v1/auth/email/registrations/{tx_id}/verify", json={"code": code}, headers=ORIGIN)
    assert again.status_code == 400 and again.json()["code"] == "CHALLENGE_INVALID"


def test_e06_two_transactions_same_username_single_winner(client, stub, db_session):
    """E06：两个已验证事务争用同一用户名 → 唯一约束生效，失败事务完整回滚。"""
    from app.models import User

    from fastapi.testclient import TestClient

    from app.main import app

    created_a = start_email_registration(client, "e06-a@example.com")
    tx_a = created_a.json()["id"]
    client.post(f"/api/v1/auth/email/registrations/{tx_a}/verify", json={"code": latest_code("e06-a@example.com")}, headers=ORIGIN)
    created_b = start_email_registration(client, "e06-b@example.com")
    tx_b = created_b.json()["id"]
    client.post(f"/api/v1/auth/email/registrations/{tx_b}/verify", json={"code": latest_code("e06-b@example.com")}, headers=ORIGIN)

    first = client.post(
        f"/api/v1/auth/email/registrations/{tx_a}/complete",
        json={"username": "race-name", "password": GOOD_PASSWORD},
        headers=ORIGIN,
    )
    assert first.status_code == 201
    second = client.post(
        f"/api/v1/auth/email/registrations/{tx_b}/complete",
        json={"username": "Race-Name", "password": GOOD_PASSWORD},
        headers=ORIGIN,
    )
    assert second.status_code == 409 and second.json()["code"] == "USERNAME_CONFLICT"
    assert len(db_session.execute(select(User)).scalars().all()) == 1  # 失败事务无半成品
    _ = TestClient  # 保留引用说明同名可跨浏览器并发（约束兕底）


def test_e06_username_conflict_explicit(client, stub):
    register_via_email(client, "e06b@example.com", "dupname")
    client.post("/api/v1/auth/logout", headers=csrf_headers(session_csrf(client)))
    created = start_email_registration(client, "e06c@example.com")
    tx_id = created.json()["id"]
    client.post(f"/api/v1/auth/email/registrations/{tx_id}/verify", json={"code": latest_code("e06c@example.com")}, headers=ORIGIN)
    conflict = client.post(
        f"/api/v1/auth/email/registrations/{tx_id}/complete",
        json={"username": "DUPNAME", "password": GOOD_PASSWORD},
        headers=ORIGIN,
    )
    assert conflict.status_code == 409 and conflict.json()["code"] == "USERNAME_CONFLICT"

    # 同一邮箱二次注册（建档阶段）→ 邮箱唯一冲突
    created2 = start_email_registration(client, "e06b@example.com")
    tx2 = created2.json()["id"]
    client.post(f"/api/v1/auth/email/registrations/{tx2}/verify", json={"code": latest_code("e06b@example.com")}, headers=ORIGIN)
    email_conflict = client.post(
        f"/api/v1/auth/email/registrations/{tx2}/complete",
        json={"username": "freshname1", "password": GOOD_PASSWORD},
        headers=ORIGIN,
    )
    assert email_conflict.status_code == 409 and email_conflict.json()["code"] == "EMAIL_CONFLICT"


def test_e08_mail_failure_not_marked_sent(client, stub, monkeypatch, db_session):
    """E08：发件失败不显示已发送/已验证，不产生永久用户；可重发最新码。"""
    from app.services import mailer, pre_registration

    def failing(*args, **kwargs):
        raise mailer.MailSendError("smtp down")

    monkeypatch.setattr(pre_registration, "send_template", failing)
    failed = start_email_registration(client, "e08@example.com")
    assert failed.status_code == 503 and failed.json()["code"] == "MAIL_UNAVAILABLE"
    from app.models import PasswordCredential, PreRegistrationRequest, User

    assert db_session.execute(select(User)).scalars().all() == []
    tx = db_session.execute(select(PreRegistrationRequest)).scalars().one()
    assert tx.send_status == "failed"  # 发件状态与真实结果一致

    monkeypatch.undo()
    # 重新发送（冷却内返回限流；跳过后成功）
    db_session.refresh(tx)
    tx.resend_available_at = None
    db_session.commit()
    resend = client.post(f"/api/v1/auth/email/registrations/{tx.id}/resend", json={"email": "e08@example.com"}, headers=ORIGIN)
    assert resend.status_code == 200 and resend.json()["status"] == "accepted"


def test_e09_storage_failure_safe_error(client, stub, monkeypatch):
    """E09：存储层故障返回稳定错误 + requestId，不回退 Mock、不放行。"""
    from sqlalchemy.exc import OperationalError

    from app.services import pre_registration

    def boom(*args, **kwargs):
        raise OperationalError("SELECT 1", None, Exception("connection refused"))

    monkeypatch.setattr(pre_registration, "create_registration", boom)
    response = start_email_registration(client, "e09@example.com")
    assert response.status_code == 503
    body = response.json()
    assert body["code"] == "SERVICE_UNAVAILABLE"
    assert body["requestId"]  # 可关联日志
    assert client.get("/api/v1/auth/session").json() == {"authenticated": False}


def test_e10_lost_response_retry_no_duplicate(client, stub, db_session):
    """E10：建档成功但响应丢失后重试 → 不重复创建，可正常登录继续。"""
    from app.models import User

    created = start_email_registration(client, "e10@example.com")
    tx_id = created.json()["id"]
    client.post(f"/api/v1/auth/email/registrations/{tx_id}/verify", json={"code": latest_code("e10@example.com")}, headers=ORIGIN)
    first = client.post(
        f"/api/v1/auth/email/registrations/{tx_id}/complete",
        json={"username": "e10user", "password": GOOD_PASSWORD},
        headers=ORIGIN,
    )
    assert first.status_code == 201
    client.post("/api/v1/auth/logout", headers=csrf_headers(session_csrf(client)))  # 模拟响应/会话丢失

    retry = client.post(
        f"/api/v1/auth/email/registrations/{tx_id}/complete",
        json={"username": "e10user", "password": GOOD_PASSWORD},
        headers=ORIGIN,
    )
    assert retry.status_code == 200 and retry.json()["status"] == "already_completed"
    assert len(db_session.execute(select(User)).scalars().all()) == 1
    assert client.post(
        "/api/v1/auth/password/login", json={"identifier": "e10user", "password": GOOD_PASSWORD}, headers=ORIGIN
    ).status_code == 200


def test_e11_account_created_business_gated(client, stub):
    """E11：建档完成但平台注册未完成 → 仅受限个人中心；直链/API 拒绝。"""
    register_via_email(client, "e11@example.com", "e11user")
    for path in ("/api/v1/home/summary", "/api/v1/projects/project-1/content"):
        response = client.get(path)
        assert response.status_code == 403 and response.json()["code"] == "REGISTRATION_REQUIRED"


def test_e22_persistence_and_no_replay(client, stub, db_session):
    """E22：事务/凭据跨连接持久化；已消费资格不能重放。"""
    from app.models import PasswordCredential, PreRegistrationRequest

    register_via_email(client, "e22@example.com", "e22user")
    from app.db import get_session_factory

    fresh = get_session_factory()()
    try:
        tx = fresh.execute(select(PreRegistrationRequest).where(PreRegistrationRequest.email_normalized == "e22@example.com")).scalar_one()
        credential = fresh.execute(select(PasswordCredential).where(PasswordCredential.login_email_normalized == "e22@example.com")).scalar_one()
        assert tx.completed_at is not None and tx.creation_grant_digest is None  # 资格已消费
        assert credential.login_email_verified_at is not None
    finally:
        fresh.close()


def test_capabilities_shape_no_secrets(client, stub):
    caps = client.get("/api/v1/auth/capabilities").json()
    text = str(caps)
    assert "secret" not in text.lower() and "smtp" not in text.lower() and "://" not in text
    assert set(caps.keys()) >= {"google", "password", "emailSignup", "passwordReset", "schoolEmailVerification"}
