"""Task-anchored + cross-task equal-split contribution v2 tests (PG16 + SQLite fallback)."""

from __future__ import annotations

import os
from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID, uuid4

import pytest
from sqlalchemy import JSON, DefaultClause, MetaData, create_engine, event, select, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapper, Session
from sqlalchemy.pool import StaticPool

from app.auth.models import SchoolEmailBinding
from app.db.base import Base
from app.db.models import (
    AcceptanceCriterion,
    Course,
    CourseMember,
    FunctionalModule,
    GroupMember,
    Project,
    ProjectGroup,
    ProjectMember,
    Task,
    TaskAssignee,
    User,
)
from app.modules.a.models import GithubActivity, GithubRepoLink
from app.modules.b.models import BTaskMeta
from app.modules.c.activity_models import ActivityRecordState
from app.modules.c.models import Evidence, EvidenceCriterion, EvidenceSourceSnapshot
from app.modules.d import contribution
from app.modules.d.models import (
    ContributionItem,
    ContributionItemTask,
    ContributionSnapshot,
    FormalOutcome,
    IntegrityCheck,
    VerificationRun,
)
from tests.b_fixtures import b_postgres_schema, b_test_database_url


@pytest.fixture
def d_engine(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    pg_url = os.getenv("B_TEST_DATABASE_URL") or os.getenv("DATABASE_URL")
    if pg_url:
        if pg_url.startswith("postgresql://"):
            pg_url = "postgresql+psycopg://" + pg_url.removeprefix("postgresql://")
        with b_postgres_schema(
            b_test_database_url() if os.getenv("B_TEST_DATABASE_URL") else pg_url
        ) as engine:
            yield engine
        return

    engine = create_engine(
        "sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False}
    )

    @event.listens_for(engine, "connect")
    def enforce_fk(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")
        connection.create_function("gen_random_uuid", 0, lambda: uuid4().hex)

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


def _make_user(session: Session, name: str, role: str = "student") -> User:
    suffix = uuid4().hex[:8]
    email = f"{role}.{suffix}@student.must.edu.mo"
    user = User(
        id=uuid4(),
        name=name,
        email=email,
        global_role=role,
        status="active",
    )
    session.add(user)
    session.flush()
    session.add(
        SchoolEmailBinding(
            user_id=user.id,
            school_email=email,
            school_email_normalized=email.lower(),
            verified_at=datetime.now(UTC),
        )
    )
    session.flush()
    return user


def _add_formal_task(
    session: Session,
    project: Project,
    module: FunctionalModule,
    *,
    creator: User,
    title: str,
    description: str,
    weight: Decimal,
    seq: int,
    resp_shares: dict[str, str],
) -> tuple[Task, FormalOutcome]:
    task = Task(
        id=uuid4(),
        project_id=project.id,
        module_id=module.id,
        created_by=creator.id,
        title=title,
        description=description,
        weight=float(weight),
        status="pending_verification",
        progress_percent=100,
    )
    session.add(task)
    session.flush()
    session.add(BTaskMeta(task_id=task.id, project_id=project.id, seq=seq))
    session.add(TaskAssignee(task_id=task.id, user_id=creator.id, role="responsible"))
    crit = AcceptanceCriterion(
        id=uuid4(),
        task_id=task.id,
        criterion_key=f"C-{seq}",
        text=f"Criterion for {title}",
        weight=1,
    )
    session.add(crit)
    session.flush()

    ev = Evidence(
        id=uuid4(),
        project_id=project.id,
        task_id=task.id,
        author_id=creator.id,
        title="Formal test report",
        description="End-to-end verification passed",
        source_type="manual",
        status="formal",
    )
    session.add(ev)
    session.flush()
    session.add(EvidenceCriterion(evidence_id=ev.id, criterion_id=crit.id))
    session.add(
        EvidenceSourceSnapshot(
            id=uuid4(),
            evidence_id=ev.id,
            version_no=1,
            source_identity=f"manual:{ev.id}",
            source_revision="v1",
            content_hash="a" * 64,
            content_json={"availability": "available", "source": {}},
            captured_by=creator.id,
        )
    )
    session.flush()

    check = IntegrityCheck(
        id=uuid4(),
        project_id=project.id,
        task_id=task.id,
        checked_by=creator.id,
        rule_version="effective-formal-v1",
        total_criteria=1,
        covered_criteria=1,
        coverage_rate=100,
        status="passed",
        missing_criteria_json=[],
        pending_sources=0,
        details_json=[
            {
                "criterion_id": str(crit.id),
                "criterion_version": crit.lock_version,
                "evidence": [{"id": str(ev.id), "version": ev.lock_version}],
            }
        ],
    )
    session.add(check)
    session.flush()

    run = VerificationRun(
        id=uuid4(),
        integrity_check_id=check.id,
        project_id=project.id,
        task_id=task.id,
        triggered_by=creator.id,
        task_version=task.lock_version,
        result="passed",
        status="completed",
        engine_version="deterministic-v1+ai-advice",
    )
    session.add(run)
    session.flush()

    outcome = FormalOutcome(
        id=uuid4(),
        project_id=project.id,
        task_id=task.id,
        verification_run_id=run.id,
        basis_json={
            "task_weight": str(weight),
            "responsibility_shares": resp_shares,
        },
    )
    session.add(outcome)
    task.status = "completed"
    task.lock_version += 1
    session.flush()
    return task, outcome


def _seed_project_with_formal_task(
    session: Session,
    *,
    task_title: str = "B1 支付网关模块",
    task_weight: Decimal = Decimal("40"),
    task_seq: int = 1,
    alice_share: str = "100",
    bob_share: str | None = None,
):
    teacher = _make_user(session, "王老师", role="teacher")
    alice = _make_user(session, "Alice")
    bob = _make_user(session, "Bob")
    carol = _make_user(session, "Carol")

    course = Course(
        id=uuid4(),
        owner_id=teacher.id,
        code=f"SE-{uuid4().hex[:6]}",
        name="软件工程",
        college="FIE",
        semester="2026-Fall",
        status="active",
    )
    session.add(course)
    session.flush()
    for u in (alice, bob, carol):
        session.add(
            CourseMember(
                id=uuid4(), course_id=course.id, user_id=u.id, role="student", status="active"
            )
        )

    group = ProjectGroup(id=uuid4(), course_id=course.id, leader_id=alice.id, name="Code Team")
    session.add(group)
    session.flush()
    for u in (alice, bob, carol):
        session.add(
            GroupMember(
                id=uuid4(),
                group_id=group.id,
                user_id=u.id,
                role="leader" if u.id == alice.id else "member",
            )
        )

    project = Project(
        id=uuid4(),
        course_id=course.id,
        group_id=group.id,
        name="GroupProof Test",
        lifecycle="active",
        visibility="members",
    )
    session.add(project)
    session.flush()
    for u in (alice, bob, carol):
        session.add(
            ProjectMember(
                id=uuid4(),
                project_id=project.id,
                user_id=u.id,
                role="leader" if u.id == alice.id else "member",
            )
        )

    module = FunctionalModule(
        id=uuid4(), project_id=project.id, owner_id=alice.id, name="Payment Gateway"
    )
    session.add(module)
    session.flush()

    shares = {str(alice.id): alice_share}
    if bob_share is not None:
        shares[str(bob.id)] = bob_share

    task, outcome = _add_formal_task(
        session,
        project,
        module,
        creator=alice,
        title=task_title,
        description="Implement payment gateway checkout flow",
        weight=task_weight,
        seq=task_seq,
        resp_shares=shares,
    )

    repo = GithubRepoLink(
        id=uuid4(),
        project_id=project.id,
        installation_id=999,
        owner="acme",
        repo="groupproof",
        default_branch="develop",
        linked_by_id=alice.id,
    )
    session.add(repo)
    session.commit()
    return project, module, task, outcome, repo, alice, bob, carol


def _add_commit(
    session: Session,
    project_id: UUID,
    repo_id: UUID,
    *,
    author: User,
    title: str,
    files: list[dict],
    sha: str | None = None,
    link_task_id: UUID | None = None,
    extra_detail: dict | None = None,
) -> GithubActivity:
    commit_sha = sha or uuid4().hex + "0" * 8
    detail = {
        "sha": commit_sha,
        "branch": "develop",
        "files_fetched": True,
        "files": files,
    }
    if extra_detail:
        detail.update(extra_detail)
    row = GithubActivity(
        id=uuid4(),
        project_id=project_id,
        link_id=repo_id,
        kind="commit",
        external_id=commit_sha,
        title=title,
        summary=title,
        author_login=author.name.lower(),
        author_name=author.name,
        author_email=author.email,
        author_user_id=author.id,
        detail=detail,
        revision=f"rev-{commit_sha[:8]}",
        occurred_at=datetime.now(UTC),
        deleted=False,
    )
    session.add(row)
    session.flush()
    if link_task_id is not None:
        session.add(
            ActivityRecordState(
                id=uuid4(),
                project_id=project_id,
                source_type="github",
                source_id=row.id,
                source_identity=f"commit:{commit_sha}",
                status="candidate",
                task_id=link_task_id,
            )
        )
        session.flush()
    return row


def test_no_cross_task_code_preserves_responsibility_shares_100_percent(d_engine):
    """Without cross-task contributors, confirmed responsibility shares are preserved untouched."""
    with Session(d_engine) as session:
        project, _mod, task, _outcome, repo, alice, bob, carol = _seed_project_with_formal_task(
            session,
            alice_share="70",
            bob_share="30",
        )
        # Nominal owner Alice writing code on her own task does NOT alter the 70/30 split.
        _add_commit(
            session,
            project.id,
            repo.id,
            author=alice,
            title="feat(payment): implement checkout #T-001",
            files=[{"path": "services/api/payment/checkout.py", "additions": 250, "deletions": 10}],
            link_task_id=task.id,
        )
        session.commit()

        snap = contribution.calculate(session, project.id, alice)
        assert snap["formula_version"] == "formal-task-weight-cross-task-equal-split-v2"
        assert snap["stale"] is False
        by_uid = {m["user_id"]: m for m in snap["members"]}
        assert by_uid[str(alice.id)]["share"] == pytest.approx(70.0)
        assert by_uid[str(bob.id)]["share"] == pytest.approx(30.0)
        assert by_uid[str(carol.id)]["share"] == pytest.approx(0.0)

        frozen = contribution.freeze_snapshot(session, project.id, alice)
        assert frozen["status"] == "frozen"
        assert frozen["stale"] is False


def test_cross_task_contributor_triggers_exact_equal_split_and_freeze(d_engine):
    """Cross-task helper with >= 20 lines splits task 50/50 + ContributionItemTask + freeze."""
    with Session(d_engine) as session:
        project, _mod, task, _outcome, repo, alice, bob, carol = _seed_project_with_formal_task(
            session,
            alice_share="100",
        )
        # Bob (not assigned to task T-001) commits >= 20 lines functionally matching T-001.
        _add_commit(
            session,
            project.id,
            repo.id,
            author=bob,
            title="feat(payment): implement checkout gateway #T-001",
            files=[{"path": "services/api/payment/gateway.py", "additions": 35, "deletions": 5}],
        )
        session.commit()

        snap = contribution.calculate(session, project.id, alice)
        assert snap["stale"] is False
        by_uid = {m["user_id"]: m for m in snap["members"]}
        assert by_uid[str(alice.id)]["share"] == pytest.approx(50.0)
        assert by_uid[str(bob.id)]["share"] == pytest.approx(50.0)
        assert by_uid[str(carol.id)]["share"] == pytest.approx(0.0)

        assert [t["task_id"] for t in by_uid[str(alice.id)]["tasks"]] == [str(task.id)]
        assert [t["task_id"] for t in by_uid[str(bob.id)]["tasks"]] == [str(task.id)]
        assert by_uid[str(bob.id)]["tasks"][0]["responsibility_share"] == pytest.approx(50.0)

        db_snap = session.get(ContributionSnapshot, UUID(snap["id"]))
        items = session.scalars(
            select(ContributionItem).where(ContributionItem.snapshot_id == db_snap.id)
        ).all()
        assert sum((item.share for item in items), Decimal()) == Decimal("100.0000")
        task_link_count = len(
            session.scalars(
                select(ContributionItemTask).where(
                    ContributionItemTask.contribution_item_id.in_([i.id for i in items])
                )
            ).all()
        )
        assert task_link_count == 2

        frozen = contribution.freeze_snapshot(session, project.id, alice)
        assert frozen["status"] == "frozen"
        assert frozen["stale"] is False
        assert contribution.current_frozen_snapshot(session, project.id) is not None


def test_tiny_typo_lockfile_and_merge_commits_do_not_trigger_cross_task_split(d_engine):
    """< 20-line typo edits, pure lockfiles, and merge commits must not split someone's task."""
    with Session(d_engine) as session:
        project, _mod, task, _outcome, repo, alice, bob, carol = _seed_project_with_formal_task(
            session,
            alice_share="100",
        )
        # Bob: tiny 5-line typo fix (below 20-line heuristic threshold) + huge lockfile + merge.
        _add_commit(
            session,
            project.id,
            repo.id,
            author=bob,
            title="fix(payment): typo in comment #T-001",
            files=[{"path": "services/api/payment/gateway.py", "additions": 3, "deletions": 2}],
        )
        _add_commit(
            session,
            project.id,
            repo.id,
            author=bob,
            title="chore: update lockfiles #T-001",
            files=[
                {"path": "package-lock.json", "additions": 120000, "deletions": 50000},
                {"path": "pnpm-lock.yaml", "additions": 20000, "deletions": 10000},
                {"path": "packages/domain/api.generated.ts", "additions": 15000, "deletions": 5000},
                {"path": "public/bundle.min.js", "additions": 5000, "deletions": 0},
                {"path": "services/api/uv.lock", "additions": 3000, "deletions": 1000},
            ],
            link_task_id=task.id,
        )
        _add_commit(
            session,
            project.id,
            repo.id,
            author=carol,
            title="Merge branch 'develop' into main",
            files=[{"path": "services/api/payment/gateway.py", "additions": 500, "deletions": 0}],
            link_task_id=task.id,
            extra_detail={"parents": ["aaa", "bbb"]},
        )
        session.commit()

        snap = contribution.calculate(session, project.id, alice)
        by_uid = {m["user_id"]: m for m in snap["members"]}
        assert by_uid[str(alice.id)]["share"] == pytest.approx(100.0)
        assert by_uid[str(bob.id)]["share"] == pytest.approx(0.0)
        assert by_uid[str(carol.id)]["share"] == pytest.approx(0.0)


def test_verbose_5000_lines_and_concise_50_lines_yield_same_equal_split(d_engine):
    """5000-line verbose code vs 50-line concise code both produce exact 50/50 (0 line gaming)."""
    with Session(d_engine) as session:
        # Task 1 (weight 10): Alice assigned 100%, Bob contributes concise 50 lines -> 50/50.
        project, module, task1, _o1, repo, alice, bob, carol = _seed_project_with_formal_task(
            session,
            task_title="核心算法任务",
            task_weight=Decimal("10"),
            task_seq=1,
            alice_share="100",
        )
        # Task 2 (weight 10): Alice assigned 100%, Carol contributes verbose 5000 lines -> 50/50.
        task2, _o2 = _add_formal_task(
            session,
            project,
            module,
            creator=alice,
            title="配置管理任务",
            description="Config helper",
            weight=Decimal("10"),
            seq=2,
            resp_shares={str(alice.id): "100"},
        )
        _add_commit(
            session,
            project.id,
            repo.id,
            author=bob,
            title="feat: concise algorithm helper #T-001",
            files=[{"path": "services/api/core/algo.py", "additions": 50, "deletions": 0}],
            link_task_id=task1.id,
        )
        _add_commit(
            session,
            project.id,
            repo.id,
            author=carol,
            title="feat: verbose config generator #T-002",
            files=[{"path": "services/api/config/gen.py", "additions": 5000, "deletions": 0}],
            link_task_id=task2.id,
        )
        session.commit()

        snap = contribution.calculate(session, project.id, alice)
        by_uid = {m["user_id"]: m for m in snap["members"]}
        # Alice: 5 + 5 = 10 credits (50%), Bob: 5 credits (25%), Carol: 5 credits (25%).
        assert by_uid[str(alice.id)]["task_credit"] == pytest.approx(10.0)
        assert by_uid[str(bob.id)]["task_credit"] == pytest.approx(5.0)
        assert by_uid[str(carol.id)]["task_credit"] == pytest.approx(5.0)
        assert by_uid[str(bob.id)]["share"] == pytest.approx(by_uid[str(carol.id)]["share"])
        assert by_uid[str(alice.id)]["share"] == pytest.approx(50.0)
        assert by_uid[str(bob.id)]["share"] == pytest.approx(25.0)
        assert by_uid[str(carol.id)]["share"] == pytest.approx(25.0)


def test_generic_monorepo_commits_do_not_falsely_split_unrelated_tasks(d_engine):
    """Generic shared-path commits with stopword tokens must not pull outsiders into tasks."""
    with Session(d_engine) as session:
        project, module, _task_a2, _o1, repo, alice, bob, carol = _seed_project_with_formal_task(
            session,
            task_title="A2 后端核心底座、数据库迁移与异步任务",
            task_weight=Decimal("50"),
            task_seq=1,
            alice_share="100",
        )
        _add_formal_task(
            session,
            project,
            module,
            creator=carol,
            title="D6 教师端工作台、课程规则模板与结课归档",
            description="Teacher workbench course rule template and archive",
            weight=Decimal("50"),
            seq=2,
            resp_shares={str(carol.id): "100"},
        )
        # Bob makes broad generic commits touching monorepo stopwords only.
        _add_commit(
            session,
            project.id,
            repo.id,
            author=bob,
            title="fix(api): refactor shared models, router, and page panel view",
            files=[
                {"path": "services/api/app/models.py", "additions": 180, "deletions": 40},
                {"path": "services/api/app/router.py", "additions": 90, "deletions": 20},
                {"path": "shared/components/panel.tsx", "additions": 110, "deletions": 15},
            ],
        )
        session.commit()

        snap = contribution.calculate(session, project.id, alice)
        by_uid = {m["user_id"]: m for m in snap["members"]}
        assert by_uid[str(alice.id)]["share"] == pytest.approx(50.0)
        assert by_uid[str(carol.id)]["share"] == pytest.approx(50.0)
        assert by_uid[str(bob.id)]["share"] == pytest.approx(0.0)


def test_minor_incidental_edit_does_not_split_while_substantive_cross_task_does(d_engine):
    """A 25-line edit on a 2000-line task does not split; >=80 lines & >=15% does split 50/50."""
    with Session(d_engine) as session:
        project, _module, task, _o1, repo, alice, bob, carol = _seed_project_with_formal_task(
            session,
            task_title="B3 支付网关结算与对账流程",
            task_weight=Decimal("100"),
            task_seq=1,
            alice_share="100",
        )
        # Alice writes 2000 effective lines on her own task.
        _add_commit(
            session,
            project.id,
            repo.id,
            author=alice,
            title="feat(payment): implement gateway settlement and reconciliation engine",
            files=[
                {
                    "path": "services/api/payment/gateway_settlement.py",
                    "additions": 1950,
                    "deletions": 50,
                }
            ],
            link_task_id=task.id,
        )
        # Bob makes a tiny 25-line incidental edit (even directly linked: 25/2025 = 1.2% < 10%).
        _add_commit(
            session,
            project.id,
            repo.id,
            author=bob,
            title="fix(payment): tweak gateway timeout constant",
            files=[
                {
                    "path": "services/api/payment/gateway_settlement.py",
                    "additions": 15,
                    "deletions": 10,
                }
            ],
            link_task_id=task.id,
        )
        session.commit()

        snap_before = contribution.calculate(session, project.id, alice)
        by_uid_before = {m["user_id"]: m for m in snap_before["members"]}
        assert by_uid_before[str(alice.id)]["share"] == pytest.approx(100.0)
        assert by_uid_before[str(bob.id)]["share"] == pytest.approx(0.0)
        assert by_uid_before[str(carol.id)]["share"] == pytest.approx(0.0)

        # Carol contributes a substantive cross-task heuristic commit (450 lines, ~18.2% >= 15%).
        _add_commit(
            session,
            project.id,
            repo.id,
            author=carol,
            title="feat(payment): build gateway checkout refund and settlement pipeline",
            files=[
                {
                    "path": "services/api/payment/gateway/checkout.py",
                    "additions": 410,
                    "deletions": 40,
                }
            ],
        )
        session.commit()

        snap_after = contribution.calculate(session, project.id, alice)
        by_uid_after = {m["user_id"]: m for m in snap_after["members"]}
        assert by_uid_after[str(alice.id)]["share"] == pytest.approx(50.0)
        assert by_uid_after[str(carol.id)]["share"] == pytest.approx(50.0)
        assert by_uid_after[str(bob.id)]["share"] == pytest.approx(0.0)


def test_explicit_task_prefix_code_matches_only_named_task(d_engine):
    """A commit naming C6 in its title splits only C6 and never bleeds into other tasks."""
    with Session(d_engine) as session:
        project, module, _task_a2, _o1, repo, alice, bob, carol = _seed_project_with_formal_task(
            session,
            task_title="A2 后端核心底座",
            task_weight=Decimal("50"),
            task_seq=1,
            alice_share="100",
        )
        _add_formal_task(
            session,
            project,
            module,
            creator=carol,
            title="C6 项目讨论区与提及解析",
            description="Discussion mentions and replies",
            weight=Decimal("50"),
            seq=2,
            resp_shares={str(carol.id): "100"},
        )
        _add_commit(
            session,
            project.id,
            repo.id,
            author=bob,
            title="feat(C6): add discussion mention parser and reply threading",
            files=[
                {"path": "services/api/discussions/mentions.py", "additions": 45, "deletions": 0}
            ],
        )
        session.commit()

        snap = contribution.calculate(session, project.id, alice)
        by_uid = {m["user_id"]: m for m in snap["members"]}
        # Alice keeps 100% of A2 (50 -> 50%); Carol & Bob split C6 50/50 (25 each -> 25%).
        assert by_uid[str(alice.id)]["share"] == pytest.approx(50.0)
        assert by_uid[str(carol.id)]["share"] == pytest.approx(25.0)
        assert by_uid[str(bob.id)]["share"] == pytest.approx(25.0)
