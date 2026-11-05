"""B-6 (B5-01~B5-05): plan draft, versions, suggestions, confirmation, freeze (PostgreSQL)."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import Milestone, Project, Task
from app.modules.a.models import AuditEvent, Notification
from app.modules.b.models import BCriterionInvalidation, BTaskVersion
from app.modules.b.ports import InvalidationOutcome, get_verification_port
from tests.b_fixtures import b_api, b_postgres_schema, b_test_database_url, build_b_world


@pytest.fixture
def b_engine(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("AI_PROVIDER", "fake")
    with b_postgres_schema(b_test_database_url()) as engine:
        yield engine


def p(world, suffix=""):
    return f"/api/v1/projects/{world.project_id}{suffix}"


def error(response):
    return response.json()["error"]["code"]


def freeze_baseline(engine, world):
    with Session(engine) as session:
        session.get(Project, world.project_id).setup_status = "frozen"
        session.commit()


def add_milestone(engine, world, title="中期检查"):
    with Session(engine) as session:
        row = Milestone(id=uuid4(), project_id=world.project_id, title=title)
        session.add(row)
        session.commit()
        return str(row.id)


def seed(api, world):
    """Two modules and three requirements while the baseline is still a draft."""
    api.as_user(world.leader_id)
    login = api.post(p(world, "/modules"), {"name": "登录"}).json()["data"]
    shop = api.post(p(world, "/modules"), {"name": "商城"}).json()["data"]
    reqs = [
        api.post(p(world, "/requirements"), body).json()["data"]
        for body in (
            {"module_id": login["id"], "title": "用户可以登录"},
            {"module_id": login["id"], "title": "忘记密码可以重置"},
            {"module_id": shop["id"], "title": "可以发布商品"},
        )
    ]
    return {"login": login["id"], "shop": shop["id"]}, [r["id"] for r in reqs]


@pytest.fixture
def setup(b_engine):
    with Session(b_engine) as session:
        world = build_b_world(session)
        other = build_b_world(session)
        session.commit()
    with b_api(b_engine) as api:
        modules, reqs = seed(api, world)
        other_modules, other_reqs = seed(api, other)
        freeze_baseline(b_engine, world)
        freeze_baseline(b_engine, other)
        api.as_user(world.leader_id)
        yield api, world, other, modules, reqs, {"modules": other_modules, "reqs": other_reqs}


def body(modules, **extra):
    data = {
        "title": "实现登录页",
        "module_id": modules["login"],
        "weight": 100,
        "criteria": [{"text": "输入正确密码能进入首页"}],
    }
    data.update(extra)
    return data


def create(api, world, payload, user=None):
    if user is not None:
        return api.post_as(user, p(world, "/plan/tasks"), payload)
    return api.post(p(world, "/plan/tasks"), payload)


def created(api, world, payload):
    response = create(api, world, payload)
    assert response.status_code == 201, response.text
    return response.json()["data"]


def put(api, world, task, **changes):
    data = {
        "title": task["title"],
        "description": task["description"],
        "module_id": task["module_id"],
        "parent_task_id": task["parent_task_id"],
        "requirement_ids": task["requirement_ids"],
        "assignee_ids": [a["id"] for a in task["assignees"]],
        "dependency_ids": task["dependency_ids"],
        "milestone_ids": task["milestone_ids"],
        "priority": task["priority"],
        "weight": task["weight"],
        "criteria": [{"id": c["id"], "text": c["text"]} for c in task["criteria"]],
        "expected_version": task["content_version"],
    }
    data.update(changes)
    return api.put(p(world, f"/plan/tasks/{task['id']}"), data)


def plan(api, world, user=None):
    if user is not None:
        response = api.client.get(p(world, "/plan"), headers={"X-B-Test-User": str(user)})
    else:
        response = api.get(p(world, "/plan"))
    assert response.status_code == 200, response.text
    return response.json()["data"]


def confirm(api, world, user):
    mine = plan(api, world, user)["my_task_versions"]
    return api.post_as(user, p(world, "/plan/confirmations/me"), {"task_versions": mine})


# ---------------------------------------------------------------- B5-01


def test_plan_needs_a_frozen_baseline_and_members(b_engine):
    with Session(b_engine) as session:
        world = build_b_world(session)
        session.commit()
    with b_api(b_engine) as api:
        modules, _ = seed(api, world)
        assert plan(api, world)["status"] == "none"
        assert plan(api, world)["can_edit"] is False
        assert error(create(api, world, body(modules))) == "BASELINE_NOT_FROZEN"
        freeze_baseline(b_engine, world)
        teacher = api.as_user(world.teacher_id)
        assert plan(teacher, world)["can_edit"] is False  # staff read only
        assert error(create(teacher, world, body(modules))) == "PROJECT_MEMBER_REQUIRED"
        api.as_user(None)
        assert api.get(p(world, "/plan")).status_code == 401


def test_cross_project_references_are_refused(setup, b_engine):
    api, world, other, modules, reqs, foreign = setup
    foreign_milestone = add_milestone(b_engine, other)
    cases = {
        "unknown_module": {"module_id": foreign["modules"]["login"]},
        "unknown_requirement": {"requirement_ids": [foreign["reqs"][0]]},
        "unknown_assignee": {"assignee_ids": [str(other.leader_id)]},
        "unknown_milestone": {"milestone_ids": [foreign_milestone]},
        "unknown_parent": {"parent_task_id": str(uuid4())},
    }
    for code, change in cases.items():
        response = create(api, world, body(modules, **change))
        assert response.status_code == 422, (code, response.text)
        assert error(response) == "PLAN_VALIDATION_FAILED"
        assert [i["code"] for i in response.json()["error"]["details"]["issues"]] == [code]
    assert plan(api, world)["tasks"] == []
    # Another group's leader cannot even see this plan.
    assert api.post_as(other.leader_id, p(world, "/plan/tasks"), body(modules)).status_code == 404


def test_dependency_cycle_is_refused_and_names_the_tasks(setup):
    api, world, other, modules, reqs, _ = setup
    a = created(api, world, body(modules, title="A", weight=50))
    b = created(api, world, body(modules, title="B", weight=50, dependency_ids=[a["id"]]))
    assert (a["code"], b["code"]) == ("T-001", "T-002")
    response = put(api, world, a, dependency_ids=[b["id"]])
    assert error(response) == "PLAN_VALIDATION_FAILED"
    issue = response.json()["error"]["details"]["issues"][0]
    assert issue["code"] == "dependency_cycle"
    assert set(issue["task_ids"]) == {a["id"], b["id"]}
    assert "T-001" in issue["message"] and "T-002" in issue["message"]
    # Parent/child loops are refused the same way.
    child = created(api, world, body(modules, title="C", weight=50, parent_task_id=a["id"]))
    response = put(api, world, a, parent_task_id=child["id"])
    assert response.json()["error"]["details"]["issues"][0]["code"] == "parent_cycle"
    assert error(put(api, world, a, dependency_ids=[a["id"]])) == "PLAN_VALIDATION_FAILED"


def test_each_save_adds_a_version_and_history_is_kept(setup, b_engine):
    api, world, other, modules, reqs, _ = setup
    task = created(api, world, body(modules, requirement_ids=[reqs[0]]))
    assert task["content_version"] == 1
    response = put(api, world, task, title="实现登录和注册页")
    assert response.status_code == 200, response.text
    second = response.json()["data"]
    assert second["content_version"] == 2
    assert error(put(api, world, task, title="过期页面")) == "VERSION_CONFLICT"
    assert put(api, world, second).json()["data"]["content_version"] == 2  # nothing changed
    history = api.get(p(world, f"/plan/tasks/{task['id']}/versions")).json()["data"]
    assert [v["version_no"] for v in history] == [2, 1]
    assert history[1]["snapshot"]["title"] == "实现登录页"
    assert history[0]["snapshot"]["title"] == "实现登录和注册页"
    with Session(b_engine) as session:
        actions = session.scalars(
            select(AuditEvent.action).where(AuditEvent.project_id == world.project_id)
        ).all()
    assert "project.plan.task_created" in actions and "project.plan.task_updated" in actions


# ---------------------------------------------------------------- B5-02


def test_freeze_lists_tasks_without_criteria(setup):
    api, world, other, modules, reqs, _ = setup
    task = created(api, world, body(modules, criteria=[], assignee_ids=[str(world.leader_id)]))
    for user in world.student_ids:
        assert confirm(api, world, user).status_code == 200
    current = plan(api, world)
    response = api.post(p(world, "/plan/freeze"), {"expected_version": current["lock_version"]})
    assert error(response) == "PLAN_NOT_READY"
    issues = response.json()["error"]["details"]["issues"]
    assert {(i["code"], i["task_id"]) for i in issues} == {("missing_criteria", task["id"])}
    assert response.json()["error"]["details"]["unconfirmed"] == []


def test_changing_criteria_of_a_started_task_tells_d_once(setup, b_engine):
    api, world, other, modules, reqs, _ = setup
    calls = []

    class Recording:
        def invalidate_criterion_results(
            self, session, *, task_id, criterion_ids, reason, actor_id
        ):
            calls.append((str(task_id), [str(c) for c in criterion_ids]))
            return InvalidationOutcome(task_id=task_id, accepted=True)

        def task_verification_status(self, session, *, task_ids):
            raise AssertionError("not used")

    api._app.dependency_overrides[get_verification_port] = Recording
    fresh = created(api, world, body(modules, title="还没开始", weight=50))
    started = created(api, world, body(modules, title="已开始", weight=50))
    with Session(b_engine) as session:
        row = session.get(Task, started["id"])
        row.status, row.started_at = "pending_verification", datetime.now(UTC)
        session.commit()
    criterion = started["criteria"][0]
    edit = [{"id": criterion["id"], "text": "输入正确密码后 2 秒内进入首页"}]
    assert put(api, world, fresh, criteria=[{"id": fresh["criteria"][0]["id"], "text": "改"}])
    assert calls == []  # never started: nothing to void
    assert put(api, world, started, criteria=edit).status_code == 200
    assert calls == [(started["id"], [criterion["id"]])]
    with Session(b_engine) as session:
        rows = session.scalars(select(BCriterionInvalidation)).all()
    assert [(str(r.task_id), r.accepted, r.task_content_version) for r in rows] == [
        (started["id"], True, 2)
    ]


def test_invalidation_is_kept_when_d_is_unavailable(setup, b_engine):
    api, world, other, modules, reqs, _ = setup
    task = created(api, world, body(modules))
    with Session(b_engine) as session:
        session.get(Task, task["id"]).started_at = datetime.now(UTC)
        session.commit()
    edit = [{"id": task["criteria"][0]["id"], "text": "新的标准"}]
    assert put(api, world, task, criteria=edit).status_code == 200
    with Session(b_engine) as session:
        row = session.scalar(select(BCriterionInvalidation))
    assert row.accepted is False  # D not connected yet: stays pending, not "voided"


# ---------------------------------------------------------------- B5-03


def test_suggestions_are_listed_deduplicated_and_never_touch_manual_tasks(setup, b_engine):
    api, world, other, modules, reqs, _ = setup
    manual = created(api, world, body(modules, requirement_ids=[reqs[0]]))
    first = api.post(p(world, "/plan/suggestions"))
    assert first.status_code == 200, first.text
    batch = first.json()["data"]
    assert batch["created"] == 2 and batch["duplicates"] == 0 and batch["is_placeholder"]
    assert {s["requirement_id"] for s in batch["suggestions"]} == {reqs[1], reqs[2]}
    assert len(plan(api, world)["tasks"]) == 1  # listing is not adopting
    again = api.post(p(world, "/plan/suggestions")).json()["data"]
    assert again["created"] == 0 and again["duplicates"] == 2
    pending = api.get(p(world, "/plan/suggestions")).json()["data"]
    assert len(pending) == 2
    chosen = next(s for s in pending if s["requirement_id"] == reqs[2])
    response = api.post(p(world, f"/plan/suggestions/{chosen['id']}/adopt"), {"weight": 10})
    assert response.status_code == 201, response.text
    adopted = response.json()["data"]
    assert adopted["origin"] == "ai" and adopted["module_id"] == modules["shop"]
    assert [c["text"] for c in adopted["criteria"]] == chosen["acceptance_criteria"]
    assert error(api.post(p(world, f"/plan/suggestions/{chosen['id']}/adopt"), {})) == (
        "SUGGESTION_HANDLED"
    )
    other_one = next(s for s in pending if s["id"] != chosen["id"])
    assert api.post(p(world, f"/plan/suggestions/{other_one['id']}/dismiss")).status_code == 200
    assert api.get(p(world, "/plan/suggestions")).json()["data"] == []
    third = api.post(p(world, "/plan/suggestions")).json()["data"]
    assert third["created"] == 0  # dismissed and adopted ones do not come back
    tasks = {t["id"]: t for t in plan(api, world)["tasks"]}
    assert tasks[manual["id"]]["content_version"] == 1
    assert tasks[manual["id"]]["title"] == manual["title"]
    with Session(b_engine) as session:
        assert (
            session.scalar(
                select(func.count())
                .select_from(BTaskVersion)
                .where(BTaskVersion.task_id == manual["id"])
            )
            == 1
        )


def test_ai_unavailable_falls_back_to_manual(setup, monkeypatch):
    api, world, other, modules, reqs, _ = setup
    monkeypatch.delenv("AI_PROVIDER")
    response = api.post(p(world, "/plan/suggestions"))
    assert response.status_code == 503 and error(response) == "AI_UNAVAILABLE"
    assert create(api, world, body(modules)).status_code == 201


# ---------------------------------------------------------------- B5-04


def test_confirmation_goes_stale_when_my_task_changes(setup):
    api, world, other, modules, reqs, _ = setup
    member = world.member_ids[1]
    task = created(api, world, body(modules, assignee_ids=[str(member)]))
    seen = plan(api, world, member)["my_task_versions"]
    assert seen == {task["id"]: 1}
    assert confirm(api, world, member).status_code == 200
    assert plan(api, world, member)["my_state"] == "confirmed"
    assert put(api, world, task, title="组长改了标题").status_code == 200
    assert plan(api, world, member)["my_state"] == "stale"
    states = {c["user"]["id"]: c["state"] for c in plan(api, world)["confirmations"]}
    assert states[str(member)] == "stale"
    stale = api.post_as(member, p(world, "/plan/confirmations/me"), {"task_versions": seen})
    assert error(stale) == "ASSIGNMENT_CHANGED"
    assert confirm(api, world, member).status_code == 200
    assert plan(api, world, member)["my_state"] == "confirmed"


# ---------------------------------------------------------------- B5-05


def notifications(engine, world, prefix):
    with Session(engine) as session:
        return session.scalars(
            select(Notification.recipient_id).where(Notification.dedupe_key.like(f"{prefix}%"))
        ).all()


def test_freeze_unlock_and_read_only(setup, b_engine):
    api, world, other, modules, reqs, _ = setup
    members = world.student_ids
    a = created(api, world, body(modules, title="A", weight=60, assignee_ids=[str(members[0])]))
    b = created(api, world, body(modules, title="B", weight=30, assignee_ids=[str(members[1])]))
    for user in members[:2]:
        assert confirm(api, world, user).status_code == 200
    response = api.post(
        p(world, "/plan/freeze"), {"expected_version": plan(api, world)["lock_version"]}
    )
    assert error(response) == "PLAN_NOT_READY"
    details = response.json()["error"]["details"]
    assert {i["code"] for i in details["issues"]} == {"root_weight_total"}
    assert {u["id"] for u in details["unconfirmed"]} == {str(m) for m in members[2:]}
    b = put(api, world, b, weight=40).json()["data"]  # members[1] must confirm again
    for user in members:
        assert confirm(api, world, user).status_code == 200
    stale = api.post(p(world, "/plan/freeze"), {"expected_version": 0})
    assert error(stale) == "VERSION_CONFLICT"
    assert (
        api.post_as(members[1], p(world, "/plan/freeze"), {"expected_version": 0}).status_code
        == 403
    )
    current = plan(api, world)
    response = api.post(p(world, "/plan/freeze"), {"expected_version": current["lock_version"]})
    assert response.status_code == 200, response.text
    frozen = response.json()["data"]
    assert frozen["status"] == "frozen" and frozen["can_edit"] is False
    assert sorted(notifications(b_engine, world, "b:plan-frozen:")) == sorted(members)

    # Frozen: every task write is refused.
    assert error(create(api, world, body(modules))) == "PLAN_FROZEN"
    assert error(put(api, world, a, title="改")) == "PLAN_FROZEN"
    assert (
        error(api.delete(p(world, f"/plan/tasks/{a['id']}"), expected_version=1)) == "PLAN_FROZEN"
    )
    assert error(api.post(p(world, "/plan/suggestions"))) == "PLAN_FROZEN"
    assert error(confirm(api, world, members[0])) == "PLAN_FROZEN"

    # Unlock: leader only, reason required, everyone confirms again.
    version = frozen["lock_version"]
    assert (
        api.post_as(
            members[1], p(world, "/plan/unlock"), {"expected_version": version, "reason": "x"}
        ).status_code
        == 403
    )
    assert (
        error(api.post(p(world, "/plan/unlock"), {"expected_version": version}))
        == "REASON_REQUIRED"
    )
    response = api.post(
        p(world, "/plan/unlock"), {"expected_version": version, "reason": "老师要求加一个模块"}
    )
    assert response.status_code == 200, response.text
    draft = response.json()["data"]
    assert draft["status"] == "draft" and draft["version_no"] == 2
    assert {c["state"] for c in draft["confirmations"]} == {"pending"}
    assert [h["status"] for h in draft["history"]] == ["draft", "archived"]
    assert sorted(notifications(b_engine, world, "b:plan-unlocked:")) == sorted(members)
    assert put(api, world, a, title="解锁后可以改").status_code == 200


def test_c_starts_tasks_only_while_the_plan_is_frozen(setup):
    api, world, other, modules, reqs, _ = setup
    leader = world.leader_id
    task = created(api, world, body(modules, assignee_ids=[str(leader)]))
    for user in world.student_ids:
        assert confirm(api, world, user).status_code == 200

    def start():
        with Session(api.engine) as session:
            version = session.get(Task, task["id"]).lock_version
        return api.client.post(
            f"/api/v1/tasks/{task['id']}/start", json={"expected_version": version}
        )

    assert error(start()) == "PLAN_NOT_FROZEN"
    frozen = api.post(
        p(world, "/plan/freeze"), {"expected_version": plan(api, world)["lock_version"]}
    ).json()["data"]
    unlocked = api.post(
        p(world, "/plan/unlock"), {"expected_version": frozen["lock_version"], "reason": "调整"}
    )
    assert unlocked.status_code == 200
    assert error(start()) == "PLAN_NOT_FROZEN"  # unlocked: C refuses
    for user in world.student_ids:
        assert confirm(api, world, user).status_code == 200
    again = api.post(
        p(world, "/plan/freeze"), {"expected_version": plan(api, world)["lock_version"]}
    )
    assert again.status_code == 200, again.text
    response = start()
    assert response.status_code == 200, response.text
    assert response.json()["data"]["status"] == "in_progress"


def test_delete_rules(setup):
    api, world, other, modules, reqs, _ = setup
    parent = created(api, world, body(modules, title="父", weight=100))
    child = created(api, world, body(modules, title="子", weight=100, parent_task_id=parent["id"]))
    assert error(api.delete(p(world, f"/plan/tasks/{parent['id']}"), expected_version=1)) == (
        "TASK_HAS_CHILDREN"
    )
    assert error(api.delete(p(world, f"/plan/tasks/{child['id']}"), expected_version=9)) == (
        "VERSION_CONFLICT"
    )
    assert api.delete(p(world, f"/plan/tasks/{child['id']}"), expected_version=1).status_code == 200
    assert [t["id"] for t in plan(api, world)["tasks"]] == [parent["id"]]
