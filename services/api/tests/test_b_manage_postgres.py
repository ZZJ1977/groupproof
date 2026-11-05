"""B-5 (B4-01~B4-03): requirement list, versions, impact, trace — HTTP over PostgreSQL."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

import pytest
from sqlalchemy.orm import Session

from app.db.models import AcceptanceCriterion, FunctionalModule, Project, Task, TaskRequirement
from app.modules.b.models import BCriterionRecheck
from app.modules.b.ports import (
    InvalidationOutcome,
    TaskVerificationStatus,
    get_verification_port,
)
from app.modules.c.models import Evidence, EvidenceCriterion
from tests.b_fixtures import b_api, b_postgres_schema, b_test_database_url, build_b_world


@pytest.fixture
def b_engine(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("AI_PROVIDER", "fake")
    with b_postgres_schema(b_test_database_url()) as engine:
        yield engine


@pytest.fixture
def setup(b_engine):
    with Session(b_engine) as session:
        world = build_b_world(session)
        other = build_b_world(session)
        session.commit()
    with b_api(b_engine) as api:
        api.as_user(world.leader_id)
        login = api.post(p(world, "/modules"), {"name": "登录"}).json()["data"]
        shop = api.post(p(world, "/modules"), {"name": "商城"}).json()["data"]
        reqs = [
            api.post(p(world, "/requirements"), body).json()["data"]
            for body in (
                {"module_id": login["id"], "title": "用户可以登录", "priority": "high"},
                {"module_id": login["id"], "title": "忘记密码可以重置"},
                {"module_id": shop["id"], "title": "可以发布商品", "description": "带图片"},
            )
        ]
        yield api, world, other, {"login": login, "shop": shop}, reqs


def p(world, suffix=""):
    return f"/api/v1/projects/{world.project_id}{suffix}"


def error(response):
    return response.json()["error"]["code"]


def listing(api, world, **params):
    response = api.get(p(world, "/requirements"), **params)
    assert response.status_code == 200, response.text
    return response.json()["data"]


def freeze(engine, world):
    with Session(engine) as session:
        session.get(Project, world.project_id).setup_status = "frozen"
        session.commit()


def link_task(engine, world, requirement_id, *, evidence=True):
    with Session(engine) as session:
        module = FunctionalModule(
            id=uuid4(), project_id=world.project_id, name=f"任务模块{uuid4().hex[:4]}"
        )
        session.add(module)
        session.flush()
        task = Task(id=uuid4(), project_id=world.project_id, module_id=module.id, title="实现登录")
        session.add(task)
        session.flush()
        session.add(TaskRequirement(task_id=task.id, requirement_id=requirement_id))
        criterion = AcceptanceCriterion(
            id=uuid4(), task_id=task.id, criterion_key="AC-1", text="输入正确密码能进入首页"
        )
        session.add(criterion)
        session.flush()
        evidence_id = None
        if evidence:
            row = Evidence(
                id=uuid4(),
                project_id=world.project_id,
                task_id=task.id,
                author_id=world.leader_id,
                title="登录截图",
                description="截图",
                source_type="manual",
                status="formal",
                created_at=datetime.now(UTC),
            )
            session.add(row)
            session.flush()
            session.add(EvidenceCriterion(evidence_id=row.id, criterion_id=criterion.id))
            evidence_id = row.id
        session.commit()
        return task.id, criterion.id, evidence_id


# ---------------------------------------------------------------- B4-01


def test_numbers_are_unique_and_never_reused(setup):
    api, world, other, modules, reqs = setup
    assert [r["code"] for r in reqs] == ["R-001", "R-002", "R-003"]
    other_code = api.as_user(other.leader_id)
    module = other_code.post(p(other, "/modules"), {"name": "别组模块"}).json()["data"]
    first = other_code.post(
        p(other, "/requirements"), {"module_id": module["id"], "title": "别组需求"}
    ).json()["data"]
    assert first["code"] == "R-001"  # numbering is per project


def test_filters_combine_and_page_totals(setup):
    api, world, other, modules, reqs = setup
    assert listing(api, world)["total"] == 3
    assert [i["code"] for i in listing(api, world, code="R-002")["items"]] == ["R-002"]
    assert listing(api, world, code="r2")["items"][0]["code"] == "R-002"
    assert listing(api, world, q="密码")["total"] == 1
    assert listing(api, world, q="图片")["total"] == 1  # description is searched too
    assert listing(api, world, module=modules["login"]["id"])["total"] == 2
    assert listing(api, world, module=modules["login"]["id"], q="登录")["total"] == 1
    assert listing(api, world, source="manual")["total"] == 3
    assert listing(api, world, source="ai")["total"] == 0
    assert listing(api, world, status="draft", module=modules["shop"]["id"])["total"] == 1
    assert listing(api, world, status="confirmed")["total"] == 0
    page = listing(api, world, page=2, page_size=2)
    assert page["total"] == 3 and [i["code"] for i in page["items"]] == ["R-003"]
    assert error(api.get(p(world, "/requirements"), status="bogus")) == "INVALID_FILTER"
    assert error(api.get(p(world, "/requirements"), code="X9")) == "INVALID_FILTER"


def test_source_filter_by_material(setup):
    api, world, other, modules, reqs = setup
    material = api.post(
        p(world, "/materials"), {"kind": "text", "text": "需求：可以收藏商品"}
    ).json()["data"]
    api.post(p(world, "/analysis"))
    data = listing(api, world, source=material["id"])
    assert data["total"] == 1 and data["items"][0]["origin"] == "ai"
    assert data["items"][0]["code"] == "R-004"


# ---------------------------------------------------------------- B4-02


def update(api, world, req, **values):
    current = api.get(p(world, f"/requirements/{req['id']}")).json()["data"]["requirement"]
    body = {
        "module_id": current["module_id"],
        "title": current["title"],
        "description": current["description"],
        "priority": current["priority"],
        "expected_version": current["lock_version"],
    }
    body.update(values)
    return api.patch(p(world, f"/requirements/{req['id']}"), body)


def test_after_freeze_a_reason_is_required_and_versions_are_kept(setup, b_engine):
    api, world, other, modules, reqs = setup
    freeze(b_engine, world)
    detail = api.get(p(world, f"/requirements/{reqs[0]['id']}")).json()["data"]
    assert detail["reason_required"] is True and detail["can_edit"] is True
    refused = update(api, world, reqs[0], title="改后的标题")
    assert refused.status_code == 409 and error(refused) == "BASELINE_FROZEN"
    assert refused.json()["error"]["details"]["reason_required"] is True
    assert error(update(api, world, reqs[0], title="改后的标题", reason="  ")) == "BASELINE_FROZEN"
    saved = update(api, world, reqs[0], title="改后的标题", reason="老师要求加验证码")
    assert saved.status_code == 200, saved.text
    history = api.get(p(world, f"/requirements/{reqs[0]['id']}/versions")).json()["data"]
    assert [v["version_no"] for v in history["versions"]] == [1, 2]
    assert history["versions"][0]["snapshot"]["title"] == "用户可以登录"
    assert history["versions"][1]["reason"] == "老师要求加验证码"
    assert history["versions"][1]["after_freeze"] is True
    # Other setup edits stay closed after the freeze.
    assert error(api.post(p(world, "/modules"), {"name": "x"})) == "BASELINE_FROZEN"


def test_draft_saves_also_keep_versions_and_no_op_saves_do_not(setup):
    api, world, other, modules, reqs = setup
    assert update(api, world, reqs[1], priority="low").status_code == 200
    assert update(api, world, reqs[1], priority="low").status_code == 200  # unchanged
    history = api.get(p(world, f"/requirements/{reqs[1]['id']}/versions")).json()["data"]
    assert [v["version_no"] for v in history["versions"]] == [1, 2]


def test_impact_preview_then_save_flags_criteria_and_tells_d(setup, b_engine):
    api, world, other, modules, reqs = setup
    task_id, criterion_id, _ = link_task(b_engine, world, reqs[0]["id"])
    calls = []

    class Recording:
        def invalidate_criterion_results(
            self, session, *, task_id, criterion_ids, reason, actor_id
        ):
            calls.append((task_id, list(criterion_ids), reason))
            return InvalidationOutcome(task_id=task_id, accepted=True)

        def task_verification_status(self, session, *, task_ids):
            return {t: TaskVerificationStatus(task_id=t, state="passed") for t in task_ids}

    api._app.dependency_overrides[get_verification_port] = Recording
    preview = api.post(p(world, f"/requirements/{reqs[0]['id']}/impact-preview")).json()["data"]
    assert [t["id"] for t in preview["tasks"]] == [str(task_id)]
    assert preview["tasks"][0]["criteria"][0]["needs_recheck"] is False
    freeze(b_engine, world)
    assert update(api, world, reqs[0], title="新标题", reason="范围调整").status_code == 200
    assert calls == [(task_id, [criterion_id], "范围调整")]
    after = api.post(p(world, f"/requirements/{reqs[0]['id']}/impact-preview")).json()["data"]
    assert after["tasks"][0]["criteria"][0]["needs_recheck"] is True
    marks = api.get(p(world, "/criteria-rechecks"), task_id=str(task_id)).json()["data"]
    assert marks[0]["requirement_version_no"] == 2 and marks[0]["verification_notified"] is True


def test_recheck_flag_is_kept_when_d_is_unavailable(setup, b_engine):
    api, world, other, modules, reqs = setup
    task_id, criterion_id, _ = link_task(b_engine, world, reqs[0]["id"])
    freeze(b_engine, world)
    assert update(api, world, reqs[0], title="新标题", reason="调整").status_code == 200
    with Session(b_engine) as session:
        mark = session.get(BCriterionRecheck, criterion_id)
        assert mark is not None and mark.verification_notified is False


# ---------------------------------------------------------------- B4-03


def test_trace_walks_module_task_criterion_evidence_and_says_when_d_is_missing(setup, b_engine):
    api, world, other, modules, reqs = setup
    task_id, criterion_id, evidence_id = link_task(b_engine, world, reqs[0]["id"])
    data = api.get(p(world, f"/requirements/{reqs[0]['id']}/trace")).json()["data"]
    assert data["module"]["name"] == "登录"
    assert data["module_href"].endswith(f"module={modules['login']['id']}")
    task = data["tasks"][0]
    assert task["href"] == f"/projects/{world.project_id}/tasks/{task_id}"
    assert task["criteria"][0]["id"] == str(criterion_id)
    assert [e["id"] for e in task["criteria"][0]["evidence"]] == [str(evidence_id)]
    assert data["evidence_status"] == "available"
    assert data["verification_status"] == "unavailable"
    assert task["verification"] == {
        "status": "unavailable",
        "state": None,
        "href": f"/projects/{world.project_id}/tasks/{task_id}/verification",
    }


def test_version_compare_lists_field_changes(setup):
    api, world, other, modules, reqs = setup
    update(api, world, reqs[2], title="可以发布二手商品", module_id=modules["login"]["id"])
    compare = api.get(p(world, f"/requirements/{reqs[2]['id']}/versions"), **{"from": 1, "to": 2})
    data = compare.json()["data"]["compare"]
    changes = {c["field"]: (c["before"], c["after"]) for c in data["changes"]}
    assert changes == {
        "title": ("可以发布商品", "可以发布二手商品"),
        "module_id": ("商城", "登录"),
    }
    missing = api.get(p(world, f"/requirements/{reqs[2]['id']}/versions"), **{"from": 1, "to": 9})
    assert error(missing) == "VERSION_NOT_FOUND"


def test_scope(setup):
    api, world, other, modules, reqs = setup
    api.as_user(other.leader_id)
    assert api.get(p(world, "/requirements")).status_code == 404
    assert api.get(p(world, f"/requirements/{reqs[0]['id']}/trace")).status_code == 404
    api.as_user(world.leader_id)
    assert api.get(p(other, f"/requirements/{reqs[0]['id']}")).status_code == 404
    api.as_user(world.teacher_id)
    detail = api.get(p(world, f"/requirements/{reqs[0]['id']}")).json()["data"]
    assert detail["can_edit"] is False
    api.as_user(None)
    assert api.get(p(world, "/requirements")).status_code == 401
