from __future__ import annotations

from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.api.errors import ApiError
from app.api.responses import ErrorResponse, SuccessResponse, success
from app.db.models import Project, ProjectMember, User
from app.db.session import get_session

router = APIRouter(prefix="/api/examples", tags=["examples"])


class ProjectExample(BaseModel):
    id: UUID
    name: str
    description: str | None
    lifecycle: str
    lock_version: int
    updated_at: datetime

    @classmethod
    def from_project(cls, project: Project) -> ProjectExample:
        return cls(
            id=project.id,
            name=project.name,
            description=project.description,
            lifecycle=project.lifecycle,
            lock_version=project.lock_version,
            updated_at=project.updated_at,
        )


class RenameProjectRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    expected_version: int = Field(ge=0)

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Project name cannot be blank.")
        return cleaned


ERROR_RESPONSES = {
    400: {"model": ErrorResponse},
    401: {"model": ErrorResponse},
    403: {"model": ErrorResponse},
    404: {"model": ErrorResponse},
    409: {"model": ErrorResponse},
    422: {"model": ErrorResponse},
    500: {"model": ErrorResponse},
}


def project_or_404(session: Session, project_id: UUID) -> Project:
    project = session.get(Project, project_id)
    if project is None:
        raise ApiError(404, "PROJECT_NOT_FOUND", "Project not found.")
    return project


def require_project_role(
    session: Session, project_id: UUID, user_id: UUID, *, leader_only: bool = False
) -> None:
    membership = session.scalar(
        select(ProjectMember).where(
            ProjectMember.project_id == project_id,
            ProjectMember.user_id == user_id,
            ProjectMember.left_at.is_(None),
        )
    )
    if membership is None or (leader_only and membership.role != "leader"):
        raise ApiError(403, "PROJECT_ACCESS_DENIED", "Project access is denied.")


@router.get(
    "/projects/{project_id}",
    response_model=SuccessResponse[ProjectExample],
    responses=ERROR_RESPONSES,
    summary="Read a project from PostgreSQL with project membership authorization",
)
def read_project(
    project_id: UUID,
    request: Request,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> SuccessResponse[ProjectExample]:
    project = project_or_404(session, project_id)
    require_project_role(session, project_id, user.id)
    return success(ProjectExample.from_project(project), request)


@router.patch(
    "/projects/{project_id}",
    response_model=SuccessResponse[ProjectExample],
    responses=ERROR_RESPONSES,
    summary="Rename a project with an atomic version check",
)
def rename_project(
    project_id: UUID,
    payload: RenameProjectRequest,
    request: Request,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> SuccessResponse[ProjectExample]:
    project = project_or_404(session, project_id)
    require_project_role(session, project_id, user.id, leader_only=True)
    if project.lifecycle != "active":
        raise ApiError(403, "PROJECT_READ_ONLY", "This project is read-only.")

    leader_exists = (
        select(ProjectMember.id)
        .where(
            ProjectMember.project_id == project_id,
            ProjectMember.user_id == user.id,
            ProjectMember.role == "leader",
            ProjectMember.left_at.is_(None),
        )
        .exists()
    )
    row = (
        session.execute(
            update(Project)
            .where(
                Project.id == project_id,
                Project.lock_version == payload.expected_version,
                Project.lifecycle == "active",
                leader_exists,
            )
            .values(
                name=payload.name,
                lock_version=Project.lock_version + 1,
                updated_at=func.now(),
            )
            .returning(
                Project.id,
                Project.name,
                Project.description,
                Project.lifecycle,
                Project.lock_version,
                Project.updated_at,
            )
        )
        .mappings()
        .one_or_none()
    )

    if row is None:
        session.rollback()
        current = project_or_404(session, project_id)
        require_project_role(session, project_id, user.id, leader_only=True)
        if current.lifecycle != "active":
            raise ApiError(403, "PROJECT_READ_ONLY", "This project is read-only.")
        raise ApiError(
            409,
            "VERSION_CONFLICT",
            "Project changed since it was loaded. Refresh and retry.",
            details={
                "expected_version": payload.expected_version,
                "current_version": current.lock_version,
            },
        )

    session.commit()
    return success(ProjectExample(**row), request)
