"""Tests for Phase 3 teacher approval and action center."""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import JSON, DefaultClause, MetaData, create_engine, event, select, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapper, Session
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.models import (
    CourseMember,
    CourseStaff,
    FunctionalModule,
    Milestone,
    ProjectMember,
    Task,
    TaskMilestone,
)
from app.modules.a.models import Notification
from app.modules.b.models import BCourseJoinPolicy, BCourseJoinRequest, BGroupInvitation
from tests.b_fixtures import _user, b_api, b_postgres_schema, b_test_database_url, build_b_world


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
def setup(b_engine):
    with Session(b_engine) as session:
        world = build_b_world(session, max_group_size=4)
        ts = datetime.now(UTC)
        applicant = _user(session, tag=uuid4().hex[:8], role="student", index=10, now=ts)
        ta = _user(session, tag=uuid4().hex[:8], role="ta", index=11, now=ts)
        session.add(
            CourseStaff(course_id=world.course_id, user_id=ta.id, role="ta", permissions={})
        )
        session.add(BCourseJoinPolicy(course_id=world.course_id, mode="approval"))
        jr = BCourseJoinRequest(
            course_id=world.course_id,
            user_id=applicant.id,
            status="pending",
            message="请批准加入软件工程班",
        )
        session.add(jr)

        # Overdue milestone
        ms = Milestone(
            id=uuid4(),
            project_id=world.project_id,
            title="需求基线评审",
            description="提交规格说明书",
            deadline=ts - timedelta(days=3),
            status="in_progress",
            progress_percent=40,
            sort_order=1,
        )
        session.add(ms)
        mod = FunctionalModule(id=uuid4(), project_id=world.project_id, name="核心模块")
        session.add(mod)
        session.flush()
        task = Task(
            id=uuid4(),
            project_id=world.project_id,
            module_id=mod.id,
            title="整理需求",
            status="in_progress",
            progress_percent=40,
            weight=100,
        )
        session.add(task)
        session.flush()
        session.add(TaskMilestone(task_id=task.id, milestone_id=ms.id))

        # Post-deadline invite awaiting teacher
        invitee = _user(session, tag=uuid4().hex[:8], role="student", index=12, now=ts)
        session.add(CourseMember(course_id=world.course_id, user_id=invitee.id, role="student"))
        inv = BGroupInvitation(
            course_id=world.course_id,
            group_id=world.group_id,
            inviter_id=world.student_ids[0],
            invitee_id=invitee.id,
            status="awaiting_teacher",
        )
        session.add(inv)
        session.flush()
        ids = (applicant.id, ta.id, jr.id, ms.id, inv.id, invitee.id)
        session.commit()
    with b_api(b_engine) as api:
        yield api, world, *ids


def test_action_center_list_handle_remind_and_batch(setup, b_engine):
    api, world, applicant_id, ta_id, jr_id, ms_id, inv_id, _invitee_id = setup
    cid = world.course_id

    # TA without approve_joins sees items read-only and gets 403 trying to approve join
    api.as_user(ta_id)
    res_ta = api.get(f"/api/v1/teacher/classes/{cid}/actions")
    assert res_ta.status_code == 200
    assert res_ta.json()["data"]["pending_count"] == 3
    denied = api.post(
        f"/api/v1/teacher/classes/{cid}/actions/join:{jr_id}/handle",
        json={"action_key": "approve"},
    )
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "PERMISSION_DENIED"

    # Teacher lists and filters overdue milestones, sends reminder to project members
    api.as_user(world.teacher_id)
    res_t = api.get(f"/api/v1/teacher/classes/{cid}/actions?type=milestone_overdue")
    assert res_t.status_code == 200 and res_t.json()["data"]["total"] == 1
    assert "已逾期" in res_t.json()["data"]["items"][0]["title"]

    reminded = api.post(
        f"/api/v1/teacher/classes/{cid}/actions/milestone:{ms_id}/remind",
        json={"message": "请抓紧推进需求基线评审！"},
    )
    assert reminded.status_code == 200 and reminded.json()["data"]["notified_count"] >= 1
    with Session(b_engine) as session:
        pm_count = len(
            session.scalars(
                select(ProjectMember.user_id).where(ProjectMember.project_id == world.project_id)
            ).all()
        )
        assert reminded.json()["data"]["notified_count"] >= pm_count
        notes = session.scalars(
            select(Notification.title).where(Notification.recipient_id == world.student_ids[0])
        ).all()
        assert any("催办" in t for t in notes)

    # Approve join request -> CourseMember added
    approved_jr = api.post(
        f"/api/v1/teacher/classes/{cid}/actions/join:{jr_id}/handle",
        json={"action_key": "approve"},
    )
    assert approved_jr.status_code == 200
    assert approved_jr.json()["data"]["status"] == "handled"
    with Session(b_engine) as session:
        cm = session.scalar(
            select(CourseMember).where(
                CourseMember.course_id == cid, CourseMember.user_id == applicant_id
            )
        )
        assert cm is not None and cm.status == "active"

    # Reject post-deadline invite without reason -> 422; with reason -> handled
    bad_inv = api.post(
        f"/api/v1/teacher/classes/{cid}/actions/invite:{inv_id}/handle",
        json={"action_key": "reject"},
    )
    assert bad_inv.status_code == 422
    ok_inv = api.post(
        f"/api/v1/teacher/classes/{cid}/actions/invite:{inv_id}/handle",
        json={"action_key": "reject", "reason": "人数已平衡"},
    )
    assert ok_inv.status_code == 200 and ok_inv.json()["data"]["decision"] == "rejected"

    # Batch acknowledge overdue milestone
    batch = api.post(
        f"/api/v1/teacher/classes/{cid}/actions/batch",
        json={"ids": [f"milestone:{ms_id}"], "action_key": "mark_read"},
    )
    assert batch.status_code == 200
    assert batch.json()["data"]["handled"] == 1
    assert (
        api.get(f"/api/v1/teacher/classes/{cid}/actions?status=pending").json()["data"]["total"]
        == 0
    )
