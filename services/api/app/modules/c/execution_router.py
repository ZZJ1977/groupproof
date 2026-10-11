"""C2 public execution routes. Mount explicitly under the canonical /api/v1 router.

The existing get_current_user remains closed in production until A delivers real
authentication. No alternate user header, role selection, or session bypass exists.
"""

from uuid import UUID

from fastapi import APIRouter, Depends, Header, Request, Response
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.api.responses import ErrorResponse, SuccessResponse, success
from app.db.models import User
from app.db.session import get_session
from app.modules.c.execution_schemas import (
    PrepareSubmissionRequest,
    PrepareSubmissionView,
    StartTaskRequest,
    TaskExecutionView,
    UpdateProgressRequest,
)
from app.modules.c.task_execution import (
    SqlExecutionRepository,
    TaskExecutionService,
    TaskSubmissionService,
)

router = APIRouter(prefix="/tasks", tags=["c-task-execution"])
ERROR_RESPONSES = {status: {"model": ErrorResponse} for status in (401, 403, 404, 409, 422, 503)}


def get_execution_service(session: Session = Depends(get_session)) -> TaskExecutionService:
    return TaskExecutionService(SqlExecutionRepository(session))


def get_submission_service(session: Session = Depends(get_session)) -> TaskSubmissionService:
    return TaskSubmissionService(session)


@router.get(
    "/{task_id}/execution",
    response_model=SuccessResponse[TaskExecutionView],
    responses=ERROR_RESPONSES,
)
def get_execution(
    task_id: UUID,
    request: Request,
    response: Response,
    user: User = Depends(get_current_user),
    service: TaskExecutionService = Depends(get_execution_service),
) -> SuccessResponse[TaskExecutionView]:
    response.headers["Cache-Control"] = "private, no-store"
    return success(service.read(task_id, user), request)


@router.post(
    "/{task_id}/start",
    response_model=SuccessResponse[TaskExecutionView],
    responses=ERROR_RESPONSES,
)
def start_task(
    task_id: UUID,
    payload: StartTaskRequest,
    request: Request,
    response: Response,
    user: User = Depends(get_current_user),
    service: TaskExecutionService = Depends(get_execution_service),
) -> SuccessResponse[TaskExecutionView]:
    response.headers["Cache-Control"] = "private, no-store"
    return success(service.start(task_id, user, payload.expected_version), request)


@router.patch(
    "/{task_id}/progress",
    response_model=SuccessResponse[TaskExecutionView],
    responses=ERROR_RESPONSES,
)
def update_progress(
    task_id: UUID,
    payload: UpdateProgressRequest,
    request: Request,
    response: Response,
    user: User = Depends(get_current_user),
    service: TaskExecutionService = Depends(get_execution_service),
) -> SuccessResponse[TaskExecutionView]:
    response.headers["Cache-Control"] = "private, no-store"
    return success(
        service.update_progress(
            task_id, user, payload.expected_version, payload.progress, payload.reason
        ),
        request,
    )


@router.post(
    "/{task_id}/prepare-submission",
    response_model=SuccessResponse[PrepareSubmissionView],
    responses=ERROR_RESPONSES,
)
def prepare_submission(
    task_id: UUID,
    payload: PrepareSubmissionRequest,
    request: Request,
    response: Response,
    idempotency_key: str = Header(alias="Idempotency-Key", min_length=1, max_length=128),
    user: User = Depends(get_current_user),
    service: TaskSubmissionService = Depends(get_submission_service),
) -> SuccessResponse[PrepareSubmissionView]:
    response.headers["Cache-Control"] = "private, no-store"
    return success(service.prepare(task_id, user, payload, idempotency_key), request)
