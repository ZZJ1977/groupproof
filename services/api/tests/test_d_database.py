"""Persistence tests for D acceptance, contribution and report history."""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from sqlalchemy import JSON, MetaData, create_engine, event, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.api.errors import ApiError
from app.db.base import Base
from app.db.models import (
    AcceptanceCriterion,
    Course,
    FunctionalModule,
    Milestone,
    Project,
    ProjectMember,
    Task,
    TaskAssignee,
    User,
)
from app.modules.c.models import Evidence, EvidenceCriterion, EvidenceSourceSnapshot
from app.modules.d import (
    acceptance,
    contribution,
    contribution_week7,
    integrity,
    report_tasks,
    reporting,
    risk_checks,
    teacher_overview,
    verification,
)
from app.modules.d.models import (
    AcceptanceDecision,
    ContributionAppeal,
    ContributionArchive,
    ContributionCalculation,
    ContributionItem,
    ContributionItemTask,
    ContributionSnapshot,
    CriterionResult,
    FormalOutcome,
    IntegrityCheck,
    Report,
    ReportArtifact,
    ReportDownloadLink,
    ReportReview,
    ReportSnapshot,
    Risk,
    VerificationRun,
)


@pytest.fixture()
def db():
    engine = create_engine(
        "sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False}
    )

    @event.listens_for(engine, "connect")
    def enforce_foreign_keys(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")

    metadata = MetaData()
    names = {
        "users",
        "courses",
        "course_staff",
        "groups",
        "projects",
        "functional_modules",
        "tasks",
        "milestones",
        "project_members",
        "task_milestones",
        "progress_events",
        "task_assignees",
        "acceptance_criteria",
        "source_references",
        "evidence",
        "evidence_criteria",
        "evidence_source_snapshots",
        "baseline_versions",
        "plan_versions",
        "integrity_checks",
        "verification_runs",
        "criterion_results",
        "acceptance_decisions",
        "formal_outcomes",
        "contribution_calculations",
        "contribution_snapshots",
        "contribution_items",
        "contribution_item_tasks",
        "collaboration_notes",
        "contribution_appeals",
        "appeal_decisions",
        "contribution_archives",
        "reports",
        "report_snapshots",
        "report_artifacts",
        "report_download_links",
        "report_downloads",
        "report_reviews",
        "risks",
        "risk_events",
    }
    for table in Base.metadata.sorted_tables:
        if table.name not in names:
            continue
        portable = table.to_metadata(metadata)
        for column in portable.columns:
            if isinstance(column.type, JSONB):
                column.type = JSON()
            if (
                column.server_default is not None
                and str(column.server_default.arg) == "gen_random_uuid()"
            ):
                column.server_default = None
    metadata.create_all(engine)

    with engine.connect() as connection:
        transaction = connection.begin()
        session = Session(
            connection, expire_on_commit=False, join_transaction_mode="create_savepoint"
        )
        try:
            yield session
        finally:
            session.close()
            transaction.rollback()
    engine.dispose()


@pytest.fixture()
def scope(db):
    user_id = uuid4()
    user = User(
        id=user_id,
        name="D tester",
        username=f"d-{user_id}",
        email=f"{user_id}@example.test",
        college="Test",
        global_role="student",
        status="active",
    )
    course = Course(
        id=uuid4(),
        owner_id=user.id,
        code=str(uuid4()),
        name="D course",
        college="Test",
        semester="2026",
        status="active",
    )
    project = Project(
        id=uuid4(),
        course_id=course.id,
        name="D project",
        lifecycle="active",
        setup_status="frozen",
    )
    module = FunctionalModule(id=uuid4(), project_id=project.id, name="Main")
    task = Task(id=uuid4(), project_id=project.id, module_id=module.id, title="Verify")
    criterion = AcceptanceCriterion(
        id=uuid4(), task_id=task.id, criterion_key="AC1", text="The result is reproducible."
    )
    db.add(user)
    db.flush()
    db.add(course)
    db.flush()
    db.add(project)
    db.flush()
    db.add(module)
    db.flush()
    db.add(task)
    db.flush()
    db.add(criterion)
    db.flush()
    return SimpleNamespace(
        user=user, course=course, project=project, task=task, criterion=criterion
    )


def test_d1_check_excludes_withdrawn_and_unavailable_sources(db, scope, monkeypatch):
    monkeypatch.setattr(
        integrity,
        "get_project_access",
        lambda *args, **kwargs: SimpleNamespace(
            member=True,
            project=scope.project,
            course=scope.course,
            latest_plan=SimpleNamespace(
                status="frozen", snapshot_json={"tasks": [str(scope.task.id)]}
            ),
        ),
    )
    evidence = Evidence(
        id=uuid4(),
        project_id=scope.project.id,
        task_id=scope.task.id,
        author_id=scope.user.id,
        title="Formal file",
        description="Evidence",
        source_type="file",
        status="formal",
        source_changed=False,
    )
    db.add(evidence)
    db.flush()
    db.add(EvidenceCriterion(evidence_id=evidence.id, criterion_id=scope.criterion.id))
    snapshot = EvidenceSourceSnapshot(
        id=uuid4(),
        evidence_id=evidence.id,
        version_no=1,
        source_identity="file-1",
        source_revision="v1",
        content_hash="a" * 64,
        content_json={"availability": "available", "source": {}},
        captured_by=scope.user.id,
    )
    db.add(snapshot)
    db.flush()
    first = integrity.run_check(db, scope.project.id, scope.task.id, scope.user)
    assert (first["covered_criteria"], first["status"]) == (1, "passed")
    provider = integrity.AcceptanceTransitionProvider(db, UUID(first["id"]))
    transition_scope = SimpleNamespace(task=scope.task, project=scope.project)
    provider.authorize(transition_scope, scope.user, "pending_verification", "check")
    snapshot.content_json = {"availability": "unavailable", "source": {}}
    db.commit()
    with pytest.raises(ApiError) as stale:
        provider.authorize(transition_scope, scope.user, "pending_verification", "check")
    assert stale.value.code == "STALE_INTEGRITY_CHECK"
    second = integrity.run_check(db, scope.project.id, scope.task.id, scope.user)
    assert (second["covered_criteria"], second["status"]) == (0, "incomplete")
    assert second["details"][0]["evidence"] == []
    snapshot.content_json = {"availability": "available", "source": {}}
    evidence.status = "withdrawn"
    db.commit()
    third = integrity.run_check(db, scope.project.id, scope.task.id, scope.user)
    assert third["covered_criteria"] == 0


def test_d1_check_rejects_non_member(db, scope, monkeypatch):
    monkeypatch.setattr(
        integrity,
        "get_project_access",
        lambda *args, **kwargs: SimpleNamespace(
            member=False,
            project=scope.project,
            course=scope.course,
            latest_plan=SimpleNamespace(
                status="frozen", snapshot_json={"tasks": [str(scope.task.id)]}
            ),
        ),
    )
    with pytest.raises(ApiError) as denied:
        integrity.run_check(db, scope.project.id, scope.task.id, scope.user)
    assert denied.value.status_code == 403


def test_d1_verification_keeps_deterministic_result_when_ai_unavailable(db, scope, monkeypatch):
    access = SimpleNamespace(
        member=True,
        project=scope.project,
        course=scope.course,
        latest_plan=SimpleNamespace(status="frozen", snapshot_json={"tasks": [str(scope.task.id)]}),
    )
    monkeypatch.setattr(integrity, "get_project_access", lambda *args, **kwargs: access)
    monkeypatch.setattr(verification, "get_project_access", lambda *args, **kwargs: access)
    monkeypatch.setattr(
        verification,
        "match_evidence",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            ApiError(503, "AI_UNAVAILABLE", "Unavailable")
        ),
    )
    scope.task.status = "pending_verification"
    item = Evidence(
        id=uuid4(),
        project_id=scope.project.id,
        task_id=scope.task.id,
        author_id=scope.user.id,
        title="Merged PR",
        description="Verified work",
        source_type="github",
        status="formal",
        source_changed=False,
    )
    db.add(item)
    db.flush()
    db.add(EvidenceCriterion(evidence_id=item.id, criterion_id=scope.criterion.id))
    db.add(
        EvidenceSourceSnapshot(
            id=uuid4(),
            evidence_id=item.id,
            version_no=1,
            source_identity="pr-1",
            source_revision="v1",
            content_hash="b" * 64,
            content_json={
                "availability": "available",
                "source": {"kind": "pull_request", "state": "merged"},
            },
            captured_by=scope.user.id,
        )
    )
    db.commit()
    result = verification.run_verification(db, scope.project.id, scope.task.id, scope.user)
    assert result["result"] == "passed"
    assert result["criteria"][0]["result"] == "passed"
    assert result["criteria"][0]["evidence"][0]["id"] == str(item.id)
    assert "AI 暂不可用" in result["criteria"][0]["reason"]


def test_integrity_checks_keep_each_historical_result(db, scope):
    first = IntegrityCheck(
        id=uuid4(),
        project_id=scope.project.id,
        task_id=scope.task.id,
        checked_by=scope.user.id,
        rule_version="d1-v1",
        total_criteria=4,
        covered_criteria=3,
        coverage_rate=75,
        status="incomplete",
        missing_criteria_json=["AC4"],
    )
    second = IntegrityCheck(
        id=uuid4(),
        project_id=scope.project.id,
        task_id=scope.task.id,
        checked_by=scope.user.id,
        rule_version="d1-v2",
        total_criteria=4,
        covered_criteria=4,
        coverage_rate=100,
        status="passed",
        missing_criteria_json=[],
    )
    db.add_all([first, second])
    db.flush()

    rows = db.scalars(select(IntegrityCheck).order_by(IntegrityCheck.rule_version)).all()
    assert [(row.rule_version, row.covered_criteria, float(row.coverage_rate)) for row in rows] == [
        ("d1-v1", 3, 75.0),
        ("d1-v2", 4, 100.0),
    ]


def test_history_constraints_reject_inconsistent_inputs(db, scope):
    with pytest.raises(IntegrityError):
        with db.begin_nested():
            db.add(
                IntegrityCheck(
                    id=uuid4(),
                    project_id=scope.project.id,
                    task_id=scope.task.id,
                    checked_by=scope.user.id,
                    rule_version="d1-v1",
                    total_criteria=4,
                    covered_criteria=3,
                    coverage_rate=90,
                )
            )
            db.flush()

    with pytest.raises(IntegrityError):
        with db.begin_nested():
            db.add(
                ContributionCalculation(
                    id=uuid4(),
                    project_id=scope.project.id,
                    formula_version="formula-1",
                    basis_version=" ",
                    calculated_by=scope.user.id,
                )
            )
            db.flush()


def test_invalidated_criterion_result_remains_auditable(db, scope):
    run = VerificationRun(
        id=uuid4(),
        project_id=scope.project.id,
        task_id=scope.task.id,
        triggered_by=scope.user.id,
        result="passed",
        status="completed",
        engine_version="engine-1",
    )
    result = CriterionResult(
        id=uuid4(),
        verification_run_id=run.id,
        criterion_id=scope.criterion.id,
        result="passed",
        confidence=0.98,
        reason="Evidence matched the criterion.",
    )
    db.add(run)
    db.flush()
    db.add(result)
    db.flush()

    result.invalidated_at = datetime.now(UTC)
    result.invalidated_by = scope.user.id
    result.invalidated_reason = "Superseded by a later evidence review."
    db.flush()

    stored = db.scalar(select(CriterionResult).where(CriterionResult.id == result.id))
    assert stored is not None
    assert stored.result == "passed"
    assert stored.invalidated_reason == "Superseded by a later evidence review."
    assert (
        db.scalars(
            select(CriterionResult).where(
                CriterionResult.criterion_id == scope.criterion.id,
                CriterionResult.invalidated_at.is_(None),
            )
        ).all()
        == []
    )


def test_contribution_calculations_and_snapshots_are_versioned(db, scope):
    first_calculation = ContributionCalculation(
        id=uuid4(),
        project_id=scope.project.id,
        formula_version="formula-1",
        basis_version="baseline-1",
        calculated_by=scope.user.id,
        input_hash="hash-1",
    )
    second_calculation = ContributionCalculation(
        id=uuid4(),
        project_id=scope.project.id,
        formula_version="formula-2",
        basis_snapshot_id=uuid4(),
        calculated_by=scope.user.id,
        input_hash="hash-2",
    )
    db.add_all([first_calculation, second_calculation])
    db.flush()
    first_snapshot = ContributionSnapshot(
        id=uuid4(),
        project_id=scope.project.id,
        calculation_id=first_calculation.id,
        version_no=1,
        status="frozen",
        created_by=scope.user.id,
        frozen_at=datetime.now(UTC),
    )
    second_snapshot = ContributionSnapshot(
        id=uuid4(),
        project_id=scope.project.id,
        calculation_id=second_calculation.id,
        version_no=2,
        status="frozen",
        created_by=scope.user.id,
        frozen_at=datetime.now(UTC),
    )
    db.add_all([first_snapshot, second_snapshot])
    db.flush()
    item = ContributionItem(
        id=uuid4(),
        snapshot_id=second_snapshot.id,
        user_id=scope.user.id,
        task_credit=8,
        collaboration_credit=2,
        share=100,
        acceptance_rate=100,
    )
    db.add(item)
    db.flush()
    db.add(ContributionItemTask(contribution_item_id=item.id, task_id=scope.task.id, ratio=100))
    db.flush()

    calculations = db.scalars(
        select(ContributionCalculation).order_by(ContributionCalculation.formula_version)
    ).all()
    assert [(row.formula_version, row.input_hash) for row in calculations] == [
        ("formula-1", "hash-1"),
        ("formula-2", "hash-2"),
    ]
    assert (
        db.scalar(
            select(ContributionSnapshot.version_no).where(
                ContributionSnapshot.id == second_snapshot.id
            )
        )
        == 2
    )
    assert db.scalar(select(ContributionItemTask.ratio)) == 100


def test_report_snapshot_freezes_render_input(db, scope):
    report = Report(id=uuid4(), project_id=scope.project.id, created_by=scope.user.id)
    source = {"project_name": "D project", "criteria": ["AC1"]}
    snapshot = ReportSnapshot(
        id=uuid4(),
        report_id=report.id,
        version_no=1,
        status="generated",
        data_snapshot=source,
    )
    db.add_all([report, snapshot])
    db.flush()

    source["project_name"] = "mutated after generation"
    db.expire(snapshot, ["data_snapshot"])
    assert snapshot.data_snapshot == {"project_name": "D project", "criteria": ["AC1"]}
    assert snapshot.snapshot_created_at is not None


def test_human_acceptance_requires_every_responsible_and_real_shares(db, scope, monkeypatch):
    second = User(
        id=uuid4(),
        name="Second responsible",
        username=f"d-{uuid4()}",
        email=f"{uuid4()}@example.test",
        college="Test",
        global_role="student",
        status="active",
    )
    db.add(second)
    db.flush()
    db.flush()
    db.add_all(
        [
            TaskAssignee(task_id=scope.task.id, user_id=scope.user.id, role="responsible"),
            TaskAssignee(task_id=scope.task.id, user_id=second.id, role="responsible"),
        ]
    )
    evidence = Evidence(
        project_id=scope.project.id,
        task_id=scope.task.id,
        author_id=scope.user.id,
        title="Formal evidence",
        description="Recorded source",
        source_type="manual",
        status="formal",
        source_changed=False,
    )
    db.add(evidence)
    db.flush()
    db.add(EvidenceCriterion(evidence_id=evidence.id, criterion_id=scope.criterion.id))
    db.add(
        EvidenceSourceSnapshot(
            evidence_id=evidence.id,
            version_no=1,
            source_identity="manual-record",
            source_revision="v1",
            content_hash="a" * 64,
            content_json={"availability": "available", "source": {}},
            captured_by=scope.user.id,
        )
    )
    db.flush()
    check = IntegrityCheck(
        project_id=scope.project.id,
        task_id=scope.task.id,
        checked_by=scope.user.id,
        rule_version="effective-formal-v1",
        total_criteria=1,
        covered_criteria=1,
        coverage_rate=100,
        status="passed",
        missing_criteria_json=[],
        pending_sources=0,
        details_json=[
            {
                "criterion_id": str(scope.criterion.id),
                "criterion_version": scope.criterion.lock_version,
                "evidence": [{"id": str(evidence.id), "version": evidence.lock_version}],
            }
        ],
    )
    db.add(check)
    db.flush()
    run = VerificationRun(
        integrity_check_id=check.id,
        project_id=scope.project.id,
        task_id=scope.task.id,
        triggered_by=scope.user.id,
        task_version=scope.task.lock_version,
        result="uncertain",
        status="completed",
        engine_version="deterministic-v1+ai-advice",
    )
    db.add(run)
    db.flush()
    transition_scope = SimpleNamespace(task=scope.task, project=scope.project)
    provider = acceptance.HumanTransitionProvider(db, run.id, "confirmed")
    db.add(
        AcceptanceDecision(
            verification_run_id=run.id,
            actor_id=scope.user.id,
            revision_no=1,
            decision="confirmed",
            responsibility_share=60,
            reason="Reviewed evidence",
        )
    )
    db.flush()
    with pytest.raises(ApiError) as missing:
        provider.authorize(transition_scope, scope.user, "completed", "confirm")
    assert missing.value.code == "CONFIRMATIONS_MISSING"
    db.add(
        AcceptanceDecision(
            verification_run_id=run.id,
            actor_id=second.id,
            revision_no=1,
            decision="confirmed",
            responsibility_share=30,
            reason="Reviewed evidence",
        )
    )
    db.flush()
    with pytest.raises(ApiError) as incomplete:
        provider.authorize(transition_scope, scope.user, "completed", "confirm")
    assert incomplete.value.code == "SHARES_INCOMPLETE"
    db.add(
        AcceptanceDecision(
            verification_run_id=run.id,
            actor_id=second.id,
            revision_no=2,
            decision="confirmed",
            responsibility_share=40,
            reason="Corrected actual share",
        )
    )
    db.flush()
    provider.authorize(transition_scope, scope.user, "completed", "confirm")
    db.flush()
    outcome = db.scalar(select(FormalOutcome).where(FormalOutcome.verification_run_id == run.id))
    assert outcome.basis_json["responsibility_shares"] == {
        str(scope.user.id): "60.0000",
        str(second.id): "40.0000",
    }
    scope.task.status = "completed"
    scope.task.lock_version += 1
    db.flush()
    monkeypatch.setattr(
        contribution,
        "get_project_access",
        lambda *a, **k: SimpleNamespace(leader=True, teacher=False, staff=False),
    )
    result = contribution.calculate(db, scope.project.id, scope.user)
    assert result["stale"] is False
    assert sum(item["share"] for item in result["members"]) == 100
    assert all(
        item["tasks"][0]["formal_outcome_id"] == str(outcome.id) for item in result["members"]
    )
    assert sorted(item["share"] for item in result["members"]) == [40, 60]
    acceptance.invalidate_for_task(db, scope.task.id, scope.user.id, "source changed")
    db.flush()
    assert outcome.invalidated_at is not None
    assert contribution.latest_snapshot(db, scope.project.id, scope.user)["stale"] is True


def test_report_submission_return_and_teacher_finalization(db, scope, monkeypatch):
    from app.modules.d.report_tasks import generate_preview

    monkeypatch.setattr(generate_preview, "delay", lambda *_: None)
    access = SimpleNamespace(leader=True, teacher=False, project=scope.project)
    monkeypatch.setattr(reporting, "get_project_access", lambda *a, **k: access)
    request = SimpleNamespace(state=SimpleNamespace(request_id="d-report-test"))
    generated = reporting.refresh_report(
        scope.project.id, reporting.RefreshInput(), request, db, scope.user
    )
    assert generated.data["version"] == 1
    assert generated.data["status"] == "generating"
    snapshot = db.scalar(
        select(ReportSnapshot).where(
            ReportSnapshot.report_id
            == db.scalar(select(Report.id).where(Report.project_id == scope.project.id))
        )
    )
    snapshot.data_snapshot = reporting.snapshot_data(
        db, scope.project.id, scope.project.name, False
    )
    snapshot.status = "generated"
    db.scalar(select(Report).where(Report.project_id == scope.project.id)).status = "generated"
    db.commit()
    assert snapshot.data_snapshot["counts"]["tasks"] == 1
    reporting.submit_report(scope.project.id, request, db, scope.user)
    assert (
        db.scalar(select(Report).where(Report.project_id == scope.project.id)).status == "submitted"
    )
    with pytest.raises(ApiError):
        reporting.edit_section(
            scope.project.id,
            reporting.EditSection(section="overview", body="Changed", expected_version=1),
            request,
            db,
            scope.user,
        )
    access.teacher = True
    reporting.review_report(
        scope.project.id,
        reporting.ReviewInput(action="return", reason="Add detail"),
        request,
        db,
        scope.user,
    )
    assert (
        db.scalar(select(Report).where(Report.project_id == scope.project.id)).status == "returned"
    )
    reporting.edit_section(
        scope.project.id,
        reporting.EditSection(section="overview", body="Updated", expected_version=1),
        request,
        db,
        scope.user,
    )
    access.teacher = False
    reporting.submit_report(scope.project.id, request, db, scope.user)
    access.teacher = True
    reporting.review_report(
        scope.project.id,
        reporting.ReviewInput(action="approve", reason="Approved"),
        request,
        db,
        scope.user,
    )
    report = db.scalar(select(Report).where(Report.project_id == scope.project.id))
    assert report.status == "finalized"
    assert [
        row.action for row in db.scalars(select(ReportReview).order_by(ReportReview.created_at))
    ] == ["submitted", "returned", "submitted", "finalized"]
    assert db.scalar(select(ReportArtifact).where(ReportArtifact.id == uuid4())) is None


def test_daily_milestone_risk_is_idempotent(db, scope):
    db.add(
        ProjectMember(id=uuid4(), project_id=scope.project.id, user_id=scope.user.id, role="leader")
    )
    db.add(
        Milestone(
            id=uuid4(),
            project_id=scope.project.id,
            title="Late",
            deadline=datetime(2026, 1, 1, tzinfo=UTC),
            status="in_progress",
            progress_percent=25,
        )
    )
    db.flush()
    now = datetime(2026, 1, 10, tzinfo=UTC)
    assert risk_checks.run_daily_risk_checks(db, now) == 1
    assert risk_checks.run_daily_risk_checks(db, now) == 0
    assert db.scalar(select(Risk).where(Risk.project_id == scope.project.id)).level == "high"


def test_seven_day_member_submission_risk_uses_evidence_activity(db, scope):
    db.add(
        ProjectMember(id=uuid4(), project_id=scope.project.id, user_id=scope.user.id, role="leader")
    )
    db.add(
        TaskAssignee(
            task_id=scope.task.id,
            user_id=scope.user.id,
            assigned_at=datetime(2026, 1, 1, tzinfo=UTC),
        )
    )
    db.flush()
    now = datetime(2026, 1, 10, tzinfo=UTC)
    assert risk_checks.run_daily_risk_checks(db, now) == 1
    assert risk_checks.run_daily_risk_checks(db, now) == 0
    db.add(
        Evidence(
            id=uuid4(),
            project_id=scope.project.id,
            task_id=scope.task.id,
            author_id=scope.user.id,
            title="New evidence",
            description="Recent",
            source_type="manual",
            status="candidate",
            created_at=datetime(2026, 1, 9, tzinfo=UTC),
        )
    )
    db.commit()
    # New evidence prevents another inactivity risk after the old one is closed.
    risk = db.scalar(select(Risk).where(Risk.project_id == scope.project.id))
    risk.status = "closed"
    db.commit()
    assert risk_checks.run_daily_risk_checks(db, now) == 0


def test_report_worker_persists_real_pdf_and_status(db, scope, monkeypatch):
    report = Report(
        id=uuid4(), project_id=scope.project.id, created_by=scope.user.id, status="generated"
    )
    db.add(report)
    db.flush()
    snapshot = ReportSnapshot(
        id=uuid4(),
        report_id=report.id,
        created_by=scope.user.id,
        version_no=1,
        status="generated",
        data_snapshot={"project_name": scope.project.name, "sections": {"overview": "Real report"}},
    )
    db.add(snapshot)
    db.flush()
    artifact = ReportArtifact(
        id=uuid4(),
        snapshot_id=snapshot.id,
        requested_by=scope.user.id,
        file_format="pdf",
        status="pending",
    )
    db.add(artifact)
    db.commit()
    monkeypatch.setattr(
        report_tasks,
        "SessionLocal",
        lambda: Session(
            db.connection(), expire_on_commit=False, join_transaction_mode="create_savepoint"
        ),
    )
    report_tasks.generate_export.run(str(artifact.id))
    db.expire_all()
    stored = db.get(ReportArtifact, artifact.id)
    assert stored.status == "ready"
    assert stored.content.startswith(b"%PDF-")


def test_preview_worker_freezes_one_report_snapshot(db, scope, monkeypatch):
    report = Report(
        id=uuid4(), project_id=scope.project.id, created_by=scope.user.id, status="generating"
    )
    db.add(report)
    db.flush()
    snapshot = ReportSnapshot(
        id=uuid4(),
        report_id=report.id,
        created_by=scope.user.id,
        version_no=1,
        status="generating",
        data_snapshot={},
    )
    db.add(snapshot)
    db.commit()
    monkeypatch.setattr(
        report_tasks,
        "SessionLocal",
        lambda: Session(
            db.connection(), expire_on_commit=False, join_transaction_mode="create_savepoint"
        ),
    )
    report_tasks.generate_preview.run(str(snapshot.id), False)
    db.expire_all()
    stored = db.get(ReportSnapshot, snapshot.id)
    assert stored.status == "generated"
    assert stored.data_snapshot["counts"]["tasks"] == 1
    assert db.get(Report, report.id).status == "generated"


def test_teacher_overview_uses_same_risk_count_and_course_authorization(db, scope):
    scope.user.global_role = "teacher"
    db.add(
        Risk(
            id=uuid4(),
            project_id=scope.project.id,
            task_id=scope.task.id,
            owner_id=scope.user.id,
            title="Late",
            description="Late task",
            level="high",
            status="open",
        )
    )
    db.commit()
    request = SimpleNamespace(state=SimpleNamespace(request_id="teacher-test"))
    result = teacher_overview.teacher_overview(scope.course.id, request, db, scope.user)
    assert result.data["projects"][0]["risks"] == {"total": 1, "high": 1, "medium": 0, "low": 0}
    outsider = User(
        id=uuid4(),
        name="Other",
        username=f"other-{uuid4()}",
        email=f"{uuid4()}@example.test",
        college="Test",
        global_role="teacher",
        status="active",
    )
    db.add(outsider)
    db.commit()
    with pytest.raises(ApiError) as denied:
        teacher_overview.teacher_overview(scope.course.id, request, db, outsider)
    assert denied.value.status_code == 403


def test_report_restore_creates_new_version_and_download_link_expires(db, scope, monkeypatch):
    access = SimpleNamespace(leader=True, teacher=False, project=scope.project)
    monkeypatch.setattr(reporting, "get_project_access", lambda *a, **k: access)
    request = SimpleNamespace(state=SimpleNamespace(request_id="report-link-test"))
    report = Report(project_id=scope.project.id, created_by=scope.user.id, status="generated")
    db.add(report)
    db.flush()
    original = ReportSnapshot(
        report_id=report.id,
        created_by=scope.user.id,
        version_no=1,
        status="generated",
        data_snapshot={"project_name": "Original", "sections": {"overview": "First"}},
    )
    current = ReportSnapshot(
        report_id=report.id,
        created_by=scope.user.id,
        version_no=2,
        status="generated",
        data_snapshot={"project_name": "Current", "sections": {"overview": "Second"}},
    )
    db.add_all([original, current])
    db.commit()
    restored = reporting.restore_report_version(
        scope.project.id, reporting.RestoreInput(version=1), request, db, scope.user
    )
    assert restored.data["version"] == 3
    assert restored.data["data"] == original.data_snapshot
    assert db.get(ReportSnapshot, original.id).data_snapshot["project_name"] == "Original"
    artifact = ReportArtifact(
        snapshot_id=UUID(restored.data["id"]),
        requested_by=scope.user.id,
        file_format="pdf",
        status="ready",
        content=b"%PDF-test",
    )
    db.add(artifact)
    db.commit()
    link = reporting.create_download_link(scope.project.id, artifact.id, request, db, scope.user)
    token = link.data["url"].split("token=")[1]
    second_link = reporting.create_download_link(
        scope.project.id, artifact.id, request, db, scope.user
    )
    assert second_link.data["url"] != link.data["url"]
    assert reporting.download_export(scope.project.id, artifact.id, token, db, scope.user).body
    with pytest.raises(ApiError) as denied:
        reporting.download_export(scope.project.id, artifact.id, "wrong", db, scope.user)
    assert denied.value.code == "REPORT_LINK_EXPIRED"
    db.scalar(
        select(ReportDownloadLink).where(
            ReportDownloadLink.token_hash == reporting.sha256(token.encode()).hexdigest()
        )
    ).expires_at = datetime(2020, 1, 1, tzinfo=UTC)
    db.commit()
    with pytest.raises(ApiError):
        reporting.download_export(scope.project.id, artifact.id, token, db, scope.user)


def test_week7_notes_restore_and_adjustment_archive_preserves_old_shares(db, scope, monkeypatch):
    second = User(
        id=uuid4(),
        name="Second",
        username=f"s-{uuid4()}",
        email=f"{uuid4()}@example.test",
        college="Test",
        global_role="student",
        status="active",
    )
    db.add(second)
    db.flush()
    db.add_all(
        [
            ProjectMember(
                id=uuid4(), project_id=scope.project.id, user_id=scope.user.id, role="leader"
            ),
            ProjectMember(
                id=uuid4(), project_id=scope.project.id, user_id=second.id, role="member"
            ),
        ]
    )
    calculation = ContributionCalculation(
        project_id=scope.project.id,
        formula_version="test-v1",
        basis_version="test",
        calculated_by=scope.user.id,
    )
    db.add(calculation)
    db.flush()
    snapshot = ContributionSnapshot(
        project_id=scope.project.id,
        calculation_id=calculation.id,
        version_no=1,
        status="frozen",
        created_by=scope.user.id,
    )
    db.add(snapshot)
    db.flush()
    db.add_all(
        [
            ContributionItem(
                snapshot_id=snapshot.id,
                user_id=scope.user.id,
                task_credit=60,
                collaboration_credit=0,
                share=60,
                acceptance_rate=100,
                status="formal",
            ),
            ContributionItem(
                snapshot_id=snapshot.id,
                user_id=second.id,
                task_credit=40,
                collaboration_credit=0,
                share=40,
                acceptance_rate=100,
                status="formal",
            ),
        ]
    )
    db.commit()
    access = SimpleNamespace(leader=True, member=True, teacher=False, project=scope.project)
    monkeypatch.setattr(contribution_week7, "get_project_access", lambda *a, **k: access)
    request = SimpleNamespace(state=SimpleNamespace(request_id="week7-test"))
    contribution_week7.save_note(
        scope.project.id,
        scope.user.id,
        contribution_week7.NoteInput(body="Original"),
        request,
        db,
        scope.user,
    )
    contribution_week7.save_note(
        scope.project.id,
        scope.user.id,
        contribution_week7.NoteInput(body="Updated"),
        request,
        db,
        scope.user,
    )
    contribution_week7.save_note(
        scope.project.id,
        scope.user.id,
        contribution_week7.NoteInput(body="restore", restore_revision=1),
        request,
        db,
        scope.user,
    )
    assert [
        row["body"]
        for row in contribution_week7.read_notes(
            scope.project.id, scope.user.id, request, db, scope.user
        ).data
    ] == ["Original", "Updated", "Original"]
    source_id = uuid4()
    contribution_week7.archive_contribution(db, scope.project.id, "grade", source_id)
    appeal = ContributionAppeal(
        project_id=scope.project.id,
        snapshot_id=snapshot.id,
        member_id=scope.user.id,
        task_id=scope.task.id,
        evidence_id=uuid4(),
        reason="Credit mismatch",
        status="pending",
    )
    # A formal evidence row is needed for the appeal foreign key.
    evidence = Evidence(
        id=appeal.evidence_id,
        project_id=scope.project.id,
        task_id=scope.task.id,
        author_id=scope.user.id,
        title="Proof",
        description="Proof",
        source_type="manual",
        status="formal",
    )
    db.add(evidence)
    db.flush()
    db.add(appeal)
    db.flush()
    revised = contribution_week7.adjusted_snapshot(db, appeal, Decimal("70"), scope.user.id)
    db.commit()
    shares = [
        item.share
        for item in db.scalars(
            select(ContributionItem).where(ContributionItem.snapshot_id == revised.id)
        )
    ]
    assert sum(shares) == 100
    assert sorted(shares) == [30, 70]
    archived = db.scalar(
        select(ContributionArchive).where(ContributionArchive.source_id == source_id)
    )
    assert sorted(row["share"] for row in archived.data["members"]) == ["40.0000", "60.0000"]
