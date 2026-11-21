"""B-1 (B1-01 ~ B1-03): my courses, invite preview, joining — HTTP over real PostgreSQL.

Opt-in with B_TEST_DATABASE_URL. Each test runs in its own schema.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import Course, CourseMember
from app.modules.a.models import ActionItem, AuditEvent, Notification
from app.modules.b.models import BCourseJoinPolicy, BCourseJoinRequest
from tests.b_fixtures import (
    add_invite,
    add_student,
    b_api,
    b_postgres_schema,
    b_test_database_url,
    build_b_world,
)


@pytest.fixture
def b_engine(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    with b_postgres_schema(b_test_database_url()) as engine:
        yield engine


@pytest.fixture
def setup(b_engine):
    with Session(b_engine) as session:
        world = build_b_world(session)
        other = build_b_world(session)
        code = add_invite(session, world)
        newcomer = add_student(session).id
        unverified = add_student(session, verified=False).id
        session.commit()
    with b_api(b_engine) as api:
        yield api, world, other, code, newcomer, unverified


def members(engine, course_id, user_id):
    with Session(engine) as session:
        return session.scalar(
            select(func.count())
            .select_from(CourseMember)
            .where(
                CourseMember.course_id == course_id,
                CourseMember.user_id == user_id,
                CourseMember.left_at.is_(None),
            )
        )


def set_mode(engine, course_id, mode):
    with Session(engine) as session:
        session.merge(BCourseJoinPolicy(course_id=course_id, mode=mode, lock_version=1))
        session.commit()


def error(response):
    return response.json()["error"]["code"]


# ---------------------------------------------------------------- B1-01


def test_my_courses_lists_only_own_courses(setup):
    api, world, other, *_ = setup
    body = api.as_user(world.leader_id).get("/api/v1/me/courses").json()["data"]
    assert [item["id"] for item in body["items"]] == [str(world.course_id)]
    item = body["items"][0]
    assert item["group"]["id"] == str(world.group_id)
    assert item["project"]["id"] == str(world.project_id)
    assert item["teacher"]["id"] == str(world.teacher_id)
    assert body["counts"] == {"all": 1, "active": 1, "ended": 0}


def test_other_course_is_404_even_with_its_id(setup):
    api, world, other, *_ = setup
    api.as_user(world.leader_id)
    assert api.get(f"/api/v1/me/courses/{world.course_id}").status_code == 200
    for course_id in (other.course_id, uuid4()):
        response = api.get(f"/api/v1/me/courses/{course_id}")
        assert response.status_code == 404 and error(response) == "COURSE_NOT_FOUND"


def test_my_courses_tab_search_and_paging(setup, b_engine):
    api, world, other, code, newcomer, _ = setup
    with Session(b_engine) as session:
        session.add(CourseMember(course_id=other.course_id, user_id=world.leader_id))
        session.get(Course, other.course_id).status = "ended"
        session.commit()
    api.as_user(world.leader_id)
    body = api.get("/api/v1/me/courses").json()["data"]
    assert body["total"] == 2 and body["counts"] == {"all": 2, "active": 1, "ended": 1}
    ended = api.get("/api/v1/me/courses", tab="ended").json()["data"]
    assert [i["id"] for i in ended["items"]] == [str(other.course_id)]
    found = api.get("/api/v1/me/courses", q="B-").json()["data"]
    assert found["total"] == 2
    page = api.get("/api/v1/me/courses", page_size=1, page=2).json()["data"]
    assert page["total"] == 2 and len(page["items"]) == 1
    assert api.get("/api/v1/me/courses", tab="bogus").status_code == 422


def test_left_course_disappears(setup, b_engine):
    api, world, *_ = setup
    with Session(b_engine) as session:
        row = session.scalar(
            select(CourseMember).where(
                CourseMember.course_id == world.course_id,
                CourseMember.user_id == world.member_ids[0],
            )
        )
        row.left_at = func.now()
        session.commit()
    api.as_user(world.member_ids[0])
    assert api.get("/api/v1/me/courses").json()["data"]["total"] == 0
    assert api.get(f"/api/v1/me/courses/{world.course_id}").status_code == 404


def test_unauthenticated_is_401(setup):
    api, *_ = setup
    api.as_user(None)
    assert api.get("/api/v1/me/courses").status_code == 401
    assert api.post("/api/v1/course-joins/preview", {"invite_code": "x" * 30}).status_code == 401


# ---------------------------------------------------------------- B1-02


def test_preview_returns_course_rules(setup):
    api, world, other, code, newcomer, _ = setup
    response = api.as_user(newcomer).post("/api/v1/course-joins/preview", {"invite_code": code})
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["course_id"] == str(world.course_id)
    assert data["join_mode"] == "direct" and data["already_member"] is False
    assert data["max_group_size"] == 5 and data["formation_deadline"]
    assert data["teacher"]["id"] == str(world.teacher_id)


def test_preview_distinguishes_three_failures(setup, b_engine):
    api, world, other, code, newcomer, unverified = setup
    wrong = api.as_user(newcomer).post("/api/v1/course-joins/preview", {"invite_code": "nope"})
    assert wrong.status_code == 404 and error(wrong) == "COURSE_INVITE_NOT_FOUND"
    revoked_like = api.post("/api/v1/course-joins/preview", {"invite_code": "B-INVITE-" + "0" * 32})
    assert error(revoked_like) == "COURSE_INVITE_NOT_FOUND"

    unverified_response = api.as_user(unverified).post(
        "/api/v1/course-joins/preview", {"invite_code": code}
    )
    assert unverified_response.status_code == 403
    assert error(unverified_response) == "EMAIL_NOT_VERIFIED"
    join = api.post("/api/v1/course-joins", {"invite_code": code})
    assert error(join) == "EMAIL_NOT_VERIFIED"
    assert members(b_engine, world.course_id, unverified) == 0

    with Session(b_engine) as session:
        session.get(Course, world.course_id).status = "ended"
        session.commit()
    closed = api.as_user(newcomer).post("/api/v1/course-joins/preview", {"invite_code": code})
    assert closed.status_code == 409 and error(closed) == "COURSE_CLOSED"
    assert error(api.post("/api/v1/course-joins", {"invite_code": code})) == "COURSE_CLOSED"


def test_teacher_cannot_join_with_code(setup):
    api, world, other, code, *_ = setup
    response = api.as_user(other.teacher_id).post(
        "/api/v1/course-joins/preview", {"invite_code": code}
    )
    assert response.status_code == 403 and error(response) == "STUDENT_ONLY"


# ---------------------------------------------------------------- B1-03 direct


def test_direct_join_is_idempotent_and_rejects_second_join(setup, b_engine):
    api, world, other, code, newcomer, _ = setup
    api.as_user(newcomer)
    first = api.post("/api/v1/course-joins", {"invite_code": code}, key="same-click")
    again = api.post("/api/v1/course-joins", {"invite_code": code}, key="same-click")
    assert first.status_code == again.status_code == 201
    assert (
        first.json()["data"]
        == again.json()["data"]
        == {
            "status": "joined",
            "course_id": str(world.course_id),
            "request_id": None,
        }
    )
    assert members(b_engine, world.course_id, newcomer) == 1
    second = api.post("/api/v1/course-joins", {"invite_code": code}, key="another-click")
    assert second.status_code == 409 and error(second) == "ALREADY_MEMBER"
    conflict = api.post("/api/v1/course-joins", {"invite_code": "other-code"}, key="same-click")
    assert conflict.status_code == 409 and error(conflict) == "IDEMPOTENCY_CONFLICT"
    preview = api.post("/api/v1/course-joins/preview", {"invite_code": code}).json()["data"]
    assert preview["already_member"] is True
    listed = api.get("/api/v1/me/courses").json()["data"]["items"]
    assert [i["id"] for i in listed] == [str(world.course_id)]
    with Session(b_engine) as session:
        assert (
            session.scalar(
                select(func.count())
                .select_from(AuditEvent)
                .where(AuditEvent.action == "course.member.joined")
            )
            == 1
        )


def test_concurrent_joins_create_one_membership(setup, b_engine):
    api, world, other, code, newcomer, _ = setup
    api.as_user(newcomer)
    barrier = Barrier(2)

    def attempt(index):
        barrier.wait()
        return api.post("/api/v1/course-joins", {"invite_code": code}, key=f"race-{index}")

    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(attempt, range(2)))
    assert sorted(r.status_code for r in results) == [201, 409]
    assert members(b_engine, world.course_id, newcomer) == 1


# ---------------------------------------------------------------- B1-03 approval


def test_approval_join_waits_for_teacher_then_approves(setup, b_engine):
    api, world, other, code, newcomer, _ = setup
    set_mode(b_engine, world.course_id, "approval")
    api.as_user(newcomer)
    assert (
        api.post("/api/v1/course-joins/preview", {"invite_code": code}).json()["data"]["join_mode"]
        == "approval"
    )
    created = api.post("/api/v1/course-joins", {"invite_code": code})
    assert created.status_code == 201, created.text
    data = created.json()["data"]
    assert data["status"] == "pending" and data["request_id"]
    assert members(b_engine, world.course_id, newcomer) == 0
    again = api.post("/api/v1/course-joins", {"invite_code": code})
    assert error(again) == "JOIN_REQUEST_PENDING"
    mine = api.get("/api/v1/me/courses").json()["data"]
    assert mine["total"] == 0 and mine["pending_joins"][0]["request_id"] == data["request_id"]

    with Session(b_engine) as session:
        item = session.scalar(select(ActionItem).where(ActionItem.recipient_id == world.teacher_id))
        assert item.status == "pending" and item.category == "member"
        assert item.target_json["kind"] == "member_change"

    # Students cannot see or decide requests.
    request_id = data["request_id"]
    assert api.get(f"/api/v1/courses/{world.course_id}/join-requests").status_code == 403
    student_decide = api.post(
        f"/api/v1/course-joins/{request_id}/decision",
        {"decision": "approve", "expected_version": 0},
    )
    assert student_decide.status_code == 403

    api.as_user(world.teacher_id)
    listed = api.get(f"/api/v1/courses/{world.course_id}/join-requests").json()["data"]
    assert [r["id"] for r in listed["items"]] == [request_id]
    stale = api.post(
        f"/api/v1/course-joins/{request_id}/decision",
        {"decision": "approve", "expected_version": 5},
    )
    assert stale.status_code == 409 and error(stale) == "VERSION_CONFLICT"
    approved = api.post(
        f"/api/v1/course-joins/{request_id}/decision",
        {"decision": "approve", "expected_version": 0},
    )
    assert approved.status_code == 200, approved.text
    assert approved.json()["data"]["status"] == "approved"
    assert members(b_engine, world.course_id, newcomer) == 1
    twice = api.post(
        f"/api/v1/course-joins/{request_id}/decision",
        {"decision": "reject", "reason": "x", "expected_version": 1},
    )
    assert error(twice) == "JOIN_REQUEST_DECIDED"
    with Session(b_engine) as session:
        assert session.scalar(select(ActionItem.status)) == "completed"
        note = session.scalar(select(Notification).where(Notification.recipient_id == newcomer))
        assert note is not None and "已加入" in note.title


def test_reject_requires_reason_and_notifies(setup, b_engine):
    api, world, other, code, newcomer, _ = setup
    set_mode(b_engine, world.course_id, "approval")
    request_id = (
        api.as_user(newcomer)
        .post("/api/v1/course-joins", {"invite_code": code})
        .json()["data"]["request_id"]
    )
    api.as_user(world.teacher_id)
    no_reason = api.post(
        f"/api/v1/course-joins/{request_id}/decision",
        {"decision": "reject", "expected_version": 0},
    )
    assert no_reason.status_code == 422 and error(no_reason) == "REASON_REQUIRED"
    rejected = api.post(
        f"/api/v1/course-joins/{request_id}/decision",
        {"decision": "reject", "reason": "不是本班学生", "expected_version": 0},
    )
    assert rejected.status_code == 200
    assert members(b_engine, world.course_id, newcomer) == 0
    with Session(b_engine) as session:
        assert session.scalar(select(ActionItem.status)) == "rejected"
        note = session.scalar(select(Notification).where(Notification.recipient_id == newcomer))
        assert "不是本班学生" in note.description
    # A rejected student may apply again.
    retry = api.as_user(newcomer).post("/api/v1/course-joins", {"invite_code": code})
    assert retry.status_code == 201 and retry.json()["data"]["status"] == "pending"


# ---------------------------------------------------------------- cross-scope refusals


def test_other_course_teacher_and_students_are_refused(setup, b_engine):
    api, world, other, code, newcomer, _ = setup
    set_mode(b_engine, world.course_id, "approval")
    request_id = (
        api.as_user(newcomer)
        .post("/api/v1/course-joins", {"invite_code": code})
        .json()["data"]["request_id"]
    )
    api.as_user(other.teacher_id)
    assert api.get(f"/api/v1/courses/{world.course_id}/join-requests").status_code == 403
    decide = api.post(
        f"/api/v1/course-joins/{request_id}/decision",
        {"decision": "approve", "expected_version": 0},
    )
    assert decide.status_code == 403
    policy = api.put(
        f"/api/v1/courses/{world.course_id}/join-policy", {"mode": "direct", "expected_version": 1}
    )
    assert policy.status_code == 403
    api.as_user(world.leader_id)
    assert (
        api.put(
            f"/api/v1/courses/{world.course_id}/join-policy",
            {"mode": "direct", "expected_version": 1},
        ).status_code
        == 403
    )
    assert members(b_engine, world.course_id, newcomer) == 0


def test_join_policy_versioning_and_closed_course(setup, b_engine):
    api, world, *_ = setup
    api.as_user(world.teacher_id)
    url = f"/api/v1/courses/{world.course_id}/join-policy"
    assert api.get(url).json()["data"] == {
        "course_id": str(world.course_id),
        "mode": "direct",
        "lock_version": 0,
    }
    changed = api.put(url, {"mode": "approval", "expected_version": 0})
    assert changed.status_code == 200 and changed.json()["data"]["lock_version"] == 1
    stale = api.put(url, {"mode": "direct", "expected_version": 0})
    assert error(stale) == "VERSION_CONFLICT"
    with Session(b_engine) as session:
        session.get(Course, world.course_id).status = "ended"
        session.commit()
    closed = api.put(url, {"mode": "direct", "expected_version": 1})
    assert closed.status_code == 409 and error(closed) == "COURSE_CLOSED"


def test_approval_refused_after_course_ends(setup, b_engine):
    api, world, other, code, newcomer, _ = setup
    set_mode(b_engine, world.course_id, "approval")
    request_id = (
        api.as_user(newcomer)
        .post("/api/v1/course-joins", {"invite_code": code})
        .json()["data"]["request_id"]
    )
    with Session(b_engine) as session:
        session.get(Course, world.course_id).status = "ended"
        session.commit()
    response = api.as_user(world.teacher_id).post(
        f"/api/v1/course-joins/{request_id}/decision",
        {"decision": "approve", "expected_version": 0},
    )
    assert error(response) == "COURSE_CLOSED"
    with Session(b_engine) as session:
        assert session.get(BCourseJoinRequest, request_id).status == "pending"
