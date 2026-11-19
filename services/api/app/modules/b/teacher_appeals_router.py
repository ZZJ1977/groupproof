"""HTTP endpoints for student appeal submission and teacher adjudication."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request

from app.modules.b import teacher_appeals_service as service
from app.modules.b.common import (
    ERROR_RESPONSES,
    CurrentUser,
    Database,
    IdempotencyKey,
    envelope,
    private_response,
    run_command,
)
from app.modules.b.teacher_appeals_schemas import (
    HandleAppealRequest,
    SubmitAppealRequest,
    SupplementAppealRequest,
)

router = APIRouter(
    tags=["b-teacher-appeals"],
    dependencies=[Depends(private_response)],
    responses=ERROR_RESPONSES,
)


@router.get("/teacher/classes/{course_id}/appeals")
def list_appeals(
    course_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
    status: str = Query(default="all"),
):
    return envelope(service.list_teacher_appeals(session, user, course_id, status=status), request)


@router.get("/teacher/classes/{course_id}/appeals/{appeal_id}")
def appeal_detail(
    course_id: UUID,
    appeal_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
):
    return envelope(service.get_appeal_detail(session, user, course_id, appeal_id), request)


@router.post("/teacher/classes/{course_id}/appeals/{appeal_id}/handle")
def handle_appeal(
    course_id: UUID,
    appeal_id: UUID,
    command: HandleAppealRequest,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return run_command(
        session,
        request,
        actor=user,
        operation=f"teacher.appeals.handle:{course_id}:{appeal_id}",
        idempotency_key=key,
        payload=command.model_dump(mode="json"),
        execute=lambda: service.handle_appeal(
            session, user, course_id, appeal_id, command, request
        ),
    )


@router.post("/courses/{course_id}/appeals", status_code=201)
def submit_appeal(
    course_id: UUID,
    command: SubmitAppealRequest,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return run_command(
        session,
        request,
        actor=user,
        operation=f"course.appeals.submit:{course_id}",
        idempotency_key=key,
        payload=command.model_dump(mode="json"),
        execute=lambda: service.submit_appeal(session, user, course_id, command, request),
        status_code=201,
    )


@router.post("/courses/{course_id}/appeals/{appeal_id}/supplement")
def supplement_appeal(
    course_id: UUID,
    appeal_id: UUID,
    command: SupplementAppealRequest,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return run_command(
        session,
        request,
        actor=user,
        operation=f"course.appeals.supplement:{course_id}:{appeal_id}",
        idempotency_key=key,
        payload=command.model_dump(mode="json"),
        execute=lambda: service.supplement_appeal(
            session, user, course_id, appeal_id, command, request
        ),
    )


@router.get("/courses/{course_id}/appeals/mine")
def my_appeals(course_id: UUID, request: Request, session: Database, user: CurrentUser):
    return envelope(service.list_my_appeals(session, user, course_id), request)
