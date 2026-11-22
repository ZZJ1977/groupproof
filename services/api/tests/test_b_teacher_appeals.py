"""Tests for student appeal workflow, teacher adjudication, and contribution adjustments."""

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
    CourseStaff,
    FunctionalModule,
    Task,
    TaskAssignee,
)
from app.modules.a.models import ActionItem, GithubActivity, GithubRepoLink, Notification
from app.modules.b.models import BCourseAppeal, BCourseAppealDecision
from app.modules.d.models import (
    ContributionCalculation,
    ContributionItem,
    ContributionSnapshot,
)
from tests.b_fixtures import (
    _user,
    b_api,
    b_postgres_schema,
    b_test_database_url,
    build_b_world,
)

_MODELS = (BCourseAppeal, BCourseAppealDecision)


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
        mod = FunctionalModule(id=uuid4(), project_id=world.project_id, name="后端服务")
        session.add(mod)
        session.flush()

        s2 = world.student_ids[1]
        t = Task(
            id=uuid4(),
            project_id=world.project_id,
            module_id=mod.id,
            title="完成鉴权与测试",
            status="completed",
            progress_percent=100,
        )
        session.add(t)
        session.flush()
        session.add(TaskAssignee(task_id=t.id, user_id=s2))

        link = GithubRepoLink(
            id=uuid4(),
            project_id=world.project_id,
            owner="org",
            repo="gp-app",
            installation_id=9,
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
                external_id="sha1",
                title="feat: auth",
                revision="sha1",
                author_user_id=s2,
                occurred_at=datetime.now(UTC),
            )
        )

        ts = datetime.now(UTC)
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
                user_id=s2,
                task_credit=12.0,
                collaboration_credit=3.0,
                share=20.0,
                acceptance_rate=100.0,
                status="formal",
            )
        )
        ta_id = ta.id
        session.commit()
    with b_api(b_engine) as api:
        yield api, b_engine, world, ta_id


def test_appeal_lifecycle_context_and_contribution_snapshot(setup):
    api, b_engine, world, ta_id = setup
    cid = str(world.course_id)
    teacher_id = world.teacher_id
    s2 = world.student_ids[1]

    # 1. Student submits appeal -> creates ActionItem and surfaces in teacher actions & appeals
    sub = api.as_user(s2).post(
        f"/api/v1/courses/{cid}/appeals",
        json={
            "appeal_type": "contribution",
            "title": "申请复核贡献度占比",
            "content": "本人完成了鉴权模块全部编码与测试提交。",
            "evidence": ["commit:sha1"],
        },
    )
    assert sub.status_code == 201
    appeal_id = sub.json()["data"]["id"]

    actions = api.as_user(teacher_id).get(f"/api/v1/teacher/classes/{cid}/actions")
    assert actions.status_code == 200
    assert any(a["type"] == "appeal" for a in actions.json()["data"]["items"])

    # TA without approve_changes cannot adjudicate
    denied = api.as_user(ta_id).post(
        f"/api/v1/teacher/classes/{cid}/appeals/{appeal_id}/handle",
        json={"action": "reject", "reason": "无权"},
    )
    assert denied.status_code == 403

    # 2. Teacher reads detail -> sees linked tasks, GitHub commit count, and current snapshot
    detail = api.as_user(teacher_id).get(f"/api/v1/teacher/classes/{cid}/appeals/{appeal_id}")
    assert detail.status_code == 200
    ddata = detail.json()["data"]
    assert ddata["github_commit_count"] == 1
    assert len(ddata["appellant_tasks"]) == 1
    assert ddata["snapshot"]["items"][0]["share"] == 20.0

    # 3. Teacher requests supplement -> student supplements
    req_sup = api.as_user(teacher_id).post(
        f"/api/v1/teacher/classes/{cid}/appeals/{appeal_id}/handle",
        json={"action": "request_supplement", "reason": "请补充接口测试通过截图说明。"},
    )
    assert req_sup.status_code == 200
    assert req_sup.json()["data"]["appeal"]["status"] == "need_supplement"

    sup = api.as_user(s2).post(
        f"/api/v1/courses/{cid}/appeals/{appeal_id}/supplement",
        json={"supplement_text": "已附上 CI 运行记录与单元测试报告。"},
    )
    assert sup.status_code == 200
    assert sup.json()["data"]["status"] == "pending"

    # 4. Teacher accepts and adjusts contribution -> frozen v2 snapshot, closes ActionItem
    acc = api.as_user(teacher_id).post(
        f"/api/v1/teacher/classes/{cid}/appeals/{appeal_id}/handle",
        json={
            "action": "accept",
            "reason": "核实编码与测试工作量无误，上调占比至 32%。",
            "contribution_adjustments": [
                {"user_id": str(s2), "share": 32.0, "note": "申诉核实上调"}
            ],
        },
    )
    assert acc.status_code == 200, acc.text
    adata = acc.json()["data"]
    assert adata["appeal"]["status"] == "accepted"
    assert adata["snapshot"]["version_no"] == 2
    adjusted_row = next(i for i in adata["snapshot"]["items"] if i["user_id"] == str(s2))
    assert adjusted_row["share"] == 32.0

    with Session(b_engine) as session:
        notes = session.scalars(select(Notification).where(Notification.recipient_id == s2)).all()
        assert any("[申诉已受理]" in n.title for n in notes)
        ai = session.scalar(select(ActionItem).where(ActionItem.category == "appeal"))
        assert ai is not None and ai.status == "completed"
