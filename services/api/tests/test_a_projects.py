"""个人项目创建、组长转让的权限与审计测试。"""

from __future__ import annotations

import a_fixtures as fixtures
import pytest
from sqlalchemy import select

from app.api.errors import ApiError
from app.db.models import ProjectMember
from app.modules.a import projects
from app.modules.a.models import AuditEvent

db = fixtures.db
scope = fixtures.scope


def test_any_active_user_can_create_personal_project_and_becomes_leader(db, scope):
    # 老师和普通学生都能建个人项目，创建者默认是组长
    for key in ("teacher", "member", "outsider"):
        project = projects.create_personal_project(db, scope.users[key], name=f"{key} 的项目")
        assert project.course_id is None and project.group_id is None
        row = db.scalar(
            select(ProjectMember).where(
                ProjectMember.project_id == project.id,
                ProjectMember.user_id == scope.users[key].id,
            )
        )
        assert row.role == "leader"
    audits = db.scalars(select(AuditEvent).where(AuditEvent.action == "project.created")).all()
    assert len(audits) >= 3


def test_disabled_user_cannot_create(db, scope):
    with pytest.raises(ApiError) as exc:
        projects.create_personal_project(db, scope.users["disabled"], name="x")
    assert exc.value.status_code == 403


def test_course_project_leadership_cannot_be_transferred_here(db, scope):
    with pytest.raises(ApiError) as exc:
        projects.transfer_personal_leadership(
            db,
            scope.users["leader"],
            scope.project.id,
            new_leader_id=scope.users["member"].id,
        )
    assert exc.value.status_code == 409


def test_personal_leader_transfers_to_member_and_keeps_membership(db, scope):
    owner = scope.users["outsider"]
    project = projects.create_personal_project(db, owner, name="个人")
    new_row = ProjectMember(project_id=project.id, user_id=scope.users["member"].id, role="member")
    db.add(new_row)
    db.flush()

    projects.transfer_personal_leadership(
        db, owner, project.id, new_leader_id=scope.users["member"].id
    )
    roles = {
        r.user_id: r.role
        for r in db.scalars(select(ProjectMember).where(ProjectMember.project_id == project.id))
    }
    assert roles[owner.id] == "member"
    assert roles[scope.users["member"].id] == "leader"


def test_only_current_leader_can_transfer_and_target_must_be_member(db, scope):
    owner = scope.users["outsider"]
    project = projects.create_personal_project(db, owner, name="个人")

    with pytest.raises(ApiError) as exc:
        projects.transfer_personal_leadership(
            db, scope.users["member"], project.id, new_leader_id=owner.id
        )
    assert exc.value.status_code in (403, 404)

    with pytest.raises(ApiError) as exc:
        projects.transfer_personal_leadership(
            db, owner, project.id, new_leader_id=scope.users["peer"].id
        )
    assert exc.value.status_code == 422


def test_personal_project_add_and_remove_members(db, scope):
    owner = scope.users["outsider"]
    teammate = scope.users["member"]
    project = projects.create_personal_project(db, owner, name="独立协作项目")

    added = projects.add_personal_member(db, owner, project.id, identifier=teammate.email)
    assert added.user_id == teammate.id and added.role == "member"

    with pytest.raises(ApiError) as dup:
        projects.add_personal_member(db, owner, project.id, identifier=teammate.email)
    assert dup.value.code == "ALREADY_A_MEMBER"

    with pytest.raises(ApiError) as leader_leave:
        projects.remove_personal_member(db, owner, project.id, member_user_id=owner.id)
    assert leader_leave.value.code == "LEADER_CANNOT_LEAVE"

    projects.remove_personal_member(db, owner, project.id, member_user_id=teammate.id)
    active = db.scalar(
        select(ProjectMember).where(
            ProjectMember.project_id == project.id,
            ProjectMember.user_id == teammate.id,
            ProjectMember.left_at.is_(None),
        )
    )
    assert active is None

    # 离开后允许组长重新添加
    readded = projects.add_personal_member(db, owner, project.id, identifier=teammate.email)
    assert readded.user_id == teammate.id and readded.left_at is None

    # 课程项目成员仍由课程小组统一管理
    with pytest.raises(ApiError) as course_err:
        projects.add_personal_member(
            db, scope.users["leader"], scope.project.id, identifier=owner.email
        )
    assert course_err.value.code == "MEMBERSHIP_MANAGED_BY_COURSE_GROUP"
