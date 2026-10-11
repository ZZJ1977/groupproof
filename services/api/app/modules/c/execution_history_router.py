"""Project-authorized C progress history from persisted events, with bounded paging."""

from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.api.responses import SuccessResponse, success
from app.db.models import ProgressEvent, Task, User
from app.modules.c.evidence_router import (
    ERROR_RESPONSES,
    CurrentUser,
    Database,
    private_response,
)
from app.modules.c.permissions import get_project_access


class ProgressHistoryEventDTO(BaseModel):
    id: UUID
    actor_name: str
    from_status: str | None
    to_status: str | None
    progress_before: int | None
    progress_after: int | None
    reason: str | None
    created_at: datetime


class ProgressHistoryPageDTO(BaseModel):
    items: list[ProgressHistoryEventDTO]
    page: int
    page_size: int
    total: int


def list_progress_history(
    session: Session, actor: User, project_id: UUID, task_id: UUID, *, page: int, page_size: int
) -> dict:
    actor = session.scalar(
        select(User).where(User.id == actor.id).execution_options(populate_existing=True)
    )
    if actor is None:
        raise ApiError(401, "UNAUTHENTICATED", "Authentication is required.")
    get_project_access(session, actor, project_id)
    task = session.scalar(select(Task.id).where(Task.id == task_id, Task.project_id == project_id))
    if task is None:
        raise ApiError(404, "TASK_NOT_FOUND", "Task not found in the authorized project.")
    conditions = (ProgressEvent.project_id == project_id, ProgressEvent.task_id == task_id)
    total = session.scalar(select(func.count()).select_from(ProgressEvent).where(*conditions)) or 0
    rows = session.execute(
        select(ProgressEvent, User.name)
        .join(User, User.id == ProgressEvent.actor_id)
        .where(*conditions)
        .order_by(ProgressEvent.created_at.desc(), ProgressEvent.id.asc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .execution_options(populate_existing=True)
    )
    return {
        "items": [
            {
                "id": row.id,
                "actor_name": name,
                "from_status": row.from_status,
                "to_status": row.to_status,
                "progress_before": row.progress_before,
                "progress_after": row.progress_after,
                "reason": row.reason,
                "created_at": row.created_at,
            }
            for row, name in rows
        ],
        "page": page,
        "page_size": page_size,
        "total": total,
    }


router = APIRouter(
    tags=["c-task-execution"], dependencies=[Depends(private_response)], responses=ERROR_RESPONSES
)


@router.get(
    "/projects/{project_id}/tasks/{task_id}/progress-history",
    response_model=SuccessResponse[ProgressHistoryPageDTO],
)
def progress_history(
    project_id: UUID,
    task_id: UUID,
    request: Request,
    session: Database,
    actor: CurrentUser,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=10, ge=1, le=100),
):
    return success(
        list_progress_history(session, actor, project_id, task_id, page=page, page_size=page_size),
        request,
    )
