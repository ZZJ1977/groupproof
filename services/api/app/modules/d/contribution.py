"""Contribution from current formal outcomes and recorded responsibility shares."""

import hashlib
import json
from datetime import UTC, datetime
from decimal import ROUND_DOWN, Decimal
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import Task, User
from app.modules.c.permissions import get_project_access
from app.modules.d.acceptance import stale_reason
from app.modules.d.models import (
    ContributionCalculation,
    ContributionItem,
    ContributionItemTask,
    ContributionSnapshot,
    FormalOutcome,
    IntegrityCheck,
    VerificationRun,
)

FORMULA = "formal-task-weight-x-confirmed-responsibility-v1"


def latest_snapshot(session: Session, project_id: UUID, user: User) -> dict | None:
    get_project_access(session, user, project_id)
    snapshot = session.scalar(
        select(ContributionSnapshot)
        .where(ContributionSnapshot.project_id == project_id)
        .order_by(ContributionSnapshot.version_no.desc())
        .limit(1)
    )
    if snapshot is None:
        return None
    calculation = session.get(ContributionCalculation, snapshot.calculation_id)
    current_basis = []
    outcomes = session.scalars(
        select(FormalOutcome)
        .where(
            FormalOutcome.project_id == project_id,
            FormalOutcome.invalidated_at.is_(None),
        )
        .order_by(FormalOutcome.created_at, FormalOutcome.id)
    ).all()
    for outcome in outcomes:
        run = session.get(VerificationRun, outcome.verification_run_id)
        if stale_reason(session, run, completed=True):
            continue
        current_basis.append(
            {
                "outcome": str(outcome.id),
                "task": str(outcome.task_id),
                "weight": outcome.basis_json["task_weight"],
                "shares": {
                    uid: value
                    for uid, value in sorted(outcome.basis_json["responsibility_shares"].items())
                },
            }
        )
    current_hash = hashlib.sha256(json.dumps(current_basis, sort_keys=True).encode()).hexdigest()
    items = session.execute(
        select(ContributionItem, User)
        .join(User, User.id == ContributionItem.user_id)
        .where(ContributionItem.snapshot_id == snapshot.id)
        .order_by(ContributionItem.share.desc(), ContributionItem.user_id)
    ).all()
    members = []
    for item, person in items:
        links = session.execute(
            select(ContributionItemTask, Task)
            .join(Task, Task.id == ContributionItemTask.task_id)
            .where(ContributionItemTask.contribution_item_id == item.id)
            .order_by(Task.title)
        ).all()
        tasks = []
        for link, task in links:
            outcome = (
                session.get(FormalOutcome, link.formal_outcome_id)
                if link.formal_outcome_id
                else None
            )
            run = session.get(VerificationRun, outcome.verification_run_id) if outcome else None
            check = session.get(IntegrityCheck, run.integrity_check_id) if run else None
            evidence = [
                {
                    "criterion_id": detail["criterion_id"],
                    "evidence_id": ref["id"],
                    "version": ref["version"],
                }
                for detail in ((check.details_json or []) if check else [])
                for ref in detail.get("evidence", [])
            ]
            tasks.append(
                {
                    "task_id": str(task.id),
                    "title": task.title,
                    "responsibility_share": float(link.ratio),
                    "weight": float(outcome.basis_json["task_weight"])
                    if outcome
                    else float(task.weight),
                    "formal_outcome_id": str(outcome.id) if outcome else None,
                    "evidence": evidence,
                    "evidence_url": f"/projects/{project_id}/tasks/{task.id}/verification",
                }
            )
        members.append(
            {
                "user_id": str(person.id),
                "name": person.name or person.username or person.email,
                "share": float(item.share),
                "task_credit": float(item.task_credit),
                "tasks": tasks,
            }
        )
    return {
        "id": str(snapshot.id),
        "version": snapshot.version_no,
        "formula_version": calculation.formula_version,
        "calculated_at": calculation.calculated_at.isoformat(),
        "input_hash": calculation.input_hash,
        "stale": calculation.input_hash != current_hash,
        "members": members,
    }


def calculate(session: Session, project_id: UUID, user: User) -> dict:
    access = get_project_access(session, user, project_id, lock=True)
    if not (access.leader or access.teacher or access.staff):
        raise ApiError(
            403, "CONTRIBUTION_DENIED", "Only a project leader or course staff can calculate."
        )
    outcomes = session.scalars(
        select(FormalOutcome)
        .where(FormalOutcome.project_id == project_id, FormalOutcome.invalidated_at.is_(None))
        .order_by(FormalOutcome.created_at, FormalOutcome.id)
    ).all()
    active = []
    for outcome in outcomes:
        run = session.get(VerificationRun, outcome.verification_run_id)
        reason = stale_reason(session, run, completed=True)
        if reason:
            outcome.invalidated_at = datetime.now(UTC)
            outcome.invalidated_reason = reason
            continue
        active.append(outcome)
    if not active:
        session.commit()
        raise ApiError(409, "NO_FORMAL_OUTCOMES", "No current formal outcomes to calculate.")
    credits: dict[UUID, Decimal] = {}
    task_links: dict[UUID, list[tuple[UUID, UUID, Decimal]]] = {}
    basis = []
    for outcome in active:
        task = session.get(Task, outcome.task_id)
        weight = Decimal(outcome.basis_json["task_weight"])
        shares = {
            UUID(uid): Decimal(value)
            for uid, value in outcome.basis_json["responsibility_shares"].items()
        }
        if task is None or task.status != "completed" or weight <= 0 or sum(shares.values()) != 100:
            raise ApiError(409, "INVALID_FORMAL_BASIS", "Formal outcome basis is incomplete.")
        basis.append(
            {
                "outcome": str(outcome.id),
                "task": str(task.id),
                "weight": str(weight),
                "shares": {
                    str(uid): str(value)
                    for uid, value in sorted(shares.items(), key=lambda row: str(row[0]))
                },
            }
        )
        for uid, ratio in shares.items():
            if ratio <= 0:
                continue
            credits[uid] = credits.get(uid, Decimal()) + weight * ratio / 100
            task_links.setdefault(uid, []).append((task.id, outcome.id, ratio))
    total = sum(credits.values(), Decimal())
    if total <= 0:
        raise ApiError(409, "NO_CONTRIBUTION_CREDIT", "No positive responsibility share recorded.")
    digest = hashlib.sha256(json.dumps(basis, sort_keys=True).encode()).hexdigest()
    version = (
        session.scalar(
            select(func.max(ContributionSnapshot.version_no)).where(
                ContributionSnapshot.project_id == project_id
            )
        )
        or 0
    ) + 1
    calculation = ContributionCalculation(
        project_id=project_id,
        formula_version=FORMULA,
        status="completed",
        input_hash=digest,
        basis_version=digest,
        calculated_by=user.id,
        started_at=datetime.now(UTC),
        completed_at=datetime.now(UTC),
    )
    session.add(calculation)
    session.flush()
    snapshot = ContributionSnapshot(
        project_id=project_id,
        calculation_id=calculation.id,
        version_no=version,
        status="draft",
        created_by=user.id,
    )
    session.add(snapshot)
    session.flush()
    # Largest-remainder rounding keeps the persisted percentages exactly at 100.0000.
    exact = {uid: credit * 100 / total for uid, credit in credits.items()}
    rounded = {
        uid: value.quantize(Decimal("0.0001"), rounding=ROUND_DOWN) for uid, value in exact.items()
    }
    units = int((Decimal(100) - sum(rounded.values())) / Decimal("0.0001"))
    order = sorted(exact, key=lambda uid: (exact[uid] - rounded[uid], str(uid)), reverse=True)
    for uid in order[:units]:
        rounded[uid] += Decimal("0.0001")
    for uid in sorted(credits, key=str):
        item = ContributionItem(
            snapshot_id=snapshot.id,
            user_id=uid,
            task_credit=credits[uid],
            collaboration_credit=0,
            share=rounded[uid],
            acceptance_rate=100,
            status="formal",
            note=None,
        )
        session.add(item)
        session.flush()
        for task_id, outcome_id, ratio in task_links[uid]:
            session.add(
                ContributionItemTask(
                    contribution_item_id=item.id,
                    task_id=task_id,
                    formal_outcome_id=outcome_id,
                    ratio=ratio,
                )
            )
    session.commit()
    return latest_snapshot(session, project_id, user)
