from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request

from app.api.responses import SuccessResponse, success
from app.modules.c.activity_ports import ActivityKind, ActivitySourcePort, get_activity_source_port
from app.modules.c.activity_schemas import (
    ActivityDTO,
    ActivityHistoryDTO,
    ActivityPageDTO,
    ActivityStateDTO,
    ActivityStatus,
    AssociateActivity,
    DecideActivity,
)
from app.modules.c.activity_service import (
    change_activity,
    get_activity,
    get_activity_history,
    query_activities,
)
from app.modules.c.evidence_router import (
    ERROR_RESPONSES,
    CurrentUser,
    Database,
    IdempotencyKey,
    commit_command,
    private_response,
)

router = APIRouter(
    tags=["c-activity"], dependencies=[Depends(private_response)], responses=ERROR_RESPONSES
)
Sources = Annotated[ActivitySourcePort, Depends(get_activity_source_port)]


@router.get(
    "/projects/{project_id}/activities/{source_type}",
    response_model=SuccessResponse[ActivityPageDTO],
)
def collection(
    project_id: UUID,
    source_type: ActivityKind,
    request: Request,
    session: Database,
    user: CurrentUser,
    sources: Sources,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    task_id: UUID | None = None,
    status: ActivityStatus | None = None,
    author_id: UUID | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    q: str | None = Query(default=None, max_length=200),
    group_id: str | None = Query(default=None, min_length=1, max_length=200),
    record_kind: str | None = Query(default=None, alias="kind", min_length=1, max_length=64),
):
    return success(
        query_activities(
            session,
            user,
            project_id,
            source_type,
            sources,
            page=page,
            page_size=page_size,
            task_id=task_id,
            status=status,
            author_id=author_id,
            since=since,
            until=until,
            q=q,
            group_id=group_id,
            record_kind=record_kind,
        ),
        request,
    )


@router.get(
    "/projects/{project_id}/activities/{source_type}/{source_id}",
    response_model=SuccessResponse[ActivityDTO],
)
def detail(
    project_id: UUID,
    source_type: ActivityKind,
    source_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
    sources: Sources,
):
    return success(
        get_activity(session, user, project_id, source_type, source_id, sources), request
    )


@router.get(
    "/projects/{project_id}/activities/{source_type}/{source_id}/history",
    response_model=SuccessResponse[ActivityHistoryDTO],
)
def history(
    project_id: UUID,
    source_type: ActivityKind,
    source_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
):
    return success(get_activity_history(session, user, project_id, source_type, source_id), request)


@router.put(
    "/projects/{project_id}/activities/{source_type}/{source_id}/association",
    response_model=SuccessResponse[ActivityStateDTO],
)
def associate(
    project_id: UUID,
    source_type: ActivityKind,
    source_id: UUID,
    command: AssociateActivity,
    request: Request,
    session: Database,
    user: CurrentUser,
    sources: Sources,
    idempotency_key: IdempotencyKey,
):
    return success(
        commit_command(
            session,
            lambda: change_activity(
                session, user, project_id, source_type, source_id, command, idempotency_key, sources
            ),
        ),
        request,
    )


@router.post(
    "/projects/{project_id}/activities/{source_type}/{source_id}/decisions",
    response_model=SuccessResponse[ActivityStateDTO],
)
def decide(
    project_id: UUID,
    source_type: ActivityKind,
    source_id: UUID,
    command: DecideActivity,
    request: Request,
    session: Database,
    user: CurrentUser,
    sources: Sources,
    idempotency_key: IdempotencyKey,
):
    return success(
        commit_command(
            session,
            lambda: change_activity(
                session, user, project_id, source_type, source_id, command, idempotency_key, sources
            ),
        ),
        request,
    )
