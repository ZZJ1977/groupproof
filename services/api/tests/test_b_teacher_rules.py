"""Tests for Phase 2 class settings, course lifecycle, and versioned course rules."""

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
from app.db.models import Project
from tests.b_fixtures import b_api, b_postgres_schema, b_test_database_url, build_b_world


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
        other = build_b_world(session)
        session.commit()
    with b_api(b_engine) as api:
        yield api, world, other


def test_class_settings_end_archive_reopen_and_delete(setup):
    api, world, _other = setup
    cid = world.course_id
    api.as_user(world.teacher_id)

    s0 = api.get(f"/api/v1/teacher/classes/{cid}/settings")
    assert s0.status_code == 200
    d0 = s0.json()["data"]
    assert d0["can_delete"] is False

    # Update name, description & toggle join_mode
    upd = api.patch(
        f"/api/v1/teacher/classes/{cid}/settings",
        json={
            "name": "软件工程实践（更新班）",
            "description": "补充班级说明",
            "join_mode": "approval",
            "expected_version": d0["lock_version"],
        },
    )
    assert upd.status_code == 200
    d1 = upd.json()["data"]
    assert d1["name"] == "软件工程实践（更新班）"
    assert d1["description"] == "补充班级说明"
    assert d1["join_mode"] == "approval"

    # End class -> subsequent write returns 409 COURSE_NOT_ACTIVE
    ended = api.post(
        f"/api/v1/teacher/classes/{cid}/end",
        json={"reason": "学期已结束", "expected_version": d1["lock_version"]},
    )
    assert ended.status_code == 200
    d2 = ended.json()["data"]
    assert d2["status"] == "ended"

    blocked_write = api.patch(
        f"/api/v1/teacher/classes/{cid}/settings",
        json={"name": "不允许修改", "expected_version": d2["lock_version"]},
    )
    assert blocked_write.status_code == 409
    assert blocked_write.json()["error"]["code"] == "COURSE_NOT_ACTIVE"

    # Cannot delete non-empty class
    cant_del = api.delete(f"/api/v1/teacher/classes/{cid}")
    assert cant_del.status_code == 409 and cant_del.json()["error"]["code"] == "COURSE_HAS_STUDENTS"

    # Archive & reopen
    archived = api.post(
        f"/api/v1/teacher/classes/{cid}/archive",
        json={"expected_version": d2["lock_version"]},
    )
    assert archived.status_code == 200 and archived.json()["data"]["archived_at"] is not None
    active_list = api.get("/api/v1/teacher/classes?tab=active").json()["data"]["items"]
    assert all(item["id"] != str(cid) for item in active_list)

    reopened = api.post(
        f"/api/v1/teacher/classes/{cid}/reopen",
        json={"reason": "开放补交", "expected_version": archived.json()["data"]["lock_version"]},
    )
    assert reopened.status_code == 200 and reopened.json()["data"]["status"] == "active"

    # Empty teacher-created class can be ended and deleted cleanly
    future = (datetime.now(UTC) + timedelta(days=30)).isoformat()
    new_cls = api.post(
        "/api/v1/teacher/classes",
        json={
            "name": "待删测试班",
            "semester": "2026秋",
            "college": "软件学院",
            "project_deadline": future,
            "min_group_size": 2,
            "max_group_size": 4,
            "join_mode": "direct",
        },
    ).json()["data"]
    assert new_cls["student_count"] == 0
    end_new = api.post(
        f"/api/v1/teacher/classes/{new_cls['id']}/end",
        json={"reason": "取消开班", "expected_version": new_cls["lock_version"]},
    )
    assert end_new.status_code == 200
    deleted = api.delete(f"/api/v1/teacher/classes/{new_cls['id']}")
    assert deleted.status_code == 200 and deleted.json()["data"]["deleted"] is True
    assert api.get(f"/api/v1/teacher/classes/{new_cls['id']}").status_code == 404


def test_course_rules_versioning_and_milestone_template(setup, b_engine):
    api, world, _other = setup
    cid = world.course_id
    api.as_user(world.teacher_id)

    with Session(b_engine) as session:
        proj_before = session.get(Project, world.project_id)
        deadline_before = proj_before.final_deadline

    r0 = api.get(f"/api/v1/teacher/classes/{cid}/rules")
    assert r0.status_code == 200 and r0.json()["data"]["can_edit"] is True

    d1_deadline = (datetime.now(UTC) + timedelta(days=15)).isoformat()
    d2_deadline = (datetime.now(UTC) + timedelta(days=40)).isoformat()
    draft = api.put(
        f"/api/v1/teacher/classes/{cid}/rules/draft",
        json={
            "change_summary": "新增两阶段里程碑模板",
            "rules": {
                "grouping_mode": "approval",
                "min_group_size": 2,
                "max_group_size": 5,
                "post_deadline_policy": "teacher_approval",
                "allow_cross_group_transfer": False,
                "project_deadline": d2_deadline,
                "milestone_template": [
                    {
                        "title": "需求评审",
                        "description": "完成需求规格说明",
                        "deadline": d1_deadline,
                        "weight": 40,
                    },
                    {
                        "title": "最终交付",
                        "description": "提交系统与演示视频",
                        "deadline": d2_deadline,
                        "weight": 60,
                    },
                ],
                "require_baseline_review": True,
                "require_plan_review": False,
                "auto_contribution": True,
                "contribution_weights": {
                    "task_weight": 50,
                    "verification_weight": 30,
                    "collaboration_weight": 20,
                },
                "appeal_window_days": 10,
                "required_deliverables": ["需求文档", "源代码压缩包"],
                "final_presentation": True,
            },
        },
    )
    assert draft.status_code == 200 and draft.json()["data"]["status"] == "draft"

    pub1 = api.post(
        f"/api/v1/teacher/classes/{cid}/rules/publish",
        json={"change_summary": "正式发布 v1 规则"},
    )
    assert pub1.status_code == 200
    assert pub1.json()["data"]["version_no"] == 1
    assert pub1.json()["data"]["status"] == "published"

    # Second publish increments version_no and archives v1
    pub2 = api.post(
        f"/api/v1/teacher/classes/{cid}/rules/publish",
        json={
            "change_summary": "调整申诉窗口为 14 天",
            "rules": {
                **pub1.json()["data"]["rules"],
                "appeal_window_days": 14,
            },
        },
    )
    assert pub2.status_code == 200 and pub2.json()["data"]["version_no"] == 2

    overview = api.get(f"/api/v1/teacher/classes/{cid}/rules").json()["data"]
    assert overview["current_published"]["version_no"] == 2
    assert len(overview["versions"]) == 2
    assert overview["versions"][1]["status"] == "archived"

    # Milestone template synced cleanly for future projects via existing B3 endpoint
    tpl = api.get(f"/api/v1/courses/{cid}/project-template")
    assert tpl.status_code == 200
    assert [m["title"] for m in tpl.json()["data"]["milestones"]] == ["需求评审", "最终交付"]

    # Existing project remains untouched
    with Session(b_engine) as session:
        proj_after = session.get(Project, world.project_id)
        assert proj_after.final_deadline == deadline_before
