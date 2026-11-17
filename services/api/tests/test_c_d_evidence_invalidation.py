"""C evidence changes through real D acceptance/contribution/report services.

Only the optional external AI call is replaced. Set C_TEST_DATABASE_URL to run
the same rollback-isolated service flows against migrated PostgreSQL.
"""

from contextlib import nullcontext
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
import test_c_discussions as discussion_tests
import test_c_evidence as evidence_tests
from sqlalchemy import func, select
from starlette.requests import Request

from app.api.errors import ApiError
from app.db.models import TaskAssignee
from app.modules.c.discussion_schemas import (
    CreateDiscussion,
    MarkDiscussionImportant,
    ReplyDiscussion,
)
from app.modules.c.discussion_service import add_reply, create_discussion, mark_important
from app.modules.c.evidence_service import evidence_data, list_evidence
from app.modules.c.execution_schemas import PrepareSubmissionRequest
from app.modules.c.models import Evidence, EvidenceDecision, IntegrationOutbox
from app.modules.c.task_execution import TaskSubmissionService
from app.modules.d import acceptance, contribution, integrity, report_tasks, reporting, verification
from app.modules.d.models import (
    AcceptanceDecision,
    ContributionSnapshot,
    CriterionResult,
    FormalOutcome,
    Report,
    ReportSnapshot,
    VerificationRun,
)

db = discussion_tests.db
scope = evidence_tests.scope


@pytest.fixture()
def flow(db, scope, monkeypatch):
    def unavailable(_):
        raise ApiError(503, "AI_UNAVAILABLE", "External AI disabled in service tests")

    monkeypatch.setattr(verification, "match_evidence", unavailable)
    actor = scope.users["author"]
    scope.task.weight = 10
    db.add(TaskAssignee(task_id=scope.task.id, user_id=actor.id, role="responsible"))
    db.flush()
    discussion = create_discussion(
        db,
        actor,
        scope.project.id,
        CreateDiscussion(title="Reviewable design", body="Original design", task_id=scope.task.id),
        str(uuid4()),
    )
    discussion = mark_important(
        db,
        actor,
        scope.project.id,
        UUID(discussion["id"]),
        MarkDiscussionImportant(
            expected_version=discussion["lock_version"], is_important=True, reason="Design basis"
        ),
        str(uuid4()),
    )
    candidate = evidence_tests.candidate(
        db, scope, source_type="discussion", source_id=UUID(discussion["id"])
    )
    formal = evidence_tests.decide(db, scope, candidate)
    spare = evidence_tests.candidate(db, scope, title="Additional evidence")
    TaskSubmissionService(db).prepare(
        scope.task.id,
        actor,
        PrepareSubmissionRequest(expected_version=scope.task.lock_version),
        str(uuid4()),
    )
    entered = integrity.enter_verification(db, scope.project.id, scope.task.id, actor)
    assert entered["integrity_check"]["status"] == "passed"
    run = verification.run_verification(db, scope.project.id, scope.task.id, actor)
    assert run["result"] == "uncertain"  # AI/manual suggestions never complete the task.
    assert scope.task.status == "pending_verification"
    return SimpleNamespace(discussion=discussion, formal=formal, spare=spare, run=run)


def change_evidence(db, scope, flow, kind, *, key=None):
    key = key or str(uuid4())
    if kind == "adopted":
        return evidence_tests.decide(db, scope, flow.spare, key=key)
    if kind == "withdrawn":
        return evidence_tests.decide(db, scope, flow.formal, decision="withdrawn", key=key)
    return add_reply(
        db,
        scope.users["author"],
        scope.project.id,
        UUID(flow.discussion["id"]),
        ReplyDiscussion(
            expected_version=flow.discussion["lock_version"], body="The design basis changed."
        ),
        key,
    )


def confirm(db, scope):
    return acceptance.decide(
        db,
        scope.project.id,
        scope.task.id,
        scope.users["author"],
        "confirmed",
        "Checked the actual source",
        Decimal(100),
    )


@pytest.mark.parametrize("kind", ["adopted", "withdrawn", "source_changed"])
def test_c_change_invalidates_run_before_any_history_read_and_rejects_confirmation(
    db, scope, flow, kind
):
    change_evidence(db, scope, flow, kind)
    db.flush()
    result = db.scalar(
        select(CriterionResult).where(CriterionResult.verification_run_id == UUID(flow.run["id"]))
    )
    assert result.invalidated_at is not None
    assert result.invalidated_by == scope.users["author"].id
    with pytest.raises(ApiError) as stale:
        confirm(db, scope)
    assert stale.value.code == "VERIFICATION_STALE"
    assert scope.task.status == "pending_verification"
    assert (
        db.scalar(
            select(func.count())
            .select_from(FormalOutcome)
            .where(FormalOutcome.task_id == scope.task.id)
        )
        == 0
    )
    assert (
        db.scalar(
            select(func.count())
            .select_from(AcceptanceDecision)
            .where(AcceptanceDecision.verification_run_id == UUID(flow.run["id"]))
        )
        == 0
    )
    history = acceptance.history(db, scope.project.id, scope.task.id, scope.users["author"])
    assert history[0]["invalidated_reason"]
    assert history[0]["formal_outcome_id"] is None
    if kind == "adopted":
        # The rollback fixture's outer PG transaction freezes now(), unlike
        # separate HTTP requests. Give the historical run its earlier time.
        db.get(VerificationRun, UUID(flow.run["id"])).created_at = datetime.now(UTC) - timedelta(
            days=1
        )
        fresh = verification.run_verification(
            db, scope.project.id, scope.task.id, scope.users["author"]
        )
        assert fresh["id"] != flow.run["id"]
        confirm(db, scope)
        assert scope.task.status == "completed"
    else:
        check = integrity.run_check(db, scope.project.id, scope.task.id, scope.users["author"])
        assert check["covered_criteria"] == 0
        assert check["status"] == "incomplete"


@pytest.mark.parametrize("queued_before_change", [False, True])
@pytest.mark.parametrize("kind", ["adopted", "withdrawn", "source_changed"])
def test_c_change_excludes_old_formal_outcomes_from_new_reports_preserving_history(
    db, scope, flow, kind, queued_before_change, monkeypatch
):
    confirm(db, scope)
    outcome = db.scalar(select(FormalOutcome).where(FormalOutcome.task_id == scope.task.id))
    calculated = contribution.calculate(db, scope.project.id, scope.users["leader"])
    assert not calculated["stale"]
    snapshot = db.get(ContributionSnapshot, UUID(calculated["id"]))
    # D has no public freeze command yet; this is an existing frozen report basis.
    snapshot.status = "frozen"
    report = Report(project_id=scope.project.id, created_by=scope.users["leader"].id)
    db.add(report)
    db.flush()
    frozen_data = reporting.snapshot_data(db, scope.project.id, scope.project.name, True)
    assert frozen_data["counts"]["contribution_members"] == 1
    old = ReportSnapshot(
        report_id=report.id,
        created_by=scope.users["leader"].id,
        version_no=1,
        status="generated",
        contribution_snapshot_id=snapshot.id,
        data_snapshot=frozen_data,
    )
    db.add(old)
    db.commit()
    old_data = deepcopy(old.data_snapshot)
    source_before = evidence_data(db, db.get(Evidence, UUID(flow.formal["id"])), history=True)

    # Use the production preview worker and database; bypass only Celery transport/AI advice.
    monkeypatch.setattr(report_tasks, "SessionLocal", lambda: nullcontext(db))
    monkeypatch.setattr(report_tasks, "risk_advice", lambda *args: None)
    monkeypatch.setattr(report_tasks.generate_preview, "delay", lambda *args: None)
    report.status = "generated"
    request = Request({"type": "http"})
    request.state.request_id = str(uuid4())

    def queue_preview():
        response = reporting.refresh_report(
            scope.project.id,
            reporting.RefreshInput(includes_appendix=True),
            request,
            db,
            scope.users["leader"],
        )
        return db.get(ReportSnapshot, UUID(response.data["id"]))

    if queued_before_change:
        new = queue_preview()
        assert new.contribution_snapshot_id == snapshot.id

    key = str(uuid4())
    change_evidence(db, scope, flow, kind, key=key)
    db.flush()
    assert outcome.invalidated_at is not None  # No history/query consumer is needed.
    timestamp = outcome.invalidated_at
    decisions = (
        select(func.count())
        .select_from(EvidenceDecision)
        .join(Evidence)
        .where(Evidence.project_id == scope.project.id)
    )
    events = (
        select(func.count())
        .select_from(IntegrationOutbox)
        .where(IntegrationOutbox.project_id == scope.project.id)
    )
    decision_count = db.scalar(decisions)
    event_count = db.scalar(events)
    change_evidence(db, scope, flow, kind, key=key)
    assert outcome.invalidated_at == timestamp
    assert db.scalar(decisions) == decision_count
    assert db.scalar(events) == event_count
    assert contribution.latest_snapshot(db, scope.project.id, scope.users["author"])["stale"]
    with pytest.raises(ApiError) as no_outcomes:
        contribution.calculate(db, scope.project.id, scope.users["leader"])
    assert no_outcomes.value.code == "NO_FORMAL_OUTCOMES"

    if not queued_before_change:
        new = queue_preview()
        assert new.contribution_snapshot_id is None
    report_tasks.generate_preview.run(str(new.id), True)
    assert new.data_snapshot["counts"]["contribution_members"] == 0
    assert new.contribution_snapshot_id is None
    assert old.data_snapshot == old_data
    assert old.contribution_snapshot_id == snapshot.id
    effective = list_evidence(
        db, scope.users["author"], scope.project.id, task_id=scope.task.id, effective_only=True
    )
    assert effective["total"] == (2 if kind == "adopted" else 0)
    after = evidence_data(db, db.get(Evidence, UUID(flow.formal["id"])), history=True)
    assert after["original_snapshot_id"] == source_before["original_snapshot_id"]
    assert after["source_snapshots"][0] == source_before["source_snapshots"][0]


def test_failed_c_transaction_rolls_back_evidence_and_d_invalidation_together(db, scope, flow):
    confirm(db, scope)
    outcome = db.scalar(select(FormalOutcome).where(FormalOutcome.task_id == scope.task.id))
    row = db.get(Evidence, UUID(flow.formal["id"]))
    original = evidence_data(db, row, history=True)
    with pytest.raises(RuntimeError), db.begin_nested():
        change_evidence(db, scope, flow, "withdrawn")
        assert outcome.invalidated_at is not None
        assert row.status == "withdrawn"
        raise RuntimeError("Fail the outer request before commit")
    db.refresh(outcome)
    db.refresh(row)
    assert outcome.invalidated_at is None
    assert evidence_data(db, row, history=True) == original
    history = acceptance.history(db, scope.project.id, scope.task.id, scope.users["author"])
    assert history[0]["invalidated_reason"] is None
    assert history[0]["formal_outcome_id"] == str(outcome.id)
