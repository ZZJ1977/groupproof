"""Authorized, bounded selector data for C pages; never a second B write API."""

from uuid import UUID

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.api.responses import SuccessResponse, success
from app.db.models import (
    AcceptanceCriterion,
    FunctionalModule,
    Milestone,
    ProjectMember,
    Requirement,
    Task,
    User,
)
from app.modules.c.discussion_service import permitted_notification_users
from app.modules.c.evidence_router import CurrentUser, Database, private_response
from app.modules.c.models import Evidence
from app.modules.c.permissions import get_project_access, task_in_frozen_plan
from app.modules.c.school_email import has_verified_school_email


class CSelectorDTO(BaseModel):
    id: UUID
    title: str


class CCriterionSelectorDTO(BaseModel):
    id: UUID
    text: str
    version: int


class CTaskSelectorDTO(CSelectorDTO):
    description: str | None = None
    status: str
    can_associate: bool
    can_capture_evidence: bool
    criteria: list[CCriterionSelectorDTO]


class CContextProjectDTO(BaseModel):
    id: UUID
    name: str
    lifecycle: str
    setup_status: str


class CContextActorDTO(BaseModel):
    id: UUID
    is_member: bool
    is_leader: bool
    is_teacher: bool


class CContextPermissionsDTO(BaseModel):
    can_manage_activity: bool
    can_manage_files: bool
    can_discuss: bool
    can_capture_evidence: bool


class CProjectContextDTO(BaseModel):
    project: CContextProjectDTO
    actor: CContextActorDTO
    permissions: CContextPermissionsDTO
    tasks: list[CTaskSelectorDTO]
    members: list[CSelectorDTO]
    mention_targets: list[CSelectorDTO] = Field(default_factory=list)
    evidence_authors: list[CSelectorDTO] = Field(default_factory=list)
    requirements: list[CSelectorDTO]
    modules: list[CSelectorDTO]
    milestones: list[CSelectorDTO]


def project_context(session: Session, actor: User, project_id: UUID) -> dict:
    actor = session.scalar(
        select(User).where(User.id == actor.id).execution_options(populate_existing=True)
    )
    if actor is None:
        raise ApiError(401, "UNAUTHENTICATED", "Authentication is required.")
    access = get_project_access(session, actor, project_id)
    active = (
        has_verified_school_email(session, actor)
        and access.project.lifecycle == "active"
        and (access.course is None or access.course.status == "active")
    )
    contributor = active and (access.member or access.teacher)
    execution = contributor and access.project.setup_status == "frozen"

    def bounded(query):
        rows = list(session.scalars(query.limit(1001).execution_options(populate_existing=True)))
        if len(rows) > 1000:
            raise ApiError(
                409, "CONTEXT_LIMIT_EXCEEDED", "Project selectors exceed the page limit."
            )
        return rows

    tasks = bounded(select(Task).where(Task.project_id == project_id).order_by(Task.title, Task.id))
    criteria = bounded(
        select(AcceptanceCriterion)
        .join(Task, AcceptanceCriterion.task_id == Task.id)
        .where(Task.project_id == project_id)
        .order_by(AcceptanceCriterion.sort_order, AcceptanceCriterion.id)
    )
    by_task: dict = {}
    for criterion in criteria:
        by_task.setdefault(criterion.task_id, []).append(
            {"id": criterion.id, "text": criterion.text, "version": criterion.lock_version}
        )
    members = bounded(
        select(User)
        .join(ProjectMember, ProjectMember.user_id == User.id)
        .where(
            ProjectMember.project_id == project_id,
            ProjectMember.left_at.is_(None),
            User.status == "active",
            User.global_role == "student",
        )
        .order_by(User.name, User.id)
    )
    # Mention targets have current read access. Historical evidence authors are
    # a separate read-only attribution set, never a grant of membership or access.
    _, reader_ids = permitted_notification_users(session, access)
    mention_targets = bounded(
        select(User).where(User.id.in_(reader_ids)).order_by(User.name, User.id)
    )
    evidence_authors = bounded(
        select(User)
        .where(User.id.in_(select(Evidence.author_id).where(Evidence.project_id == project_id)))
        .order_by(User.name, User.id)
    )
    result = {
        "project": {
            "id": access.project.id,
            "name": access.project.name,
            "lifecycle": access.project.lifecycle,
            "setup_status": access.project.setup_status,
        },
        "actor": {
            "id": actor.id,
            "is_member": access.member,
            "is_leader": access.leader,
            "is_teacher": access.teacher,
        },
        "permissions": {
            "can_manage_activity": execution,
            "can_manage_files": active and access.member,
            "can_discuss": contributor,
            "can_capture_evidence": execution,
        },
        "tasks": [
            {
                "id": task.id,
                "title": task.title,
                "description": task.description,
                "status": task.status,
                "can_associate": execution and task_in_frozen_plan(access.latest_plan, task.id),
                "can_capture_evidence": execution
                and task_in_frozen_plan(access.latest_plan, task.id)
                and task.status in {"in_progress", "pending_submission"},
                "criteria": by_task.get(task.id, []),
            }
            for task in tasks
        ],
        "members": [{"id": member.id, "title": member.name} for member in members],
        "mention_targets": [{"id": member.id, "title": member.name} for member in mention_targets],
        "evidence_authors": [
            {"id": author.id, "title": author.name} for author in evidence_authors
        ],
    }
    for name, model in [
        ("requirements", Requirement),
        ("modules", FunctionalModule),
        ("milestones", Milestone),
    ]:
        result[name] = [
            {"id": row.id, "title": row.title if hasattr(row, "title") else row.name}
            for row in bounded(
                select(model).where(model.project_id == project_id).order_by(model.id)
            )
        ]
    return result


router = APIRouter(tags=["c-context"], dependencies=[Depends(private_response)])


@router.get("/projects/{project_id}/c-context", response_model=SuccessResponse[CProjectContextDTO])
def context(project_id: UUID, request: Request, session: Database, user: CurrentUser):
    return success(project_context(session, user, project_id), request)
