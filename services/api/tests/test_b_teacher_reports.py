"""Tests for teacher class data reports center."""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import JSON, DefaultClause, MetaData, create_engine, event, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapper, Session
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.models.core import (
    CourseStaff,
    FunctionalModule,
    Milestone,
    ProgressEvent,
    Task,
    TaskAssignee,
    TaskMilestone,
)
from app.modules.a.models import GithubActivity, GithubRepoLink
from app.modules.d.models import (
    ContributionCalculation,
    ContributionItem,
    ContributionSnapshot,
    Risk,
)
from tests.b_fixtures import (
    _user,
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
        ta = _user(session, tag=uuid4().hex[:8], role="ta", index=2, now=datetime.now(UTC))
        session.add(
            CourseStaff(course_id=world.course_id, user_id=ta.id, role="ta", permissions={})
        )

        mod = FunctionalModule(id=uuid4(), project_id=world.project_id, name="核心模块")
        session.add(mod)
        session.flush()

        ts = datetime.now(UTC)
        ms = Milestone(
            id=uuid4(),
            project_id=world.project_id,
            title="需求评审",
            deadline=ts - timedelta(days=2),
            status="in_progress",
            progress_percent=50,
            sort_order=1,
        )
        session.add(ms)
        session.flush()

        t_done = Task(
            id=uuid4(),
            project_id=world.project_id,
            module_id=mod.id,
            title="完成需求文档",
            status="completed",
            progress_percent=100,
        )
        t_todo = Task(
            id=uuid4(),
            project_id=world.project_id,
            module_id=mod.id,
            title="编写接口测试",
            status="in_progress",
            progress_percent=20,
        )
        session.add_all([t_done, t_todo])
        session.flush()

        session.add_all(
            [
                TaskMilestone(task_id=t_done.id, milestone_id=ms.id),
                TaskMilestone(task_id=t_todo.id, milestone_id=ms.id),
                TaskAssignee(task_id=t_done.id, user_id=world.leader_id),
                ProgressEvent(
                    id=uuid4(),
                    project_id=world.project_id,
                    task_id=t_done.id,
                    actor_id=world.leader_id,
                    to_status="completed",
                    progress_after=100,
                ),
                Risk(
                    id=uuid4(),
                    project_id=world.project_id,
                    milestone_id=ms.id,
                    owner_id=world.leader_id,
                    title="里程碑逾期风险",
                    description="关键前置未按时结项",
                    level="high",
                    status="open",
                ),
            ]
        )

        link = GithubRepoLink(
            id=uuid4(),
            project_id=world.project_id,
            owner="org",
            repo="gp-demo",
            installation_id=1001,
            default_branch="main",
        )
        session.add(link)
        session.flush()
        session.add(
            GithubActivity(
                id=uuid4(),
                project_id=world.project_id,
                link_id=link.id,
                kind="commit",
                external_id="abc123",
                title="feat: setup",
                revision="abc123",
                author_user_id=world.leader_id,
                occurred_at=ts,
            )
        )

        calc = ContributionCalculation(
            id=uuid4(),
            project_id=world.project_id,
            formula_version="v1",
            status="completed",
            basis_version="baseline-1",
            calculated_by=world.teacher_id,
            completed_at=ts,
        )
        session.add(calc)
        session.flush()
        snap = ContributionSnapshot(
            id=uuid4(),
            project_id=world.project_id,
            calculation_id=calc.id,
            version_no=1,
            status="frozen",
            created_by=world.teacher_id,
            frozen_at=ts,
        )
        session.add(snap)
        session.flush()
        session.add(
            ContributionItem(
                id=uuid4(),
                snapshot_id=snap.id,
                user_id=world.leader_id,
                task_credit=10.0,
                collaboration_credit=2.0,
                share=40.0,
                acceptance_rate=100.0,
                status="formal",
            )
        )
        ta_id = ta.id
        session.commit()
    with b_api(b_engine) as api:
        yield api, world, ta_id


def test_reports_endpoints_and_export_permission(setup):
    api, world, ta_id = setup
    cid = str(world.course_id)
    teacher_id = world.teacher_id

    ov = api.as_user(teacher_id).get(f"/api/v1/teacher/classes/{cid}/reports/overview")
    assert ov.status_code == 200
    ov_data = ov.json()["data"]
    assert ov_data["student_count"] == 4
    assert ov_data["group_count"] == 1
    assert ov_data["project_count"] == 1
    assert ov_data["high_risk_groups"] == 1
    assert ov_data["overdue_milestones"] == 1

    prog = api.as_user(teacher_id).get(f"/api/v1/teacher/classes/{cid}/reports/progress")
    assert prog.status_code == 200
    assert prog.json()["data"]["items"][0]["tone"] == "red"
    assert prog.json()["data"]["items"][0]["completed_tasks"] == 1

    ms = api.as_user(teacher_id).get(f"/api/v1/teacher/classes/{cid}/reports/milestones")
    assert ms.status_code == 200
    assert len(ms.json()["data"]["rows"][0]["milestones"]) == 1

    risks = api.as_user(teacher_id).get(f"/api/v1/teacher/classes/{cid}/reports/risks")
    assert risks.status_code == 200
    assert risks.json()["data"]["items"][0]["risk_level"] == "high"
    assert risks.json()["data"]["items"][0]["open_risk_count"] == 1

    act = api.as_user(teacher_id).get(f"/api/v1/teacher/classes/{cid}/reports/activity")
    assert act.status_code == 200
    leader_row = act.json()["data"]["items"][0]
    assert leader_row["user_id"] == str(world.leader_id)
    assert leader_row["github_events"] == 1
    assert leader_row["progress_events"] == 1
    assert leader_row["completed_tasks"] == 1
    assert any(row["low_activity"] for row in act.json()["data"]["items"][1:])

    contrib = api.as_user(teacher_id).get(f"/api/v1/teacher/classes/{cid}/reports/contribution")
    assert contrib.status_code == 200
    assert contrib.json()["data"]["projects"][0]["items"][0]["share"] == 40.0

    # TA without export_reports is blocked from exporting
    denied = api.as_user(ta_id).post(
        f"/api/v1/teacher/classes/{cid}/reports/export",
        json={"format": "csv"},
    )
    assert denied.status_code == 403

    # Owner exports CSV + Markdown download
    exp = api.as_user(teacher_id).post(
        f"/api/v1/teacher/classes/{cid}/reports/export",
        json={"format": "markdown"},
    )
    assert exp.status_code == 200
    assert "教学数据报告" in exp.json()["data"]["content"]

    dl = api.as_user(teacher_id).get(
        f"/api/v1/teacher/classes/{cid}/reports/export/download?format=csv"
    )
    assert dl.status_code == 200
    assert dl.content.startswith(b"\xef\xbb\xbf")
