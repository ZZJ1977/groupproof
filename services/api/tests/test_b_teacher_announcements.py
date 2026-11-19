"""Tests for teacher course announcements, pinning, read receipts, and unread reminders."""

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
from app.db.models import CourseStaff
from app.modules.a.models import Notification
from app.modules.b.models import BAnnouncementRead, BCourseAnnouncement
from tests.b_fixtures import (
    _user,
    b_api,
    b_postgres_schema,
    b_test_database_url,
    build_b_world,
)

_MODELS = (BCourseAnnouncement, BAnnouncementRead)


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
        ta_id = ta.id
        session.commit()
    with b_api(b_engine) as api:
        yield api, b_engine, world, ta_id


def test_announcements_publish_pin_reads_remind_and_permissions(setup):
    api, b_engine, world, ta_id = setup
    cid = str(world.course_id)
    teacher_id = world.teacher_id
    s1, s2 = world.student_ids[0], world.student_ids[1]

    # TA without post_announcements is rejected
    denied = api.as_user(ta_id).post(
        f"/api/v1/teacher/classes/{cid}/announcements",
        json={"title": "越权公告", "content": "内容", "priority": "normal"},
    )
    assert denied.status_code == 403

    # Owner grants post_announcements to TA
    grant = api.as_user(teacher_id).patch(
        f"/api/v1/teacher/classes/{cid}/staff/{ta_id}/permissions",
        json={"post_announcements": True},
    )
    assert grant.status_code == 200

    # Publish normal unpinned announcement first
    r1 = api.as_user(ta_id).post(
        f"/api/v1/teacher/classes/{cid}/announcements",
        json={"title": "第一周实验安排", "content": "请于周五前提交选题。", "priority": "normal"},
    )
    assert r1.status_code == 201
    ann1_id = r1.json()["data"]["id"]

    # Publish urgent pinned announcement -> notification table must receive urgent announcement
    r2 = api.as_user(teacher_id).post(
        f"/api/v1/teacher/classes/{cid}/announcements",
        json={
            "title": "中期答辩时间变更",
            "content": "调整至下周三下午 14:00。",
            "priority": "urgent",
            "is_pinned": True,
        },
    )
    assert r2.status_code == 201
    ann2_id = r2.json()["data"]["id"]

    with Session(b_engine) as session:
        notes = session.scalars(select(Notification).where(Notification.recipient_id == s1)).all()
        assert any("[紧急公告]" in n.title for n in notes)

    # List should order pinned announcement first
    listing = api.as_user(teacher_id).get(f"/api/v1/teacher/classes/{cid}/announcements")
    assert listing.status_code == 200
    items = listing.json()["data"]["items"]
    assert items[0]["id"] == ann2_id
    assert listing.json()["data"]["total_students"] == 4

    # Student s1 checks unread & marks ann2 read
    unread_s1 = api.as_user(s1).get("/api/v1/me/announcements/unread")
    assert unread_s1.status_code == 200
    assert unread_s1.json()["data"]["total"] == 2
    assert unread_s1.json()["data"]["items"][0]["id"] == ann2_id

    mark = api.as_user(s1).post(f"/api/v1/courses/{cid}/announcements/{ann2_id}/read", json={})
    assert mark.status_code == 200
    assert mark.json()["data"]["read"] is True

    # Pin ann1 via PATCH & check teacher reads breakdown + remind unread
    pin1 = api.as_user(teacher_id).patch(
        f"/api/v1/teacher/classes/{cid}/announcements/{ann1_id}",
        json={"is_pinned": True},
    )
    assert pin1.status_code == 200

    reads = api.as_user(teacher_id).get(
        f"/api/v1/teacher/classes/{cid}/announcements/{ann2_id}/reads"
    )
    assert reads.status_code == 200
    assert reads.json()["data"]["read_count"] == 1
    assert reads.json()["data"]["unread_count"] == 3

    rem = api.as_user(teacher_id).post(
        f"/api/v1/teacher/classes/{cid}/announcements/{ann2_id}/remind",
        json={},
    )
    assert rem.status_code == 200
    assert rem.json()["data"]["notified_count"] == 3

    with Session(b_engine) as session:
        s2_notes = session.scalars(
            select(Notification).where(Notification.recipient_id == s2)
        ).all()
        assert any("[公告催读]" in n.title for n in s2_notes)
