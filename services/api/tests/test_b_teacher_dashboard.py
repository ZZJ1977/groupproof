"""Tests for per-class project monitor (Screen 61) and cross-class teacher dashboard (Screen 58)."""

from __future__ import annotations

import os
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from sqlalchemy import JSON, DefaultClause, MetaData, create_engine, event, select, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapper, Session
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.models.core import (
    Course,
    CourseStaff,
    FunctionalModule,
    ProgressEvent,
    ProjectGroup,
    Task,
)
from app.modules.a.models import Notification
from tests.b_fixtures import (
    _user,
    add_course_student,
    b_api,
    b_postgres_schema,
    b_test_database_url,
    build_b_world,
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
def setup(b_engine):
    with Session(b_engine) as session:
        world = build_b_world(session, max_group_size=4)
        add_course_student(session, world)
        # Empty group without initialized project
        empty_group = ProjectGroup(
            id=uuid4(),
            course_id=world.course_id,
            name="待立项新队",
        )
        session.add(empty_group)

        # Second class taught by the same teacher
        second_course = Course(
            id=uuid4(),
            code=f"CS{uuid4().hex[:6].upper()}",
            name="分布式系统课程设计",
            semester="2026-Fall",
            college="计算机学院",
            status="active",
            owner_id=world.teacher_id,
            min_group_size=2,
            max_group_size=4,
        )
        session.add(second_course)
        session.flush()
        session.add(
            CourseStaff(
                course_id=second_course.id, user_id=world.teacher_id, role="teacher", permissions={}
            )
        )

        mod = FunctionalModule(id=uuid4(), project_id=world.project_id, name="核心调度")
        session.add(mod)
        session.flush()
        task = Task(
            id=uuid4(),
            project_id=world.project_id,
            module_id=mod.id,
            title="实现工作台统计",
            status="completed",
            progress_percent=100,
        )
        session.add(task)
        session.flush()
        session.add(
            ProgressEvent(
                id=uuid4(),
                project_id=world.project_id,
                task_id=task.id,
                actor_id=world.leader_id,
                to_status="completed",
                progress_after=100,
            )
        )
        # Extra teacher who owns no classes should see 0 classes
        other_teacher = _user(
            session, tag=uuid4().hex[:8], role="teacher", index=9, now=datetime.now(UTC)
        )
        other_tid = other_teacher.id
        second_cid = second_course.id
        session.commit()
    with b_api(b_engine) as api:
        yield api, b_engine, world, second_cid, other_tid


def test_class_projects_monitor_and_cross_class_dashboard(setup):
    api, b_engine, world, second_cid, other_tid = setup
    cid = str(world.course_id)
    teacher_id = world.teacher_id

    # 1. Per-class projects monitor returns both initialized and uninitialized groups
    projs = api.as_user(teacher_id).get(f"/api/v1/teacher/classes/{cid}/projects")
    assert projs.status_code == 200
    pdata = projs.json()["data"]
    assert pdata["counts"]["initialized"] == 1
    assert pdata["counts"]["uninitialized"] == 1

    # Detail + remind on initialized group
    detail = api.as_user(teacher_id).get(f"/api/v1/teacher/classes/{cid}/projects/{world.group_id}")
    assert detail.status_code == 200
    assert detail.json()["data"]["card"]["completed_tasks"] == 1

    rem = api.as_user(teacher_id).post(
        f"/api/v1/teacher/classes/{cid}/projects/{world.group_id}/remind",
        json={"message": "请本周内更新进度。"},
    )
    assert rem.status_code == 200
    assert rem.json()["data"]["notified_count"] == 4

    with Session(b_engine) as session:
        notes = session.scalars(
            select(Notification).where(Notification.recipient_id == world.leader_id)
        ).all()
        assert any("[项目催办]" in n.title for n in notes)

    # 2. Student cannot access /teacher/dashboard
    stu_denied = api.as_user(world.leader_id).get("/api/v1/teacher/dashboard")
    assert stu_denied.status_code == 403

    # 3. Teacher dashboard aggregates across managed classes
    dash = api.as_user(teacher_id).get("/api/v1/teacher/dashboard")
    assert dash.status_code == 200
    ddata = dash.json()["data"]
    assert ddata["total_classes"] == 2
    assert ddata["total_students"] == 5
    assert ddata["total_groups"] == 2
    assert ddata["total_projects"] == 1
    assert {c["course_id"] for c in ddata["classes"]} == {cid, str(second_cid)}
    assert len(ddata["recent_activity"]) >= 1

    # Isolated teacher sees 0 classes
    other_dash = api.as_user(other_tid).get("/api/v1/teacher/dashboard")
    assert other_dash.status_code == 200
    assert other_dash.json()["data"]["total_classes"] == 0

    for suffix in ("actions", "risks", "activity"):
        sub = api.as_user(teacher_id).get(f"/api/v1/teacher/dashboard/{suffix}")
        assert sub.status_code == 200
