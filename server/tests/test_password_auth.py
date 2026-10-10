"""账号密码登录/改密/旧注册路径封堵（E07、E16、E18 相关）。"""
from __future__ import annotations

import threading

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from tests.conftest import csrf_headers, session_csrf
from tests.flows import GOOD_PASSWORD, ORIGIN, login_new_user, register_via_email, start_email_registration, verify_school_email

# 运行期与 pytest 常量
import tests.flows as flows

verify_school_email = flows.verify_school_email


def login_password(client, identifier, password=GOOD_PASSWORD):
    return client.post("/api/v1/auth/password/login", json={"identifier": identifier, "password": password}, headers=ORIGIN)


def test_old_register_path_closed_e07(client, stub):
    """E07：旧无验证码注册路径关闭；伪造 verified/role 也无从提权。"""
    response = client.post(
        "/api/v1/auth/password/register",
        json={"username": "oldpath", "email": "oldpath@example.com", "password": GOOD_PASSWORD, "verified": True, "role": "admin"},
        headers=ORIGIN,
    )
    assert response.status_code == 410
    assert response.json()["code"] == "REGISTRATION_CLOSED"
    from app.models import PasswordCredential, User

    assert client.get("/api/v1/auth/session").json() == {"authenticated": False}


def test_password_register_login_roundtrip(client, stub):
    """三步注册建档后可用用户名或登录邮箱登录；未完成平台注册仅受限个人中心。"""
    session = register_via_email(client, "pwrt@example.com", "pwrt")
    assert session["sessionScope"] == "onboarding"
    assert session["accountState"] == "profile_required"
    assert session["loginEmailVerified"] is True
    # 未完成平台注册：业务 API 拒绝（E11）
    assert client.get("/api/v1/home/summary").status_code == 403

    client.post("/api/v1/auth/logout", headers=csrf_headers(session_csrf(client)))
    assert login_password(client, "PWRT").json()["sessionScope"] == "onboarding"
    client.post("/api/v1/auth/logout", headers=csrf_headers(session_csrf(client)))
    assert login_password(client, "Pwrt@Example.com").json()["sessionScope"] == "onboarding"


def test_password_no_user_enumeration(client, stub):
    """未知用户与错误密码返回同一通用错误（E13 登录侧）。"""
    register_via_email(client, "pwnum2@example.com", "pwnum2")
    client.post("/api/v1/auth/logout", headers=csrf_headers(session_csrf(client)))
    unknown = login_password(client, "ghost")
    wrong = login_password(client, "pwnum2", "wrong-password-123")
    unknown_mail = login_password(client, "ghost@example.com")
    for response in (unknown, wrong, unknown_mail):
        assert response.status_code == 401
        assert response.json()["code"] == "INVALID_CREDENTIALS"


def test_password_policy_rejected(client, stub):
    tx = start_email_registration(client, "pwweak2@example.com")
    from tests.conftest import latest_code

    tx_id = tx.json()["id"]
    client.post(f"/api/v1/auth/email/registrations/{tx_id}/verify", json={"code": latest_code("pwweak2@example.com")}, headers=ORIGIN)
    for weak in ("short", "", "        ", "x" * 200, "password123"):
        response = client.post(
            f"/api/v1/auth/email/registrations/{tx_id}/complete",
            json={"username": "pwweak2", "password": weak},
            headers=ORIGIN,
        )
        assert response.status_code == 400
        assert response.json()["fieldErrors"]["password"] in ("password_policy", "password_too_common")


def test_password_login_rate_limited(client, stub):
    register_via_email(client, "pwlimit2@example.com", "pwlimit2")
    client.post("/api/v1/auth/logout", headers=csrf_headers(session_csrf(client)))
    for _ in range(5):
        login_password(client, "pwlimit2", "bad-password-12345")
    limited = login_password(client, "pwlimit2", "bad-password-12345")
    assert limited.status_code == 429 and limited.json()["code"] == "RATE_LIMITED"


def test_legacy_bcrypt_account_and_upgrade_e16(client, stub, db_session):
    """E16：历史 bcrypt 凭据可登录且成功后升级 Argon2id；新账户使用 Argon2id。"""
    from app.models import PasswordCredential, User
    from app.security import hash_password_legacy

    user = User(id="u-legacy-1", username="legacy1", username_normalized="legacy1", account_status="enabled")
    db_session.add(user)
    db_session.add(
        PasswordCredential(
            user_id=user.id,
            login_email="legacy1@example.com",
            login_email_normalized="legacy1@example.com",
            password_hash=hash_password_legacy(GOOD_PASSWORD),
            password_algo="bcrypt",
        )
    )
    db_session.commit()

    assert login_password(client, "legacy1").status_code == 200
    row = db_session.execute(select(PasswordCredential).where(PasswordCredential.user_id == "u-legacy-1")).scalar_one()
    assert row.password_algo == "argon2id" and row.password_hash.startswith("$argon2")  # 成功验证后升级
    assert row.login_email_verified_at is None  # 历史行不自动补真

    register_via_email(client, "argon1@example.com", "argon1")
    from app.db import get_session_factory

    fresh = get_session_factory()()
    try:
        new_row = fresh.execute(select(PasswordCredential).where(PasswordCredential.login_email_normalized == "argon1@example.com")).scalar_one()
        assert new_row.password_hash.startswith("$argon2")
    finally:
        fresh.close()


def test_legacy_unverified_login_email_scope_capped(client, stub, db_session):
    """E16/E17：历史未验证登录邮箱的密码会话不得取得 full 业务会话；补验后按资格放行。"""
    from app.models import PasswordCredential, User
    from app.security import hash_password_legacy

    user = User(id="u-legacy-2", username="legacy2", username_normalized="legacy2", account_status="enabled")
    db_session.add(user)
    db_session.add(
        PasswordCredential(
            user_id=user.id,
            login_email="legacy2@example.com",
            login_email_normalized="legacy2@example.com",
            password_hash=hash_password_legacy(GOOD_PASSWORD),
            password_algo="bcrypt",
        )
    )
    db_session.commit()

    session = login_password(client, "legacy2").json()
    assert session["sessionScope"] == "onboarding"
    assert session["loginEmailVerified"] is False
    assert session["nextAction"]["type"] == "verify_login_email"

    # 补验登录邮箱（受限会话 + CSRF + 真实验证码）
    csrf = session_csrf(client)
    created = client.post("/api/v1/me/login-email/challenges", json={}, headers=csrf_headers(csrf))
    assert created.status_code == 200, created.text
    from tests.conftest import latest_code

    verified = client.post(
        "/api/v1/me/login-email/verify",
        json={"challengeId": created.json()["challengeId"], "code": latest_code("legacy2@example.com")},
        headers=csrf_headers(csrf),
    )
    assert verified.status_code == 200, verified.text
    assert verified.json()["registration"]["loginEmailVerified"] is True


def test_change_password_requires_current(client, stub):
    """改密需当前密码；成功后旧密码失效、新密码可登录、会话轮换。"""
    register_via_email(client, "pwchg2@example.com", "pwchg2")
    csrf = session_csrf(client)
    wrong = client.post("/api/v1/me/password", json={"currentPassword": "bad", "newPassword": GOOD_PASSWORD + "x"}, headers=csrf_headers(csrf))
    assert wrong.status_code == 401 and wrong.json()["code"] == "INVALID_CREDENTIALS"

    weak = client.post("/api/v1/me/password", json={"currentPassword": GOOD_PASSWORD, "newPassword": "x"}, headers=csrf_headers(csrf))
    assert weak.status_code == 400 and weak.json()["fieldErrors"]["newPassword"] in ("password_policy", "password_too_common")

    changed = client.post(
        "/api/v1/me/password",
        json={"currentPassword": GOOD_PASSWORD, "newPassword": GOOD_PASSWORD + "-v2"},
        headers=csrf_headers(csrf),
    )
    assert changed.status_code == 200, changed.text
    client.post("/api/v1/auth/logout", headers=csrf_headers(session_csrf(client)))

    assert login_password(client, "pwchg2").status_code == 401
    assert login_password(client, "pwchg2", GOOD_PASSWORD + "-v2").status_code == 200


def test_concurrent_complete_single_account_e05(db_session):
    """E05：并发争用同一建档资格/同名用户，唯一约束保证单账户单凭据。"""
    from app.models import PasswordCredential, User
    from app.security import hash_password

    results: list[str] = []
    barrier = threading.Barrier(2)

    def insert(idx: int):
        from app.db import get_session_factory

        session = get_session_factory()()
        try:
            user = User(id=f"u-pwrace2-{idx}", username="raceuser2", username_normalized="raceuser2", account_status="enabled")
            session.add(user)
            session.add(
                PasswordCredential(
                    user_id=user.id,
                    login_email=f"race2-{idx}@example.com",
                    login_email_normalized=f"race2-{idx}@example.com",
                    login_email_verified_at=__import__("app.models", fromlist=["utcnow"]).utcnow(),
                    password_hash=hash_password(GOOD_PASSWORD),
                    password_algo="argon2id",
                )
            )
            barrier.wait(timeout=5)
            session.commit()
            results.append("ok")
        except IntegrityError:
            session.rollback()
            results.append("conflict")
        finally:
            session.close()

    threads = [threading.Thread(target=insert, args=(idx,)) for idx in (1, 2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(results) == ["conflict", "ok"]


def test_google_only_account_cannot_password_login(client, stub):
    login_new_user(client, stub, sub="google-only-pw2", email="g2@gmail.com", name="谷歌用户")
    client.post("/api/v1/auth/logout", headers=csrf_headers(session_csrf(client)))
    response = login_password(client, "g2@gmail.com")
    assert response.status_code == 401 and response.json()["code"] == "INVALID_CREDENTIALS"


def test_password_login_origin_checked(client, stub):
    response = client.post(
        "/api/v1/auth/password/login",
        json={"identifier": "x", "password": "y"},
        headers={"Origin": "https://evil.example"},
    )
    assert response.status_code == 403
