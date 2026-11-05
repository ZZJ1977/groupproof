"""B-8 (B2-04, B2-06, B2-07): member removal / leaving with task handover."""

from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import GroupMember, ProjectMember, Task, TaskAssignee
from app.modules.a.models import ActionItem, Notification
from tests.b_fixtures import b_api, build_b_world
from tests.test_b_planning_postgres import (
    b_engine,  # noqa: F401  (fixture)
    body,
    created,
    error,
    freeze_baseline,
    seed,
)


@pytest.fixture(params=["open", "closed"])
def setup(request, b_engine):  # noqa: F811
    formation = timedelta(days=14) if request.param == "open" else timedelta(days=-1)
    with Session(b_engine) as session:
        world = build_b_world(session, formation_deadline=formation)
        other = build_b_world(session)
        session.commit()
    with b_api(b_engine) as api:
        modules, _ = seed(api, world)
        freeze_baseline(b_engine, world)
        api.as_user(world.leader_id)
        s = world.student_ids
        login = created(
            api, world, body(modules, title="登录页", weight=50, assignee_ids=[str(s[1])])
        )
        report = created(
            api,
            world,
            body(modules, title="测试报告", weight=30, assignee_ids=[str(s[1]), str(s[2])]),
        )
        done = created(
            api, world, body(modules, title="已完成", weight=20, assignee_ids=[str(s[1])])
        )
        with Session(b_engine) as session:
            session.get(Task, done["id"]).status = "completed"
            session.commit()
        yield request.param, api, world, other, login, report


def g(world, suffix=""):
    return f"/api/v1/groups/{world.group_id}{suffix}"


def active_assignees(engine, task_id):
    with Session(engine) as session:
        return sorted(
            str(u)
            for u in session.scalars(
                select(TaskAssignee.user_id).where(
                    TaskAssignee.task_id == task_id, TaskAssignee.unassigned_at.is_(None)
                )
            )
        )


def in_group(engine, world, user_id):
    with Session(engine) as session:
        group = session.scalar(
            select(GroupMember.left_at).where(
                GroupMember.group_id == world.group_id, GroupMember.user_id == user_id
            )
        )
        project = session.scalar(
            select(ProjectMember.left_at).where(
                ProjectMember.project_id == world.project_id, ProjectMember.user_id == user_id
            )
        )
        return group is None and project is None


def leftover_tasks(engine, world, user_id):
    with Session(engine) as session:
        return session.scalars(
            select(Task.id)
            .join(TaskAssignee, TaskAssignee.task_id == Task.id)
            .where(
                Task.project_id == world.project_id,
                TaskAssignee.user_id == user_id,
                TaskAssignee.unassigned_at.is_(None),
                Task.status != "completed",
            )
        ).all()


def pending_items(engine, request_id):
    with Session(engine) as session:
        return session.scalars(
            select(ActionItem).where(
                ActionItem.source_key.like(f"b:membership-change:{request_id}:%"),
                ActionItem.status == "pending",
            )
        ).all()


def handover(login, report, to):
    return [
        {"task_id": login["id"], "to_user_id": str(to)},
        {"task_id": report["id"], "to_user_id": str(to)},
    ]


# ---------------------------------------------------------------- B2-04 remove


def test_remove_lists_open_tasks_and_requires_a_receiver_for_each(setup, b_engine):  # noqa: F811
    mode, api, world, other, login, report = setup
    s = world.student_ids
    page = api.get(g(world, f"/members/{s[1]}/open-tasks")).json()["data"]
    assert sorted(t["title"] for t in page["tasks"]) == ["测试报告", "登录页"]  # not the done one
    assert {c["id"] for c in page["candidates"]} == {str(s[0]), str(s[2]), str(s[3])}
    assert page["applies_immediately"] is (mode == "open")
    # A plain member cannot look at someone else's tasks or remove anyone.
    looked = api.client.get(
        g(world, f"/members/{s[2]}/open-tasks"), headers={"X-B-Test-User": str(s[1])}
    )
    assert looked.status_code == 403
    path = g(world, "/membership-changes")
    base = {"change_type": "remove", "member_id": str(s[1]), "reason": "长期不参与"}
    assert (
        api.post_as(s[2], path, {**base, "handovers": handover(login, report, s[2])}).status_code
        == 403
    )
    assert error(
        api.post(path, {**base, "reason": " ", "handovers": handover(login, report, s[2])})
    ) == ("REASON_REQUIRED")
    partial = api.post(path, {**base, "handovers": handover(login, report, s[2])[:1]})
    assert error(partial) == "HANDOVER_REQUIRED"
    assert partial.json()["error"]["details"]["codes"] == ["T-002"]
    for bad in (s[1], other.student_ids[1]):
        assert error(api.post(path, {**base, "handovers": handover(login, report, bad)})) == (
            "HANDOVER_INVALID"
        )
    assert (
        error(api.post(path, {**base, "member_id": str(s[0]), "handovers": []})) == "MEMBER_INVALID"
    )
    assert leftover_tasks(b_engine, world, s[1])  # nothing moved by the refusals
    response = api.post(path, {**base, "handovers": handover(login, report, s[2])})
    assert response.status_code == 201, response.text
    row = response.json()["data"]
    if mode == "open":
        assert row["status"] == "applied"
        assert not in_group(b_engine, world, s[1])
        assert leftover_tasks(b_engine, world, s[1]) == []
        assert active_assignees(b_engine, login["id"]) == [str(s[2])]
        assert active_assignees(b_engine, report["id"]) == [str(s[2])]
        assert all(h["applied_at"] for h in row["handovers"])
    else:
        assert row["status"] == "pending"
        assert in_group(b_engine, world, s[1])
        assert len(pending_items(b_engine, row["id"])) == 1  # one teacher
        again = api.post(path, {**base, "handovers": handover(login, report, s[2])})
        assert error(again) == "MEMBERSHIP_CHANGE_PENDING"


# ---------------------------------------------------------------- B2-06 leave


def test_leave_applies_before_the_deadline_and_waits_after(setup, b_engine):  # noqa: F811
    mode, api, world, other, login, report = setup
    s = world.student_ids
    path = g(world, "/membership-changes")
    leader_leaves = api.post(path, {"change_type": "leave", "reason": "转专业", "handovers": []})
    assert error(leader_leaves) == "LEADER_MUST_TRANSFER"
    response = api.post_as(
        s[1],
        path,
        {"change_type": "leave", "reason": "转专业", "handovers": handover(login, report, s[3])},
    )
    assert response.status_code == 201, response.text
    row = response.json()["data"]
    if mode == "open":
        assert row["status"] == "applied"
        assert not in_group(b_engine, world, s[1])
        assert active_assignees(b_engine, report["id"]) == sorted([str(s[2]), str(s[3])])
        with Session(b_engine) as session:
            told = session.scalars(
                select(Notification.recipient_id).where(
                    Notification.dedupe_key.like(f"b:membership-%:{row['id']}")
                )
            ).all()
        assert set(told) >= {s[1], s[3]}
    else:
        assert row["status"] == "pending"
        assert in_group(b_engine, world, s[1])  # only a teacher item, the person stays
        assert active_assignees(b_engine, login["id"]) == [str(s[1])]
        assert len(pending_items(b_engine, row["id"])) == 1


# ---------------------------------------------------------------- B2-07 teacher


@pytest.fixture
def pending(b_engine):  # noqa: F811
    with Session(b_engine) as session:
        world = build_b_world(session, formation_deadline=timedelta(days=-1))
        session.commit()
    with b_api(b_engine) as api:
        modules, _ = seed(api, world)
        freeze_baseline(b_engine, world)
        api.as_user(world.leader_id)
        s = world.student_ids
        login = created(
            api, world, body(modules, title="登录页", weight=60, assignee_ids=[str(s[1])])
        )
        report = created(
            api, world, body(modules, title="报告", weight=40, assignee_ids=[str(s[1])])
        )
        row = api.post(
            g(world, "/membership-changes"),
            {
                "change_type": "remove",
                "member_id": str(s[1]),
                "reason": "长期不参与",
                "handovers": handover(login, report, s[2]),
            },
        ).json()["data"]
        yield api, world, login, report, row


def decide(api, world, row, decision, comment=None, version=None):
    payload = {
        "decision": decision,
        "expected_version": row["lock_version"] if version is None else version,
    }
    if comment is not None:
        payload["comment"] = comment
    return api.post_as(world.teacher_id, f"/api/v1/membership-changes/{row['id']}/decide", payload)


def test_teacher_approval_moves_everything_in_one_go(pending, b_engine):  # noqa: F811
    api, world, login, report, row = pending
    s = world.student_ids
    listed = api.client.get(
        f"/api/v1/courses/{world.course_id}/membership-changes",
        params={"status": "pending"},
        headers={"X-B-Test-User": str(world.teacher_id)},
    ).json()["data"]
    assert [r["id"] for r in listed] == [row["id"]]
    assert (
        api.post_as(
            s[0],
            f"/api/v1/membership-changes/{row['id']}/decide",
            {"decision": "approve", "expected_version": 0},
        ).status_code
        == 403
    )
    approved = decide(api, world, row, "approve")
    assert approved.status_code == 200, approved.text
    assert approved.json()["data"]["status"] == "applied"
    assert not in_group(b_engine, world, s[1])
    assert leftover_tasks(b_engine, world, s[1]) == []  # no task_assignees left behind
    assert active_assignees(b_engine, login["id"]) == [str(s[2])]
    assert pending_items(b_engine, row["id"]) == []
    assert error(decide(api, world, row, "approve", version=1)) == "MEMBERSHIP_CHANGE_CLOSED"


def test_a_failure_during_approval_leaves_people_and_tasks_alone(pending, b_engine):  # noqa: F811
    api, world, login, report, row = pending
    s = world.student_ids
    with Session(b_engine) as session:  # the receiver leaves meanwhile
        from app.modules.b.common import now

        member = session.scalar(
            select(GroupMember).where(
                GroupMember.group_id == world.group_id, GroupMember.user_id == s[2]
            )
        )
        member.left_at = now()
        session.commit()
    failed = decide(api, world, row, "approve")
    assert (failed.status_code, error(failed)) == (409, "HANDOVER_TARGET_LEFT")
    assert in_group(b_engine, world, s[1])
    assert active_assignees(b_engine, login["id"]) == [str(s[1])]
    assert active_assignees(b_engine, report["id"]) == [str(s[1])]
    assert len(pending_items(b_engine, row["id"])) == 1
    with Session(b_engine) as session:
        from app.modules.b.models import BMembershipChangeRequest, BTaskHandover

        assert session.get(BMembershipChangeRequest, row["id"]).status == "pending"
        assert all(h.applied_at is None for h in session.scalars(select(BTaskHandover)))


def test_reject_and_needs_info_notify_and_allow_editing(pending, b_engine):  # noqa: F811
    api, world, login, report, row = pending
    s = world.student_ids
    assert error(decide(api, world, row, "needs_info")) == "REASON_REQUIRED"
    asked = decide(api, world, row, "needs_info", "请说明沟通过程")
    assert asked.status_code == 200, asked.text
    asked = asked.json()["data"]
    assert asked["status"] == "needs_info" and asked["teacher_comment"] == "请说明沟通过程"
    assert pending_items(b_engine, row["id"]) == []
    with Session(b_engine) as session:
        assert session.scalar(
            select(Notification).where(
                Notification.recipient_id == s[0],
                Notification.dedupe_key == f"b:membership-decision:{row['id']}:v1",
            )
        )
    groups = api.get(g(world, "/membership-changes")).json()["data"]
    assert groups[0]["can_edit"] is True
    edit = f"/api/v1/membership-changes/{row['id']}"
    stranger = api.client.put(
        edit,
        json={"reason": "x", "handovers": [], "expected_version": 1},
        headers={"X-B-Test-User": str(s[2]), "Idempotency-Key": "k-1"},
    )
    assert stranger.status_code == 404
    edited = api.put(
        edit,
        {
            "reason": "多次联系未回复",
            "handovers": handover(login, report, s[3]),
            "expected_version": 1,
        },
    )
    assert edited.status_code == 200, edited.text
    edited = edited.json()["data"]
    assert edited["status"] == "pending" and edited["reason"] == "多次联系未回复"
    assert {h["to_user"]["id"] for h in edited["handovers"]} == {str(s[3])}
    assert len(pending_items(b_engine, row["id"])) == 1  # a fresh teacher item
    assert error(decide(api, world, edited, "reject")) == "REASON_REQUIRED"
    rejected = decide(api, world, edited, "reject", "请先和同学沟通")
    assert rejected.json()["data"]["status"] == "rejected"
    assert in_group(b_engine, world, s[1])
    assert active_assignees(b_engine, login["id"]) == [str(s[1])]
    assert pending_items(b_engine, row["id"]) == []
