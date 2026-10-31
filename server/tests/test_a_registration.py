"""身份、注册与会话验收：A02–A12、A16、A17（HTTP 层，真实协议路径）。"""
from __future__ import annotations

from tests.conftest import complete_oauth, csrf_headers, latest_code, session_csrf
from tests.flows import login_new_user, profile_payload, register_student, register_teacher_to_review, verify_school_email


def test_a02_first_login_creates_single_pending_user(client, stub, db_session):
    """A02：清空本地状态后首次 Google 认证 → 创建唯一待注册用户，进入个人中心，不是演示组长。"""
    response = complete_oauth(client, stub, sub="google-sub-a02", email="g@gmail.com", name="新用户")
    assert response.status_code == 302
    assert response.headers["location"] == "/account/profile"
    session = client.get("/api/v1/auth/session").json()
    assert session["accountState"] == "profile_required"
    assert session["sessionScope"] == "onboarding"
    me = client.get("/api/v1/me").json()
    assert me["user"]["roles"] == []  # 申请身份未写入正式角色
    assert me["user"]["name"] == "新用户"  # Google 姓名预填


def test_a04_missing_profile_blocked(client, stub):
    """A04：受限会话缺资料：业务 API 403 REGISTRATION_REQUIRED。"""
    login_new_user(client, stub, sub="google-sub-a04")
    response = client.get("/api/v1/home/summary")
    assert response.status_code == 403
    assert response.json()["code"] == "REGISTRATION_REQUIRED"


def test_a05_profile_done_email_unverified_blocked(client, stub):
    """A05：资料完成但未验证学校邮箱 → 仅账号功能可用。"""
    login_new_user(client, stub, sub="google-sub-a05")
    csrf = session_csrf(client)
    client.patch(
        "/api/v1/me/profile",
        json=profile_payload(username="a05user", email="2023000005@student.must.edu.mo", student_id="2023000005"),
        headers=csrf_headers(csrf),
    )
    me = client.get("/api/v1/me").json()
    assert me["registration"]["accountState"] == "email_required"
    for path in ("/api/v1/home/summary", "/api/v1/projects/project-1/content"):
        response = client.get(path)
        assert response.status_code == 403
        assert response.json()["code"] == "REGISTRATION_REQUIRED"


def test_a06_invalid_codes_rejected(client, stub):
    """A06：任意 6 位数字、错误/过期验证码、旧验证码、他人 challengeId 均失败。"""
    login_new_user(client, stub, sub="google-sub-a06")
    csrf = session_csrf(client)
    client.patch(
        "/api/v1/me/profile",
        json=profile_payload(username="a06user", email="2023000006@student.must.edu.mo", student_id="2023000006"),
        headers=csrf_headers(csrf),
    )
    first = client.post("/api/v1/me/school-email/challenges", json={}, headers=csrf_headers(csrf)).json()
    real_code = latest_code("2023000006@student.must.edu.mo")

    wrong = client.post("/api/v1/me/school-email/verify", json={"challengeId": first["challengeId"], "code": "000000"}, headers=csrf_headers(csrf))
    assert wrong.status_code == 400 and wrong.json()["code"] == "INVALID_CODE"

    # 重发后旧 challenge 作废
    client.post("/api/v1/me/school-email/challenges", json={}, headers=csrf_headers(csrf))
    stale = client.post("/api/v1/me/school-email/verify", json={"challengeId": first["challengeId"], "code": real_code}, headers=csrf_headers(csrf))
    assert stale.status_code == 400 and stale.json()["code"] == "CHALLENGE_INVALID"

    # 他人/不存在 challengeId
    foreign = client.post("/api/v1/me/school-email/verify", json={"challengeId": "not-mine", "code": real_code}, headers=csrf_headers(csrf))
    assert foreign.status_code == 400 and foreign.json()["code"] == "CHALLENGE_INVALID"

    # 连续错码 5 次后锁定该挑战
    second = client.post("/api/v1/me/school-email/challenges", json={}, headers=csrf_headers(csrf)).json()
    for _ in range(5):
        client.post("/api/v1/me/school-email/verify", json={"challengeId": second["challengeId"], "code": "999999"}, headers=csrf_headers(csrf))
    locked = client.post(
        "/api/v1/me/school-email/verify",
        json={"challengeId": second["challengeId"], "code": latest_code("2023000006@student.must.edu.mo")},
        headers=csrf_headers(csrf),
    )
    assert locked.status_code == 400 and locked.json()["code"] in ("CODE_EXPIRED", "INVALID_CODE")


def test_a07_double_consume_single_effect(client, stub, db_session):
    """A07：同一验证码并发/重复消费仅一次生效（行锁 + 一次性标记）。"""
    login_new_user(client, stub, sub="google-sub-a07")
    csrf = session_csrf(client)
    client.patch(
        "/api/v1/me/profile",
        json=profile_payload(username="a07user", email="2023000007@student.must.edu.mo", student_id="2023000007"),
        headers=csrf_headers(csrf),
    )
    challenge = client.post("/api/v1/me/school-email/challenges", json={}, headers=csrf_headers(csrf)).json()
    code = latest_code("2023000007@student.must.edu.mo")

    first = client.post("/api/v1/me/school-email/verify", json={"challengeId": challenge["challengeId"], "code": code}, headers=csrf_headers(csrf))
    assert first.status_code == 200
    # 资格提升时会话已轮换：后续请求使用新会话的 CSRF token
    csrf = session_csrf(client)
    second = client.post("/api/v1/me/school-email/verify", json={"challengeId": challenge["challengeId"], "code": code}, headers=csrf_headers(csrf))
    assert second.status_code in (400, 409)  # 仅一次生效：重复消费被拒绝
    assert second.json()["code"] in ("CHALLENGE_INVALID", "INVALID_STATE")

    from app.models import SchoolEmailBinding
    from sqlalchemy import select

    bindings = db_session.execute(select(SchoolEmailBinding)).scalars().all()
    assert len(bindings) == 1  # 不重复绑定、不写多条成功记录


def test_a08_email_domain_and_conflict(client, stub):
    """A08：伪后缀邮箱拒绝；已绑定他人邮箱返回可恢复冲突，不自动合并账户。"""
    register_student(client, stub, sub="google-sub-a08a", email="2023000008@student.must.edu.mo", username="a08a", student_id="2023000008")

    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app, base_url="http://localhost:8000", raise_server_exceptions=False) as other:
        login_new_user(other, stub, sub="google-sub-a08b", email="o@gmail.com", name="冒名者")
        csrf = session_csrf(other)
        # 伪后缀：evilstudent.must.edu.mo / student.must.edu.mo.evil.com 均不允许
        for bad in ("x@student.must.edu.mo.evil.com", "x@evilstudent.must.edu.mo", "x@must.edu.mo"):
            response = other.patch(
                "/api/v1/me/profile",
                json=profile_payload(username="a08b", email=bad, student_id="2023000009"),
                headers=csrf_headers(csrf),
            )
            assert response.status_code == 400
            assert response.json()["fieldErrors"]["schoolEmail"] == "email_domain_not_allowed"
        # 声明与他人相同的已验证邮箱 → 验证后冲突，不合并
        other.patch(
            "/api/v1/me/profile",
            json=profile_payload(username="a08b", email="2023000008@student.must.edu.mo", student_id="2023000009"),
            headers=csrf_headers(csrf),
        )
        created = other.post("/api/v1/me/school-email/challenges", json={}, headers=csrf_headers(csrf))
        assert created.status_code == 200
        verified = other.post(
            "/api/v1/me/school-email/verify",
            json={"challengeId": created.json()["challengeId"], "code": latest_code("2023000008@student.must.edu.mo")},
            headers=csrf_headers(csrf),
        )
        assert verified.status_code == 409 and verified.json()["code"] == "EMAIL_CONFLICT"


def test_a09_student_activation_and_session_rotation(client, stub):
    """A09：首次学生达标 → active，旧受限会话失效，新会话访问自己的授权资源。"""
    facts = register_student(client, stub, sub="google-sub-a09", email="2023000009@student.must.edu.mo", username="a09user", student_id="2023000009")
    session = client.get("/api/v1/auth/session").json()
    assert session["sessionScope"] == "full"
    assert facts["registration"]["accountState"] == "active"
    assert "student" in facts["user"]["roles"] or facts["user"]["requestedIdentity"] == "student"
    home = client.get("/api/v1/home/summary")
    assert home.status_code == 200


def test_a10_teacher_not_reviewed_blocked(client, stub):
    """A10：教师邮箱已验证但未审/驳回 → 不开放教师页或普通业务 API。"""
    register_teacher_to_review(client, stub, sub="google-sub-a10", email="a10@must.edu.mo", name="李老师", username="a10t")
    for path in ("/api/v1/home/summary", "/api/v1/projects/project-1/content"):
        response = client.get(path)
        assert response.status_code == 403
        assert response.json()["code"] == "TEACHER_REVIEW_PENDING"


def test_a11_admin_approval_current_version_only(client, stub):
    """A11：管理员只批准当前版本申请；旧版本审核被拒绝。"""
    from tests.flows import login_admin

    register_teacher_to_review(client, stub, sub="google-sub-a11", email="a11@must.edu.mo", name="周老师", username="a11t")
    login_admin(client, stub, sub="google-admin-a11", username="adm11", email="adm11@must.edu.mo")
    csrf = session_csrf(client)

    # 先修改审核依据资料（申请快照过时）
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app, base_url="http://localhost:8000", raise_server_exceptions=False) as teacher_client:
        complete_oauth(teacher_client, stub, sub="google-sub-a11", email="a11@must.edu.mo", name="周老师")
        t_csrf = session_csrf(teacher_client)
        me = teacher_client.get("/api/v1/me").json()
        teacher_client.patch("/api/v1/me/profile", json={"name": "周大老师", "expectedVersion": me["user"]["version"]}, headers=csrf_headers(t_csrf))

    apps = client.get("/api/v1/admin/teacher-applications", headers=csrf_headers(csrf)).json()["items"]
    assert len(apps) == 1
    stale = client.post(
        f"/api/v1/admin/teacher-applications/{apps[0]['id']}/review",
        json={"decision": "approve", "expectedVersion": apps[0]["applicationVersion"]},
        headers=csrf_headers(csrf),
    )
    assert stale.status_code == 409  # 旧审核不能批准后来更改的身份资料

    # 教师重新提交当前版本后批准 → 转 active 并轮换会话
    with TestClient(app, base_url="http://localhost:8000", raise_server_exceptions=False) as teacher_client:
        complete_oauth(teacher_client, stub, sub="google-sub-a11", email="a11@must.edu.mo", name="周大老师")
        t_csrf = session_csrf(teacher_client)
        me = teacher_client.get("/api/v1/me").json()
        assert me["registration"]["accountState"] == "review_required"
        teacher_client.post("/api/v1/me/teacher-application", json={"expectedVersion": me["user"]["version"]}, headers=csrf_headers(t_csrf))

    apps = client.get("/api/v1/admin/teacher-applications", headers=csrf_headers(csrf)).json()["items"]
    approved = client.post(
        f"/api/v1/admin/teacher-applications/{apps[0]['id']}/review",
        json={"decision": "approve", "expectedVersion": apps[0]["applicationVersion"], "reason": "材料齐全"},
        headers=csrf_headers(csrf),
    )
    assert approved.status_code == 200, approved.text

    with TestClient(app, base_url="http://localhost:8000", raise_server_exceptions=False) as teacher_client:
        response = complete_oauth(teacher_client, stub, sub="google-sub-a11", email="a11@must.edu.mo", name="周大老师")
        assert response.status_code == 302
        me = teacher_client.get("/api/v1/me").json()
        assert me["registration"]["accountState"] == "active"
        assert "teacher" in me["user"]["roles"]
        assert teacher_client.get("/api/v1/home/summary").status_code == 200


def test_a11_rejected_teacher_can_view_and_resubmit(client, stub):
    from tests.flows import login_admin

    register_teacher_to_review(client, stub, sub="google-sub-a11r", email="a11r@must.edu.mo", name="驳老师", username="a11rt")
    login_admin(client, stub, sub="google-admin-a11r", username="adm11r", email="adm11r@must.edu.mo")
    csrf = session_csrf(client)
    apps = client.get("/api/v1/admin/teacher-applications", headers=csrf_headers(csrf)).json()["items"]
    client.post(
        f"/api/v1/admin/teacher-applications/{apps[0]['id']}/review",
        json={"decision": "reject", "reason": "材料不足", "expectedVersion": apps[0]["applicationVersion"]},
        headers=csrf_headers(csrf),
    )
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app, base_url="http://localhost:8000", raise_server_exceptions=False) as teacher_client:
        complete_oauth(teacher_client, stub, sub="google-sub-a11r", email="a11r@must.edu.mo", name="驳老师")
        me = teacher_client.get("/api/v1/me").json()
        assert me["registration"]["accountState"] == "review_rejected"
        assert me["teacherApplication"]["reason"] == "材料不足"  # 本人可见原因
        resubmit = teacher_client.post(
            "/api/v1/me/teacher-application",
            json={"expectedVersion": me["user"]["version"]},
            headers=csrf_headers(session_csrf(teacher_client)),
        )
        assert resubmit.status_code == 200
        assert resubmit.json()["registration"]["accountState"] == "review_pending"


def test_a12_no_escalation_via_extra_fields(client, stub, db_session):
    """A12：伪造 role/verified/active 等字段被拒绝，无提权。"""
    login_new_user(client, stub, sub="google-sub-a12")
    csrf = session_csrf(client)
    for forged in (
        {"role": "admin", "expectedVersion": 1},
        {"roles": ["admin"], "expectedVersion": 1},
        {"verified": True, "status": "active", "expectedVersion": 1},
        {"teacherStatus": "approved", "expectedVersion": 1},
    ):
        response = client.patch("/api/v1/me/profile", json=forged, headers=csrf_headers(csrf))
        assert response.status_code == 400
        assert response.json()["code"] == "VALIDATION_ERROR"
    me = client.get("/api/v1/me").json()
    assert me["user"]["roles"] == []
    assert me["registration"]["accountState"] == "profile_required"


def test_a16_profile_edit_and_email_change_flow(client, stub):
    """A16：无关资料修改不重置验证；换绑未完成保留旧地址，成功原子替换。"""
    facts = register_student(client, stub, sub="google-sub-a16", email="2023000016@student.must.edu.mo", username="a16user", student_id="2023000016")
    csrf = session_csrf(client)
    me = client.get("/api/v1/me").json()

    # 语言变更不影响验证
    client.patch("/api/v1/me/preferences", json={"preferredLocale": "zh-Hant"}, headers=csrf_headers(csrf))
    assert client.get("/api/v1/me").json()["registration"]["schoolEmailVerified"] is True

    # 换绑：需近期重新认证（本次登录满足）；未验证前旧地址保留
    change = client.post(
        "/api/v1/me/school-email/change",
        json={"schoolEmail": "2023000017@student.must.edu.mo", "expectedVersion": me["user"]["version"]},
        headers=csrf_headers(csrf),
    )
    assert change.status_code == 200, change.text
    mid = client.get("/api/v1/me").json()
    assert mid["schoolEmail"]["verified"] is True  # 旧有效绑定仍满足注册条件
    assert mid["registration"]["accountState"] == "active"
    assert mid["schoolEmail"]["pendingEmail"].endswith("***@student.must.edu.mo")

    # 换绑未完成（例如验证失败/取消）：旧地址保留
    challenge = client.post("/api/v1/me/school-email/challenges", json={}, headers=csrf_headers(csrf)).json()
    bad = client.post("/api/v1/me/school-email/verify", json={"challengeId": challenge["challengeId"], "code": "111111"}, headers=csrf_headers(csrf))
    assert bad.status_code == 400
    unchanged = client.get("/api/v1/me").json()
    assert unchanged["schoolEmail"]["verifiedEmail"].endswith("16***@student.must.edu.mo") or unchanged["schoolEmail"]["verifiedEmail"].endswith("***@student.must.edu.mo")
    assert unchanged["registration"]["schoolEmailVerified"] is True

    # 新地址验证成功后原子替换
    challenge = client.post("/api/v1/me/school-email/challenges", json={}, headers=csrf_headers(csrf)).json()
    done = client.post(
        "/api/v1/me/school-email/verify",
        json={"challengeId": challenge["challengeId"], "code": latest_code("2023000017@student.must.edu.mo")},
        headers=csrf_headers(csrf),
    )
    assert done.status_code == 200, done.text
    after = client.get("/api/v1/me").json()
    assert after["schoolEmail"]["pendingEmail"] is None
    assert after["registration"]["schoolEmailVerified"] is True


def test_a17_resume_registration_from_server_state(client, stub):
    """A17：中断注册后重新登录 → 从服务端恢复正确步骤与已保存资料。"""
    login_new_user(client, stub, sub="google-sub-a17")
    csrf = session_csrf(client)
    client.patch(
        "/api/v1/me/profile",
        json=profile_payload(username="a17user", email="2023000017@student.must.edu.mo", student_id="2023000017"),
        headers=csrf_headers(csrf),
    )
    client.post("/api/v1/auth/logout", headers=csrf_headers(csrf))  # 中断

    response = complete_oauth(client, stub, sub="google-sub-a17", email="g17@gmail.com", name="王小明")
    assert response.status_code == 302
    session = client.get("/api/v1/auth/session").json()
    assert session["accountState"] == "email_required"
    assert session["nextAction"]["href"] == "/account/email"
    me = client.get("/api/v1/me").json()
    assert me["user"]["username"] == "a17user"  # 已保存资料保留
    assert me["registration"]["schoolEmailVerified"] is False  # 不授予临时业务资格


def test_student_id_rule_not_invented(client, stub):
    """学号规则未确认前不臆造固定格式；规则元数据标注未经学校确认。"""
    login_new_user(client, stub, sub="google-sub-sid")
    csrf = session_csrf(client)
    rule = client.get("/api/v1/me").json()["studentIdRule"]
    assert rule["confirmedBySchool"] is False
    assert rule["emailPrefixRule"] == "none"
    response = client.patch(
        "/api/v1/me/profile",
        json=profile_payload(username="siduser", email="abc@student.must.edu.mo", student_id="AB-99100234", identity="student"),
        headers=csrf_headers(csrf),
    )
    assert response.status_code == 200  # 非“6 位数字”的学号不被臆造规则拒绝


def test_requested_identity_not_written_to_roles(client, stub):
    """申请身份不能直接写入实际角色。"""
    login_new_user(client, stub, sub="google-sub-role")
    csrf = session_csrf(client)
    saved = client.patch(
        "/api/v1/me/profile",
        json=profile_payload(username="roleuser", identity="teacher", student_id=None, email="role@must.edu.mo"),
        headers=csrf_headers(csrf),
    )
    assert saved.status_code == 200
    me = client.get("/api/v1/me").json()
    assert me["user"]["requestedIdentity"] == "teacher"
    assert me["user"]["roles"] == []  # 邮箱域只证明范围，不授予教师角色
