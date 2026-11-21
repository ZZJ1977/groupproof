"""Read D's human acceptance and invalidate its results in B's source transaction."""

from collections.abc import Mapping, Sequence
from uuid import UUID

from sqlalchemy import inspect, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import AcceptanceCriterion, Task
from app.modules.b.ports import (
    InvalidationOutcome,
    TaskVerificationStatus,
    verification_unavailable,
)
from app.modules.d.acceptance import invalidate_for_task, stale_reason
from app.modules.d.models import CriterionResult, FormalOutcome, VerificationRun


class PersistedVerificationPort:
    @staticmethod
    def _require_tables(session: Session) -> None:
        schema = inspect(session.connection())
        if not all(
            schema.has_table(model.__tablename__)
            for model in (VerificationRun, CriterionResult, FormalOutcome)
        ):
            raise verification_unavailable()

    def invalidate_criterion_results(
        self,
        session: Session,
        *,
        task_id: UUID,
        criterion_ids: Sequence[UUID],
        reason: str,
        actor_id: UUID,
    ) -> InvalidationOutcome:
        self._require_tables(session)
        if session.get(Task, task_id) is None:
            raise ApiError(404, "NOT_FOUND", "Task not found.")
        result_ids = tuple(
            session.scalars(
                select(CriterionResult.id)
                .join(VerificationRun, CriterionResult.verification_run_id == VerificationRun.id)
                .where(
                    VerificationRun.task_id == task_id,
                    CriterionResult.invalidated_at.is_(None),
                )
            )
        )
        # A criterion change makes the whole task's prior acceptance basis stale.
        # D owns invalidation; no commit here, so a failed B write rolls it back too.
        invalidate_for_task(session, task_id, actor_id, reason)
        session.flush()
        return InvalidationOutcome(
            task_id=task_id, accepted=True, invalidated_result_ids=result_ids
        )

    def task_verification_status(
        self, session: Session, *, task_ids: Sequence[UUID]
    ) -> Mapping[UUID, TaskVerificationStatus]:
        self._require_tables(session)
        statuses: dict[UUID, TaskVerificationStatus] = {}
        for task_id in dict.fromkeys(task_ids):
            task = session.get(Task, task_id)
            if task is None:
                raise ApiError(404, "NOT_FOUND", "Task not found.")
            criteria = tuple(
                session.scalars(
                    select(AcceptanceCriterion.id).where(AcceptanceCriterion.task_id == task_id)
                )
            )
            run = session.scalar(
                select(VerificationRun)
                .where(VerificationRun.task_id == task_id)
                .order_by(VerificationRun.created_at.desc(), VerificationRun.id.desc())
                .limit(1)
            )
            state = "not_submitted"
            if run is not None:
                outcome = session.scalar(
                    select(FormalOutcome).where(FormalOutcome.verification_run_id == run.id)
                )
                completed = outcome is not None and outcome.invalidated_at is None
                if stale_reason(session, run, completed=completed):
                    state = "invalidated"
                elif completed and task.status == "completed":
                    # AI success alone is insufficient: D creates this outcome only
                    # after all responsible members confirm their work and shares.
                    state = "passed"
                elif run.status == "failed" or run.result == "failed":
                    state = "failed"
                else:
                    state = "in_review"
            statuses[task_id] = TaskVerificationStatus(
                task_id=task_id,
                state=state,
                missing_criterion_ids=() if state == "passed" else criteria,
            )
        return statuses
