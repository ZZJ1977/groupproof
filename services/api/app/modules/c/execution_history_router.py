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
    session: Session,
    actor: User,
    project_id: UUID,
    task_id: UUID,
    *,
    page: int,
    page_size: int,
    focus_event_id: UUID | None = None,
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
    if page < 1 or not 1 <= page_size <= 100:
        raise ApiError(422, "INVALID_PAGINATION", "Invalid page or page_size.")
    conditions = (ProgressEvent.project_id == project_id, ProgressEvent.task_id == task_id)
    query = select(ProgressEvent, User.name).join(User, User.id == ProgressEvent.actor_id)
    if focus_event_id is not None:
        # Keep the focus position, total and selected rows in one statement so
        # concurrent progress writes cannot shift the target off the returned page.
        ranked = (
            select(
                ProgressEvent.id.label("id"),
                func.row_number()
                .over(order_by=(ProgressEvent.created_at.desc(), ProgressEvent.id.asc()))
                .label("position"),
                func.count().over().label("total"),
            )
            .where(*conditions)
            .cte("ranked_progress")
        )
        position = select(ranked.c.position).where(ranked.c.id == focus_event_id).scalar_subquery()
        start = ((position - 1) // page_size) * page_size
        focused_rows = session.execute(
            query.add_columns(ranked.c.position, ranked.c.total)
            .join(ranked, ranked.c.id == ProgressEvent.id)
            .where(ranked.c.position > start, ranked.c.position <= start + page_size)
            .order_by(ranked.c.position)
            .execution_options(populate_existing=True)
        ).all()
        if not focused_rows:
            raise ApiError(
                404, "PROGRESS_EVENT_NOT_FOUND", "Progress event not found in this task."
            )
        page = (focused_rows[0].position - 1) // page_size + 1
        total = focused_rows[0].total
        rows = [(row, name) for row, name, _, _ in focused_rows]
    else:
        total = (
            session.scalar(select(func.count()).select_from(ProgressEvent).where(*conditions)) or 0
        )
        rows = session.execute(
            query.where(*conditions)
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
    focus_event_id: UUID | None = None,
):
    return success(
        list_progress_history(
            session,
            actor,
            project_id,
            task_id,
            page=page,
            page_size=page_size,
            focus_event_id=focus_event_id,
        ),
        request,
    )
