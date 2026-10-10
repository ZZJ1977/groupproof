"""用户数据库与核验依据验收：D01–D08（真实 PostgreSQL 约束/事务/并发）。"""
from __future__ import annotations

import threading

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from tests.conftest import complete_oauth, csrf_headers, latest_code, session_csrf
from tests.flows import login_new_user, profile_payload, register_student, register_teacher_to_review, verify_school_email


def _new_identity(db, user_id: str, subject: str, issuer: str):
    from app.models import AuthIdentity, User

    user = User(id=user_id, name="并发用户", account_status="enabled")
    identity = AuthIdentity(id=f"id-{subject}-{user_id}", provider="google", issuer=issuer, subject=subject, user_id=user_id)
    user.identities = [identity]
    db.add(user)
    return user


def test_d01_concurrent_first_login_single_identity(client, stub, db_session):
    """D01：相同 Google 身份并发首次注册 → 一个 User、一条身份绑定，无孤立记录。"""
    from app.models import AuthIdentity, User

    subject = "google-sub-d01"
    errors: list[Exception] = []
    barrier = threading.Barrier(2)

    def insert():
        session = _thread_session()
        try:
            _new_identity(session, f"user-{threading.get_ident()}", subject, stub.issuer)
            barrier.wait(timeout=5)
            session.commit()
        except IntegrityError as exc:
            errors.append(exc)
            session.rollback()
        finally:
            session.close()

    def _thread_session():
        from app.db import get_session_factory

        return get_session_factory()()

    threads = [threading.Thread(target=insert) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(errors) == 1, "并发首次注册应只有一个事务成功，另一个触发唯一约束"
    users = db_session.execute(select(User)).scalars().all()
    identities = db_session.execute(select(AuthIdentity)).scalars().all()
    assert len(users) == 1
    assert len(identities) == 1

    # 重复登录不再新增账户（同一 sub、邮箱变化也只有一条绑定）
    response = complete_oauth(client, stub, sub=subject, email="changed@gmail.com", name="并发用户")
    assert response.status_code == 302
    assert len(db_session.execute(select(User)).scalars().all()) == 1
    assert len(db_session.execute(select(AuthIdentity)).scalars().all()) == 1


def test_d01_orphan_records_none(client, stub, db_session):
    """D01：User 与 AuthIdentity 同事务创建，不存在无绑定的半成品账户。"""
    from app.models import AuthIdentity, User

    login_new_user(client, stub, sub="google-sub-orphan", email="o@gmail.com")
    users = db_session.execute(select(User)).scalars().all()
    identities = db_session.execute(select(AuthIdentity)).scalars().all()
    assert len(users) == len(identities) == 1
    assert identities[0].user_id == users[0].id


def test_d02_persistence_across_clients(client, stub, db_session):
    """D02：保存资料后（等价服务重启/换浏览器）按 Google 身份找回原记录与真实验证结果。"""
    register_student(client, stub, sub="google-sub-d02", email="2023111111@student.must.edu.mo", username="d02user", student_id="2023111111")

    # 模拟换设备/换浏览器：全新客户端、仅凭 Google 身份重新认证
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app, base_url="http://localhost:8000", raise_server_exceptions=False) as second:
        response = complete_oauth(second, stub, sub="google-sub-d02", email="o2@gmail.com", name="王小明")
        assert response.status_code == 302
        me = second.get("/api/v1/me").json()
        assert me["user"]["username"] == "d02user"
        assert me["registration"]["accountState"] == "active"
        assert me["registration"]["schoolEmailVerified"] is True
        assert me["user"]["studentId"] == "2023111111"


def test_d03_username_uniqueness_rollback(client, stub, db_session):
    """D03：规范用户名并发争用由数据库唯一约束兜底，失败事务完整回滚。"""
    from app.models import User

    register_student(client, stub, sub="google-sub-d03a", email="2023222222@student.must.edu.mo", username="dupuser", student_id="2023222222")

    login_new_user(client, stub, sub="google-sub-d03b", email="other@gmail.com", name="另一人")
    csrf = session_csrf(client)
    response = client.patch(
        "/api/v1/me/profile",
        json=profile_payload(username="DUPUSER", email="2023333333@student.must.edu.mo", student_id="2023333333"),
        headers=csrf_headers(csrf),
    )
    assert response.status_code == 409
    assert response.json()["code"] == "USERNAME_CONFLICT"
    # 回滚完整性：失败事务不应留下部分写入
    second = db_session.execute(select(User).where(User.username_normalized == "dupuser")).scalar_one()
    assert second.name == "王小明"


def test_d03_verified_email_unique_constraint(db_session):
    """D03：已验证规范学校邮箱全局唯一（数据库约束，不靠先查后写）。"""
    from app.models import SchoolEmailBinding, User

    for idx in (1, 2):
        user = User(id=f"u-d03-{idx}", name=f"用户{idx}", account_status="enabled")
        db_session.add(user)
        db_session.add(
            SchoolEmailBinding(
                user_id=user.id,
                school_email="same@student.must.edu.mo",
                school_email_normalized="same@student.must.edu.mo",
                verified_at=__import__("app.models", fromlist=["utcnow"]).utcnow(),
                verification_method="email_code",
            )
        )
    with pytest.raises(IntegrityError):
        db_session.flush()
        db_session.commit()
    db_session.rollback()


def test_d03_concurrent_email_binding_single_winner(db_session):
    """D03：两个账户并发绑定同一已验证邮箱 → 仅一个成功，另一个整体回滚。"""
    from app.models import SchoolEmailBinding, User, utcnow

    results: list[str] = []
    barrier = threading.Barrier(2)

    def bind(idx: int):
        from app.db import get_session_factory

        session = get_session_factory()()
        try:
            session.add(User(id=f"u-race-{idx}", name=f"竞态{idx}", account_status="enabled"))
            session.flush()
            session.add(
                SchoolEmailBinding(
                    user_id=f"u-race-{idx}",
                    school_email="race@student.must.edu.mo",
                    school_email_normalized="race@student.must.edu.mo",
                    verified_at=utcnow(),
                    verification_method="email_code",
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

    threads = [threading.Thread(target=bind, args=(idx,)) for idx in (1, 2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(results) == ["conflict", "ok"]


def test_d04_email_verification_keeps_academic_unverified(client, stub):
    """D04：资料一致 + 邮箱验证通过 ≠ 学校实名已核验。"""
    facts = register_student(client, stub, sub="google-sub-d04", email="2023444444@student.must.edu.mo", username="d04user", student_id="2023444444")
    assert facts["registration"]["academicIdentityStatus"] == "unverified"
    assert {item["kind"] for item in facts["registration"]["verificationBasis"]} == {"google_auth", "school_email_control"}
    assert all(item["kind"] != "school_real_name" for item in facts["registration"]["verificationBasis"])


def test_d05_record_exists_but_not_granted(client, stub, db_session):
    """D05：仅有用户记录（资料缺失/未验证/未审/停用）不得签发 full 会话或业务访问。"""
    login_new_user(client, stub, sub="google-sub-d05", email="x@gmail.com")
    session = client.get("/api/v1/auth/session").json()
    assert session["authenticated"] is True
    assert session["sessionScope"] == "onboarding"
    assert session["accountState"] == "profile_required"
    denied = client.get("/api/v1/home/summary")
    assert denied.status_code == 403
    assert denied.json()["code"] == "REGISTRATION_REQUIRED"


def test_d06_no_cross_user_profile_access(client, stub):
    """D06：普通用户不能读取他人档案/审核记录，本人仅获取允许摘要。"""
    register_student(client, stub, sub="google-sub-d06a", email="2023555555@student.must.edu.mo", username="d06a", student_id="2023555555")
    me = client.get("/api/v1/me").json()
    assert set(me.keys()) <= {"user", "schoolEmail", "registration", "teacherApplication", "studentIdRule"}
    assert "sessions" not in me and "codeHmac" not in str(me)

    # 他人管理接口需要管理员资格
    response = client.post("/api/v1/admin/users/someone/disable", json={"expectedVersion": 1}, headers=csrf_headers(session_csrf(client)))
    assert response.status_code == 403

    # 无 userId 参数：/me 只返回本人
    assert me["user"]["id"]


def test_d07_verified_field_change_invalidates_checks(client, stub, db_session):
    """D07：核验依赖字段变化使旧结论过时并保留历史；无关变更不清空有效证明。"""
    from app.models import AcademicIdentityCheck
    from app.models import utcnow as now_fn

    facts = register_student(client, stub, sub="google-sub-d07", email="2023666666@student.must.edu.mo", username="d07user", student_id="2023666666")
    user_id = facts["user"]["id"]
    db_session.add(
        AcademicIdentityCheck(
            id="check-1",
            user_id=user_id,
            checked_fields=["name", "studentId"],
            snapshot={"name": "王小明", "studentId": "2023666666"},
            method="documented_manual_review",
            result="passed",
            evidence_ref="ref-1",
            checked_at=now_fn(),
        )
    )
    db_session.commit()
    me = client.get("/api/v1/me").json()
    assert me["registration"]["academicIdentityStatus"] == "verified"

    # 无关变更（语言）不清空有效证明
    csrf = session_csrf(client)
    client.patch("/api/v1/me/preferences", json={"preferredLocale": "en"}, headers=csrf_headers(csrf))
    assert client.get("/api/v1/me").json()["registration"]["academicIdentityStatus"] == "verified"

    # 核验依赖字段（姓名）变化 → 旧结论过时，保留历史
    response = client.patch(
        "/api/v1/me/profile",
        json={"name": "王大明", "expectedVersion": me["user"]["version"]},
        headers=csrf_headers(csrf),
    )
    assert response.status_code == 200, response.text
    after = client.get("/api/v1/me").json()
    assert after["registration"]["academicIdentityStatus"] == "stale"
    rows = db_session.execute(select(AcademicIdentityCheck)).scalars().all()
    assert len(rows) == 1 and rows[0].result == "passed" and rows[0].superseded_at is not None


def test_d07_teacher_basis_change_revokes_role(client, stub):
    """D07/§5.2：教师审核依据变更 → 撤销旧教师资格并重新审核。"""
    from tests.flows import login_admin

    register_teacher_to_review(client, stub, sub="google-t-d07", email="td07@must.edu.mo", name="陈老师", username="td07")
    admin = login_admin(client, stub, sub="google-admin-d07", username="adm07", email="adm07@must.edu.mo")
    admin_csrf = session_csrf(client)
    apps = client.get("/api/v1/admin/teacher-applications", headers=csrf_headers(admin_csrf)).json()["items"]
    assert len(apps) == 1
    review = client.post(
        f"/api/v1/admin/teacher-applications/{apps[0]['id']}/review",
        json={"decision": "approve", "expectedVersion": apps[0]["applicationVersion"]},
        headers=csrf_headers(admin_csrf),
    )
    assert review.status_code == 200, review.text

    # 教师本人改名（审核依据字段）→ 需重新审核，旧批准不沿用
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app, base_url="http://localhost:8000", raise_server_exceptions=False) as teacher_client:
        complete_oauth(teacher_client, stub, sub="google-t-d07", email="td07@must.edu.mo", name="陈老师")
        csrf = session_csrf(teacher_client)
        me = teacher_client.get("/api/v1/me").json()
        assert me["registration"]["accountState"] == "active"
        assert "teacher" in me["user"]["roles"]
        teacher_client.patch("/api/v1/me/profile", json={"name": "陈大老师", "expectedVersion": me["user"]["version"]}, headers=csrf_headers(csrf))
        after = teacher_client.get("/api/v1/me").json()
        assert after["registration"]["accountState"] == "review_required"
        assert "teacher" not in after["user"]["roles"]


def test_d08_transaction_rollback_on_failure(client, stub, db_session, monkeypatch):
    """D08：验证码消费/绑定事务中注入失败 → 整体回滚，不出现缺少依据的已验证状态。"""
    from app.services import email_challenges

    login_new_user(client, stub, sub="google-sub-d08", email="x8@gmail.com")
    csrf = session_csrf(client)
    client.patch(
        "/api/v1/me/profile",
        json=profile_payload(username="d08user", email="2023777777@student.must.edu.mo", student_id="2023777777"),
        headers=csrf_headers(csrf),
    )
    create = client.post("/api/v1/me/school-email/challenges", json={}, headers=csrf_headers(csrf))
    challenge_id = create.json()["challengeId"]
    code = latest_code("2023777777@student.must.edu.mo")

    original = email_challenges.bind_verified_email

    def failing_bind(*args, **kwargs):
        raise RuntimeError("injected failure")

    monkeypatch.setattr(email_challenges, "bind_verified_email", failing_bind)
    response = client.post(
        "/api/v1/me/school-email/verify",
        json={"challengeId": challenge_id, "code": code},
        headers=csrf_headers(csrf),
    )
    assert response.status_code == 500  # 未预期程序错误：通用 500 + requestId，不伪报成功
    assert response.json()["code"] == "INTERNAL_ERROR"
    assert response.json()["requestId"]
    monkeypatch.setattr(email_challenges, "bind_verified_email", original)

    me = client.get("/api/v1/me").json()
    assert me["registration"]["schoolEmailVerified"] is False
    # 验证码也未被消费（同一事务整体回滚），重试不会重复授予资格
    retry = client.post(
        "/api/v1/me/school-email/verify",
        json={"challengeId": challenge_id, "code": code},
        headers=csrf_headers(csrf),
    )
    assert retry.status_code == 200, retry.text
    assert retry.json()["registration"]["schoolEmailVerified"] is True
