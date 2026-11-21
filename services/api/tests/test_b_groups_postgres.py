"""B-2 (B2-01/02/03/05): groups, joining, invitations, leader change — HTTP over PostgreSQL."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Barrier
from uuid import uuid4

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import Course, GroupMember, ProjectGroup, ProjectMember
from app.modules.a.models import ActionItem, AuditEvent, Notification
from tests.b_fixtures import (
    add_course_student,
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
        loose = [add_course_student(session, world) for _ in range(4)]
        session.commit()
    with b_api(b_engine) as api:
        yield api, world, other, loose


def error(response):
    return response.json()["error"]["code"]


def group_members(engine, group_id):
    with Session(engine) as session:
        return set(
            session.scalars(
                select(GroupMember.user_id).where(
                    GroupMember.group_id == group_id, GroupMember.left_at.is_(None)
                )
            )
        )


def set_course(engine, course_id, **values):
    with Session(engine) as session:
        course = session.get(Course, course_id)
        for key, value in values.items():
            setattr(course, key, value)
        session.commit()


def create(api, course_id, name="新小组"):
    return api.post(f"/api/v1/courses/{course_id}/groups", {"name": name, "direction": "方向"})


# ---------------------------------------------------------------- B2-01


def test_create_group_makes_creator_leader(setup, b_engine):
    api, world, other, loose = setup
    response = create(api.as_user(loose[0]), world.course_id)
    assert response.status_code == 201, response.text
    data = response.json()["data"]
    assert data["leader"]["id"] == str(loose[0])
    assert data["members"] == [
        {
            "id": str(loose[0]),
            "name": data["members"][0]["name"],
            "role": "leader",
            "joined_at": data["members"][0]["joined_at"],
        }
    ]
    with Session(b_engine) as session:
        group = session.get(ProjectGroup, data["id"])
        assert group.leader_id == loose[0]
        role = session.scalar(select(GroupMember.role).where(GroupMember.group_id == group.id))
        assert role == "leader"
        assert (
            session.scalar(
                select(func.count())
                .select_from(AuditEvent)
                .where(AuditEvent.action == "group.created")
            )
            == 1
        )


def test_create_group_refusals(setup, b_engine):
    api, world, other, loose = setup
    duplicate = create(api.as_user(loose[0]), world.course_id, name=f"B Team {str(world.group_id)}")
    assert duplicate.status_code == 201  # different name than fixture group
    taken = create(api.as_user(loose[1]), world.course_id, name=duplicate.json()["data"]["name"])
    assert taken.status_code == 409 and error(taken) == "GROUP_NAME_TAKEN"
    assert error(create(api.as_user(world.leader_id), world.course_id)) == "ALREADY_IN_GROUP"
    outsider = create(api.as_user(other.leader_id), world.course_id)
    assert outsider.status_code == 404
    teacher = create(api.as_user(world.teacher_id), world.course_id)
    assert teacher.status_code == 403
    set_course(b_engine, world.course_id, formation_deadline=datetime.now(UTC) - timedelta(days=1))
    assert error(create(api.as_user(loose[2]), world.course_id, name="迟到")) == "FORMATION_CLOSED"


# ---------------------------------------------------------------- B2-02


def test_join_three_refusals(setup, b_engine):
    api, world, other, loose = setup
    set_course(b_engine, world.course_id, max_group_size=5)
    group_id = create(api.as_user(loose[0]), world.course_id).json()["data"]["id"]
    # already in another group
    in_group = api.as_user(world.leader_id).post(f"/api/v1/groups/{group_id}/join")
    assert in_group.status_code == 409 and error(in_group) == "ALREADY_IN_GROUP"
    # full: fixture group already has 4 of max 4
    set_course(b_engine, world.course_id, max_group_size=4)
    full = api.as_user(loose[1]).post(f"/api/v1/groups/{world.group_id}/join")
    assert full.status_code == 409 and error(full) == "GROUP_FULL"
    assert full.json()["error"]["details"]["max_group_size"] == 4
    # deadline passed
    set_course(b_engine, world.course_id, formation_deadline=datetime.now(UTC) - timedelta(hours=1))
    late = api.as_user(loose[1]).post(f"/api/v1/groups/{group_id}/join")
    assert late.status_code == 409 and error(late) == "FORMATION_CLOSED"
    # roster frozen counts as closed too
    set_course(b_engine, world.course_id, formation_deadline=datetime.now(UTC) + timedelta(days=1))
    with Session(b_engine) as session:
        session.get(ProjectGroup, group_id).roster_frozen = True
        session.commit()
    frozen = api.as_user(loose[1]).post(f"/api/v1/groups/{group_id}/join")
    assert error(frozen) == "FORMATION_CLOSED"
    assert group_members(b_engine, group_id) == {loose[0]}


def test_join_adds_member_and_project_member(setup, b_engine):
    api, world, other, loose = setup
    set_course(b_engine, world.course_id, max_group_size=5)
    response = api.as_user(loose[0]).post(f"/api/v1/groups/{world.group_id}/join")
    assert response.status_code == 200, response.text
    assert loose[0] in group_members(b_engine, world.group_id)
    with Session(b_engine) as session:
        assert (
            session.scalar(
                select(ProjectMember.role).where(
                    ProjectMember.project_id == world.project_id, ProjectMember.user_id == loose[0]
                )
            )
            == "member"
        )
    listing = api.get(f"/api/v1/courses/{world.course_id}/groups").json()["data"]
    assert listing["my_group_id"] == str(world.group_id)
    assert [g["full"] for g in listing["items"]] == [True]


def test_last_seat_race_admits_one(setup, b_engine):
    """Fixture group has 4 of 5 seats; two different students race for the last one."""
    api, world, other, loose = setup
    set_course(b_engine, world.course_id, max_group_size=5)
    api.as_user(loose[0])
    barrier = Barrier(2)

    def race(user_id):
        barrier.wait()
        return api.post_as(user_id, f"/api/v1/groups/{world.group_id}/join")

    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(race, loose[:2]))
    assert sorted(r.status_code for r in results) == [200, 409]
    assert {error(r) for r in results if r.status_code == 409} == {"GROUP_FULL"}
    assert len(group_members(b_engine, world.group_id)) == 5


def test_one_student_cannot_join_two_groups_concurrently(setup, b_engine):
    api, world, other, loose = setup
    a = create(api.as_user(loose[0]), world.course_id, name="甲组").json()["data"]["id"]
    b = create(api.as_user(loose[1]), world.course_id, name="乙组").json()["data"]["id"]
    api.as_user(loose[2])
    barrier = Barrier(2)

    def race(group_id):
        barrier.wait()
        return api.post(f"/api/v1/groups/{group_id}/join")

    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(race, [a, b]))
    assert sorted(r.status_code for r in results) == [200, 409]
    assert (loose[2] in group_members(b_engine, a)) != (loose[2] in group_members(b_engine, b))


# ---------------------------------------------------------------- B2-03


def test_invite_before_deadline_notifies_and_accept_joins(setup, b_engine):
    api, world, other, loose = setup
    group_id = create(api.as_user(loose[0]), world.course_id).json()["data"]["id"]
    candidates = api.get(f"/api/v1/courses/{world.course_id}/ungrouped-students").json()["data"]
    assert {c["id"] for c in candidates} == {str(u) for u in loose[1:]}
    invited = api.post(f"/api/v1/groups/{group_id}/invitations", {"invitee_id": str(loose[1])})
    assert invited.status_code == 201, invited.text
    invitation = invited.json()["data"]
    assert invitation["status"] == "pending"
    again = api.post(f"/api/v1/groups/{group_id}/invitations", {"invitee_id": str(loose[1])})
    assert error(again) == "INVITATION_PENDING"
    with Session(b_engine) as session:
        assert (
            session.scalar(
                select(func.count())
                .select_from(Notification)
                .where(Notification.recipient_id == loose[1])
            )
            == 1
        )
    assert loose[1] not in group_members(b_engine, group_id)
    api.as_user(loose[1])
    mine = api.get("/api/v1/me/group-invitations").json()["data"]
    assert [i["id"] for i in mine] == [invitation["id"]]
    accepted = api.post(
        f"/api/v1/group-invitations/{invitation['id']}/response",
        {"accept": True, "expected_version": 0},
    )
    assert accepted.status_code == 200, accepted.text
    assert loose[1] in group_members(b_engine, group_id)


def test_invite_refuses_outsiders_and_grouped(setup):
    api, world, other, loose = setup
    group_id = create(api.as_user(loose[0]), world.course_id).json()["data"]["id"]
    outside = api.post(
        f"/api/v1/groups/{group_id}/invitations", {"invitee_id": str(other.leader_id)}
    )
    assert outside.status_code == 422 and error(outside) == "INVITEE_NOT_IN_COURSE"
    grouped = api.post(
        f"/api/v1/groups/{group_id}/invitations", {"invitee_id": str(world.leader_id)}
    )
    assert grouped.status_code == 409 and error(grouped) == "INVITEE_IN_GROUP"
    self_invite = api.post(f"/api/v1/groups/{group_id}/invitations", {"invitee_id": str(loose[0])})
    assert error(self_invite) == "INVITEE_INVALID"
    not_member = api.as_user(loose[1]).post(
        f"/api/v1/groups/{group_id}/invitations", {"invitee_id": str(loose[2])}
    )
    assert not_member.status_code == 403
    other_group = api.as_user(other.leader_id).post(
        f"/api/v1/groups/{group_id}/invitations", {"invitee_id": str(loose[2])}
    )
    assert other_group.status_code == 403


def test_invite_after_deadline_goes_to_teacher(setup, b_engine):
    api, world, other, loose = setup
    group_id = create(api.as_user(loose[0]), world.course_id).json()["data"]["id"]
    set_course(b_engine, world.course_id, formation_deadline=datetime.now(UTC) - timedelta(hours=1))
    invited = api.post(f"/api/v1/groups/{group_id}/invitations", {"invitee_id": str(loose[1])})
    assert invited.status_code == 201
    invitation = invited.json()["data"]
    assert invitation["status"] == "awaiting_teacher"
    assert loose[1] not in group_members(b_engine, group_id)
    with Session(b_engine) as session:
        item = session.scalar(select(ActionItem).where(ActionItem.recipient_id == world.teacher_id))
        assert item is not None and item.status == "pending"
        assert (
            session.scalar(
                select(func.count())
                .select_from(Notification)
                .where(Notification.recipient_id == loose[1])
            )
            == 0
        )
    # invitee cannot accept by themselves
    self_accept = api.as_user(loose[1]).post(
        f"/api/v1/group-invitations/{invitation['id']}/response",
        {"accept": True, "expected_version": 0},
    )
    assert error(self_accept) == "INVITATION_CLOSED"
    # other course teacher refused; own teacher approves
    assert (
        api.as_user(other.teacher_id)
        .post(
            f"/api/v1/group-invitations/{invitation['id']}/decision",
            {"decision": "approve", "expected_version": 0},
        )
        .status_code
        == 403
    )
    api.as_user(world.teacher_id)
    listed = api.get(f"/api/v1/courses/{world.course_id}/group-invitations").json()["data"]
    assert [i["id"] for i in listed] == [invitation["id"]]
    approved = api.post(
        f"/api/v1/group-invitations/{invitation['id']}/decision",
        {"decision": "approve", "expected_version": 0},
    )
    assert approved.status_code == 200, approved.text
    assert loose[1] in group_members(b_engine, group_id)
    with Session(b_engine) as session:
        assert session.scalar(select(ActionItem.status)) == "completed"


# ---------------------------------------------------------------- B2-05


def start(api, world, candidate, reason="组长时间冲突"):
    return api.post(
        f"/api/v1/groups/{world.group_id}/leader-changes",
        {"candidate_id": str(candidate), "reason": reason},
    )


def test_leader_change_validation(setup):
    api, world, other, loose = setup
    api.as_user(world.leader_id)
    assert error(start(api, world, world.member_ids[0], reason="  ")) == "REASON_REQUIRED"
    not_member = start(api, world, loose[0])
    assert not_member.status_code == 422 and error(not_member) == "CANDIDATE_NOT_MEMBER"
    assert error(start(api, world, world.leader_id)) == "CANDIDATE_IS_LEADER"
    outsider = api.as_user(other.leader_id)
    assert start(outsider, world, world.member_ids[0]).status_code == 403
    api.as_user(world.leader_id)
    assert start(api, world, world.member_ids[0]).status_code == 201
    assert error(start(api, world, world.member_ids[1])) == "LEADER_CHANGE_PENDING"


def test_leader_switches_only_after_last_confirmation(setup, b_engine):
    api, world, other, loose = setup
    candidate = world.member_ids[0]
    request_id = start(api.as_user(world.leader_id), world, candidate).json()["data"]["id"]
    with Session(b_engine) as session:
        assert (
            session.scalar(
                select(func.count()).select_from(ActionItem).where(ActionItem.status == "pending")
            )
            == 3
        )
    confirm_url = f"/api/v1/leader-changes/{request_id}/confirmations"
    # requester is not a confirmer; outsiders are refused
    assert error(api.post(confirm_url, {"decision": "confirm"})) == "NOT_A_CONFIRMER"
    assert (
        api.as_user(other.leader_id).post(confirm_url, {"decision": "confirm"}).status_code == 403
    )
    for index, member in enumerate(world.member_ids):
        response = api.as_user(member).post(confirm_url, {"decision": "confirm"})
        assert response.status_code == 200, response.text
        with Session(b_engine) as session:
            leader = session.get(ProjectGroup, world.group_id).leader_id
        if index < len(world.member_ids) - 1:
            assert leader == world.leader_id
            twice = api.post(confirm_url, {"decision": "confirm"})
            assert twice.status_code == 409 and error(twice) == "ALREADY_CONFIRMED"
        else:
            assert leader == candidate
    assert response.json()["data"]["status"] == "approved"
    with Session(b_engine) as session:
        roles = dict(
            session.execute(
                select(GroupMember.user_id, GroupMember.role).where(
                    GroupMember.group_id == world.group_id
                )
            ).all()
        )
        assert roles[candidate] == "leader" and roles[world.leader_id] == "member"
        project_roles = dict(
            session.execute(
                select(ProjectMember.user_id, ProjectMember.role).where(
                    ProjectMember.project_id == world.project_id
                )
            ).all()
        )
        assert project_roles[candidate] == "leader"
        notes = session.scalars(
            select(Notification.recipient_id).where(Notification.title.contains("组长已更换"))
        ).all()
        assert sorted(notes) == sorted(world.student_ids)
        assert (
            session.scalar(
                select(func.count()).select_from(ActionItem).where(ActionItem.status == "pending")
            )
            == 0
        )


def test_any_rejection_fails_the_change(setup, b_engine):
    api, world, other, loose = setup
    request_id = start(api.as_user(world.leader_id), world, world.member_ids[0]).json()["data"][
        "id"
    ]
    url = f"/api/v1/leader-changes/{request_id}/confirmations"
    assert api.as_user(world.member_ids[0]).post(url, {"decision": "confirm"}).status_code == 200
    rejected = api.as_user(world.member_ids[1]).post(url, {"decision": "reject"})
    assert rejected.json()["data"]["status"] == "rejected"
    late = api.as_user(world.member_ids[2]).post(url, {"decision": "confirm"})
    assert error(late) == "LEADER_CHANGE_CLOSED"
    with Session(b_engine) as session:
        assert session.get(ProjectGroup, world.group_id).leader_id == world.leader_id
    # a new request may start once the old one ended
    assert start(api.as_user(world.leader_id), world, world.member_ids[1]).status_code == 201


def test_group_detail_hides_internal_state_from_non_members(setup):
    api, world, other, loose = setup
    detail = api.as_user(loose[0]).get(f"/api/v1/groups/{world.group_id}").json()["data"]
    assert detail["invitations"] == [] and detail["leader_change"] is None
    assert api.as_user(other.leader_id).get(f"/api/v1/groups/{world.group_id}").status_code == 404
    assert api.get(f"/api/v1/groups/{uuid4()}").status_code == 404


def test_unauthenticated(setup):
    api, world, *_ = setup
    api.as_user(None)
    assert api.get(f"/api/v1/courses/{world.course_id}/groups").status_code == 401
