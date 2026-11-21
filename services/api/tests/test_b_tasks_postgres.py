"""B-7 (B6-01~B6-03): one task query for the tree, board and list (PostgreSQL)."""

from __future__ import annotations

from uuid import uuid4

import pytest
from sqlalchemy.orm import Session

from app.db.models import FunctionalModule, Task
from tests.b_fixtures import b_api, build_b_world
from tests.test_b_planning_postgres import (
    add_milestone,
    b_engine,  # noqa: F401  (fixture)
    body,
    confirm,
    created,
    error,
    freeze_baseline,
    p,
    plan,
    seed,
)


@pytest.fixture
def world_api(b_engine):  # noqa: F811
    with Session(b_engine) as session:
        world = build_b_world(session)
        other = build_b_world(session)
        session.commit()
    with b_api(b_engine) as api:
        modules, reqs = seed(api, world)
        freeze_baseline(b_engine, world)
        api.as_user(world.leader_id)
        yield api, world, other, modules, reqs


def tasks(api, world, user=None, **params):
    headers = {"X-B-Test-User": str(user)} if user else None
    response = api.client.get(p(world, "/tasks"), params=params or None, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["data"]


def freeze(api, world):
    for user in world.student_ids:
        assert confirm(api, world, user).status_code == 200
    response = api.post(
        p(world, "/plan/freeze"), {"expected_version": plan(api, world)["lock_version"]}
    )
    assert response.status_code == 200, response.text


def three(api, world, modules, b_engine):  # noqa: F811
    s = world.student_ids
    milestone = add_milestone(b_engine, world)
    login = created(
        api,
        world,
        body(
            modules,
            title="实现登录页",
            weight=50,
            priority="high",
            assignee_ids=[str(s[0])],
            milestone_ids=[milestone],
        ),
    )
    shop = created(
        api,
        world,
        body(
            modules,
            title="商品列表",
            module_id=modules["shop"],
            weight=30,
            priority="low",
            assignee_ids=[str(s[1])],
        ),
    )
    report = created(
        api,
        world,
        body(
            modules,
            title="写测试报告",
            weight=20,
            description="登录相关的测试",
            dependency_ids=[login["id"]],
            assignee_ids=[str(s[0]), str(s[1])],
        ),
    )
    return login, shop, report, milestone


def codes(page):
    return [i["code"] for i in page["items"]]


# ---------------------------------------------------------------- B6-03 list


def test_filters_sort_and_pages(world_api, b_engine):  # noqa: F811
    api, world, other, modules, reqs = world_api
    login, shop, report, milestone = three(api, world, modules, b_engine)
    member = world.student_ids[1]
    assert tasks(api, world, view="list")["total"] == 3
    assert codes(tasks(api, world, view="list", q="登录")) == [
        "T-001",
        "T-003",
    ]  # title + description
    assert codes(tasks(api, world, view="list", q="t2")) == ["T-002"]
    assert codes(tasks(api, world, view="list", assignee=str(member))) == ["T-002", "T-003"]
    assert codes(tasks(api, world, view="list", assignee=str(member), module=modules["login"])) == [
        "T-003"
    ]
    assert codes(tasks(api, world, view="list", milestone=milestone)) == ["T-001"]
    assert codes(tasks(api, world, view="list", assignee="me")) == ["T-001", "T-003"]
    assert codes(tasks(api, world, view="list", sort="-weight")) == ["T-001", "T-002", "T-003"]
    assert codes(tasks(api, world, view="list", sort="priority")) == ["T-001", "T-003", "T-002"]
    page = tasks(api, world, view="list", sort="code", page=2, page_size=2)
    assert page["total"] == 3 and codes(page) == ["T-003"]
    assert tasks(api, world, view="list", status="in_progress")["total"] == 0
    row = tasks(api, world, view="list", q="T-001")["items"][0]
    assert row["links"] == {
        "detail": f"/projects/{world.project_id}/tasks/{login['id']}",
        "submit": f"/projects/{world.project_id}/tasks/{login['id']}/submit",
        "evidence": f"/projects/{world.project_id}/evidence?task={login['id']}",
        "verification": f"/projects/{world.project_id}/tasks/{login['id']}/verification",
    }
    for bad in (
        {"view": "gantt"},
        {"status": "done"},
        {"sort": "owner"},
        {"module": "x"},
        {"page": 0},
    ):
        assert error(api.get(p(world, "/tasks"), **bad)) == "INVALID_FILTER"


def test_the_three_views_share_the_same_rows(world_api, b_engine):  # noqa: F811
    api, world, other, modules, reqs = world_api
    three(api, world, modules, b_engine)
    views = {v: tasks(api, world, view=v, page_size=100) for v in ("tree", "board", "list")}
    ids = {v: sorted(i["id"] for i in page["items"]) for v, page in views.items()}
    assert ids["tree"] == ids["board"] == ids["list"]
    assert len({page["lock_version"] for page in views.values()}) == 1
    assert {c["status"]: c["count"] for c in views["board"]["columns"]}["not_started"] == 3


# ---------------------------------------------------------------- B6-01 tree


def test_tree_marks_a_cycle_and_an_orphan_without_failing(world_api, b_engine):  # noqa: F811
    api, world, other, modules, reqs = world_api
    a = created(api, world, body(modules, title="A", weight=50))
    b = created(api, world, body(modules, title="B", weight=50))
    c = created(api, world, body(modules, title="C", weight=50))
    with Session(b_engine) as session:
        foreign_module = FunctionalModule(id=uuid4(), project_id=other.project_id, name="别组")
        session.add(foreign_module)
        session.flush()
        foreign = Task(
            id=uuid4(), project_id=other.project_id, module_id=foreign_module.id, title="别组任务"
        )
        session.add(foreign)
        session.flush()
        session.get(Task, a["id"]).parent_task_id = b["id"]
        session.get(Task, b["id"]).parent_task_id = a["id"]
        session.get(Task, c["id"]).parent_task_id = foreign.id
        session.commit()
    page = tasks(api, world, view="tree")
    assert sorted(i["id"] for i in page["items"]) == sorted([a["id"], b["id"], c["id"]])
    issues = {i["code"]: i for i in page["integrity_issues"]}
    assert set(issues["parent_cycle"]["task_ids"]) == {a["id"], b["id"]}
    assert issues["unknown_parent"]["task_id"] == c["id"]
    assert tasks(api, world, view="list")["integrity_issues"] == []  # tree only


def test_tree_keeps_ancestors_of_matches(world_api):
    api, world, other, modules, reqs = world_api
    parent = created(api, world, body(modules, title="父任务", weight=100))
    child = created(
        api, world, body(modules, title="子任务登录", weight=100, parent_task_id=parent["id"])
    )
    page = tasks(api, world, view="tree", q="登录")
    assert page["total"] == 1
    rows = {i["id"]: i["matched"] for i in page["items"]}
    assert rows == {parent["id"]: False, child["id"]: True}


# ---------------------------------------------------------------- B6-02 board


def test_board_moves_follow_c_rules_and_go_through_c(world_api, b_engine):  # noqa: F811
    api, world, other, modules, reqs = world_api
    login, shop, report, _ = three(api, world, modules, b_engine)
    draft = {i["id"]: i for i in tasks(api, world, view="board")["items"]}
    assert draft[login["id"]]["transitions"] == []
    assert draft[login["id"]]["blocked_reason"] == "任务计划还没冻结"
    freeze(api, world)
    rows = {i["id"]: i for i in tasks(api, world, view="board")["items"]}
    start = rows[login["id"]]["transitions"]
    assert [(t["to"], t["kind"], t["path"]) for t in start] == [
        ("in_progress", "api", f"/api/v1/tasks/{login['id']}/start")
    ]
    assert rows[shop["id"]]["blocked_reason"] == "只有负责人可以开始这个任务"
    assert rows[report["id"]]["blocked_reason"] == "前置任务未完成：T-001"
    assert rows[report["id"]]["dependencies_done"] is False
    # B has no status endpoint; the card moves only through C's route.
    assert api.client.patch(
        p(world, f"/tasks/{login['id']}"), json={"status": "in_progress"}
    ).status_code in {404, 405}
    response = api.client.post(
        start[0]["path"], json={"expected_version": start[0]["expected_version"]}
    )
    assert response.status_code == 200, response.text
    after = {i["id"]: i for i in tasks(api, world, view="list")["items"]}
    assert after[login["id"]]["status"] == "in_progress"
    assert [(t["to"], t["kind"]) for t in after[login["id"]]["transitions"]] == [
        ("pending_submission", "page")
    ]
    stale = api.client.post(start[0]["path"], json={"expected_version": 0})
    assert stale.status_code in {200, 409}  # C decides; a repeat start is a no-op in C
    member_view = {
        i["id"]: i for i in tasks(api, world, user=world.student_ids[1], view="board")["items"]
    }
    assert member_view[shop["id"]]["transitions"][0]["to"] == "in_progress"


def test_scope(world_api):
    api, world, other, modules, reqs = world_api
    created(api, world, body(modules))
    teacher_rows = tasks(api, world, user=world.teacher_id, view="board")["items"]
    assert teacher_rows[0]["transitions"] == []
    assert teacher_rows[0]["blocked_reason"] == "只有本组成员可以推进任务"
    outsider = api.client.get(p(world, "/tasks"), headers={"X-B-Test-User": str(other.leader_id)})
    assert outsider.status_code == 404
    api.as_user(None)
    assert api.get(p(world, "/tasks")).status_code == 401
