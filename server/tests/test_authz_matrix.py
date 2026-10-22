"""业务资源授权验收 A13 + 权限矩阵一致性（阶段 01 表格）。

矩阵以 lib/access/policy.ts 为准；此处用同一组用例核对服务端实现。
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.services import authz

DATA = json.loads((Path(__file__).parent / "data" / "workspace.json").read_text(encoding="utf-8"))


def actor(user_id: str, role: str, status: str = "active", teacher_status: str | None = None) -> dict:
    return {"id": user_id, "role": role, "status": status, "teacherStatus": teacher_status}


MEMBER_1 = actor("member-1", "leader")          # group-1 组长
MEMBER_2 = actor("member-2", "student")         # group-1 普通成员
MEMBER_21 = actor("member-21", "student")       # course-1 其他小组
DISABLED = actor("member-9", "student", status="disabled")
TEACHER = actor("teacher-1", "teacher", teacher_status="approved")
TA_GRANTED = actor("ta-1", "ta")                # course-1 助教，授予 course.rules.edit
TA_NO_GRANT = actor("ta-2", "ta")               # 无归属助教
ADMIN = actor("admin-1", "admin")

P1 = {"kind": "project", "id": "project-1"}
P2 = {"kind": "project", "id": "project-2"}
P3 = {"kind": "project", "id": "project-3"}
C1 = {"kind": "course", "id": "course-1"}
G1 = {"kind": "group", "id": "group-1"}
G2 = {"kind": "group", "id": "group-2"}


@pytest.mark.parametrize(
    "who,action,target,expected",
    [
        # 项目内容阅读
        (MEMBER_2, "project.content.read", P1, True),
        (MEMBER_1, "project.content.read", P1, True),
        (TEACHER, "project.content.read", P1, True),
        (TA_GRANTED, "project.content.read", P1, True),
        (TA_NO_GRANT, "project.content.read", P1, False),
        (MEMBER_21, "project.content.read", P1, False),  # 同课程其他小组不可读内容
        (DISABLED, "project.content.read", P1, False),
        (ADMIN, "project.content.read", P1, False),  # 管理员不默认获得项目内容
        # 公开总览（visibility=course）
        (MEMBER_21, "project.summary.read", P1, True),
        (MEMBER_21, "project.summary.read", P2, False),  # visibility=members
        (MEMBER_21, "project.content.read", P3, False),  # 跨课程
        # 草稿编辑/确认/资料写
        (MEMBER_2, "project.draft.edit", P1, True),
        (MEMBER_1, "project.files.write", P1, True),
        (TEACHER, "project.draft.edit", P1, False),
        (TA_GRANTED, "project.draft.edit", P1, False),
        (MEMBER_21, "project.draft.edit", P1, False),
        # 发布/解锁/设置/归档：仅该项目组长（Group.leaderId）
        (MEMBER_1, "project.publish", P1, True),
        (MEMBER_2, "project.publish", P1, False),
        (MEMBER_1, "project.archive", P1, True),
        (TEACHER, "project.settings.update", P1, False),
        # 无小组项目 ownerId
        (MEMBER_1, "project.settings.update", P2, True),
        (MEMBER_2, "project.content.read", P2, False),
        # 创建项目：该组组长
        (MEMBER_1, "project.create", G1, True),
        (MEMBER_2, "project.create", G1, False),
        (MEMBER_21, "project.create", G2, True),
        (MEMBER_1, "project.create", G2, False),
        # 课程
        (TEACHER, "course.read", C1, True),
        (TA_GRANTED, "course.read", C1, True),
        (TA_NO_GRANT, "course.read", C1, False),
        (MEMBER_2, "course.read", C1, True),
        (MEMBER_21, "course.read", C1, True),
        (TEACHER, "course.staff.manage", C1, True),
        (TA_GRANTED, "course.staff.manage", C1, False),
        (TEACHER, "course.settings.update", C1, True),
        (TA_GRANTED, "course.rules.edit", C1, True),   # 按操作授权
        (TA_GRANTED, "course.rules.publish", C1, False),  # 未授予发布
        (TA_NO_GRANT, "course.rules.edit", C1, False),
        (MEMBER_2, "course.settings.update", C1, False),
    ],
)
def test_permission_matrix(who, action, target, expected):
    assert authz.can(DATA, who, action, target) is expected


def test_unknown_action_denied():
    assert authz.can(DATA, MEMBER_1, "project.nuke", P1) is False


def test_project_summary_five_fields_only():
    summary = authz.project_summary(DATA["projects"][0])
    assert set(summary.keys()) == {"id", "name", "description", "progress", "lifecycle"}


def test_a13_http_cross_account_and_scope(client, stub, db_session):
    """A13：HTTP 层跨用户/跨课程/助教无授权/管理员访问业务内容按矩阵拒绝。"""
    from tests.flows import provision_active_user

    # 预置与业务快照对应的真实账户（用户 ID 与业务成员 ID 一致，映射由业务迁移负责）
    provision_active_user(db_session, "member-21", sub="sub-member-21", roles=["student"], email="m21@student.must.edu.mo", username="m21", name="同课程同学", student_id="2023000021", issuer=stub.issuer)
    provision_active_user(db_session, "member-2", sub="sub-member-2", roles=["student"], email="m2@student.must.edu.mo", username="m2", name="组员", student_id="2023000022", issuer=stub.issuer)
    provision_active_user(db_session, "ta-1", sub="sub-ta-1", roles=["ta"], email="ta1@student.must.edu.mo", username="ta1", name="助教", student_id="2023000023", issuer=stub.issuer)
    provision_active_user(db_session, "admin-1", sub="sub-admin-1", roles=["admin"], email="adm@must.edu.mo", username="adm1", name="管理员", issuer=stub.issuer)

    from tests.conftest import complete_oauth, session_csrf

    # 同课程其他小组：只可读公开总览五字段，内容 404
    complete_oauth(client, stub, sub="sub-member-21", email="g@gmail.com", name="同课程同学")
    summary = client.get("/api/v1/projects/project-1/summary")
    assert summary.status_code == 200
    assert set(summary.json().keys()) == {"id", "name", "description", "progress", "lifecycle"}
    assert client.get("/api/v1/projects/project-1/content").status_code == 404
    assert client.get("/api/v1/projects/project-3/summary").status_code == 404  # 跨课程

    # 组员：内容可读
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app, base_url="http://localhost:8000", raise_server_exceptions=False) as member_client:
        complete_oauth(member_client, stub, sub="sub-member-2", email="g2@gmail.com", name="组员")
        assert member_client.get("/api/v1/projects/project-1/content").status_code == 200

    # 无授权助教（ta-2 不在任何课程）：项目/课程均拒绝
    with TestClient(app, base_url="http://localhost:8000", raise_server_exceptions=False) as ta_client:
        provision_active_user(db_session, "ta-2", sub="sub-ta-2", roles=["ta"], email="ta2@student.must.edu.mo", username="ta2", name="无归属助教", student_id="2023000024", issuer=stub.issuer)
        complete_oauth(ta_client, stub, sub="sub-ta-2", email="g3@gmail.com", name="无归属助教")
        assert ta_client.get("/api/v1/projects/project-1/content").status_code == 404

    # 管理员：业务内容默认不放行（治理接口除外）
    with TestClient(app, base_url="http://localhost:8000", raise_server_exceptions=False) as admin_client:
        complete_oauth(admin_client, stub, sub="sub-admin-1", email="adm@must.edu.mo", name="管理员")
        assert admin_client.get("/api/v1/projects/project-1/content").status_code == 404
        assert admin_client.get("/api/v1/admin/teacher-applications").status_code == 200  # 治理接口可用
        assert session_csrf(admin_client)
