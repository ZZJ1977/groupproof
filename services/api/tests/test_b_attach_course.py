"""Integration tests for moving a standalone project into a course (teacher <-> student interop)."""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import JSON, DefaultClause, MetaData, create_engine, event, select, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapper, Session
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.models import (
    FunctionalModule,
    GroupMember,
    Project,
    ProjectGroup,
    ProjectMember,
    Task,
)
from app.modules.a.models import AuditEvent
from tests.b_fixtures import (
    _user,
    b_api,
    b_postgres_schema,
    b_test_database_url,
)


@pytest.fixture
def b_engine(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    if os.getenv("B_TEST_DATABASE_URL"):
        with b_postgres_schema(b_test_database_url()) as engine:
            yield engine
        return
    engine = create_engine(
        "sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False}
    )

    @event.listens_for(engine, "connect")
    def enforce_foreign_keys(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")
        connection.create_function("gen_random_uuid", 0, lambda: uuid4().hex)
        connection.create_function("to_regclass", 1, lambda _name: None)

    def ensure_tz(target, *_args):
        for key, val in list(vars(target).items()):
            if isinstance(val, datetime) and val.tzinfo is None:
                setattr(target, key, val.replace(tzinfo=UTC))

    event.listen(Mapper, "load", ensure_tz)
    event.listen(Mapper, "refresh", ensure_tz)

    metadata = MetaData()
    for table in Base.metadata.sorted_tables:
        portable = table.to_metadata(metadata)
        for column in portable.columns:
            if isinstance(column.type, JSONB):
                column.type = JSON()
            if (
                column.server_default is not None
                and str(column.server_default.arg) == "gen_random_uuid()"
            ):
                column.server_default = DefaultClause(text("(gen_random_uuid())"))
    metadata.create_all(engine)
    try:
        yield engine
    finally:
        event.remove(Mapper, "load", ensure_tz)
        event.remove(Mapper, "refresh", ensure_tz)
        engine.dispose()


@pytest.fixture
def actors(b_engine):
    now = datetime.now(UTC)
    tag = uuid4().hex[:8]
    with Session(b_engine) as session:
        teacher = _user(session, tag=tag, role="teacher", index=1, now=now, verified=True)
        leader = _user(session, tag=tag, role="student", index=2, now=now, verified=True)
        teammate_in_course = _user(
            session, tag=tag, role="student", index=3, now=now, verified=True
        )
        teammate_outside = _user(session, tag=tag, role="student", index=4, now=now, verified=True)
        outsider = _user(session, tag=tag, role="student", index=5, now=now, verified=True)
        session.commit()
        ids = {
            "teacher": teacher.id,
            "leader": leader.id,
            "teammate_in_course": teammate_in_course.id,
            "teammate_outside": teammate_outside.id,
            "outsider": outsider.id,
        }
    with b_api(b_engine) as api:
        yield api, ids


def _create_teacher_class(api, teacher_id: UUID, code_suffix: str):
    resp = api.as_user(teacher_id).post(
        "/api/v1/teacher/classes",
        {
            "name": f"软件工程实验 {code_suffix}",
            "code": f"CS-{code_suffix}",
            "semester": "2026-Spring",
            "college": "计算机学院",
            "min_group_size": 1,
            "max_group_size": 5,
            "grouping_mode": "free",
            "join_mode": "direct",
            "formation_deadline": (datetime.now(UTC) + timedelta(days=14)).isoformat(),
            "project_deadline": (datetime.now(UTC) + timedelta(days=60)).isoformat(),
        },
    )
    assert resp.status_code == 201, resp.text
    data = resp.json()["data"]
    return data["id"], data["invite_code"]


def _join_course(api, student_id: UUID, invite_code: str):
    resp = api.as_user(student_id).post("/api/v1/course-joins", {"invite_code": invite_code})
    assert resp.status_code in (200, 201), resp.text
    assert resp.json()["data"]["status"] == "joined"


def _create_standalone_project(api, b_engine, leader_id: UUID, name: str, member_ids=None):
    resp = api.as_user(leader_id).post(
        "/api/v1/a/projects",
        {"name": name, "description": "独立开发的智能实验平台"},
    )
    assert resp.status_code == 201, resp.text
    project_id = UUID(resp.json()["data"]["project_id"])
    with Session(b_engine) as session:
        for uid in member_ids or []:
            session.add(ProjectMember(project_id=project_id, user_id=uid, role="member"))
        mod = FunctionalModule(project_id=project_id, owner_id=leader_id, name="核心模块")
        session.add(mod)
        session.flush()
        session.add(
            Task(
                project_id=project_id,
                module_id=mod.id,
                created_by=leader_id,
                title="搭建核心接口",
                status="in_progress",
                progress_percent=50,
                weight=100,
            )
        )
        session.commit()
    return project_id


def test_full_teacher_student_attach_course_interop_loop(actors, b_engine):
    api, ids = actors
    course_id, invite_code = _create_teacher_class(api, ids["teacher"], "INTEROP01")

    # Leader and one teammate join the teacher's course via invite code.
    _join_course(api, ids["leader"], invite_code)
    _join_course(api, ids["teammate_in_course"], invite_code)

    # Leader creates a standalone project with a course teammate, an external teammate, and a task.
    project_id = _create_standalone_project(
        api,
        b_engine,
        ids["leader"],
        "独立智能协作平台",
        member_ids=[ids["teammate_in_course"], ids["teammate_outside"]],
    )

    # Student leader attaches the standalone project to the course.
    attach_resp = api.as_user(ids["leader"]).post(
        f"/api/v1/projects/{project_id}/attach-course",
        {"course_id": course_id},
    )
    assert attach_resp.status_code == 200, attach_resp.text
    attached = attach_resp.json()["data"]
    assert attached["project_id"] == str(project_id)
    assert attached["course_id"] == course_id
    assert attached["group_name"] == "独立智能协作平台"
    assert attached["members_synced"] == 1
    assert attached["already_attached"] is False
    group_id = attached["group_id"]

    # Student project overview now reflects course_id & group_id, and tasks/members are preserved.
    student_ov = api.as_user(ids["leader"]).get(f"/api/v1/projects/{project_id}/overview")
    assert student_ov.status_code == 200, student_ov.text
    ov_data = student_ov.json()["data"]
    assert ov_data["course_id"] == course_id
    assert ov_data["group_id"] == group_id
    assert ov_data["stats"]["task_count"] == 1
    assert ov_data["stats"]["member_count"] == 3

    # Verify external teammate was NOT removed from ProjectMember, and course teammate joined group.
    with Session(b_engine) as session:
        gm_users = set(
            session.scalars(
                select(GroupMember.user_id).where(
                    GroupMember.group_id == UUID(group_id), GroupMember.left_at.is_(None)
                )
            ).all()
        )
        assert gm_users == {ids["leader"], ids["teammate_in_course"]}
        pm_users = set(
            session.scalars(
                select(ProjectMember.user_id).where(
                    ProjectMember.project_id == project_id, ProjectMember.left_at.is_(None)
                )
            ).all()
        )
        assert pm_users == {ids["leader"], ids["teammate_in_course"], ids["teammate_outside"]}
        audit = session.scalar(
            select(AuditEvent).where(
                AuditEvent.action == "project.attached_to_course",
                AuditEvent.project_id == project_id,
            )
        )
        assert audit is not None

    # Teacher's class endpoints immediately see the group & project.
    api.as_user(ids["teacher"])

    class_home = api.get(f"/api/v1/teacher/classes/{course_id}")
    assert class_home.status_code == 200, class_home.text
    assert class_home.json()["data"]["group_count"] == 1

    plaza = api.get(f"/api/v1/teacher/classes/{course_id}/plaza")
    assert plaza.status_code == 200, plaza.text
    plaza_groups = plaza.json()["data"]["groups"]
    assert any(
        g["id"] == group_id and g.get("project") and g["project"]["id"] == str(project_id)
        for g in plaza_groups
    )

    teacher_projects = api.get(f"/api/v1/teacher/classes/{course_id}/projects")
    assert teacher_projects.status_code == 200, teacher_projects.text
    cards = teacher_projects.json()["data"]["items"]
    assert len(cards) == 1
    assert cards[0]["group_id"] == group_id
    assert cards[0]["project_id"] == str(project_id)
    assert cards[0]["has_project"] is True
    assert cards[0]["total_tasks"] == 1

    reports_overview = api.get(f"/api/v1/teacher/classes/{course_id}/reports/overview")
    assert reports_overview.status_code == 200, reports_overview.text
    rep_data = reports_overview.json()["data"]
    assert rep_data["group_count"] == 1
    assert rep_data["project_count"] == 1


def test_attach_course_reuses_existing_empty_group_and_handles_errors(actors, b_engine):
    api, ids = actors
    course_id, invite_code = _create_teacher_class(api, ids["teacher"], "INTEROP02")
    _join_course(api, ids["leader"], invite_code)
    _join_course(api, ids["teammate_in_course"], invite_code)

    # Student already created an empty group in this course.
    grp_resp = api.as_user(ids["leader"]).post(
        f"/api/v1/courses/{course_id}/groups",
        {"name": "既有星辰组", "direction": "AI"},
    )
    assert grp_resp.status_code == 201, grp_resp.text
    existing_group_id = grp_resp.json()["data"]["id"]

    project_id = _create_standalone_project(
        api,
        b_engine,
        ids["leader"],
        "复用小组项目",
        member_ids=[ids["teammate_in_course"]],
    )

    # Error 1: non-leader project member gets 403 PROJECT_LEADER_REQUIRED.
    non_leader = api.as_user(ids["teammate_in_course"]).post(
        f"/api/v1/projects/{project_id}/attach-course",
        {"course_id": course_id},
    )
    assert non_leader.status_code == 403
    assert non_leader.json()["error"]["code"] == "PROJECT_LEADER_REQUIRED"

    # Error 2: outsider who is not a member of the course gets 403 COURSE_MEMBER_REQUIRED.
    outsider_proj = _create_standalone_project(api, b_engine, ids["outsider"], "外部项目")
    not_in_course = api.as_user(ids["outsider"]).post(
        f"/api/v1/projects/{outsider_proj}/attach-course",
        {"course_id": course_id},
    )
    assert not_in_course.status_code == 403
    assert not_in_course.json()["error"]["code"] == "COURSE_MEMBER_REQUIRED"

    # Success: attaches and reuses existing empty group.
    ok = api.as_user(ids["leader"]).post(
        f"/api/v1/projects/{project_id}/attach-course",
        {"course_id": course_id},
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["data"]["group_id"] == existing_group_id
    assert ok.json()["data"]["group_name"] == "既有星辰组"

    # Error 3: attaching the same project again returns 409 PROJECT_ALREADY_IN_COURSE.
    again = api.as_user(ids["leader"]).post(
        f"/api/v1/projects/{project_id}/attach-course",
        {"course_id": course_id},
    )
    assert again.status_code == 409
    assert again.json()["error"]["code"] == "PROJECT_ALREADY_IN_COURSE"

    # Error 4: attaching another standalone project into a busy group returns 409 GROUP_HAS_PROJECT.
    second_proj = _create_standalone_project(api, b_engine, ids["leader"], "第二个独立项目")
    group_busy = api.as_user(ids["leader"]).post(
        f"/api/v1/projects/{second_proj}/attach-course",
        {"course_id": course_id, "group_id": existing_group_id},
    )
    assert group_busy.status_code == 409
    assert group_busy.json()["error"]["code"] == "GROUP_HAS_PROJECT"

    # Verify DB integrity: project row has the expected course/group.
    with Session(b_engine) as session:
        proj = session.get(Project, project_id)
        grp = session.get(ProjectGroup, UUID(existing_group_id))
        assert proj is not None and grp is not None
        assert proj.course_id == UUID(course_id)
        assert proj.group_id == grp.id


def test_attach_course_blocks_non_leader_group_member_and_respects_frozen_roster(actors, b_engine):
    api, ids = actors
    course_id, invite_code = _create_teacher_class(api, ids["teacher"], "INTEROP03")
    _join_course(api, ids["leader"], invite_code)
    _join_course(api, ids["teammate_in_course"], invite_code)
    _join_course(api, ids["outsider"], invite_code)

    # Leader creates an empty group; teammate_in_course joins as non-leader member.
    grp_resp = api.as_user(ids["leader"]).post(
        f"/api/v1/courses/{course_id}/groups",
        {"name": "权限校验组", "direction": "Security"},
    )
    assert grp_resp.status_code == 201, grp_resp.text
    group_id = grp_resp.json()["data"]["id"]
    join_resp = api.as_user(ids["teammate_in_course"]).post(f"/api/v1/groups/{group_id}/join")
    assert join_resp.status_code == 200, join_resp.text

    # Non-leader member creates their own standalone project and tries to attach without group_id.
    member_proj = _create_standalone_project(
        api, b_engine, ids["teammate_in_course"], "非组长个人项目"
    )
    denied = api.as_user(ids["teammate_in_course"]).post(
        f"/api/v1/projects/{member_proj}/attach-course",
        {"course_id": course_id},
    )
    assert denied.status_code == 403, denied.text
    assert denied.json()["error"]["code"] == "GROUP_LEADER_REQUIRED"

    # Now freeze group roster and verify leader's attach does not mutate frozen group members.
    with Session(b_engine) as session:
        grp = session.get(ProjectGroup, UUID(group_id))
        assert grp is not None
        grp.roster_frozen = True
        session.commit()

    leader_proj = _create_standalone_project(
        api,
        b_engine,
        ids["leader"],
        "冻结名单项目",
        member_ids=[ids["outsider"]],
    )
    attached = api.as_user(ids["leader"]).post(
        f"/api/v1/projects/{leader_proj}/attach-course",
        {"course_id": course_id},
    )
    assert attached.status_code == 200, attached.text
    assert attached.json()["data"]["members_synced"] == 0

    with Session(b_engine) as session:
        gm_users = set(
            session.scalars(
                select(GroupMember.user_id).where(
                    GroupMember.group_id == UUID(group_id), GroupMember.left_at.is_(None)
                )
            ).all()
        )
        assert ids["outsider"] not in gm_users
        assert gm_users == {ids["leader"], ids["teammate_in_course"]}
