"""常用注册/登录流程辅助（走真实接口，不用内存 Mock）。"""
from __future__ import annotations

from tests.conftest import complete_oauth, csrf_headers, latest_code, session_csrf


def profile_payload(name="王小明", username="wangxm1", student_id="2023123456", identity="student", email="2023123456@student.must.edu.mo", expected_version=1, **extra):
    body = {
        "name": name,
        "username": username,
        "studentId": student_id,
        "requestedIdentity": identity,
        "schoolEmail": email,
        "expectedVersion": expected_version,
    }
    body.update(extra)
    return body


def login_new_user(client, stub, *, sub="google-sub-1", email="someone@student.must.edu.mo", name="测试用户", return_to=None):
    response = complete_oauth(client, stub, sub=sub, email=email, name=name, return_to=return_to)
    assert response.status_code == 302, response.text
    return response


def verify_school_email(client, stub, *, to_email, expected_version_after_profile):
    csrf = session_csrf(client)
    create = client.post("/api/v1/me/school-email/challenges", json={"purpose": "school_email_verify"}, headers=csrf_headers(csrf))
    assert create.status_code == 200, create.text
    challenge_id = create.json()["challengeId"]
    code = latest_code(to_email)
    verify = client.post(
        "/api/v1/me/school-email/verify",
        json={"challengeId": challenge_id, "code": code},
        headers=csrf_headers(csrf),
    )
    assert verify.status_code == 200, verify.text
    return verify.json()


def register_student(client, stub, *, sub="google-sub-1", email="2023123456@student.must.edu.mo", name="王小明", username="wangxm1", student_id="2023123456"):
    """A09 主流程：Google 认证 → 资料 → 真实验证码 → active。"""
    login_new_user(client, stub, sub=sub, email="google-x@gmail.com", name=name)
    csrf = session_csrf(client)
    saved = client.patch(
        "/api/v1/me/profile",
        json=profile_payload(name=name, username=username, student_id=student_id, email=email),
        headers=csrf_headers(csrf),
    )
    assert saved.status_code == 200, saved.text
    facts = verify_school_email(client, stub, to_email=email, expected_version_after_profile=2)
    assert facts["registration"]["accountState"] == "active"
    return facts


def register_teacher_to_review(client, stub, *, sub="google-teacher-1", email="t1@must.edu.mo", name="陈老师", username="chent"):
    login_new_user(client, stub, sub=sub, email="google-t@gmail.com", name=name)
    csrf = session_csrf(client)
    saved = client.patch(
        "/api/v1/me/profile",
        json=profile_payload(
            name=name,
            username=username,
            student_id=None,
            identity="teacher",
            email=email,
        ),
        headers=csrf_headers(csrf),
    )
    assert saved.status_code == 200, saved.text
    verify_school_email(client, stub, to_email=email, expected_version_after_profile=2)
    csrf = session_csrf(client)
    me = client.get("/api/v1/me").json()
    submit = client.post(
        "/api/v1/me/teacher-application",
        json={"expectedVersion": me["user"]["version"]},
        headers=csrf_headers(csrf),
    )
    assert submit.status_code == 200, submit.text
    assert submit.json()["registration"]["accountState"] == "review_pending"
    return submit.json()


ORIGIN = {"Origin": "http://localhost:3000"}
GOOD_PASSWORD = "correct-horse-battery-1"


def start_email_registration(client, email, locale="zh-Hans"):
    return client.post("/api/v1/auth/email/registrations", json={"email": email, "locale": locale}, headers=ORIGIN)


def register_via_email(client, email, username, password=GOOD_PASSWORD, locale="zh-Hans", skip_complete=False):
    """三步注册：邮箱 → 真实验证码 → 用户名/密码建档（走真实接口）。"""
    created = start_email_registration(client, email, locale)
    assert created.status_code == 200, created.text
    tx_id = created.json()["id"]
    code = latest_code(email)
    verified = client.post(
        f"/api/v1/auth/email/registrations/{tx_id}/verify",
        json={"code": code},
        headers=ORIGIN,
    )
    assert verified.status_code == 200, verified.text
    if skip_complete:
        return tx_id
    completed = client.post(
        f"/api/v1/auth/email/registrations/{tx_id}/complete",
        json={"username": username, "password": password},
        headers=ORIGIN,
    )
    assert completed.status_code == 201, completed.text
    return completed.json()


def provision_active_user(
    db,
    user_id: str,
    *,
    sub: str,
    roles: list[str],
    email: str,
    username: str,
    name: str,
    student_id: str | None = None,
    issuer: str = "https://accounts.google.com",
):
    """预置与业务快照 ID 对应的已激活真实账户（供 A13 类矩阵验收使用）。"""
    from app.models import AuthIdentity, SchoolEmailBinding, User, utcnow
    from app.security import normalize_username
    from app.services.registration import profile_field_errors

    requested = "teacher" if "teacher" in roles or "admin" in roles else "student"
    user = User(
        id=user_id,
        name=name,
        username=username,
        username_normalized=normalize_username(username),
        student_id=student_id,
        requested_identity=None if "admin" in roles else requested,
        roles=roles,
        account_status="enabled",
    )
    db.add(user)
    db.add(AuthIdentity(id=f"id-{sub}", provider="google", issuer=issuer, subject=sub, user_id=user_id))
    db.add(
        SchoolEmailBinding(
            user_id=user_id,
            school_email=email,
            school_email_normalized=email.lower(),
            verified_at=utcnow(),
            verification_method="email_code",
        )
    )
    if "teacher" in roles:
        from app.models import TeacherApplication

        db.add(TeacherApplication(
            id=f"approval-{sub}", user_id=user_id, application_version=1, status="approved",
            snapshot={"name": name, "requestedIdentity": requested, "schoolEmailNormalized": email.lower()},
            reviewed_at=utcnow(), reviewer_id="test-provisioner",
        ))
    db.commit()
    assert profile_field_errors(
        name=name,
        username=username,
        student_id=student_id,
        requested_identity=requested,
        school_email=email,
    ) == {} or "admin" in roles
    return user


def login_admin(client, stub, *, sub="google-admin-1", name="系统管理员", username="admin01", email="admin@must.edu.mo"):
    from app.db import get_session_factory
    from app.services.bootstrap import bootstrap_admin

    db = get_session_factory()()
    try:
        user = bootstrap_admin(db, google_subject=sub, google_issuer=stub.issuer, name=name, username=username, school_email=email)
    finally:
        db.close()
    login_new_user(client, stub, sub=sub, email=email, name=name)
    return user
