"""B-7 HTTP route (mounted under /api/v1): the task query behind pages 11–13."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Request

from app.modules.b import tasks_view_service
from app.modules.b.common import ERROR_RESPONSES, CurrentUser, Database, envelope, private_response

router = APIRouter(
    tags=["b-tasks"], dependencies=[Depends(private_response)], responses=ERROR_RESPONSES
)


@router.get("/projects/{project_id}/tasks")
def tasks(
    project_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
    view: str = "tree",
    q: str = "",
    status: str = "",
    assignee: str = "",
    module: str = "",
    milestone: str = "",
    sort: str = "",
    page: int = 1,
    page_size: int = 20,
):
    return envelope(
        tasks_view_service.list_tasks(
            session,
            user,
            project_id,
            view=view,
            q=q,
            status=status,
            assignee=assignee,
            module=module,
            milestone=milestone,
            sort=sort,
            page=page,
            page_size=page_size,
        ),
        request,
    )
