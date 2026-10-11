"""注册进度与「登入」资格（2026-10-10）：真实状态转换与会话问题，不重复样式实现。

覆盖点：
- 完成状态只依据后端已保存/已验证的事实（与页面访问顺序无关）；
- 教师身份必须有有效审核批准：提交申请/状态页/客户端选择均不算完成，批准后才放行；
- 账号安全为可选阶段：注册时已满足即完成，不要求再改一次密码/绑定 Google，不计入必填进度；
- 会话升级/轮换后必须写回新 Cookie 并同步新 CSRF，旧 Cookie/旧 CSRF 失效，业务 API 无 403 循环；
- 未验证登录邮箱的密码/历史凭据不得借 active 取得 full 业务会话；已验证 Google 身份不受影响；
- 审核依据失效时进度同步退回，不展示过期完成结果。
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from tests.conftest import csrf_headers, latest_code, session_csrf
from tests.flows import GOOD_PASSWORD, login_admin, login_new_user, profile_payload, register_student, register_via_email


def _me(client) -> dict:
    response = client.get("/api/v1/me")
    assert response.status_code == 200, response.text
    return response.json()


def _reg(client) -> dict:
    return _me(client)["registration"]


def _verify_school_email(client, email: str) -> dict:
    """真实验证码完成学校邮箱验证（邮件捕获器读取验证码）。"""
    csrf = session_csrf(client)
    created = client.post("/api/v1/me/school-email/challenges", json={"purpose": "school_email_verify"}, headers=csrf_headers(csrf))
    assert created.status_code == 200, created.text
    code = latest_code(email)
    verified = client.post(
        "/api/v1/me/school-email/verify",
        json={"challengeId": created.json()["challengeId"], "code": code},
        headers=csrf_headers(csrf),
    )
    assert verified.status_code == 200, verified.text
    return verified.json()["registration"]


def _mark_school_email_verified(username: str, school_email: str) -> None:
    """直接落库“学校邮箱已验证”事实（模拟另一会话/通道完成验证后的持久化状态）。"""
    from app.db import get_session_factory
    from app.models import SchoolEmailBinding, User, utcnow
    from sqlalchemy import select

    db = get_session_factory()()
    try:
        user = db.execute(select(User).where(User.username_normalized == username.lower())).scalar_one()
        binding = db.get(SchoolEmailBinding, user.id)
        if binding is None:
            binding = SchoolEmailBinding(user_id=user.id)
            db.add(binding)
        binding.school_email = school_email
        binding.school_email_normalized = school_email.lower()
        binding.verified_at = utcnow()
        binding.verification_method = "email_code"
        db.commit()
    finally:
        db.close()


def _clear_login_email_verified(username: str) -> None:
    """模拟历史账户：密码凭据存在但登录邮箱归属未验证（上线前真实迁移数据形态）。"""
    from app.db import get_session_factory
    from app.models import PasswordCredential, User
    from sqlalchemy import select

    db = get_session_factory()()
    try:
        user = db.execute(select(User).where(User.username_normalized == username.lower())).scalar_one()
        credential = db.get(PasswordCredential, user.id)
        assert credential is not None
        credential.login_email_verified_at = None
        db.commit()
    finally:
        db.close()


def _attach_unverified_password(username: str, login_email: str) -> None:
    """为 Google 账户附加一条未验证登录邮箱的密码凭据（混合账户）。"""
    from app.db import get_session_factory
    from app.models import PasswordCredential, User
    from app.security import hash_password
    from sqlalchemy import select

    db = get_session_factory()()
    try:
        user = db.execute(select(User).where(User.username_normalized == username.lower())).scalar_one()
        db.add(
            PasswordCredential(
                user_id=user.id,
                login_email=login_email,
                login_email_normalized=login_email.lower(),
                password_hash=hash_password(GOOD_PASSWORD),
                password_algo="argon2id",
                credential_version=1,
            )
        )
        db.commit()
    finally:
        db.close()


def test_p1_student_progress_follows_saved_and_verified_data(client):
    """P1：学生前三项随已保存/已验证事实逐步点亮；账号安全在注册时即满足（可选）。"""
    register_via_email(client, "p1s@qq.com", "p1student")
    reg = _reg(client)
    assert reg["profileComplete"] is False
    assert reg["schoolEmailVerified"] is False
    assert reg["identityConfirmed"] is False
    assert reg["requiredCompletedCount"] == 0
    assert reg["canEnterWorkspace"] is False
    # 新注册已有可用密码凭据 + 已验证登录邮箱 → 可选“账号安全”即为完成，不得要求再改一次密码
    assert reg["securityComplete"] is True

    # 仅保存资料 → 只有第 1 项完成（状态取自后端事实，与访问过哪些页面无关）
    csrf = session_csrf(client)
    saved = client.patch(
        "/api/v1/me/profile",
        json=profile_payload(
            name="王小明",
            username="p1student",
            student_id="2023123456",
            identity="student",
            email="2023123456@student.must.edu.mo",
            expected_version=1,
        ),
        headers=csrf_headers(csrf),
    )
    assert saved.status_code == 200, saved.text
    reg = saved.json()["registration"]
    assert reg["profileComplete"] is True
    assert reg["schoolEmailVerified"] is False
    assert reg["identityConfirmed"] is False
    assert reg["requiredCompletedCount"] == 1
    assert reg["canEnterWorkspace"] is False
    assert client.get("/api/v1/home/summary").status_code == 403

    # 学校邮箱真实验证后 → 前三项完成并允许进入（会话同步升级）
    reg = _verify_school_email(client, "2023123456@student.must.edu.mo")
    assert reg["schoolEmailVerified"] is True
    assert reg["identityConfirmed"] is True
    assert reg["requiredCompletedCount"] == 3
    assert reg["canEnterWorkspace"] is True
    assert client.get("/api/v1/home/summary").status_code == 200

    # 会话 DTO 与 /me 口径一致（侧栏与页面共用同一来源）
    session = client.get("/api/v1/auth/session").json()
    assert session["accountState"] == "active"
    assert session["requiredCompletedCount"] == 3
    assert session["canEnterWorkspace"] is True


def test_p2_teacher_requires_effective_approval(client, stub):
    """P2/P4：教师身份确认必须有有效审核批准；提交申请不算完成；批准后才放行。"""
    from app.main import app

    teacher = TestClient(app, base_url="http://localhost:8000", raise_server_exceptions=False)
    register_via_email(teacher, "p2t@qq.com", "p2teacher")
    csrf = session_csrf(teacher)
    saved = teacher.patch(
        "/api/v1/me/profile",
        json=profile_payload(name="陈老师", username="p2teacher", student_id=None, identity="teacher", email="p2t@must.edu.mo", expected_version=1),
        headers=csrf_headers(csrf),
    )
    assert saved.status_code == 200, saved.text
    reg = _verify_school_email(teacher, "p2t@must.edu.mo")
    assert reg["profileComplete"] is True and reg["schoolEmailVerified"] is True
    assert reg["teacherReviewStatus"] == "review_required"
    assert reg["identityConfirmed"] is False
    assert reg["requiredCompletedCount"] == 2
    assert reg["canEnterWorkspace"] is False

    # 提交申请 → 审核中：仍不算完成、不放行
    me = _me(teacher)
    submitted = teacher.post("/api/v1/me/teacher-application", json={"expectedVersion": me["user"]["version"]}, headers=csrf_headers(session_csrf(teacher)))
    assert submitted.status_code == 200, submitted.text
    reg = submitted.json()["registration"]
    assert reg["teacherReviewStatus"] == "review_pending"
    assert reg["identityConfirmed"] is False
    assert reg["canEnterWorkspace"] is False
    assert teacher.get("/api/v1/home/summary").status_code == 403

    # 管理员真实批准后才确认身份（改文案/看状态页不能跳过审核）
    login_admin(client, stub, sub="google-admin-p2", username="admp2", email="adm2@must.edu.mo")
    admin_csrf = session_csrf(client)
    apps = client.get("/api/v1/admin/teacher-applications", headers=csrf_headers(admin_csrf)).json()["items"]
    assert len(apps) == 1
    approved = client.post(
        f"/api/v1/admin/teacher-applications/{apps[0]['id']}/review",
        json={"decision": "approve", "expectedVersion": apps[0]["applicationVersion"], "reason": "材料齐全"},
        headers=csrf_headers(admin_csrf),
    )
    assert approved.status_code == 200, approved.text

    # 退出重登后同一份持久化状态（不是前端变量）
    relogin = TestClient(app, base_url="http://localhost:8000", raise_server_exceptions=False)
    login = relogin.post(
        "/api/v1/auth/password/login",
        json={"identifier": "p2teacher", "password": GOOD_PASSWORD},
        headers={"Origin": "http://localhost:3000"},
    )
    assert login.status_code == 200, login.text
    reg = _reg(relogin)
    assert reg["teacherReviewStatus"] == "approved"
    assert reg["identityConfirmed"] is True
    assert reg["requiredCompletedCount"] == 3
    assert reg["canEnterWorkspace"] is True
    assert relogin.get("/api/v1/home/summary").status_code == 200


def test_p2b_teacher_rejected_stays_incomplete(client, stub):
    """P4（驳回分支）：审核未通过 → 第 3 项保持未完成、按钮不允许进入。"""
    from app.main import app

    teacher = TestClient(app, base_url="http://localhost:8000", raise_server_exceptions=False)
    register_via_email(teacher, "p2r@qq.com", "p2reject")
    csrf = session_csrf(teacher)
    teacher.patch(
        "/api/v1/me/profile",
        json=profile_payload(name="李老师", username="p2reject", student_id=None, identity="teacher", email="p2r@must.edu.mo", expected_version=1),
        headers=csrf_headers(csrf),
    )
    _verify_school_email(teacher, "p2r@must.edu.mo")
    me = _me(teacher)
    teacher.post("/api/v1/me/teacher-application", json={"expectedVersion": me["user"]["version"]}, headers=csrf_headers(session_csrf(teacher)))

    login_admin(client, stub, sub="google-admin-p2b", username="admp2b", email="adm2b@must.edu.mo")
    admin_csrf = session_csrf(client)
    apps = client.get("/api/v1/admin/teacher-applications", headers=csrf_headers(admin_csrf)).json()["items"]
    rejected = client.post(
        f"/api/v1/admin/teacher-applications/{apps[0]['id']}/review",
        json={"decision": "reject", "expectedVersion": apps[0]["applicationVersion"], "reason": "材料不全"},
        headers=csrf_headers(admin_csrf),
    )
    assert rejected.status_code == 200, rejected.text

    reg = _reg(teacher)
    assert reg["teacherReviewStatus"] == "review_rejected"
    assert reg["identityConfirmed"] is False
    assert reg["canEnterWorkspace"] is False
    assert reg["requiredCompletedCount"] == 2
    assert teacher.get("/api/v1/home/summary").status_code == 403


def test_p3_session_refresh_writes_rotated_cookie_and_new_csrf(client):
    """P5 会话升级：refresh 轮换会话时必须写回新 Cookie 并同步新 CSRF；旧 Cookie/旧 CSRF 失效。"""
    from app.main import app

    register_via_email(client, "p3s@qq.com", "p3student")
    csrf = session_csrf(client)
    old_cookie = client.cookies.get("gp_session")
    assert old_cookie, "注册应签发会话 Cookie"
    saved = client.patch(
        "/api/v1/me/profile",
        json=profile_payload(name="王小明", username="p3student", student_id="2023123456", identity="student", email="2023123456@student.must.edu.mo", expected_version=1),
        headers=csrf_headers(csrf),
    )
    assert saved.status_code == 200, saved.text

    # 后端事实已满足（学校邮箱已验证），但会话仍是 onboarding → refresh 必须升级并写回
    _mark_school_email_verified("p3student", "2023123456@student.must.edu.mo")
    refreshed = client.post("/api/v1/auth/session/refresh", headers=csrf_headers(csrf))
    assert refreshed.status_code == 200, refreshed.text
    assert "gp_session=" in refreshed.headers.get("set-cookie", ""), "会话轮换必须把新 Cookie 写回浏览器"
    new_cookie = client.cookies.get("gp_session")
    assert new_cookie and new_cookie != old_cookie
    body = refreshed.json()
    assert body["sessionScope"] == "full"
    assert body["accountState"] == "active"
    assert body["canEnterWorkspace"] is True
    new_csrf = body["csrfToken"]
    assert new_csrf and new_csrf != csrf, "轮换后必须同步新 CSRF"

    # 旧 Cookie 与旧 CSRF 均已失效
    stale = TestClient(app, base_url="http://localhost:8000", raise_server_exceptions=False)
    assert stale.get("/api/v1/me", headers={"Cookie": f"gp_session={old_cookie}"}).status_code == 401
    assert (
        client.patch("/api/v1/me/preferences", json={"preferredLocale": "en"}, headers=csrf_headers(csrf)).status_code == 403
    )

    # 新 Cookie + 新 CSRF 正常写；业务 API 可访问（无跳回登录页/403 循环）
    assert client.patch("/api/v1/me/preferences", json={"preferredLocale": "en"}, headers=csrf_headers(new_csrf)).status_code == 200
    assert client.get("/api/v1/home/summary").status_code == 200


def test_p4_session_refresh_without_rotation_keeps_cookie(client):
    """无轮换时 refresh 不得动 Cookie/CSRF（避免无谓失效）。"""
    register_via_email(client, "p4s@qq.com", "p4student")
    csrf = session_csrf(client)
    client.patch(
        "/api/v1/me/profile",
        json=profile_payload(name="王小明", username="p4student", student_id="2023123456", identity="student", email="2023123456@student.must.edu.mo", expected_version=1),
        headers=csrf_headers(csrf),
    )
    _verify_school_email(client, "2023123456@student.must.edu.mo")  # 轮换发生在验证（已有写回）
    cookie = client.cookies.get("gp_session")
    refreshed = client.post("/api/v1/auth/session/refresh", headers=csrf_headers(session_csrf(client)))
    assert refreshed.status_code == 200, refreshed.text
    assert refreshed.headers.get("set-cookie") is None
    assert refreshed.json()["csrfToken"] == session_csrf(client)
    assert client.cookies.get("gp_session") == cookie


def test_p5_security_optional_and_login_email_gate(client, stub):
    """P3/P5：账号安全可选；历史未验证登录邮箱不得借 active 取得 full 会话；Google 身份不受影响。"""
    from app.main import app

    # 新注册密码账户：账号安全（可选）在注册时即满足
    register_via_email(client, "p5s@qq.com", "p5student")
    assert _reg(client)["securityComplete"] is True

    # 历史账户（密码凭据 + 登录邮箱未验证）：账号安全未完成，但不计入必填进度
    _clear_login_email_verified("p5student")
    reg = _reg(client)
    assert reg["securityComplete"] is False
    assert reg["loginEmailVerified"] is False
    assert reg["requiredCompletedCount"] == 0  # 可选项不计入必填进度
    assert reg["canEnterWorkspace"] is False
    assert client.get("/api/v1/home/summary").status_code == 403

    # 纯 Google 账户：沿用可信认证事实，不强制创建密码 → 账号安全完成
    google = TestClient(app, base_url="http://localhost:8000", raise_server_exceptions=False)
    register_student(google, stub, sub="google-sub-p5", email="2023123457@student.must.edu.mo", name="谷歌同学", username="p5google", student_id="2023123457")
    assert _reg(google)["securityComplete"] is True

    # 混合账户（Google + 未验证密码凭据）：账号安全未完成（浅灰可选），但 Google 会话可正常进入
    _attach_unverified_password("p5google", "p5-legacy@example.com")
    login_new_user(google, stub, sub="google-sub-p5", email="google-x@gmail.com", name="谷歌同学")
    reg = _reg(google)
    assert reg["securityComplete"] is False
    assert reg["canEnterWorkspace"] is True
    assert google.get("/api/v1/home/summary").status_code == 200


def test_p6_review_invalidation_rolls_progress_back(client):
    """P4 同步退回：审核依据资料变化 → 旧结论失效，进度/按钮状态回到未完成。"""
    from app.main import app

    teacher = TestClient(app, base_url="http://localhost:8000", raise_server_exceptions=False)
    register_via_email(teacher, "p6t@qq.com", "p6teacher")
    csrf = session_csrf(teacher)
    teacher.patch(
        "/api/v1/me/profile",
        json=profile_payload(name="陈老师", username="p6teacher", student_id=None, identity="teacher", email="p6t@must.edu.mo", expected_version=1),
        headers=csrf_headers(csrf),
    )
    _verify_school_email(teacher, "p6t@must.edu.mo")
    me = _me(teacher)
    teacher.post("/api/v1/me/teacher-application", json={"expectedVersion": me["user"]["version"]}, headers=csrf_headers(session_csrf(teacher)))

    # 修改审核依据（姓名）→ 旧申请结论不再有效
    current_version = _me(teacher)["user"]["version"]
    changed = teacher.patch(
        "/api/v1/me/profile",
        json={"name": "陈大老师", "expectedVersion": current_version},
        headers=csrf_headers(session_csrf(teacher)),
    )
    assert changed.status_code == 200, changed.text
    reg = changed.json()["registration"]
    assert reg["teacherReviewStatus"] == "review_required"
    assert reg["identityConfirmed"] is False
    assert reg["canEnterWorkspace"] is False
    assert reg["requiredCompletedCount"] == 2
    assert teacher.get("/api/v1/home/summary").status_code == 403
