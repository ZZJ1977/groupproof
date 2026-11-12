"""D1-01: immutable completeness checks against C's effective evidence rows."""

from decimal import Decimal
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import AcceptanceCriterion, Task, User
from app.modules.c.models import Evidence, EvidenceCriterion, EvidenceSourceSnapshot
from app.modules.c.permissions import (
    get_project_access,
    require_execution_write,
    require_task_plan,
)
from app.modules.c.task_execution import SqlExecutionRepository, TaskExecutionService
from app.modules.d.models import IntegrityCheck


def check_data(row: IntegrityCheck) -> dict:
    return {
        "id": str(row.id),
        "project_id": str(row.project_id),
        "task_id": str(row.task_id),
        "rule_version": row.rule_version,
        "total_criteria": row.total_criteria,
        "covered_criteria": row.covered_criteria,
        "coverage_rate": float(row.coverage_rate),
        "status": row.status,
        "details": row.details_json or [],
        "checked_at": row.checked_at.isoformat() if row.checked_at else None,
    }


def require_task(session: Session, project_id: UUID, task_id: UUID) -> Task:
    task = session.scalar(select(Task).where(Task.id == task_id, Task.project_id == project_id))
    if task is None:
        raise ApiError(404, "TASK_NOT_FOUND", "Task not found in this project.")
    return task


def latest_check(session: Session, project_id: UUID, task_id: UUID, user: User) -> dict | None:
    get_project_access(session, user, project_id)
    require_task(session, project_id, task_id)
    row = session.scalar(
        select(IntegrityCheck)
        .where(IntegrityCheck.project_id == project_id, IntegrityCheck.task_id == task_id)
        .order_by(
            IntegrityCheck.checked_at.desc(),
            IntegrityCheck.created_at.desc(),
            IntegrityCheck.id.desc(),
        )
    )
    return check_data(row) if row else None


def run_check(session: Session, project_id: UUID, task_id: UUID, user: User) -> dict:
    access = get_project_access(session, user, project_id, lock=True)
    require_execution_write(access.project, access.course)
    require_task_plan(access.latest_plan, task_id)
    if not access.member:
        raise ApiError(403, "INTEGRITY_CHECK_DENIED", "No permission to check this task.")
    require_task(session, project_id, task_id)
    criteria = session.scalars(
        select(AcceptanceCriterion)
        .where(AcceptanceCriterion.task_id == task_id)
        .order_by(AcceptanceCriterion.sort_order, AcceptanceCriterion.id)
    ).all()
    linked = (
        session.execute(
            select(EvidenceCriterion.criterion_id, Evidence)
            .join(Evidence, Evidence.id == EvidenceCriterion.evidence_id)
            .where(
                Evidence.project_id == project_id,
                Evidence.task_id == task_id,
                Evidence.status == "formal",
                Evidence.source_changed.is_(False),
                EvidenceCriterion.criterion_id.in_([item.id for item in criteria]),
            )
        ).all()
        if criteria
        else []
    )
    evidence_by_criterion: dict[UUID, list[dict]] = {item.id: [] for item in criteria}
    unavailable: set[UUID] = set()
    for criterion_id, evidence in linked:
        snapshot = session.scalar(
            select(EvidenceSourceSnapshot)
            .where(EvidenceSourceSnapshot.evidence_id == evidence.id)
            .order_by(EvidenceSourceSnapshot.version_no.desc())
            .limit(1)
        )
        if snapshot is None or snapshot.content_json.get("availability") != "available":
            unavailable.add(evidence.id)
            continue
        evidence_by_criterion[criterion_id].append(
            {"id": str(evidence.id), "version": evidence.lock_version}
        )
    details = [
        {
            "criterion_id": str(item.id),
            "criterion_key": item.criterion_key,
            "text": item.text,
            "criterion_version": item.lock_version,
            "evidence": evidence_by_criterion[item.id],
            "covered": bool(evidence_by_criterion[item.id]),
        }
        for item in criteria
    ]
    covered = sum(item["covered"] for item in details)
    total = len(details)
    rate = (
        (Decimal(covered) * 100 / Decimal(total)).quantize(Decimal("0.01"))
        if total
        else Decimal("0.00")
    )
    row = IntegrityCheck(
        project_id=project_id,
        task_id=task_id,
        checked_by=user.id,
        rule_version="effective-formal-v1",
        total_criteria=total,
        covered_criteria=covered,
        coverage_rate=rate,
        status="passed" if total and covered == total else "incomplete",
        missing_criteria_json=[item["criterion_id"] for item in details if not item["covered"]],
        pending_sources=len(unavailable),
        details_json=details,
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return check_data(row)


class AcceptanceTransitionProvider:
    """C's trusted transition hook; never accepts a browser supplied coverage flag."""

    def __init__(self, session: Session, check_id: UUID):
        self.session = session
        self.check_id = check_id

    def authorize(self, scope, user: User, target: str, reason: str) -> None:
        if target != "pending_verification":
            raise ApiError(409, "INVALID_ACCEPTANCE_TRANSITION", "Unsupported transition.")
        row = self.session.get(IntegrityCheck, self.check_id)
        if (
            row is None
            or row.task_id != scope.task.id
            or row.project_id != scope.project.id
            or row.status != "passed"
            or not row.total_criteria
            or row.covered_criteria != row.total_criteria
        ):
            raise ApiError(
                409, "INCOMPLETE_EVIDENCE", "Every criterion needs effective formal evidence."
            )
        criteria = self.session.scalars(
            select(AcceptanceCriterion)
            .where(AcceptanceCriterion.task_id == scope.task.id)
            .execution_options(populate_existing=True)
        ).all()
        versions = {str(item.id): item.lock_version for item in criteria}
        if len(versions) != row.total_criteria or any(
            versions.get(item["criterion_id"]) != item["criterion_version"]
            for item in row.details_json or []
        ):
            raise ApiError(409, "STALE_INTEGRITY_CHECK", "Criteria changed; check again.")
        for detail in row.details_json or []:
            if not any(
                self._still_effective(UUID(ref["id"]), UUID(detail["criterion_id"]), ref["version"])
                for ref in detail["evidence"]
            ):
                raise ApiError(409, "STALE_INTEGRITY_CHECK", "Evidence changed; check again.")

    def _still_effective(self, evidence_id: UUID, criterion_id: UUID, version: int) -> bool:
        evidence = self.session.scalar(
            select(Evidence)
            .join(EvidenceCriterion, EvidenceCriterion.evidence_id == Evidence.id)
            .where(Evidence.id == evidence_id, EvidenceCriterion.criterion_id == criterion_id)
            .execution_options(populate_existing=True)
        )
        if (
            not evidence
            or evidence.status != "formal"
            or evidence.source_changed
            or evidence.lock_version != version
        ):
            return False
        snapshot = self.session.scalar(
            select(EvidenceSourceSnapshot)
            .where(EvidenceSourceSnapshot.evidence_id == evidence_id)
            .order_by(EvidenceSourceSnapshot.version_no.desc())
            .limit(1)
            .execution_options(populate_existing=True)
        )
        return bool(snapshot and snapshot.content_json.get("availability") == "available")


def enter_verification(session: Session, project_id: UUID, task_id: UUID, user: User) -> dict:
    task = require_task(session, project_id, task_id)
    if task.status != "pending_submission":
        raise ApiError(409, "TASK_NOT_SUBMITTED", "Submit the task before verification.")
    check = run_check(session, project_id, task_id, user)
    if check["status"] != "passed":
        raise ApiError(
            409, "INCOMPLETE_EVIDENCE", "Every criterion needs effective formal evidence."
        )
    result = TaskExecutionService(SqlExecutionRepository(session)).change_task_status(
        task_id,
        user,
        task.lock_version,
        "pending_verification",
        "D1-02 evidence completeness passed",
        provider=AcceptanceTransitionProvider(session, UUID(check["id"])),
    )
    return {"integrity_check": check, "task": result.model_dump(mode="json")}
