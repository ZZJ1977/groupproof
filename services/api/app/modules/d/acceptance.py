"""Human confirmation, formal outcomes, and revision-aware acceptance history."""

from datetime import UTC, datetime
from decimal import Decimal
from types import SimpleNamespace
from uuid import UUID

from sqlalchemy import func, inspect, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import TaskAssignee, User
from app.modules.c.permissions import get_project_access
from app.modules.c.task_execution import SqlExecutionRepository, TaskExecutionService
from app.modules.d.integrity import AcceptanceTransitionProvider, require_task
from app.modules.d.models import (
    AcceptanceDecision,
    CriterionResult,
    FormalOutcome,
    VerificationRun,
)
from app.modules.d.verification import verification_data


def responsible_ids(session: Session, task_id: UUID) -> list[UUID]:
    return list(
        session.scalars(
            select(TaskAssignee.user_id).where(
                TaskAssignee.task_id == task_id,
                TaskAssignee.role == "responsible",
                TaskAssignee.unassigned_at.is_(None),
            )
        )
    )


def decisions_for_run(session: Session, run_id: UUID) -> dict[UUID, AcceptanceDecision]:
    decisions = session.scalars(
        select(AcceptanceDecision)
        .where(AcceptanceDecision.verification_run_id == run_id)
        .order_by(AcceptanceDecision.revision_no.asc())
    ).all()
    return {row.actor_id: row for row in decisions}


def stale_reason(session: Session, run: VerificationRun, *, completed: bool = False) -> str | None:
    task = require_task(session, run.project_id, run.task_id)
    expected = run.task_version + (1 if completed else 0) if run.task_version is not None else None
    if expected is None or task.lock_version != expected:
        return "任务版本已变化"
    try:
        AcceptanceTransitionProvider(session, run.integrity_check_id).authorize(
            SimpleNamespace(task=task, project=SimpleNamespace(id=run.project_id)),
            None,
            "pending_verification",
            "freshness check",
        )
    except ApiError:
        return "验收标准或正式证据已变化"
    return None


def invalidate_run(session: Session, run: VerificationRun, actor: User, reason: str) -> None:
    now = datetime.now(UTC)
    for result in session.scalars(
        select(CriterionResult).where(
            CriterionResult.verification_run_id == run.id,
            CriterionResult.invalidated_at.is_(None),
        )
    ):
        result.invalidated_at = now
        result.invalidated_by = actor.id
        result.invalidated_reason = reason
    outcome = session.scalar(
        select(FormalOutcome).where(
            FormalOutcome.verification_run_id == run.id,
            FormalOutcome.invalidated_at.is_(None),
        )
    )
    if outcome:
        outcome.invalidated_at = now
        outcome.invalidated_reason = reason


def invalidate_for_task(session: Session, task_id: UUID, actor_id: UUID, reason: str) -> None:
    """Invalidate in the source transaction once the week-five D schema exists.

    C evidence operations also run while historical databases are upgraded from
    revision 0013; those databases have no D acceptance tables yet.
    """
    if not inspect(session.connection()).has_table(FormalOutcome.__tablename__):
        return
    actor = session.get(User, actor_id)
    if actor is None:
        raise ApiError(409, "ACTOR_NOT_FOUND", "Invalidation actor no longer exists.")
    for run in session.scalars(select(VerificationRun).where(VerificationRun.task_id == task_id)):
        invalidate_run(session, run, actor, reason)


def history(session: Session, project_id: UUID, task_id: UUID, user: User) -> list[dict]:
    get_project_access(session, user, project_id)
    require_task(session, project_id, task_id)
    runs = session.scalars(
        select(VerificationRun)
        .where(VerificationRun.project_id == project_id, VerificationRun.task_id == task_id)
        .order_by(VerificationRun.created_at.desc(), VerificationRun.id.desc())
    ).all()
    result = []
    changed = False
    for run in runs:
        outcome = session.scalar(
            select(FormalOutcome).where(FormalOutcome.verification_run_id == run.id)
        )
        decisions = decisions_for_run(session, run.id)
        prior_invalidation = session.scalar(
            select(CriterionResult.invalidated_reason)
            .where(
                CriterionResult.verification_run_id == run.id,
                CriterionResult.invalidated_at.is_not(None),
            )
            .limit(1)
        )
        reason = stale_reason(session, run, completed=bool(outcome and not outcome.invalidated_at))
        if (
            reason
            and prior_invalidation is None
            and (outcome is None or not outcome.invalidated_at)
        ):
            invalidate_run(session, run, user, reason)
            changed = True
        result.append(
            {
                **verification_data(session, run),
                "invalidated_reason": outcome.invalidated_reason
                if outcome and outcome.invalidated_at
                else prior_invalidation or reason,
                "formal_outcome_id": str(outcome.id)
                if outcome and not outcome.invalidated_at
                else None,
                "responsible_ids": [str(item) for item in responsible_ids(session, task_id)],
                "decisions": [
                    {
                        "actor_id": str(row.actor_id),
                        "decision": row.decision,
                        "responsibility_share": float(row.responsibility_share)
                        if row.responsibility_share is not None
                        else None,
                        "reason": row.reason,
                        "created_at": row.created_at.isoformat() if row.created_at else None,
                    }
                    for row in decisions.values()
                ],
            }
        )
    if changed:
        session.commit()
    return result


class HumanTransitionProvider:
    def __init__(self, session: Session, run_id: UUID, decision: str):
        self.session, self.run_id, self.decision = session, run_id, decision

    def authorize(self, scope, user: User, target: str, reason: str) -> None:
        run = self.session.get(VerificationRun, self.run_id)
        if run is None or run.task_id != scope.task.id or run.project_id != scope.project.id:
            raise ApiError(409, "VERIFICATION_CHANGED", "Verification result changed.")
        if self.decision == "confirmed" and target == "completed":
            if stale_reason(self.session, run):
                raise ApiError(409, "VERIFICATION_STALE", "Task or evidence changed; verify again.")
            assignees = set(responsible_ids(self.session, scope.task.id))
            decisions = decisions_for_run(self.session, run.id)
            if not assignees or any(
                user_id not in decisions or decisions[user_id].decision != "confirmed"
                for user_id in assignees
            ):
                raise ApiError(
                    409, "CONFIRMATIONS_MISSING", "Every responsible member must confirm."
                )
            if (
                sum(
                    (Decimal(decisions[user_id].responsibility_share) for user_id in assignees),
                    Decimal(),
                )
                != 100
            ):
                raise ApiError(409, "SHARES_INCOMPLETE", "Responsibility shares must total 100%.")
            self.session.add(
                FormalOutcome(
                    project_id=run.project_id,
                    task_id=run.task_id,
                    verification_run_id=run.id,
                    basis_json={
                        "task_weight": str(scope.task.weight),
                        "responsibility_shares": {
                            str(uid): str(decisions[uid].responsibility_share) for uid in assignees
                        },
                        "verification_run_id": str(run.id),
                    },
                )
            )
        elif self.decision == "rejected" and target == "in_progress":
            invalidate_run(self.session, run, user, reason)
        else:
            raise ApiError(409, "INVALID_ACCEPTANCE_TRANSITION", "Unsupported transition.")


def decide(
    session: Session,
    project_id: UUID,
    task_id: UUID,
    user: User,
    decision: str,
    reason: str,
    share: Decimal | None,
) -> dict:
    access = get_project_access(session, user, project_id, lock=True)
    if not access.member:
        raise ApiError(403, "PROJECT_MEMBER_REQUIRED", "Only an active project member can decide.")
    task = require_task(session, project_id, task_id)
    if user.id not in responsible_ids(session, task_id):
        raise ApiError(403, "TASK_RESPONSIBLE_REQUIRED", "Only a responsible assignee can decide.")
    if decision not in {"confirmed", "rejected"} or not reason.strip():
        raise ApiError(422, "INVALID_DECISION", "A decision and reason are required.")
    run = session.scalar(
        select(VerificationRun)
        .where(VerificationRun.project_id == project_id, VerificationRun.task_id == task_id)
        .order_by(VerificationRun.created_at.desc(), VerificationRun.id.desc())
    )
    if run is None or run.status != "completed":
        raise ApiError(409, "VERIFICATION_REQUIRED", "Run verification first.")
    if task.status != "pending_verification":
        raise ApiError(409, "INVALID_TASK_STATE", "Task is not awaiting confirmation.")
    if stale_reason(session, run):
        invalidate_run(session, run, user, "任务或证据发生变化")
        session.commit()
        raise ApiError(409, "VERIFICATION_STALE", "Task or evidence changed; verify again.")
    if decision == "confirmed" and (
        share is None
        or not share.is_finite()
        or share < 0
        or share > 100
        or share != share.quantize(Decimal("0.0001"))
    ):
        raise ApiError(
            422,
            "SHARE_REQUIRED",
            "Enter a responsibility share from 0 to 100 with at most four decimal places.",
        )
    if decision == "rejected" and share is not None:
        raise ApiError(422, "SHARE_NOT_APPLICABLE", "Rejection has no responsibility share.")
    session.add(
        AcceptanceDecision(
            verification_run_id=run.id,
            actor_id=user.id,
            revision_no=(
                session.scalar(
                    select(func.max(AcceptanceDecision.revision_no)).where(
                        AcceptanceDecision.verification_run_id == run.id,
                        AcceptanceDecision.actor_id == user.id,
                    )
                )
                or 0
            )
            + 1,
            decision=decision,
            reason=reason.strip(),
            responsibility_share=share,
        )
    )
    session.flush()
    if decision == "rejected":
        TaskExecutionService(SqlExecutionRepository(session)).return_to_in_progress(
            task_id,
            user,
            task.lock_version,
            reason,
            provider=HumanTransitionProvider(session, run.id, decision),
        )
    else:
        assignees = set(responsible_ids(session, task_id))
        decisions = decisions_for_run(session, run.id)
        if assignees.issubset(decisions) and all(
            decisions[uid].decision == "confirmed" for uid in assignees
        ):
            total = sum(
                (Decimal(decisions[uid].responsibility_share) for uid in assignees), Decimal()
            )
            if total != 100:
                session.commit()
                return {"status": "shares_incomplete", "share_total": float(total)}
            TaskExecutionService(SqlExecutionRepository(session)).mark_completed(
                task_id,
                user,
                task.lock_version,
                "All responsible members confirmed acceptance.",
                provider=HumanTransitionProvider(session, run.id, decision),
            )
        else:
            session.commit()
    return {"status": "recorded", "history": history(session, project_id, task_id, user)}
