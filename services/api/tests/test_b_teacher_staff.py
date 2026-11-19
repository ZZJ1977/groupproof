"""Tests for course TA staff invitations, fine-grained permissions, and removal."""

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
from app.db.models import User
from app.modules.a.models import AuditEvent
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
        other = build_b_world(session)
        loose = add_course_student(session, world)
        loose_user = session.get(User, loose)
        ts = datetime.now(UTC)
        ta1 = _user(session, tag=uuid4().hex[:8], role="ta", index=1, now=ts)
        ta2 = _user(session, tag=uuid4().hex[:8], role="ta", index=2, now=ts)
        coteacher = _user(session, tag=uuid4().hex[:8], role="teacher", index=3, now=ts)
        loose_email = loose_user.email
        ta1_info = (ta1.id, ta1.email)
        ta2_info = (ta2.id, ta2.email)
        co_info = (coteacher.id, coteacher.email)
        session.commit()
    with b_api(b_engine) as api:
        yield api, world, other, (loose, loose_email), ta1_info, ta2_info, co_info


def test_staff_invite_validation_and_listing(setup):
    api, world, other, (_loose_id, loose_email), (ta1_id, ta1_email), _ta2, (co_id, co_email) = (
        setup
    )
    cid = world.course_id

    api.as_user(world.teacher_id)
    initial = api.get(f"/api/v1/teacher/classes/{cid}/staff")
    assert initial.status_code == 200
    assert initial.json()["data"]["total"] == 1
    assert initial.json()["data"]["items"][0]["is_owner"] is True
    assert initial.json()["data"]["can_manage_staff"] is True

    # Unknown email -> 404
    not_found = api.post(
        f"/api/v1/teacher/classes/{cid}/staff/invite",
        json={"email": "nobody@school.local", "role": "ta"},
    )
    assert not_found.status_code == 404 and not_found.json()["error"]["code"] == "USER_NOT_FOUND"

    # Student cannot be invited as staff -> 422
    student_email_req = api.post(
        f"/api/v1/teacher/classes/{cid}/staff/invite",
        json={"email": loose_email, "role": "ta"},
    )
    assert (
        student_email_req.status_code == 422
        and student_email_req.json()["error"]["code"] == "NOT_TEACHER_OR_TA"
    )

    # Invite TA1 -> 201, all 6 permissions False by default
    invited = api.post(
        f"/api/v1/teacher/classes/{cid}/staff/invite",
        json={"email": ta1_email.upper(), "role": "ta"},
    )
    assert invited.status_code == 201
    data = invited.json()["data"]
    assert data["user_id"] == str(ta1_id)
    assert data["role"] == "ta"
    assert all(v is False for v in data["permissions"].values())

    # Duplicate invite -> 409
    dup = api.post(
        f"/api/v1/teacher/classes/{cid}/staff/invite",
        json={"email": ta1_email, "role": "ta"},
    )
    assert dup.status_code == 409 and dup.json()["error"]["code"] == "ALREADY_STAFF"

    # Invite co-teacher; co-teacher is not owner so cannot invite others -> 403
    co_inv = api.post(
        f"/api/v1/teacher/classes/{cid}/staff/invite",
        json={"email": co_email, "role": "teacher"},
    )
    assert co_inv.status_code == 201
    api.as_user(co_id)
    assert (
        api.post(
            f"/api/v1/teacher/classes/{cid}/staff/invite",
            json={"email": ta1_email, "role": "ta"},
        ).status_code
        == 403
    )

    # Other course teacher gets 403
    api.as_user(other.teacher_id)
    assert api.get(f"/api/v1/teacher/classes/{cid}/staff").status_code == 403


def test_ta_permissions_toggle_enforced_on_group_actions(setup, b_engine):
    api, world, _other, (loose, _loose_email), (ta1_id, ta1_email), _ta2, _co = setup
    cid = world.course_id

    api.as_user(world.teacher_id)
    owner_perms = api.get(f"/api/v1/teacher/classes/{cid}/my-permissions")
    assert owner_perms.status_code == 200
    assert owner_perms.json()["data"]["is_owner"] is True
    assert all(owner_perms.json()["data"]["permissions"].values())

    api.post(
        f"/api/v1/teacher/classes/{cid}/staff/invite",
        json={"email": ta1_email, "role": "ta"},
    )

    # Without manage_groups, TA is denied on group creation & assignment (403 PERMISSION_DENIED)
    api.as_user(ta1_id)
    ta_perms_before = api.get(f"/api/v1/teacher/classes/{cid}/my-permissions").json()["data"]
    assert ta_perms_before["role"] == "ta"
    assert ta_perms_before["permissions"]["manage_groups"] is False
    denied_group = api.post(
        f"/api/v1/teacher/classes/{cid}/groups",
        json={"name": "TA Team"},
    )
    assert denied_group.status_code == 403
    assert denied_group.json()["error"]["code"] == "PERMISSION_DENIED"
    denied_assign = api.post(
        f"/api/v1/teacher/classes/{cid}/assignments",
        json={"student_id": str(loose), "to_group_id": str(world.group_id)},
    )
    assert denied_assign.status_code == 403

    # Owner enables manage_groups -> TA can create group and assign loose student
    api.as_user(world.teacher_id)
    patched = api.patch(
        f"/api/v1/teacher/classes/{cid}/staff/{ta1_id}/permissions",
        json={"manage_groups": True, "approve_joins": True},
    )
    assert patched.status_code == 200
    assert patched.json()["data"]["permissions"]["manage_groups"] is True
    assert patched.json()["data"]["permissions"]["approve_joins"] is True
    assert patched.json()["data"]["permissions"]["export_reports"] is False

    api.as_user(ta1_id)
    ta_plaza = api.get(f"/api/v1/teacher/classes/{cid}/plaza").json()["data"]
    assert ta_plaza["can_manage"] is True
    ta_group = api.post(
        f"/api/v1/teacher/classes/{cid}/groups",
        json={"name": "TA Authorized Team"},
    )
    assert ta_group.status_code == 201
    tg_data = ta_group.json()["data"]
    assigned = api.post(
        f"/api/v1/teacher/classes/{cid}/assignments",
        json={
            "student_id": str(loose),
            "to_group_id": tg_data["id"],
            "to_group_version": tg_data["lock_version"],
        },
    )
    assert assigned.status_code == 200
    assert assigned.json()["data"]["to_group"]["member_count"] == 1

    # TA still cannot remove students or rotate invite (teacher-only actions)
    assert (
        api.post(
            f"/api/v1/teacher/classes/{cid}/invite-code/rotate",
            json={"expected_version": 0},
        ).status_code
        == 403
    )

    with Session(b_engine) as session:
        audit_actions = session.scalars(
            select(AuditEvent.action).where(AuditEvent.course_id == cid)
        ).all()
        assert "staff.invited" in audit_actions
        assert "staff.permissions_updated" in audit_actions


def test_staff_remove_and_reinvite_resets_permissions(setup):
    api, world, _other, _loose, (ta1_id, ta1_email), _ta2, _co = setup
    cid = world.course_id

    api.as_user(world.teacher_id)
    # Cannot modify or remove owner
    assert (
        api.patch(
            f"/api/v1/teacher/classes/{cid}/staff/{world.teacher_id}/permissions",
            json={"manage_groups": False},
        ).status_code
        == 422
    )
    assert (
        api.post(
            f"/api/v1/teacher/classes/{cid}/staff/{world.teacher_id}/remove",
            json={"reason": "test"},
        ).status_code
        == 422
    )

    api.post(
        f"/api/v1/teacher/classes/{cid}/staff/invite",
        json={"email": ta1_email, "role": "ta"},
    )
    api.patch(
        f"/api/v1/teacher/classes/{cid}/staff/{ta1_id}/permissions",
        json={"manage_groups": True},
    )

    removed = api.post(
        f"/api/v1/teacher/classes/{cid}/staff/{ta1_id}/remove",
        json={"reason": "学期调整"},
    )
    assert removed.status_code == 200
    assert removed.json()["data"]["removed"] is True

    # Removed TA loses access immediately
    api.as_user(ta1_id)
    assert api.get(f"/api/v1/teacher/classes/{cid}/my-permissions").status_code == 403

    # Re-inviting resets permissions back to all False
    api.as_user(world.teacher_id)
    reinvited = api.post(
        f"/api/v1/teacher/classes/{cid}/staff/invite",
        json={"email": ta1_email, "role": "ta"},
    )
    assert reinvited.status_code == 201
    assert reinvited.json()["data"]["permissions"]["manage_groups"] is False
