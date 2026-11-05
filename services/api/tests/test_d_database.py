"""Persistence tests for D acceptance, contribution and report history."""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import JSON, MetaData, create_engine, event, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.models import AcceptanceCriterion, Course, FunctionalModule, Project, Task, User
from app.modules.d.models import (
    ContributionCalculation,
    ContributionItem,
    ContributionItemTask,
    ContributionSnapshot,
    CriterionResult,
    IntegrityCheck,
    Report,
    ReportSnapshot,
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
        "groups",
        "projects",
        "functional_modules",
        "tasks",
        "acceptance_criteria",
        "baseline_versions",
        "plan_versions",
        "integrity_checks",
        "verification_runs",
        "criterion_results",
        "contribution_calculations",
        "contribution_snapshots",
        "contribution_items",
        "contribution_item_tasks",
        "reports",
        "report_snapshots",
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
