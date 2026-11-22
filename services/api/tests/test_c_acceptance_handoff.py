"""C2-01: real authenticated HTTP handoff from submission to D acceptance.

The shared fixture supplies A's actual school binding, session cookie and CSRF
checks. Planning and previously adopted source snapshots are seed data; only the
remote AI advice is replaced. SQLite covers persisted workflow behavior, not
PostgreSQL concurrency or external GitHub ingestion.
"""

from decimal import Decimal
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
import test_c_auth_verification_integration as auth_tests
from sqlalchemy import func, select

from app.db.models import AcceptanceCriterion, ProgressEvent, TaskAssignee
from app.modules.c.models import (
    Evidence,
    EvidenceCriterion,
    EvidenceSourceSnapshot,
    IntegrationOutbox,
    TaskNoteVersion,
)
from app.modules.d import verification
from app.modules.d.models import AcceptanceDecision, CriterionResult, FormalOutcome, VerificationRun
from app.modules.d.router import acceptance_router

db = auth_tests.db
scope = auth_tests.scope
http = auth_tests.http


def _data(response):
    assert response.status_code == 200, response.text
    return response.json()["data"]


def _count(db, model):
    return db.scalar(select(func.count()).select_from(model))


def _formal_evidence(db, scope, criterion, kind, state):
    evidence = Evidence(
        project_id=scope.project.id,
        task_id=scope.task.id,
        author_id=scope.users["author"].id,
        title=kind,
        description="Previously adopted, synchronized GitHub evidence",
        source_type="github",
        status="formal",
    )
    db.add(evidence)
    db.flush()
    db.add(EvidenceCriterion(evidence_id=evidence.id, criterion_id=criterion.id))
    db.add(
        EvidenceSourceSnapshot(
            evidence_id=evidence.id,
            version_no=1,
            source_identity=f"github:{evidence.id}",
            source_revision="1",
            content_hash="a" * 64,
            content_json={"availability": "available", "source": {"kind": kind, "state": state}},
            captured_by=scope.users["author"].id,
        )
    )
    return evidence


@pytest.fixture()
def handoff(db, scope, http, monkeypatch):
    http.client.app.include_router(acceptance_router)
    db.add(
        TaskAssignee(task_id=scope.task.id, user_id=scope.users["author"].id, role="responsible")
    )
    second = AcceptanceCriterion(
        id=uuid4(), task_id=scope.task.id, criterion_key="AC2", text="CI succeeds", sort_order=2
    )
    db.add(second)
    db.flush()
    proofs = [
        _formal_evidence(db, scope, scope.criterion, "pull_request", "merged"),
        _formal_evidence(db, scope, second, "ci_run", "success"),
    ]
    db.commit()
    calls = []

    def ai_advice(payload):
        calls.append(payload)
        return SimpleNamespace(is_placeholder=False, verdict="pass", reasons=["Evidence matches"])

    monkeypatch.setattr(verification, "match_evidence", ai_advice)
    student_ids = {user.id: f"ST{index:04d}" for index, user in enumerate(scope.users.values(), 1)}

    def sign_in(user):
        return http.sign_in(user, student_id=student_ids[user.id])

    sign_in(scope.users["author"])
    return SimpleNamespace(
        client=http.client,
        sign_in=sign_in,
        c=f"/api/v1/tasks/{scope.task.id}",
        d=f"/api/v1/projects/{scope.project.id}/tasks/{scope.task.id}",
        criteria=[scope.criterion, second],
        proofs=proofs,
        ai_calls=calls,
    )


def _execution(handoff, status):
    execution = _data(handoff.client.get(handoff.c + "/execution"))
    assert execution["status"] == status
    assert (execution["completed_at"] is not None) == (status == "completed")
    return execution


def _prepare(handoff, *, note_version=0):
    before = _execution(handoff, "in_progress")
    progress = _data(
        handoff.client.patch(
            handoff.c + "/progress",
            json={
                "expected_version": before["version"],
                "progress": 100,
                "reason": "Ready to review",
            },
        )
    )
    assert progress["status"] == "in_progress" and progress["completed_at"] is None
    saved = _data(
        handoff.client.post(
            handoff.c + "/prepare-submission",
            headers={"Idempotency-Key": f"acceptance-handoff-{note_version}"},
            json={
                "expected_version": progress["version"],
                "note": {
                    "expected_version": note_version,
                    "title": "Submission preparation",
                    "body": f"Implementation ready for review, revision {note_version + 1}",
                },
            },
        )
    )
    assert saved["note"]["current_version_no"] == note_version + 1
    assert saved["execution"]["status"] == "pending_submission"
    assert saved["execution"]["completed_at"] is None
    return saved


def _verify(handoff):
    check = _data(handoff.client.post(handoff.d + "/integrity-check"))
    assert check["status"] == "passed" and check["coverage_rate"] == 100
    assert check["covered_criteria"] == check["total_criteria"] == 2
    _execution(handoff, "pending_submission")
    entered = _data(handoff.client.post(handoff.d + "/enter-verification"))
    assert entered["task"]["status"] == "pending_verification"
    _execution(handoff, "pending_verification")
    run = _data(handoff.client.post(handoff.d + "/verification"))
    assert run["status"] == "completed" and run["result"] == "passed"
    assert {row["criterion_id"] for row in run["criteria"]} == {
        str(criterion.id) for criterion in handoff.criteria
    }
    for row in run["criteria"]:
        assert row["result"] == "passed" and row["evidence"]
        assert "AI 建议：pass" in row["reason"]
    assert len(handoff.ai_calls) == 2
    assert _data(handoff.client.get(handoff.d + "/verification")) == run
    # Successful deterministic rules and AI advice still await human confirmation.
    _execution(handoff, "pending_verification")
    return run


def _confirm(handoff, share):
    return _data(
        handoff.client.post(
            handoff.d + "/verification/decision",
            json={
                "decision": "confirmed",
                "reason": "Reviewed both criteria",
                "responsibility_share": share,
            },
        )
    )


def test_submission_handoff_completes_only_after_responsible_human_confirmation(db, scope, handoff):
    _prepare(handoff)
    assert _count(db, TaskNoteVersion) == 1
    assert (
        db.scalar(
            select(func.count())
            .select_from(IntegrationOutbox)
            .where(IntegrationOutbox.event_type == "task.submission_prepared")
        )
        == 1
    )
    assert _count(db, VerificationRun) == _count(db, FormalOutcome) == 0
    run = _verify(handoff)
    assert _count(db, CriterionResult) == 2
    assert _count(db, AcceptanceDecision) == _count(db, FormalOutcome) == 0

    handoff.sign_in(scope.users["leader"])
    forbidden = handoff.client.post(
        handoff.d + "/verification/decision",
        json={"decision": "confirmed", "reason": "Leader review", "responsibility_share": 100},
    )
    assert forbidden.status_code == 403
    assert forbidden.json()["error"]["code"] == "TASK_RESPONSIBLE_REQUIRED"
    assert _count(db, AcceptanceDecision) == _count(db, FormalOutcome) == 0
    handoff.sign_in(scope.users["author"])
    assert _confirm(handoff, 100)["status"] == "recorded"
    completed = _execution(handoff, "completed")
    assert completed["progress"] == 100
    outcome = db.scalar(select(FormalOutcome))
    assert outcome.verification_run_id == UUID(run["id"])
    assert outcome.basis_json["responsibility_shares"] == {
        str(scope.users["author"].id): "100.0000"
    }
    history = _data(handoff.client.get(handoff.d + "/verification/history"))
    assert history[0]["formal_outcome_id"] == str(outcome.id)
    assert history[0]["invalidated_reason"] is None
    transitions = set(db.execute(select(ProgressEvent.from_status, ProgressEvent.to_status)))
    assert {
        ("in_progress", "pending_submission"),
        ("pending_submission", "pending_verification"),
        ("pending_verification", "completed"),
    } <= transitions


def test_all_responsible_members_must_confirm_and_shares_must_total_100(db, scope, handoff):
    db.add(
        TaskAssignee(task_id=scope.task.id, user_id=scope.users["member"].id, role="responsible")
    )
    db.commit()
    _prepare(handoff)
    _verify(handoff)
    assert _confirm(handoff, 100)["status"] == "recorded"
    _execution(handoff, "pending_verification")
    assert _count(db, FormalOutcome) == 0

    handoff.sign_in(scope.users["member"])
    assert _confirm(handoff, 30) == {"status": "shares_incomplete", "share_total": 130}
    _execution(handoff, "pending_verification")
    assert _count(db, FormalOutcome) == 0
    handoff.sign_in(scope.users["author"])
    assert _confirm(handoff, 70)["status"] == "recorded"
    _execution(handoff, "completed")
    assert _count(db, FormalOutcome) == 1
    decisions = db.scalars(
        select(AcceptanceDecision)
        .where(AcceptanceDecision.actor_id == scope.users["author"].id)
        .order_by(AcceptanceDecision.revision_no)
    ).all()
    assert [(row.revision_no, row.responsibility_share) for row in decisions] == [
        (1, Decimal(100)),
        (2, Decimal(70)),
    ]
    shares = db.scalar(select(FormalOutcome)).basis_json["responsibility_shares"]
    assert {actor: Decimal(share) for actor, share in shares.items()} == {
        str(scope.users["author"].id): Decimal(70),
        str(scope.users["member"].id): Decimal(30),
    }


def test_rejection_returns_to_c_and_preserves_history_for_resubmission(db, handoff):
    _prepare(handoff)
    run = _verify(handoff)
    rejected = _data(
        handoff.client.post(
            handoff.d + "/verification/decision",
            json={"decision": "rejected", "reason": "Acceptance needs a correction"},
        )
    )
    assert rejected["status"] == "recorded"
    resumed = _execution(handoff, "in_progress")
    assert resumed["progress"] == 100 and resumed["can_update_progress"]
    assert _count(db, FormalOutcome) == 0
    results = db.scalars(select(CriterionResult)).all()
    assert len(results) == 2
    assert all(row.invalidated_at is not None for row in results)
    assert {row.invalidated_reason for row in results} == {"Acceptance needs a correction"}
    history = _data(handoff.client.get(handoff.d + "/verification/history"))
    assert history[0]["id"] == run["id"] and history[0]["formal_outcome_id"] is None
    assert history[0]["decisions"][0]["decision"] == "rejected"
    assert (
        db.scalar(
            select(ProgressEvent).where(
                ProgressEvent.from_status == "pending_verification",
                ProgressEvent.to_status == "in_progress",
            )
        ).reason
        == "Acceptance needs a correction"
    )
    # C accepts a new preparation with the updated task and immutable note versions.
    _prepare(handoff, note_version=1)
    assert list(
        db.scalars(select(TaskNoteVersion.version_no).order_by(TaskNoteVersion.version_no))
    ) == [1, 2]
    assert _count(db, VerificationRun) == 1 and _count(db, AcceptanceDecision) == 1


def test_incomplete_formal_evidence_keeps_submission_out_of_verification(db, handoff):
    handoff.proofs[1].status = "candidate"
    db.commit()
    _prepare(handoff)
    check = _data(handoff.client.post(handoff.d + "/integrity-check"))
    assert check["status"] == "incomplete" and check["coverage_rate"] == 50
    assert check["covered_criteria"] == 1 and check["total_criteria"] == 2
    denied = handoff.client.post(handoff.d + "/enter-verification")
    assert denied.status_code == 409
    assert denied.json()["error"]["code"] == "INCOMPLETE_EVIDENCE"
    _execution(handoff, "pending_submission")
    assert _count(db, VerificationRun) == _count(db, FormalOutcome) == 0
    assert not handoff.ai_calls
