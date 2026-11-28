"""Tests for code-driven incremental task discovery & non-blocking frozen-plan amendments."""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import JSON, DefaultClause, MetaData, create_engine, event, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapper, Session
from sqlalchemy.pool import StaticPool

from app.api.auth import get_current_user
from app.api.errors import ApiError
from app.db.base import Base
from app.db.models import (
    AcceptanceCriterion,
    FunctionalModule,
    PlanVersion,
    Project,
    ProjectMember,
    Task,
    TaskAssignee,
    User,
)
from app.db.session import get_session
from app.main import app
from app.modules.a import ai
from app.modules.a.models import GithubActivity, GithubRepoLink
from app.modules.b import (
    code_discovery_service,
    planning_service,
    tasks_view_service,
    teacher_projects_service,
)
from app.modules.b.models import BTaskMeta
from app.modules.b.plan_validation import PlanTask, validate_plan
from app.modules.b.planning_schemas import (
    AdoptCodeDiscoveryRequest,
    ApproveCodeDiscoveryRequest,
    CriterionInput,
    DismissCodeDiscoveryRequest,
    ScanCodeDiscoveriesRequest,
    UpdateTask,
)
from app.modules.b.ports import get_verification_port
from app.modules.c.activity_models import ActivityRecordState
from app.modules.c.models import Evidence, EvidenceCriterion, EvidenceSourceSnapshot
from app.modules.c.permissions import task_in_frozen_plan
from app.modules.d import contribution, reporting, verification
from app.modules.d.models import FormalOutcome, IntegrityCheck, VerificationRun
from tests.b_fixtures import _user, b_postgres_schema, b_test_database_url, build_b_world


@pytest.fixture
def cd_db(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("APP_MODE", "dev")
    monkeypatch.setenv("AI_PROVIDER", "fake")
    if os.getenv("B_TEST_DATABASE_URL"):
        with b_postgres_schema(b_test_database_url()) as pg_engine:
            with Session(pg_engine) as session:
                yield session
        return

    engine = create_engine(
        "sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False}
    )

    @event.listens_for(engine, "connect")
    def enforce_fk(conn, _):
        conn.execute("PRAGMA foreign_keys=ON")
        conn.create_function("gen_random_uuid", 0, lambda: uuid4().hex)

    @event.listens_for(Mapper, "before_insert")
    def fill_defaults(_, __, target):
        now_dt = datetime.now(UTC)
        for column in target.__table__.columns:
            if getattr(target, column.key, None) is not None:
                continue
            if column.primary_key and column.type.python_type is type(uuid4()):
                setattr(target, column.key, uuid4())
            elif column.key in {
                "created_at",
                "updated_at",
                "joined_at",
                "linked_at",
                "occurred_at",
                "checked_at",
                "decided_at",
                "synced_at",
                "recorded_at",
                "calculated_at",
            }:
                setattr(target, column.key, now_dt)

    meta = MetaData()
    for table in Base.metadata.tables.values():
        clone = table.to_metadata(meta)
        for col in clone.columns:
            if isinstance(col.type, JSONB):
                col.type = JSON()
            if isinstance(col.server_default, DefaultClause):
                raw = str(col.server_default.arg)
                if "gen_random_uuid" in raw or "::jsonb" in raw or "now()" in raw:
                    col.server_default = None
    meta.create_all(engine)
    try:
        with Session(engine) as session:
            yield session
    finally:
        event.remove(Mapper, "before_insert", fill_defaults)
        engine.dispose()


def _seed_team_project(
    session: Session, *, member_count: int = 3, frozen_plan: bool = True
) -> tuple[list[User], Project, FunctionalModule, Task, PlanVersion]:
    now_dt = datetime.now(UTC)
    tag = uuid4().hex[:6]
    users: list[User] = []
    for idx in range(member_count):
        u = _user(session, tag=f"cd_{tag}", role="student", index=idx + 1, now=now_dt)
        u.name = f"Member {idx + 1}"
        u.github_username = f"dev_{tag}_{idx + 1}"
        users.append(u)
    session.flush()

    project = Project(
        id=uuid4(),
        name="CodeDiscoveryDemo",
        lifecycle="active",
        setup_status="frozen",
    )
    session.add(project)
    session.flush()
    for idx, u in enumerate(users):
        session.add(
            ProjectMember(
                id=uuid4(),
                project_id=project.id,
                user_id=u.id,
                role="leader" if idx == 0 else "member",
            )
        )
    mod = FunctionalModule(
        id=uuid4(),
        project_id=project.id,
        owner_id=users[0].id,
        name="核心业务模块",
        description="基础核心模块",
        sort_order=0,
    )
    session.add(mod)
    session.flush()

    baseline_task = Task(
        id=uuid4(),
        project_id=project.id,
        module_id=mod.id,
        created_by=users[0].id,
        title="用户认证登录接口",
        description="实现邮箱登录与会话签发",
        priority="high",
        weight=100,
        status="in_progress",
        progress_percent=40,
        lock_version=0,
    )
    session.add(baseline_task)
    session.flush()
    session.add(
        TaskAssignee(
            task_id=baseline_task.id,
            user_id=users[0].id,
            role="responsible",
            assigned_at=now_dt,
        )
    )
    session.add(
        AcceptanceCriterion(
            id=uuid4(),
            task_id=baseline_task.id,
            criterion_key="AC-BASE-1",
            text="登录接口返回有效会话 Cookie",
            sort_order=0,
        )
    )
    session.add(
        BTaskMeta(
            task_id=baseline_task.id,
            project_id=project.id,
            seq=1,
            content_version=1,
            origin="manual",
        )
    )
    plan = PlanVersion(
        id=uuid4(),
        project_id=project.id,
        version_no=1,
        created_by=users[0].id,
        status="frozen" if frozen_plan else "draft",
        snapshot_json={"tasks": [{"id": str(baseline_task.id), "code": "T-001"}]},
        frozen_at=now_dt if frozen_plan else None,
        confirmed_at=now_dt if frozen_plan else None,
        lock_version=1,
    )
    session.add(plan)
    session.flush()
    return users, project, mod, baseline_task, plan


def _add_commit(
    session: Session,
    project_id: UUID,
    *,
    sha: str,
    title: str,
    author: User | None = None,
    author_login: str | None = None,
    author_name: str | None = None,
    files: list[dict] | None = None,
    detail_extra: dict | None = None,
    offset_minutes: int = 0,
) -> GithubActivity:
    detail: dict = {}
    if files is not None:
        detail["files"] = files
    if detail_extra:
        detail.update(detail_extra)
    repo_link = session.scalar(
        select(GithubRepoLink).where(GithubRepoLink.project_id == project_id).limit(1)
    )
    if repo_link is None:
        owner_uid = (
            author.id
            if author
            else session.scalar(
                select(ProjectMember.user_id).where(ProjectMember.project_id == project_id).limit(1)
            )
        )
        repo_link = GithubRepoLink(
            id=uuid4(),
            project_id=project_id,
            owner="acme",
            repo="demo",
            installation_id=1001,
            default_branch="main",
            linked_by_id=owner_uid,
        )
        session.add(repo_link)
        session.flush()
    act = GithubActivity(
        id=uuid4(),
        project_id=project_id,
        link_id=repo_link.id,
        kind="commit",
        external_id=sha,
        revision=sha,
        title=title,
        summary=title,
        url=f"https://github.com/acme/demo/commit/{sha}",
        author_user_id=author.id if author else None,
        author_login=author_login or (author.github_username if author else "dev"),
        author_name=author_name or (author.name if author else "Dev"),
        author_email=author.email if author else "dev@example.com",
        occurred_at=datetime.now(UTC) - timedelta(minutes=offset_minutes),
        deleted=False,
        detail=detail,
    )
    session.add(act)
    session.flush()
    return act


def test_ai_discover_tasks_from_code_fake_and_sanitization(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "fake")
    monkeypatch.setenv("APP_ENV", "test")
    project_id = uuid4()
    mod_id = uuid4()
    member_id = uuid4()
    c1 = uuid4()
    c2 = uuid4()
    c_trivial = uuid4()

    payload = ai.CodeTaskDiscoveryInput(
        project_id=project_id,
        project_name="GroupProof",
        modules=[ai.CodeDiscoveryModuleBrief(id=mod_id, name="导出模块")],
        existing_tasks=[],
        members=[ai.CodeDiscoveryMemberBrief(id=member_id, name="Alice")],
        unmatched_commits=[
            ai.CodeDiscoveryCommitBrief(
                id=c1,
                sha="aaa1111",
                title="feat(billing): add invoice PDF export endpoint",
                author_name="Alice",
                author_user_id=member_id,
                effective_lines=140,
                files=["services/billing/export_pdf.py"],
            ),
            ai.CodeDiscoveryCommitBrief(
                id=c2,
                sha="bbb2222",
                title="feat(billing): add invoice currency rounding",
                author_name="Alice",
                author_user_id=member_id,
                effective_lines=65,
                files=["services/billing/currency.py"],
            ),
            ai.CodeDiscoveryCommitBrief(
                id=c_trivial,
                sha="ccc3333",
                title="style: format spacing",
                author_name="Alice",
                author_user_id=member_id,
                effective_lines=4,
                files=["services/billing/format.py"],
            ),
        ],
    )
    res = ai.discover_tasks_from_code(payload)
    assert res.needs_human_review is True
    assert res.provider == "fake"
    assert res.is_placeholder is True
    assert len(res.suggestions) == 1
    sug = res.suggestions[0]
    assert sug.action_type == "new_top_level"
    assert set(sug.source_commit_ids) == {c1, c2}
    assert sug.suggested_assignee_ids == [member_id]
    assert 1 <= sug.suggested_weight <= 6
    assert len(sug.acceptance_criteria) >= 1

    # Sanitizer strips hallucinated commit/task IDs and downgrades invalid merge_existing
    class HallucinatingProvider:
        name = "stub"
        is_placeholder = False
        model = "stub"
        last_usage = None

        def generate(self, feature, raw_payload, *, timeout):
            return {
                "suggestions": [
                    {
                        "action_type": "merge_existing",
                        "title": "Invoice Export",
                        "target_task_id": str(uuid4()),  # bogus
                        "suggested_module_id": str(uuid4()),  # bogus -> fallback to mod_id
                        "suggested_weight": 99,  # clamped to 6
                        "source_commit_ids": [str(c1), str(uuid4())],  # bogus dropped
                        "acceptance_criteria": [],
                    },
                    {
                        "action_type": "new_top_level",
                        "title": "Pure Hallucination",
                        "source_commit_ids": [str(uuid4())],  # all bogus -> dropped
                        "acceptance_criteria": ["x"],
                    },
                ]
            }

    sanitized = ai.discover_tasks_from_code(payload, provider=HallucinatingProvider())
    assert len(sanitized.suggestions) == 1
    item = sanitized.suggestions[0]
    assert item.action_type == "new_top_level"
    assert item.target_task_id is None
    assert item.suggested_module_id == mod_id
    assert item.suggested_weight == 6
    assert item.source_commit_ids == [c1]
    assert len(item.acceptance_criteria) == 1


def test_unmatched_commit_filtering_and_scan_deduplication(cd_db):
    users, project, _mod, baseline_task, _plan = _seed_team_project(cd_db, member_count=2)
    leader, member = users

    # 1. Bot commit -> excluded
    _add_commit(
        cd_db,
        project.id,
        sha="bot0001",
        title="chore(deps): bump httpx",
        author_login="dependabot[bot]",
        author_name="dependabot[bot]",
        files=[{"path": "services/api/requirements.txt", "additions": 2, "deletions": 2}],
    )
    # 2. Merge commit -> excluded
    _add_commit(
        cd_db,
        project.id,
        sha="mrg0002",
        title="Merge branch 'develop' into feat-x",
        author=member,
        files=[{"path": "services/export/a.py", "additions": 50, "deletions": 0}],
    )
    # 3. Lockfile-only commit -> excluded
    _add_commit(
        cd_db,
        project.id,
        sha="lck0003",
        title="chore: update lockfile",
        author=member,
        files=[{"path": "package-lock.json", "additions": 800, "deletions": 400}],
    )
    # 4. Already linked via ActivityRecordState -> excluded
    linked_act = _add_commit(
        cd_db,
        project.id,
        sha="lnk0004",
        title="feat(telemetry): send heartbeat",
        author=member,
        files=[{"path": "services/telemetry/ping.py", "additions": 60, "deletions": 0}],
    )
    cd_db.add(
        ActivityRecordState(
            id=uuid4(),
            project_id=project.id,
            source_type="github",
            source_id=linked_act.id,
            source_identity="commit:lnk0004",
            status="candidate",
            task_id=baseline_task.id,
        )
    )
    # 5. Substantive unmatched commit -> INCLUDED
    unmatched_act = _add_commit(
        cd_db,
        project.id,
        sha="new0005",
        title="feat(webhook): add slack alert dispatcher",
        author=member,
        files=[{"path": "services/webhook/slack_dispatcher.py", "additions": 120, "deletions": 5}],
    )
    cd_db.flush()

    listing = code_discovery_service.list_code_discoveries(cd_db, leader, project.id)
    assert listing.unmatched_commits_count == 1
    assert listing.unmatched_commits[0].id == unmatched_act.id
    assert listing.unmatched_commits[0].effective_lines == 125
    assert listing.unmatched_commits[0].author_user_id == member.id

    scan1 = code_discovery_service.scan_code_discoveries(
        cd_db, leader, project.id, ScanCodeDiscoveriesRequest(max_commits=30)
    )
    assert scan1.created_count == 1
    assert scan1.pending_count == 1
    assert len(scan1.items) == 1

    # Second scan deduplicates cleanly
    scan2 = code_discovery_service.scan_code_discoveries(cd_db, leader, project.id)
    assert scan2.created_count == 0
    assert len(scan2.items) == 1


def test_l1_merge_existing_attaches_candidate_evidence_without_unfreezing(cd_db):
    users, project, _mod, baseline_task, plan = _seed_team_project(cd_db, member_count=3)
    leader, member, _ = users
    unmatched_act = _add_commit(
        cd_db,
        project.id,
        sha="mrg1001",
        title="feat(session): add refresh token sliding window",
        author=member,
        files=[{"path": "services/session/sliding.py", "additions": 90, "deletions": 10}],
    )

    class MergeProvider:
        name = "stub"
        is_placeholder = False
        model = "stub"
        last_usage = None

        def generate(self, feature, payload, *, timeout):
            return {
                "suggestions": [
                    {
                        "action_type": "merge_existing",
                        "title": "会话续期滑动窗口",
                        "description": "归并到现有登录认证任务",
                        "target_task_id": str(baseline_task.id),
                        "source_commit_ids": [str(unmatched_act.id)],
                        "acceptance_criteria": ["刷新令牌过期前可无感续期"],
                        "suggested_weight": 2,
                        "rationale": "与登录会话属于同一能力域",
                        "confidence": 0.91,
                    }
                ]
            }

    scan = code_discovery_service.scan_code_discoveries(
        cd_db, member, project.id, provider=MergeProvider()
    )
    assert scan.created_count == 1
    sug_id = scan.items[0].id
    before_lock_ver = baseline_task.lock_version

    result = code_discovery_service.adopt_code_discovery(cd_db, member, project.id, sug_id)
    assert result.adopted_immediately is True
    assert result.task_id == baseline_task.id
    assert result.attached_evidence_count == 1
    assert result.item.status == "adopted"
    assert result.item.approval_status == "approved"

    cd_db.refresh(plan)
    cd_db.refresh(baseline_task)
    assert plan.status == "frozen"
    assert baseline_task.lock_version == before_lock_ver

    evidences = cd_db.scalars(
        select(Evidence).where(Evidence.task_id == baseline_task.id, Evidence.status == "candidate")
    ).all()
    assert len(evidences) == 1


def test_frozen_l2_subtask_and_l3_top_level_tiered_approval_and_zero_lock_bump(cd_db):
    users, project, mod, baseline_task, plan = _seed_team_project(cd_db, member_count=3)
    leader, member1, member2 = users

    c_sub = _add_commit(
        cd_db,
        project.id,
        sha="sub2001",
        title="feat(auth-2fa): add TOTP QR code helper",
        author=member1,
        files=[{"path": "services/totp/qr_helper.py", "additions": 85, "deletions": 0}],
    )
    c_top = _add_commit(
        cd_db,
        project.id,
        sha="top3001",
        title="feat(analytics): add cohort retention matrix export",
        author=member2,
        files=[{"path": "services/analytics/cohort_matrix.py", "additions": 210, "deletions": 15}],
    )

    class TwoSuggestionProvider:
        name = "stub"
        is_placeholder = False
        model = "stub"
        last_usage = None

        def generate(self, feature, payload, *, timeout):
            return {
                "suggestions": [
                    {
                        "action_type": "new_subtask",
                        "title": "补充 TOTP 二次验证助手",
                        "description": "为认证流程补充双因素二维码辅助功能",
                        "suggested_parent_task_id": str(baseline_task.id),
                        "suggested_module_id": str(mod.id),
                        "suggested_assignee_ids": [str(member1.id)],
                        "suggested_weight": 3,
                        "source_commit_ids": [str(c_sub.id)],
                        "acceptance_criteria": ["可生成标准 TOTP 二维码并校验动态口令"],
                        "rationale": "认证登录子能力扩展",
                        "confidence": 0.85,
                    },
                    {
                        "action_type": "new_top_level",
                        "title": "新增留存矩阵导出能力",
                        "description": "跨模块新增数据分析导出能力",
                        "suggested_module_id": str(mod.id),
                        "suggested_assignee_ids": [str(member1.id), str(member2.id)],
                        "suggested_weight": 5,
                        "source_commit_ids": [str(c_top.id)],
                        "acceptance_criteria": [
                            "支持按周期导出留存矩阵 CSV",
                            "核心统计单元测试通过",
                        ],
                        "rationale": "独立新增数据分析域",
                        "confidence": 0.88,
                    },
                ]
            }

    scan = code_discovery_service.scan_code_discoveries(
        cd_db, member1, project.id, provider=TwoSuggestionProvider()
    )
    assert scan.created_count == 2
    sub_sug = next(i for i in scan.items if i.action_type == "new_subtask")
    top_sug = next(i for i in scan.items if i.action_type == "new_top_level")
    assert sub_sug.required_approvals == 2
    assert top_sug.required_approvals == 2  # 3-member team majority = (3//2)+1 = 2 + leader

    # --- L2 Subtask: member1 proposes -> cannot self-approve -> leader approves -> materializes!
    prop_sub = code_discovery_service.adopt_code_discovery(
        cd_db,
        member1,
        project.id,
        sub_sug.id,
        AdoptCodeDiscoveryRequest(reason="补充认证双因素子任务"),
    )
    assert prop_sub.adopted_immediately is False
    assert prop_sub.task_id is None
    assert prop_sub.item.approval_status == "pending_approval"
    assert prop_sub.item.can_approve is False  # proposer cannot self-approve

    with pytest.raises(ApiError) as self_err:
        code_discovery_service.approve_code_discovery(cd_db, member1, project.id, sub_sug.id)
    assert self_err.value.code == "PROPOSER_CANNOT_SELF_APPROVE"

    # Leader sees can_approve=True
    leader_list = code_discovery_service.list_code_discoveries(cd_db, leader, project.id)
    assert leader_list.pending_approval_count == 1
    leader_sub_view = next(i for i in leader_list.items if i.id == sub_sug.id)
    assert leader_sub_view.can_approve is True

    approved_sub = code_discovery_service.approve_code_discovery(
        cd_db, leader, project.id, sub_sug.id, ApproveCodeDiscoveryRequest(reason="同意增补")
    )
    assert approved_sub.adopted_immediately is True
    assert approved_sub.task_id is not None
    assert approved_sub.attached_evidence_count == 1
    sub_task = cd_db.get(Task, approved_sub.task_id)
    assert sub_task is not None and sub_task.parent_task_id == baseline_task.id
    sub_meta = cd_db.get(BTaskMeta, sub_task.id)
    assert sub_meta is not None and sub_meta.origin == "ai_code"
    assert sub_meta.discovered_from_json["amendment_mode"] == "frozen_supplemental"

    # L3 Top-level: member2 proposes -> member1 approves (no leader yet) -> leader approves.
    prop_top = code_discovery_service.adopt_code_discovery(
        cd_db,
        member2,
        project.id,
        top_sug.id,
        AdoptCodeDiscoveryRequest(reason="新增独立统计导出模块"),
    )
    assert prop_top.adopted_immediately is False

    partial_top = code_discovery_service.approve_code_discovery(
        cd_db, member1, project.id, top_sug.id
    )
    assert partial_top.adopted_immediately is False
    assert len(partial_top.item.approvals) == 2

    final_top = code_discovery_service.approve_code_discovery(cd_db, leader, project.id, top_sug.id)
    assert final_top.adopted_immediately is True
    assert final_top.task_id is not None
    assert final_top.attached_evidence_count == 1

    # Verify frozen plan intact, new tasks in snapshot, baseline lock_version unchanged.
    cd_db.refresh(plan)
    cd_db.refresh(baseline_task)
    assert plan.status == "frozen"
    assert baseline_task.lock_version == 0
    assert task_in_frozen_plan(plan, approved_sub.task_id) is True
    assert task_in_frozen_plan(plan, final_top.task_id) is True

    top_meta = cd_db.get(BTaskMeta, final_top.task_id)
    assert top_meta is not None
    assert top_meta.origin == "ai_code"
    shares = top_meta.discovered_from_json["responsibility_shares"]
    assert sum(Decimal(v) for v in shares.values()) == Decimal("100")

    # Verify /tasks?origin=... filtering & DTO fields
    all_page = tasks_view_service.list_tasks(cd_db, leader, project.id, view="list", origin="all")
    planned_page = tasks_view_service.list_tasks(
        cd_db, leader, project.id, view="list", origin="planned"
    )
    code_page = tasks_view_service.list_tasks(
        cd_db, leader, project.id, view="list", origin="code_discovered"
    )
    assert all_page.total == 3
    assert planned_page.total == 1
    assert planned_page.items[0].origin == "manual"
    assert planned_page.items[0].is_code_discovered is False
    assert code_page.total == 2
    assert all(row.origin == "ai_code" and row.is_code_discovered for row in code_page.items)
    assert all(row.discovered_from is not None for row in code_page.items)


def test_draft_immediate_adoption_dismiss_and_plan_validation_rebalance(cd_db):
    users, project, mod, baseline_task, _draft_plan = _seed_team_project(
        cd_db, member_count=2, frozen_plan=False
    )
    leader, member = users

    _add_commit(
        cd_db,
        project.id,
        sha="drf4001",
        title="feat(export): add markdown exporter",
        author=member,
        files=[{"path": "services/export/markdown.py", "additions": 100, "deletions": 0}],
    )
    _add_commit(
        cd_db,
        project.id,
        sha="drf4002",
        title="feat(cache): add redis ttl helper",
        author=member,
        files=[{"path": "services/cache/ttl.py", "additions": 70, "deletions": 0}],
    )

    scan = code_discovery_service.scan_code_discoveries(cd_db, leader, project.id)
    assert scan.created_count == 2

    # Immediate adoption in draft plan
    adopted = code_discovery_service.adopt_code_discovery(
        cd_db, member, project.id, scan.items[0].id
    )
    assert adopted.adopted_immediately is True
    assert adopted.task_id is not None

    # Dismiss second suggestion
    dismissed = code_discovery_service.dismiss_code_discovery(
        cd_db, leader, project.id, scan.items[1].id, DismissCodeDiscoveryRequest(reason="暂不需要")
    )
    assert dismissed.item.status == "dismissed"
    assert dismissed.item.approval_status == "rejected"

    # Plan validation still passes with baseline root=100 + supplemental ai_code root!
    plan_dto = planning_service.plan_view(cd_db, leader, project.id)
    assert plan_dto.root_weight_total == 100
    assert not any(issue.code == "root_weight_total" for issue in plan_dto.issues)
    code_task_dto = next(t for t in plan_dto.tasks if t.id == adopted.task_id)
    assert code_task_dto.origin == "ai_code"
    assert code_task_dto.is_code_discovered is True

    # Completed task weight-only rebalance does NOT bump task.lock_version
    baseline_task.status = "completed"
    baseline_task.lock_version = 4
    cd_db.flush()
    existing_crit = cd_db.scalar(
        select(AcceptanceCriterion).where(AcceptanceCriterion.task_id == baseline_task.id)
    )
    assert existing_crit is not None
    planning_service.update_task(
        cd_db,
        leader,
        project.id,
        baseline_task.id,
        UpdateTask(
            title=baseline_task.title,
            description=baseline_task.description or "",
            module_id=mod.id,
            assignee_ids=[leader.id],
            priority="high",
            weight=80,
            criteria=[CriterionInput(id=existing_crit.id, text=existing_crit.text)],
            expected_version=1,
        ),
        get_verification_port(),
    )
    cd_db.refresh(baseline_task)
    assert int(baseline_task.weight) == 80
    assert baseline_task.lock_version == 4  # preserved so FormalOutcome stays valid!

    # Direct unit test of validate_plan with ai_code root
    issues = validate_plan(
        [
            PlanTask(
                id=uuid4(),
                code="T-001",
                module_id=mod.id,
                parent_id=None,
                weight=100,
                criteria_count=1,
                assignee_ids=(leader.id,),
                origin="manual",
            ),
            PlanTask(
                id=uuid4(),
                code="T-002",
                module_id=mod.id,
                parent_id=None,
                weight=5,
                criteria_count=1,
                assignee_ids=(member.id,),
                origin="ai_code",
            ),
        ],
        modules=[mod.id],
        requirements=[],
        milestones=[],
        members=[leader.id, member.id],
    )
    assert issues == []


def test_module_d_contribution_verification_reporting_and_teacher_metrics(cd_db):
    world = build_b_world(cd_db)
    teacher = cd_db.get(User, world.teacher_id)
    leader = cd_db.get(User, world.leader_id)
    member = cd_db.get(User, world.member_ids[0])
    project = cd_db.get(Project, world.project_id)
    assert teacher and leader and member and project
    project.setup_status = "frozen"

    mod = FunctionalModule(
        id=uuid4(), project_id=project.id, owner_id=leader.id, name="主模块", sort_order=0
    )
    cd_db.add(mod)
    cd_db.flush()

    now_dt = datetime.now(UTC)
    t_planned = Task(
        id=uuid4(),
        project_id=project.id,
        module_id=mod.id,
        created_by=leader.id,
        title="基线核心任务",
        weight=60,
        status="completed",
        progress_percent=100,
        lock_version=1,
    )
    t_code = Task(
        id=uuid4(),
        project_id=project.id,
        module_id=mod.id,
        created_by=member.id,
        title="代码演进增补任务",
        weight=40,  # 40 / (60+40) = 40% > 20% -> high_expansion_warning=True
        status="completed",
        progress_percent=100,
        lock_version=1,
    )
    cd_db.add_all([t_planned, t_code])
    cd_db.flush()
    cd_db.add_all(
        [
            BTaskMeta(
                task_id=t_planned.id,
                project_id=project.id,
                seq=1,
                content_version=1,
                origin="manual",
            ),
            BTaskMeta(
                task_id=t_code.id,
                project_id=project.id,
                seq=2,
                content_version=1,
                origin="ai_code",
                discovered_from_json={
                    "source_type": "github_code",
                    "commit_ids": [str(uuid4())],
                    "shas": ["abc1234"],
                    "commit_count": 1,
                    "amendment_mode": "frozen_supplemental",
                    "approved_by_name": leader.name,
                },
            ),
        ]
    )

    # Create valid Criterion, Formal Evidence, IntegrityCheck, VerificationRun, FormalOutcome
    for idx, (task_obj, owner_id) in enumerate(((t_planned, leader.id), (t_code, member.id))):
        crit = AcceptanceCriterion(
            id=uuid4(),
            task_id=task_obj.id,
            criterion_key=f"AC-D-{idx}",
            text=f"{task_obj.title} 验收标准",
            sort_order=0,
            lock_version=0,
        )
        ev = Evidence(
            id=uuid4(),
            project_id=project.id,
            task_id=task_obj.id,
            author_id=owner_id,
            title=f"{task_obj.title} 正式证据",
            description="完成实现与自测",
            source_type="manual",
            status="formal",
            lock_version=0,
            source_changed=False,
        )
        cd_db.add_all([crit, ev])
        cd_db.flush()
        cd_db.add(EvidenceCriterion(evidence_id=ev.id, criterion_id=crit.id))
        cd_db.add(
            EvidenceSourceSnapshot(
                evidence_id=ev.id,
                version_no=1,
                source_identity=f"manual:{ev.id}",
                source_revision="v1",
                content_hash="abc123",
                content_json={"availability": "available", "source": {"kind": "manual"}},
                captured_by=owner_id,
            )
        )
        chk = IntegrityCheck(
            id=uuid4(),
            project_id=project.id,
            task_id=task_obj.id,
            checked_by=leader.id,
            rule_version="effective-formal-v1",
            status="passed",
            total_criteria=1,
            covered_criteria=1,
            coverage_rate=Decimal("100.00"),
            missing_criteria_json=[],
            pending_sources=0,
            details_json=[
                {
                    "criterion_id": str(crit.id),
                    "criterion_key": crit.criterion_key,
                    "text": crit.text,
                    "criterion_version": 0,
                    "evidence": [{"id": str(ev.id), "version": 0}],
                    "covered": True,
                }
            ],
        )
        cd_db.add(chk)
        cd_db.flush()
        run = VerificationRun(
            id=uuid4(),
            integrity_check_id=chk.id,
            project_id=project.id,
            task_id=task_obj.id,
            triggered_by=leader.id,
            task_version=0,  # completed=True expects task_version + 1 == 1
            result="passed",
            status="completed",
            engine_version="deterministic-v1",
            started_at=now_dt,
            completed_at=now_dt,
        )
        cd_db.add(run)
        cd_db.flush()
        cd_db.add(
            FormalOutcome(
                id=uuid4(),
                project_id=project.id,
                task_id=task_obj.id,
                verification_run_id=run.id,
                basis_json={
                    "task_weight": str(int(task_obj.weight)),
                    "responsibility_shares": {str(owner_id): "100"},
                    "verification_run_id": str(run.id),
                },
            )
        )
    cd_db.commit()

    # 1. Contribution snapshot
    snap = contribution.calculate(cd_db, project.id, leader)
    summary = snap["origin_summary"]
    assert summary["planned_task_count"] == 1
    assert summary["code_discovered_task_count"] == 1
    assert summary["planned_weight_total"] == 60.0
    assert summary["code_discovered_weight_total"] == 40.0
    assert summary["code_discovered_weight_share"] == 0.4
    assert summary["high_expansion_warning"] is True

    leader_row = next(m for m in snap["members"] if m["user_id"] == str(leader.id))
    member_row = next(m for m in snap["members"] if m["user_id"] == str(member.id))
    assert leader_row["planned_credit"] == 60.0
    assert leader_row["code_discovered_credit"] == 0.0
    assert leader_row["tasks"][0]["origin"] == "manual"
    assert leader_row["tasks"][0]["is_code_discovered"] is False
    assert member_row["planned_credit"] == 0.0
    assert member_row["code_discovered_credit"] == 40.0
    assert member_row["tasks"][0]["origin"] == "ai_code"
    assert member_row["tasks"][0]["is_code_discovered"] is True

    # 2. Verification detail exposes code-discovered review note
    ver_code = verification.latest_verification(cd_db, project.id, t_code.id, leader)
    assert ver_code is not None
    assert ver_code["origin"] == "ai_code"
    assert ver_code["is_code_discovered"] is True
    assert ver_code["discovered_from"]["commit_count"] == 1
    assert ver_code["code_discovered_review_note"] is not None

    ver_planned = verification.latest_verification(cd_db, project.id, t_planned.id, leader)
    assert ver_planned is not None
    assert ver_planned["origin"] == "manual"
    assert ver_planned["is_code_discovered"] is False
    assert ver_planned["code_discovered_review_note"] is None

    # 3. Reporting facts distinguish baseline vs code-discovered tasks
    facts = reporting.collect_project_facts(cd_db, project.id, project.name)
    assert facts["counts"]["planned_task_count"] == 1
    assert facts["counts"]["code_discovered_task_count"] == 1
    assert facts["counts"]["code_discovered_weight_share"] == 0.4
    chapters = reporting.render_fallback_chapters(facts)
    assert "代码演进增补" in chapters["overview"]

    # 4. Teacher class projects card exposes expansion metrics
    cards = teacher_projects_service.list_class_projects(cd_db, teacher, world.course_id)
    assert len(cards.items) == 1
    card = cards.items[0]
    assert card.planned_task_count == 1
    assert card.code_discovered_task_count == 1
    assert card.code_discovered_weight_share == 0.4
    assert card.high_expansion_warning is True


def test_http_endpoints_smoke_code_discovery_and_tasks_origin_filter(cd_db):
    users, project, _mod, _baseline_task, _plan = _seed_team_project(
        cd_db, member_count=2, frozen_plan=True
    )
    leader, member = users
    _add_commit(
        cd_db,
        project.id,
        sha="http5001",
        title="feat(audit): add CSV audit log download",
        author=member,
        files=[{"path": "services/audit/csv_download.py", "additions": 95, "deletions": 2}],
    )
    cd_db.commit()

    current_actor = {"user": member}

    def override_session():
        yield cd_db

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_current_user] = lambda: current_actor["user"]
    try:
        client = TestClient(app)
        r_list = client.get(f"/api/v1/projects/{project.id}/plan/code-discoveries")
        assert r_list.status_code == 200
        assert r_list.json()["data"]["unmatched_commits_count"] == 1

        r_scan = client.post(
            f"/api/v1/projects/{project.id}/plan/code-discoveries",
            json={"max_commits": 20},
        )
        assert r_scan.status_code == 200
        scan_data = r_scan.json()["data"]
        assert scan_data["created_count"] == 1
        sug_id = scan_data["items"][0]["id"]

        r_adopt = client.post(
            f"/api/v1/projects/{project.id}/plan/code-discoveries/{sug_id}/adopt",
            json={"reason": "通过 HTTP 增补审计导出任务"},
            headers={"Idempotency-Key": f"adopt-{sug_id}"},
        )
        assert r_adopt.status_code == 200
        assert r_adopt.json()["data"]["adopted_immediately"] is False

        # Switch to leader and approve
        current_actor["user"] = leader
        r_approve = client.post(
            f"/api/v1/projects/{project.id}/plan/code-discoveries/{sug_id}/approve",
            json={"reason": "批准增补"},
            headers={"Idempotency-Key": f"approve-{sug_id}"},
        )
        assert r_approve.status_code == 200
        assert r_approve.json()["data"]["adopted_immediately"] is True
        new_task_id = r_approve.json()["data"]["task_id"]
        assert new_task_id is not None

        r_tasks = client.get(
            f"/api/v1/projects/{project.id}/tasks",
            params={"view": "list", "origin": "code_discovered"},
        )
        assert r_tasks.status_code == 200
        items = r_tasks.json()["data"]["items"]
        assert len(items) == 1
        assert items[0]["id"] == new_task_id
        assert items[0]["origin"] == "ai_code"
        assert items[0]["is_code_discovered"] is True
    finally:
        app.dependency_overrides.clear()
