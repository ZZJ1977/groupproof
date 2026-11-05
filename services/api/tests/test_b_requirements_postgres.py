"""B-4 (B3-05~B3-08): analysis, conflicts, checklist, baseline — HTTP over PostgreSQL."""

from __future__ import annotations

from uuid import uuid4

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import BaselineVersion, Project, Requirement
from app.modules.a.models import ActionItem, AuditEvent, Notification
from app.modules.b.models import BAnalysisRun
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
        yield api, world, other


def error(response):
    return response.json()["error"]["code"]


def p(world, suffix=""):
    return f"/api/v1/projects/{world.project_id}{suffix}"


def add_text(api, world, text):
    response = api.post(p(world, "/materials"), {"kind": "text", "text": text})
    assert response.status_code == 201, response.text


def board(api, world):
    response = api.get(p(world, "/setup/requirements"))
    assert response.status_code == 200, response.text
    return response.json()["data"]


def analyse(api, world):
    response = api.post(p(world, "/analysis"))
    assert response.status_code == 202, response.text
    run = response.json()["data"]
    assert run["status"] == "processing"
    return api.get(p(world, f"/analysis/{run['id']}")).json()["data"]


def manual_ready(api, world):
    """One module with an owner and one requirement, scope and both ticks: checklist ready."""
    module = api.post(
        p(world, "/modules"), {"name": "登录模块", "owner_id": str(world.leader_id)}
    ).json()["data"]
    requirement = api.post(
        p(world, "/requirements"), {"module_id": module["id"], "title": "用户可以登录"}
    ).json()["data"]
    api.put(p(world, "/baseline/scope"), {"in_scope": "登录和注册", "expected_version": 0})
    for key in ("requirements_reviewed", "sources_checked"):
        assert api.put(p(world, f"/baseline/checklist/{key}"), {"checked": True}).status_code == 200
    return module, requirement


# ---------------------------------------------------------------- B3-05


def test_analysis_writes_draft_requirements_with_sources(setup):
    api, world, other = setup
    add_text(api, world, "需求一：学生可以发布二手商品。\n\n第二段")
    add_text(api, world, "需求二：商品必须经过审核才能上架。")
    run = analyse(api, world)
    assert run["status"] == "succeeded", run
    assert run["is_placeholder"] is True
    assert run["summary"]["requirements_added"] == 2
    data = board(api, world)
    assert [m["name"] for m in data["modules"]] == ["示例模块"]
    assert {r["origin"] for r in data["requirements"]} == {"ai"}
    assert all(r["status"] == "draft" and r["sources"] for r in data["requirements"])
    assert data["requirements"][0]["sources"][0]["segment_id"] == "p1"
    assert data["open_conflicts"] == 1
    assert data["setup_step"] >= 3


def test_ai_unavailable_falls_back_to_manual_entry(setup, monkeypatch):
    api, world, other = setup
    monkeypatch.delenv("AI_PROVIDER")
    add_text(api, world, "资料正文")
    run = analyse(api, world)
    assert run["status"] == "unavailable" and run["error_code"] == "AI_UNAVAILABLE"
    module = api.post(p(world, "/modules"), {"name": "手工模块"})
    assert module.status_code == 201, module.text
    created = api.post(
        p(world, "/requirements"),
        {"module_id": module.json()["data"]["id"], "title": "手工需求", "priority": "high"},
    )
    assert created.status_code == 201, created.text
    assert created.json()["data"]["origin"] == "manual"
    assert board(api, world)["latest_run"]["status"] == "unavailable"


def test_reanalysis_keeps_edited_and_manual_requirements(setup):
    api, world, other = setup
    add_text(api, world, "需求一：发布商品。")
    add_text(api, world, "需求二：审核商品。")
    analyse(api, world)
    first = board(api, world)
    edited, untouched = first["requirements"]
    response = api.patch(
        p(world, f"/requirements/{edited['id']}"),
        {
            "module_id": edited["module_id"],
            "title": "人工改过的需求",
            "description": "补充说明",
            "priority": "high",
            "expected_version": edited["lock_version"],
        },
    )
    assert response.status_code == 200, response.text
    manual = api.post(
        p(world, "/requirements"), {"module_id": edited["module_id"], "title": "手工新增"}
    ).json()["data"]
    run = analyse(api, world)
    assert run["status"] == "succeeded"
    assert run["summary"]["requirements_replaced"] == 1
    assert run["summary"]["duplicates_skipped"] == 1
    after = {r["id"]: r for r in board(api, world)["requirements"]}
    assert after[edited["id"]]["title"] == "人工改过的需求"
    assert after[edited["id"]]["edited_by_human"] is True
    assert after[manual["id"]]["title"] == "手工新增"
    assert untouched["id"] not in after
    assert len(after) == 3


def test_analysis_needs_material_and_runs_one_at_a_time(setup, b_engine):
    api, world, other = setup
    assert error(api.post(p(world, "/analysis"))) == "NO_ANALYZABLE_MATERIALS"
    add_text(api, world, "资料")
    with Session(b_engine) as session:
        session.add(
            BAnalysisRun(
                id=uuid4(),
                project_id=world.project_id,
                requested_by=world.leader_id,
                status="processing",
                material_ids=[],
            )
        )
        session.commit()
    assert error(api.post(p(world, "/analysis"))) == "ANALYSIS_RUNNING"


# ---------------------------------------------------------------- B3-06


def test_conflicts_block_continue_until_resolved_with_reason(setup):
    api, world, other = setup
    add_text(api, world, "需求一")
    add_text(api, world, "需求二")
    analyse(api, world)
    conflict = board(api, world)["conflicts"][0]
    path = p(world, f"/conflicts/{conflict['id']}/resolution")
    blocked = api.post(p(world, "/setup/advance"), {"from_step": 4})
    assert blocked.status_code == 409 and error(blocked) == "CONFLICTS_UNRESOLVED"
    assert error(api.post(path, {"decision": "keep_left"})) == "REASON_REQUIRED"
    assert error(api.post(path, {"decision": "keep_left", "reason": "  "})) == "REASON_REQUIRED"
    assert error(api.post(path, {"decision": "merge", "reason": "合并"})) == "MERGED_TITLE_REQUIRED"
    done = api.post(path, {"decision": "keep_left", "reason": "课程要求以第一份为准"})
    assert done.status_code == 200, done.text
    assert done.json()["data"]["status"] == "resolved"
    assert done.json()["data"]["right"]["excluded"] is True
    assert error(api.post(path, {"decision": "keep_right", "reason": "x"})) == "CONFLICT_CLOSED"
    advanced = api.post(p(world, "/setup/advance"), {"from_step": 4})
    assert advanced.status_code == 200 and advanced.json()["data"]["setup_step"] == 5


def test_merge_rewrites_the_kept_requirement(setup):
    api, world, other = setup
    add_text(api, world, "需求一")
    add_text(api, world, "需求二")
    analyse(api, world)
    conflict = board(api, world)["conflicts"][0]
    done = api.post(
        p(world, f"/conflicts/{conflict['id']}/resolution"),
        {"decision": "merge", "reason": "两条说的是一件事", "merged_title": "合并后的需求"},
    ).json()["data"]
    assert done["left"]["title"] == "合并后的需求" and done["right"]["excluded"] is True
    assert done["resolution"]["reason"] == "两条说的是一件事"


# ---------------------------------------------------------------- B3-07


def test_checklist_is_enforced_by_the_server(setup):
    api, world, other = setup
    review = api.get(p(world, "/baseline/checklist")).json()["data"]
    assert review["ready"] is False
    refused = api.post(p(world, "/baselines"))
    assert refused.status_code == 409 and error(refused) == "CHECKLIST_INCOMPLETE"
    assert "scope_filled" in refused.json()["error"]["details"]["failed"]
    module = api.post(p(world, "/modules"), {"name": "无主模块"}).json()["data"]
    api.post(p(world, "/requirements"), {"module_id": module["id"], "title": "需求"})
    api.put(p(world, "/baseline/scope"), {"in_scope": "范围", "expected_version": 0})
    for key in ("requirements_reviewed", "sources_checked"):
        api.put(p(world, f"/baseline/checklist/{key}"), {"checked": True})
    review = api.get(p(world, "/baseline/checklist")).json()["data"]
    failed = [item["key"] for item in review["items"] if not item["passed"]]
    assert failed == ["modules_have_owners"]
    assert error(api.post(p(world, "/baselines"))) == "CHECKLIST_INCOMPLETE"
    response = api.patch(
        p(world, f"/modules/{module['id']}"),
        {"name": "无主模块", "owner_id": str(world.member_ids[0]), "expected_version": 0},
    )
    assert response.status_code == 200, response.text
    assert api.get(p(world, "/baseline/checklist")).json()["data"]["ready"] is True
    api.as_user(world.member_ids[0])
    assert error(api.post(p(world, "/baselines"))) == "PROJECT_LEADER_REQUIRED"
    assert error(api.put(p(world, "/baseline/checklist/unknown"), {"checked": True})) == (
        "CHECK_ITEM_NOT_FOUND"
    )


def test_module_owner_must_be_member(setup):
    api, world, other = setup
    response = api.post(p(world, "/modules"), {"name": "模块", "owner_id": str(other.leader_id)})
    assert response.status_code == 422 and error(response) == "OWNER_NOT_MEMBER"


# ---------------------------------------------------------------- B3-08


def submit(api, world):
    response = api.post(p(world, "/baselines"))
    assert response.status_code == 201, response.text
    return response.json()["data"]


def test_each_member_confirms_only_themselves_and_last_one_freezes(setup, b_engine):
    api, world, other = setup
    module, requirement = manual_ready(api, world)
    baseline = submit(api, world)
    assert baseline["status"] == "draft"
    assert {p["id"] for p in baseline["waiting_for"]} == {str(m) for m in world.member_ids}
    path = p(world, f"/baselines/{baseline['id']}/confirmations")
    a, b, c = world.member_ids
    api.as_user(a)
    assert error(api.put(f"{path}/{b}", {"decision": "confirm"})) == "NOT_YOUR_CONFIRMATION"
    assert api.put(f"{path}/{a}", {"decision": "confirm"}).status_code == 200
    assert error(api.put(f"{path}/{a}", {"decision": "confirm"})) == "ALREADY_CONFIRMED"
    # Editing is closed while members confirm.
    assert error(api.post(p(world, "/modules"), {"name": "新模块"})) == "BASELINE_IN_CONFIRMATION"
    api.as_user(b)
    assert api.put(f"{path}/{b}", {"decision": "confirm"}).status_code == 200
    with Session(b_engine) as session:
        assert session.get(Project, world.project_id).setup_status == "pending_confirmation"
    api.as_user(c)
    last = api.put(f"{path}/{c}", {"decision": "confirm"}).json()["data"]
    assert last["status"] == "frozen" and last["waiting_for"] == []
    with Session(b_engine) as session:
        assert session.get(Project, world.project_id).setup_status == "frozen"
        assert session.get(Requirement, requirement["id"]).status == "confirmed"
        assert (
            session.scalar(
                select(func.count())
                .select_from(ActionItem)
                .where(ActionItem.source_key == f"b:baseline-confirm:{baseline['id']}")
                .where(ActionItem.status == "pending")
            )
            == 0
        )
    # Frozen: every edit endpoint refuses.
    for response in (
        api.post(p(world, "/modules"), {"name": "新模块"}),
        api.post(p(world, "/requirements"), {"module_id": module["id"], "title": "x"}),
        api.patch(
            p(world, f"/requirements/{requirement['id']}"),
            {"module_id": module["id"], "title": "x", "priority": "low", "expected_version": 1},
        ),
        api.put(p(world, "/baseline/scope"), {"in_scope": "x", "expected_version": 1}),
        api.post(p(world, "/materials"), {"kind": "text", "text": "x"}),
    ):
        assert error(response) == "BASELINE_FROZEN", response.text
    assert board(api, world)["editable"] is False


def test_force_freeze_needs_leader_and_reason_and_tells_the_unconfirmed(setup, b_engine):
    api, world, other = setup
    manual_ready(api, world)
    baseline = submit(api, world)
    a, b, c = world.member_ids
    api.as_user(a)
    api.put(p(world, f"/baselines/{baseline['id']}/confirmations/{a}"), {"decision": "confirm"})
    force = p(world, f"/baselines/{baseline['id']}/force-freeze")
    assert error(api.post(force, {"reason": "赶进度"})) == "PROJECT_LEADER_REQUIRED"
    api.as_user(world.leader_id)
    assert error(api.post(force, {})) == "REASON_REQUIRED"
    done = api.post(force, {"reason": "截止前必须冻结"})
    assert done.status_code == 200, done.text
    assert done.json()["data"]["status"] == "frozen"
    with Session(b_engine) as session:
        for member_id, expected in ((a, 0), (b, 1), (c, 1)):
            count = session.scalar(
                select(func.count())
                .select_from(Notification)
                .where(
                    Notification.recipient_id == member_id,
                    Notification.dedupe_key == f"b:baseline-forced:{baseline['id']}:{member_id}",
                )
            )
            assert count == expected, member_id
        event = session.scalar(
            select(AuditEvent).where(AuditEvent.action == "project.baseline.force_frozen")
        )
        assert event.reason == "截止前必须冻结"
        assert set(event.after_json["unconfirmed"]) == {str(b), str(c)}


def test_reject_needs_a_comment_and_reopens_the_draft(setup, b_engine):
    api, world, other = setup
    manual_ready(api, world)
    baseline = submit(api, world)
    a = world.member_ids[0]
    api.as_user(a)
    path = p(world, f"/baselines/{baseline['id']}/confirmations/{a}")
    assert error(api.put(path, {"decision": "reject"})) == "REASON_REQUIRED"
    rejected = api.put(path, {"decision": "reject", "comment": "范围写得不清楚"}).json()["data"]
    assert rejected["status"] == "archived"
    with Session(b_engine) as session:
        assert session.get(Project, world.project_id).setup_status == "draft"
    assert api.post(p(world, "/modules"), {"name": "又可以改了"}).status_code == 201


def test_frozen_snapshot_ignores_later_table_edits(setup, b_engine):
    api, world, other = setup
    module, requirement = manual_ready(api, world)
    baseline = submit(api, world)
    api.as_user(world.leader_id)
    api.post(p(world, f"/baselines/{baseline['id']}/force-freeze"), {"reason": "演示"})
    with Session(b_engine) as session:
        session.get(Requirement, requirement["id"]).title = "被直接改掉的标题"
        session.commit()
    current = api.get(p(world, "/baselines/current")).json()["data"]
    assert [r["title"] for r in current["snapshot"]["requirements"]] == ["用户可以登录"]
    assert current["snapshot"]["scope"]["in_scope"] == "登录和注册"
    with Session(b_engine) as session:
        stored = session.get(BaselineVersion, baseline["id"]).snapshot_json
        assert stored["requirements"][0]["title"] == "用户可以登录"


def test_scope_of_reads_and_writes(setup):
    api, world, other = setup
    api.as_user(other.leader_id)
    assert api.get(p(world, "/setup/requirements")).status_code == 404
    assert api.post(p(world, "/modules"), {"name": "x"}).status_code == 404
    api.as_user(world.teacher_id)
    assert api.get(p(world, "/setup/requirements")).json()["data"]["editable"] is False
    assert api.post(p(world, "/modules"), {"name": "x"}).status_code == 403
    api.as_user(None)
    assert api.get(p(world, "/baseline/checklist")).status_code == 401
