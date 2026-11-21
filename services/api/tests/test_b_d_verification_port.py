"""B consumes D's persisted human acceptance without substituting AI verdicts."""

from uuid import UUID

import pytest
import test_c_d_evidence_invalidation as acceptance_flow
from sqlalchemy import select

from app.modules.b.ports import get_verification_port
from app.modules.d.models import CriterionResult, FormalOutcome

db = acceptance_flow.db
scope = acceptance_flow.scope
flow = acceptance_flow.flow


def state(db, scope):
    return (
        get_verification_port()
        .task_verification_status(db, task_ids=[scope.task.id])[scope.task.id]
        .state
    )


def test_unsubmitted_task_has_no_passing_result(db, scope):
    assert state(db, scope) == "not_submitted"


def test_only_fresh_human_accepted_outcome_satisfies_b_milestone(db, scope, flow):
    assert state(db, scope) == "in_review"
    acceptance_flow.confirm(db, scope)
    assert state(db, scope) == "passed"
    acceptance_flow.change_evidence(db, scope, flow, "withdrawn")
    assert state(db, scope) == "invalidated"


def test_b_criterion_invalidation_uses_d_transaction_and_keeps_history(db, scope, flow):
    acceptance_flow.confirm(db, scope)
    outcome = db.scalar(select(FormalOutcome).where(FormalOutcome.task_id == scope.task.id))
    result = db.scalar(
        select(CriterionResult).where(CriterionResult.verification_run_id == UUID(flow.run["id"]))
    )
    port = get_verification_port()
    with pytest.raises(RuntimeError), db.begin_nested():
        invalidation = port.invalidate_criterion_results(
            db,
            task_id=scope.task.id,
            criterion_ids=[result.criterion_id],
            reason="Changed acceptance criteria",
            actor_id=scope.users["leader"].id,
        )
        assert invalidation.accepted is True
        assert result.id in invalidation.invalidated_result_ids
        assert outcome.invalidated_at is not None
        assert state(db, scope) == "invalidated"
        raise RuntimeError("Abort B request")
    db.refresh(outcome)
    db.refresh(result)
    assert result.invalidated_at is None
    assert outcome.invalidated_at is None
    assert state(db, scope) == "passed"
