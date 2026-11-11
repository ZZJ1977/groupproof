"""A3-05 共享权限函数 + A3-06 越权测试（权限矩阵与 lib/access/policy.ts 同一套用例）。"""

from __future__ import annotations

import a_fixtures as fixtures
import pytest

from app.api.errors import ApiError
from app.modules.a import permissions as perm
from app.modules.a.permissions import Target

db = fixtures.db
scope = fixtures.scope


def project(scope, which="project"):
    return Target("project", getattr(scope, which).id)


@pytest.mark.parametrize(
    "who,action,which,expected",
    [
        # 项目内容：成员和本课老师/助教可读；同课其他组、外课、停用、管理员都不行
        ("member", "project.content.read", "project", True),
        ("leader", "project.content.read", "project", True),
        ("teacher", "project.content.read", "project", True),
        ("ta", "project.content.read", "project", True),
        ("unassigned_ta", "project.content.read", "project", False),
        ("other_teacher", "project.content.read", "project", False),
        ("peer", "project.content.read", "project", False),
        ("outsider", "project.content.read", "project", False),
        ("disabled", "project.content.read", "project", False),
        ("admin", "project.content.read", "project", False),
        # 公开总览：visibility=course 时同课同学可看，members 时不行
        ("peer", "project.summary.read", "project", True),
        ("leader", "project.summary.read", "other_project", False),
        ("outsider", "project.summary.read", "project", False),
        # 成员写入
        ("member", "project.draft.edit", "project", True),
        ("leader", "project.files.write", "project", True),
        ("teacher", "project.draft.edit", "project", False),
        ("ta", "project.draft.edit", "project", False),
        ("peer", "project.draft.edit", "project", False),
        # A 组账号改 B 组数据
        ("leader", "project.files.write", "other_project", False),
        ("leader", "project.settings.update", "other_project", False),
        # 组长专属
        ("leader", "project.publish", "project", True),
        ("member", "project.publish", "project", False),
        ("leader", "project.archive", "project", True),
        ("teacher", "project.settings.update", "project", False),
        # 归档项目只读：任何人都不能改，组长可以重新打开
        ("leader", "project.files.write", "archived_project", False),
        ("member", "project.draft.edit", "archived_project", False),
        ("leader", "project.settings.update", "archived_project", False),
        ("member", "project.content.read", "archived_project", True),
        ("leader", "project.reopen", "archived_project", True),
        ("member", "project.reopen", "archived_project", False),
        ("leader", "project.reopen", "project", False),
    ],
)
def test_project_matrix(db, scope, who, action, which, expected):
    assert perm.can(db, scope.users[who], action, project(scope, which)) is expected


@pytest.mark.parametrize(
    "who,action,expected",
    [
        ("teacher", "course.read", True),
        ("ta", "course.read", True),
        ("unassigned_ta", "course.read", False),
        ("member", "course.read", True),
        ("outsider", "course.read", False),
        ("admin", "course.read", False),
        ("teacher", "course.staff.manage", True),
        ("ta", "course.staff.manage", False),
        ("teacher", "course.settings.update", True),
        ("other_teacher", "course.settings.update", False),
        ("ta", "course.rules.publish", False),
        ("member", "course.settings.update", False),
    ],
)
def test_course_matrix(db, scope, who, action, expected):
    assert perm.can(db, scope.users[who], action, Target("course", scope.course.id)) is expected


@pytest.mark.parametrize(
    "who,which,expected",
    [
        ("leader", "group", True),
        ("member", "group", False),
        ("peer", "other_group", True),
        ("leader", "other_group", False),
    ],
)
def test_group_create_project(db, scope, who, which, expected):
    target = Target("group", getattr(scope, which).id)
    assert perm.can(db, scope.users[who], "project.create", target) is expected


def test_unknown_action_and_wrong_target_are_denied(db, scope):
    leader = scope.users["leader"]
    assert not perm.can(db, leader, "project.nuke", project(scope))
    assert not perm.can(db, leader, "course.read", project(scope))


def test_named_helpers(db, scope):
    u, c = scope.users, scope.course.id
    assert perm.is_admin(u["admin"]) and not perm.is_admin(u["teacher"])
    assert perm.is_course_teacher(db, u["teacher"], c)
    assert not perm.is_course_teacher(db, u["ta"], c)
    assert perm.is_course_ta(db, u["ta"], c) and perm.is_course_staff(db, u["ta"], c)
    assert perm.is_group_leader(db, u["leader"], scope.group.id)
    assert perm.is_group_member(db, u["member"], scope.group.id)
    assert not perm.is_group_leader(db, u["member"], scope.group.id)
    assert not perm.is_group_member(db, u["disabled"], scope.group.id)
    assert perm.is_project_member(db, u["member"], scope.project.id)
    assert perm.is_project_leader(db, u["leader"], scope.project.id)
    assert perm.is_project_teacher(db, u["teacher"], scope.project.id)
    assert not perm.is_project_member(db, u["peer"], scope.project.id)
    assert perm.is_project_writable(db, scope.project.id)
    assert not perm.is_project_writable(db, scope.archived_project.id)


def test_removed_member_loses_access_immediately(db, scope):
    from sqlalchemy import update

    from app.db.models import ProjectMember

    member = scope.users["member"]
    assert perm.is_project_member(db, member, scope.project.id)
    db.execute(
        update(ProjectMember)
        .where(ProjectMember.user_id == member.id, ProjectMember.project_id == scope.project.id)
        .values(left_at=scope.project.created_at)
    )
    assert not perm.is_project_member(db, member, scope.project.id)


def test_ended_course_makes_projects_read_only(db, scope):
    scope.course.status = "ended"
    db.flush()
    leader = scope.users["leader"]
    assert perm.can(db, leader, "project.content.read", project(scope))
    assert not perm.can(db, leader, "project.files.write", project(scope))
    with pytest.raises(ApiError) as error:
        perm.require_project_member(db, leader, scope.project.id)
    assert error.value.code == "PROJECT_READ_ONLY"


@pytest.mark.parametrize(
    "call,who,code,status",
    [
        (lambda db, s, u: perm.require_project_member(db, u, s.other_project.id), "leader",
         "PROJECT_NOT_FOUND", 404),
        (lambda db, s, u: perm.require_project_member(db, u, s.project.id), "teacher",
         "PROJECT_MEMBER_REQUIRED", 403),
        (lambda db, s, u: perm.require_project_leader(db, u, s.project.id), "member",
         "PROJECT_LEADER_REQUIRED", 403),
        (lambda db, s, u: perm.require_project_member(db, u, s.archived_project.id), "leader",
         "PROJECT_READ_ONLY", 403),
        (lambda db, s, u: perm.require_course_teacher(db, u, s.course.id), "member",
         "COURSE_TEACHER_REQUIRED", 403),
        (lambda db, s, u: perm.require_course_teacher(db, u, s.course.id), "ta",
         "COURSE_TEACHER_REQUIRED", 403),
        (lambda db, s, u: perm.require_admin(u), "teacher", "FORBIDDEN", 403),
        (lambda db, s, u: perm.require_project_read(db, u, s.project.id), "disabled",
         "ACCOUNT_INACTIVE", 403),
        (lambda db, s, u: perm.require_action(db, u, "project.files.write",
                                              Target("project", s.other_project.id)),
         "leader", "PROJECT_NOT_FOUND", 404),
        (lambda db, s, u: perm.require_action(db, u, "project.files.write",
                                              Target("project", s.archived_project.id)),
         "leader", "PROJECT_READ_ONLY", 403),
    ],
)  # fmt: skip
def test_require_functions_reject_escalation(db, scope, call, who, code, status):
    with pytest.raises(ApiError) as error:
        call(db, scope, scope.users[who])
    assert (error.value.code, error.value.status_code) == (code, status)


def test_require_functions_return_relation(db, scope):
    relation = perm.require_project_leader(db, scope.users["leader"], scope.project.id)
    assert relation.leader and relation.member and not relation.read_only
    perm.require_course_teacher(db, scope.users["teacher"], scope.course.id)
    perm.require_admin(scope.users["admin"])
