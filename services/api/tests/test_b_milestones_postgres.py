"""B-8 (B7-01~B7-04): milestones, deliverables, stage completion, rescheduling."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.db.models import Milestone, Project, Task
from app.modules.a.models import Notification
from app.modules.b.models import BMilestoneDateChange
from app.modules.b.ports import TaskVerificationStatus, get_verification_port
from app.modules.c.files_models import LogicalFile
from tests.b_fixtures import b_api, build_b_world
from tests.test_b_planning_postgres import (
    add_milestone,
    b_engine,  # noqa: F401  (fixture)
    body,
    created,
    error,
    freeze_baseline,
    p,
    seed,
)


class FakeVerification:
    def __init__(self):
        self.passed: set = set()
        self.down = False

    def invalidate_criterion_results(self, session, **kwargs):  # pragma: no cover
        raise AssertionError("not used here")

    def task_verification_status(self, session, *, task_ids):
        if self.down:
            from app.modules.b.ports import verification_unavailable

            raise verification_unavailable()
        return {
            t: TaskVerificationStatus(
                task_id=t, state="passed" if t in self.passed else "in_review"
            )
            for t in task_ids
        }


@pytest.fixture
def world_api(b_engine):  # noqa: F811
    with Session(b_engine) as session:
        world = build_b_world(session)
        other = build_b_world(session)
        session.commit()
    with b_api(b_engine) as api:
        modules, _ = seed(api, world)
        freeze_baseline(b_engine, world)
        api.as_user(world.leader_id)
        yield api, world, other, modules


def m(world, milestone, suffix=""):
    return p(world, f"/milestones/{milestone}{suffix}")


def detail(api, world, milestone, user=None):
    headers = {"X-B-Test-User": str(user)} if user else None
    response = api.client.get(m(world, milestone), headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["data"]


def two_tasks(api, world, modules, b_engine):  # noqa: F811
    milestone = add_milestone(b_engine, world)
    a = created(api, world, body(modules, title="登录页", weight=60, milestone_ids=[milestone]))
    b = created(api, world, body(modules, title="注册页", weight=40, milestone_ids=[milestone]))
    return milestone, a, b


def set_task(engine, task_id, **values):
    with Session(engine) as session:
        task = session.get(Task, task_id)
        for k, v in values.items():
            setattr(task, k, v)
        session.commit()


def notes(engine, key):
    with Session(engine) as session:
        return sorted(
            str(n.recipient_id)
            for n in session.scalars(select(Notification).where(Notification.dedupe_key == key))
        )


# ---------------------------------------------------------------- B7-01


def test_progress_follows_linked_tasks_and_risk_stays_null(world_api, b_engine):  # noqa: F811
    api, world, other, modules = world_api
    milestone, a, b = two_tasks(api, world, modules, b_engine)
    page = api.get(p(world, "/milestones")).json()["data"]
    row = page["items"][0]
    assert (row["progress_percent"], row["task_count"], row["risk"]) == (0, 2, None)
    assert page["can_lead"] is True
    set_task(b_engine, a["id"], status="completed", progress_percent=100)
    row = detail(api, world, milestone)
    assert row["progress_percent"] == 60 and row["completed_task_count"] == 1
    assert [t["code"] for t in row["tasks"]] == ["T-001", "T-002"]
    set_task(b_engine, b["id"], progress_percent=50)
    assert detail(api, world, milestone)["progress_percent"] == 80
    # members read, teachers read, outsiders do not.
    assert detail(api, world, milestone, world.student_ids[1])["can_lead"] is False
    assert detail(api, world, milestone, world.teacher_id)["can_lead"] is False
    outsider = api.client.get(m(world, milestone), headers={"X-B-Test-User": str(other.leader_id)})
    assert outsider.status_code == 404
    assert error(api.get(m(world, uuid4()))) == "MILESTONE_NOT_FOUND"


# D's risks table, as created by D's migration 0017_d_risks. IF NOT EXISTS so the
# test keeps working once D's model is part of the shared metadata.
D_RISKS_DDL = """
CREATE TABLE IF NOT EXISTS risks (
    id uuid PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES projects(id),
    task_id uuid REFERENCES tasks(id),
    milestone_id uuid REFERENCES milestones(id),
    owner_id uuid NOT NULL REFERENCES users(id),
    title varchar(240) NOT NULL,
    description text NOT NULL,
    level varchar(16) NOT NULL CHECK (level IN ('low','medium','high')),
    status varchar(16) NOT NULL CHECK (status IN ('open','mitigating','closed')),
    due_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    lock_version integer NOT NULL DEFAULT 0,
    CHECK (task_id IS NOT NULL OR milestone_id IS NOT NULL)
)
"""


def add_risk(
    engine, world, owner, title, level, *, status="open", task=None, milestone=None, due=None
):
    with Session(engine) as session:
        session.execute(
            text(
                "INSERT INTO risks (id, project_id, task_id, milestone_id, owner_id, title,"
                " description, level, status, due_at) VALUES (:id, :p, :t, :m, :o, :title,"
                " '', :level, :status, :due)"
            ),
            {
                "id": uuid4(),
                "p": world.project_id,
                "t": task,
                "m": milestone,
                "o": owner,
                "title": title,
                "level": level,
                "status": status,
                "due": due,
            },
        )
        session.commit()


def test_milestones_show_ds_open_risks_on_the_milestone_and_its_tasks(world_api, b_engine):  # noqa: F811
    api, world, other, modules = world_api
    milestone, a, b = two_tasks(api, world, modules, b_engine)
    quiet = add_milestone(b_engine, world, title="终期答辩")
    with b_engine.begin() as connection:
        connection.execute(text(D_RISKS_DDL))
    rows = {r["id"]: r["risk"] for r in api.get(p(world, "/milestones")).json()["data"]["items"]}
    # D's table exists but has nothing open: "no risk", not "no data".
    assert rows[milestone] == {"level": None, "open_count": 0, "items": []}
    soon = datetime.now(UTC).replace(microsecond=0) + timedelta(days=3)
    member = world.student_ids[1]
    add_risk(b_engine, world, member, "接口文档没定", "medium", task=a["id"], due=soon)
    add_risk(
        b_engine,
        world,
        world.leader_id,
        "演示环境未申请",
        "high",
        milestone=milestone,
        status="mitigating",
    )
    add_risk(b_engine, world, member, "注册页已解决", "high", task=b["id"], status="closed")
    add_risk(b_engine, world, member, "只关联别的里程碑", "low", milestone=quiet)
    page = api.get(p(world, "/milestones")).json()["data"]
    rows = {r["id"]: r["risk"] for r in page["items"]}
    risk = rows[milestone]
    assert (risk["level"], risk["open_count"]) == ("high", 2)
    assert [i["title"] for i in risk["items"]] == ["演示环境未申请", "接口文档没定"]
    on_task = risk["items"][1]
    assert on_task["task"] == {"id": a["id"], "code": "T-001", "title": "登录页"}
    assert on_task["owner"]["id"] == str(member) and on_task["status"] == "open"
    assert datetime.fromisoformat(on_task["due_at"]) == soon
    assert risk["items"][0]["task"] is None and risk["items"][0]["status"] == "mitigating"
    assert (rows[quiet]["level"], rows[quiet]["open_count"]) == ("low", 1)
    assert detail(api, world, quiet)["risk"] == rows[quiet]  # no linked tasks at all
    # The detail page reads the same summary; teachers see it too.
    assert detail(api, world, milestone)["risk"] == risk
    assert detail(api, world, milestone, world.teacher_id)["risk"] == risk


# ---------------------------------------------------------------- B7-02


def test_only_the_leader_checks_deliverables_and_history_is_kept(world_api, b_engine):  # noqa: F811
    api, world, other, modules = world_api
    milestone = add_milestone(b_engine, world)
    with Session(b_engine) as session:
        file = LogicalFile(
            project_id=world.project_id,
            name="中期报告.pdf",
            name_key="中期报告.pdf",
            category="documents",
            latest_version_no=1,
            created_by=world.leader_id,
        )
        foreign = LogicalFile(
            project_id=other.project_id,
            name="别组.pdf",
            name_key="别组.pdf",
            category="documents",
            latest_version_no=1,
            created_by=other.leader_id,
        )
        session.add_all([file, foreign])
        session.commit()
        file_id, foreign_id = str(file.id), str(foreign.id)
    member = world.student_ids[1]
    denied = api.post_as(member, m(world, milestone, "/deliverables"), {"title": "中期报告"})
    assert denied.status_code == 403
    added = api.post(m(world, milestone, "/deliverables"), {"title": "中期报告"})
    assert added.status_code == 201, added.text
    item = added.json()["data"]["deliverables"][0]
    check = m(world, milestone, f"/deliverables/{item['id']}/check")
    assert api.post_as(member, check, {"done": True, "expected_version": 0}).status_code == 403
    assert error(api.post(check, {"done": True, "file_id": foreign_id, "expected_version": 0})) == (
        "FILE_NOT_FOUND"
    )
    done = api.post(check, {"done": True, "file_id": file_id, "expected_version": 0})
    assert done.status_code == 200, done.text
    assert error(api.post(check, {"done": False, "expected_version": 0})) == "VERSION_CONFLICT"
    assert api.post(check, {"done": False, "expected_version": 1}).status_code == 200
    assert (
        api.post(check, {"done": True, "file_id": file_id, "expected_version": 2}).status_code
        == 200
    )
    item = detail(api, world, milestone)["deliverables"][0]  # survives a fresh read
    assert item["done"] is True and item["done_by"]["id"] == str(world.leader_id)
    assert item["file"]["href"] == f"/projects/{world.project_id}/files?file={file_id}"
    assert [h["action"] for h in item["history"]] == ["checked", "unchecked", "checked"]
    assert item["history"][1]["file"] is None


# ---------------------------------------------------------------- B7-03


def test_completion_lists_what_is_missing_and_never_skips_d(world_api, b_engine):  # noqa: F811
    api, world, other, modules = world_api
    milestone, a, b = two_tasks(api, world, modules, b_engine)
    port = FakeVerification()
    api._app.dependency_overrides[get_verification_port] = lambda: port
    item = api.post(m(world, milestone, "/deliverables"), {"title": "演示视频"}).json()["data"][
        "deliverables"
    ][0]
    complete = m(world, milestone, "/complete")
    assert api.post_as(world.student_ids[1], complete, {"expected_version": 0}).status_code == 403
    port.down = True
    down = api.post(complete, {"expected_version": 0})
    assert (down.status_code, error(down)) == (503, "VERIFICATION_UNAVAILABLE")
    port.down = False
    port.passed = {UUID(a["id"])}
    refused = api.post(complete, {"expected_version": 0})
    assert error(refused) == "MILESTONE_NOT_READY"
    missing = refused.json()["error"]["details"]
    assert [t["code"] for t in missing["tasks"]] == ["T-002"]
    assert missing["tasks"][0]["state"] == "in_review"
    assert [d["title"] for d in missing["deliverables"]] == ["演示视频"]
    port.passed = {UUID(a["id"]), UUID(b["id"])}
    check = m(world, milestone, f"/deliverables/{item['id']}/check")
    assert api.post(check, {"done": True, "expected_version": 0}).status_code == 200
    done = api.post(complete, {"expected_version": 0})
    assert done.status_code == 200, done.text
    assert (done.json()["data"]["status"], done.json()["data"]["progress_percent"]) == (
        "completed",
        100,
    )
    assert notes(b_engine, f"b:milestone-completed:{milestone}") == [str(world.teacher_id)]
    assert error(api.post(complete, {"expected_version": 1})) == "MILESTONE_COMPLETED"
    assert error(api.post(m(world, milestone, "/deliverables"), {"title": "x"})) == (
        "MILESTONE_COMPLETED"
    )


def test_completion_without_linked_tasks_skips_d(world_api, b_engine):  # noqa: F811
    api, world, other, modules = world_api
    milestone = add_milestone(b_engine, world)
    # The default port is unavailable; with no linked tasks it is never asked.
    done = api.post(m(world, milestone, "/complete"), {"expected_version": 0})
    assert done.status_code == 200, done.text


# ---------------------------------------------------------------- B7-04


def test_reschedule_needs_a_reason_keeps_history_and_tells_everyone(world_api, b_engine):  # noqa: F811
    api, world, other, modules = world_api
    milestone = add_milestone(b_engine, world)
    old = datetime.now(UTC).replace(microsecond=0) + timedelta(days=10)
    with Session(b_engine) as session:
        session.get(Milestone, milestone).deadline = old
        final = session.get(Project, world.project_id).final_deadline
        session.commit()
    new = old + timedelta(days=5)
    path = m(world, milestone, "/reschedule")
    payload = {"deadline": new.isoformat(), "expected_version": 0}
    assert error(api.post(path, {**payload, "reason": "  "})) == "REASON_REQUIRED"
    assert error(api.post(path, {**payload, "deadline": old.isoformat(), "reason": "x"})) == (
        "DEADLINE_UNCHANGED"
    )
    if final is not None:
        late = (final + timedelta(days=1)).isoformat()
        assert error(api.post(path, {**payload, "deadline": late, "reason": "x"})) == (
            "DEADLINE_AFTER_PROJECT_END"
        )
    member = world.student_ids[1]
    assert api.post_as(member, path, {**payload, "reason": "接口延期"}).status_code == 403
    moved = api.post(path, {**payload, "reason": "接口联调延期"})
    assert moved.status_code == 200, moved.text
    change = moved.json()["data"]["date_changes"][0]
    assert change["reason"] == "接口联调延期"
    assert datetime.fromisoformat(change["old_deadline"]) == old
    assert datetime.fromisoformat(change["new_deadline"]) == new
    with Session(b_engine) as session:
        row = session.scalar(select(BMilestoneDateChange))
    expected = sorted(str(u) for u in (world.teacher_id, *world.student_ids))
    assert notes(b_engine, f"b:milestone-rescheduled:{row.id}") == expected
    assert error(api.post(path, {**payload, "reason": "再改"})) == "VERSION_CONFLICT"
