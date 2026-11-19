"""Versioned collaboration notes, evidence-linked appeals, and archived shares."""

from datetime import UTC, datetime
from decimal import ROUND_DOWN, Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.api.errors import ApiError
from app.api.responses import success
from app.db.models import Course, CourseStaff, ProjectMember, Task, User
from app.db.session import get_session
from app.modules.a.inbox import close_action_items_by_source, create_action_item
from app.modules.c.models import Evidence
from app.modules.c.permissions import get_project_access
from app.modules.d.models import (
    AppealDecision,
    CollaborationNote,
    ContributionAppeal,
    ContributionArchive,
    ContributionItem,
    ContributionItemTask,
    ContributionSnapshot,
)

router = APIRouter(
    prefix="/api/v1/projects/{project_id}/contribution", tags=["d-contribution-week7"]
)


class NoteInput(BaseModel):
    body: str = Field(min_length=1, max_length=10000)
    restore_revision: int | None = Field(default=None, ge=1)


class AppealInput(BaseModel):
    task_id: UUID
    evidence_id: UUID
    reason: str = Field(min_length=1, max_length=4000)


class DecisionInput(BaseModel):
    action: str = Field(pattern="^(uphold|adjust|return)$")
    reason: str = Field(min_length=1, max_length=4000)
    adjusted_share: Decimal | None = Field(default=None, ge=0, le=100)


def latest_contribution(session: Session, project_id: UUID) -> ContributionSnapshot | None:
    return session.scalar(
        select(ContributionSnapshot)
        .where(ContributionSnapshot.project_id == project_id)
        .order_by(ContributionSnapshot.version_no.desc())
        .limit(1)
    )


def archive_contribution(
    session: Session,
    project_id: UUID,
    source_kind: str,
    source_id: UUID,
    snapshot_id: UUID | None = None,
) -> ContributionArchive | None:
    snapshot = (
        session.get(ContributionSnapshot, snapshot_id)
        if snapshot_id
        else latest_contribution(session, project_id)
    )
    if snapshot is None:
        return None
    if snapshot.project_id != project_id:
        raise ApiError(
            422,
            "CONTRIBUTION_SNAPSHOT_INVALID",
            "Contribution snapshot belongs to another project.",
        )
    existing = session.scalar(
        select(ContributionArchive).where(
            ContributionArchive.source_kind == source_kind,
            ContributionArchive.source_id == source_id,
        )
    )
    if existing:
        return existing
    items = session.scalars(
        select(ContributionItem).where(ContributionItem.snapshot_id == snapshot.id)
    ).all()
    row = ContributionArchive(
        project_id=project_id,
        snapshot_id=snapshot.id,
        source_kind=source_kind,
        source_id=source_id,
        data={
            "version": snapshot.version_no,
            "members": [
                {
                    "user_id": str(item.user_id),
                    "share": str(item.share),
                    "task_credit": str(item.task_credit),
                }
                for item in items
            ],
        },
    )
    session.add(row)
    return row


@router.get("/members/{member_id}/notes")
def read_notes(
    project_id: UUID,
    member_id: UUID,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    get_project_access(session, user, project_id)
    notes = session.scalars(
        select(CollaborationNote)
        .where(CollaborationNote.project_id == project_id, CollaborationNote.member_id == member_id)
        .order_by(CollaborationNote.revision.desc())
    ).all()
    return success(
        [
            {
                "revision": row.revision,
                "body": row.body,
                "author_id": str(row.author_id),
                "created_at": row.created_at.isoformat(),
            }
            for row in notes
        ],
        request,
    )


@router.post("/members/{member_id}/notes", status_code=201)
def save_note(
    project_id: UUID,
    member_id: UUID,
    payload: NoteInput,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    access = get_project_access(session, user, project_id, lock=True)
    if not (access.leader or (access.member and user.id == member_id)):
        raise ApiError(403, "NOTE_WRITE_DENIED", "Only this member or the leader may edit.")
    member = session.scalar(
        select(ProjectMember).where(
            ProjectMember.project_id == project_id,
            ProjectMember.user_id == member_id,
            ProjectMember.left_at.is_(None),
        )
    )
    if member is None or access.project.lifecycle != "active":
        raise ApiError(409, "NOTE_READ_ONLY", "Member or project is inactive.")
    source = None
    if payload.restore_revision is not None:
        source = session.scalar(
            select(CollaborationNote).where(
                CollaborationNote.project_id == project_id,
                CollaborationNote.member_id == member_id,
                CollaborationNote.revision == payload.restore_revision,
            )
        )
        if source is None:
            raise ApiError(404, "NOTE_REVISION_NOT_FOUND", "Revision not found.")
    latest = (
        session.scalar(
            select(func.max(CollaborationNote.revision)).where(
                CollaborationNote.project_id == project_id, CollaborationNote.member_id == member_id
            )
        )
        or 0
    )
    row = CollaborationNote(
        project_id=project_id,
        member_id=member_id,
        author_id=user.id,
        revision=latest + 1,
        body=source.body if source else payload.body.strip(),
        restored_from=source.id if source else None,
    )
    session.add(row)
    session.commit()
    return success({"revision": row.revision, "body": row.body}, request)


@router.get("/appeals")
def list_appeals(
    project_id: UUID,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    access = get_project_access(session, user, project_id)
    query = select(ContributionAppeal).where(ContributionAppeal.project_id == project_id)
    if not access.staff and not access.leader:
        query = query.where(ContributionAppeal.member_id == user.id)
    rows = session.scalars(query.order_by(ContributionAppeal.created_at.desc())).all()
    return success(
        [
            {
                "id": str(row.id),
                "member_id": str(row.member_id),
                "task_id": str(row.task_id),
                "evidence_id": str(row.evidence_id),
                "reason": row.reason,
                "status": row.status,
                "snapshot_id": str(row.snapshot_id),
                "created_at": row.created_at.isoformat(),
            }
            for row in rows
        ],
        request,
    )


@router.post("/appeals", status_code=201)
def submit_appeal(
    project_id: UUID,
    payload: AppealInput,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    access = get_project_access(session, user, project_id, lock=True)
    if not access.member or access.project.lifecycle != "active":
        raise ApiError(403, "APPEAL_DENIED", "Only an active project member may appeal.")
    snapshot = latest_contribution(session, project_id)
    task = session.get(Task, payload.task_id)
    evidence = session.get(Evidence, payload.evidence_id)
    if (
        snapshot is None
        or task is None
        or task.project_id != project_id
        or evidence is None
        or (
            evidence.project_id != project_id
            or evidence.task_id != task.id
            or evidence.status != "formal"
        )
    ):
        raise ApiError(
            422, "APPEAL_BASIS_INVALID", "Choose a contribution task and formal evidence."
        )
    item = session.scalar(
        select(ContributionItem).where(
            ContributionItem.snapshot_id == snapshot.id, ContributionItem.user_id == user.id
        )
    )
    if item is None or session.get(ContributionItemTask, (item.id, task.id)) is None:
        raise ApiError(422, "APPEAL_TASK_INVALID", "Task is not part of this contribution.")
    appeal = ContributionAppeal(
        project_id=project_id,
        snapshot_id=snapshot.id,
        member_id=user.id,
        task_id=task.id,
        evidence_id=evidence.id,
        reason=payload.reason.strip(),
        status="pending",
    )
    session.add(appeal)
    session.flush()
    course = session.get(Course, access.project.course_id) if access.project.course_id else None
    teachers = {course.owner_id} if course else set()
    if course:
        teachers.update(
            session.scalars(
                select(CourseStaff.user_id).where(
                    CourseStaff.course_id == course.id,
                    CourseStaff.role == "teacher",
                    CourseStaff.left_at.is_(None),
                )
            ).all()
        )
    for teacher_id in teachers:
        create_action_item(
            session,
            recipient=teacher_id,
            category="appeal",
            title="贡献申诉待处理",
            description=payload.reason.strip(),
            target={"kind": "appeal", "id": appeal.id, "course_id": course.id},
            source_key=f"contribution-appeal:{appeal.id}",
        )
    session.commit()
    return success({"id": str(appeal.id), "status": appeal.status}, request)


def adjusted_snapshot(
    session: Session, appeal: ContributionAppeal, requested: Decimal, teacher_id: UUID
) -> ContributionSnapshot:
    previous = session.get(ContributionSnapshot, appeal.snapshot_id)
    items = session.scalars(
        select(ContributionItem).where(ContributionItem.snapshot_id == previous.id)
    ).all()
    shares = {item.user_id: Decimal(str(item.share)) for item in items}
    if appeal.member_id not in shares or len(shares) < 2:
        raise ApiError(409, "APPEAL_ADJUSTMENT_INVALID", "At least two members are needed.")
    others = {uid: value for uid, value in shares.items() if uid != appeal.member_id}
    total = sum(others.values())
    if total <= 0 and requested != 100:
        raise ApiError(409, "APPEAL_ADJUSTMENT_INVALID", "Other members have no share.")
    updated = {appeal.member_id: requested}
    remaining = Decimal(100) - requested
    for uid, share in others.items():
        updated[uid] = (
            (remaining * share / total).quantize(Decimal("0.0001"), rounding=ROUND_DOWN)
            if total
            else Decimal(0)
        )
    remainder = Decimal(100) - sum(updated.values())
    updated[sorted(others, key=str)[0]] += remainder
    version = (
        session.scalar(
            select(func.max(ContributionSnapshot.version_no)).where(
                ContributionSnapshot.project_id == appeal.project_id
            )
        )
        or 0
    ) + 1
    snapshot = ContributionSnapshot(
        project_id=appeal.project_id,
        calculation_id=previous.calculation_id,
        version_no=version,
        status="frozen",
        created_by=teacher_id,
        frozen_at=datetime.now(UTC),
    )
    session.add(snapshot)
    session.flush()
    for item in items:
        copy = ContributionItem(
            snapshot_id=snapshot.id,
            user_id=item.user_id,
            task_credit=item.task_credit,
            collaboration_credit=item.collaboration_credit,
            share=updated[item.user_id],
            acceptance_rate=item.acceptance_rate,
            status="formal",
            note=item.note,
        )
        session.add(copy)
        session.flush()
        for link in session.scalars(
            select(ContributionItemTask).where(ContributionItemTask.contribution_item_id == item.id)
        ):
            session.add(
                ContributionItemTask(
                    contribution_item_id=copy.id,
                    task_id=link.task_id,
                    formal_outcome_id=link.formal_outcome_id,
                    ratio=link.ratio,
                )
            )
    return snapshot


@router.post("/appeals/{appeal_id}/decision")
def decide_appeal(
    project_id: UUID,
    appeal_id: UUID,
    payload: DecisionInput,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    access = get_project_access(session, user, project_id, lock=True)
    if not access.teacher:
        raise ApiError(403, "APPEAL_REVIEW_DENIED", "Only the course teacher may decide.")
    appeal = session.scalar(
        select(ContributionAppeal)
        .where(ContributionAppeal.id == appeal_id, ContributionAppeal.project_id == project_id)
        .with_for_update()
    )
    if appeal is None:
        raise ApiError(404, "APPEAL_NOT_FOUND", "Appeal not found.")
    if appeal.status != "pending":
        raise ApiError(409, "APPEAL_ALREADY_DECIDED", "Appeal was already decided.")
    if not payload.reason.strip() or (payload.action == "adjust") != (
        payload.adjusted_share is not None
    ):
        raise ApiError(422, "APPEAL_DECISION_INVALID", "Adjustment share and reason are required.")
    snapshot = (
        adjusted_snapshot(session, appeal, payload.adjusted_share, user.id)
        if payload.action == "adjust"
        else None
    )
    appeal.status = {"uphold": "upheld", "adjust": "adjusted", "return": "returned"}[payload.action]
    session.add(
        AppealDecision(
            appeal_id=appeal.id,
            teacher_id=user.id,
            action=payload.action,
            reason=payload.reason.strip(),
            adjusted_share=payload.adjusted_share,
            resulting_snapshot_id=snapshot.id if snapshot else None,
        )
    )
    close_action_items_by_source(session, f"contribution-appeal:{appeal.id}", actor=user.id)
    session.commit()
    return success(
        {"status": appeal.status, "snapshot_id": str(snapshot.id) if snapshot else None}, request
    )
