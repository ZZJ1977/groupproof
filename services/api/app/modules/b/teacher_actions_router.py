"""HTTP endpoints for teacher approval and action center (Screen 44)."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request

from app.modules.b import teacher_actions_service as service
from app.modules.b.common import (
    ERROR_RESPONSES,
    CurrentUser,
    Database,
    IdempotencyKey,
    envelope,
    private_response,
    run_command,
)
from app.modules.b.teacher_actions_schemas import BatchAction, HandleAction, RemindAction

router = APIRouter(
    tags=["b-teacher-actions"],
    dependencies=[Depends(private_response)],
    responses=ERROR_RESPONSES,
)


@router.get("/teacher/classes/{course_id}/actions")
def list_actions(
    course_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
    type: str | None = Query(default=None, max_length=200),
    status: str = Query(default="all", max_length=32),
    priority: str = Query(default="all", max_length=32),
    days: int | None = Query(default=None, ge=1, le=365),
    page: int = Query(default=1, ge=1, le=200),
    page_size: int = Query(default=20, ge=1, le=100),
):
    types = [t.strip() for t in type.split(",") if t.strip()] if type else None
    return envelope(
        service.list_actions(
            session,
            user,
            course_id,
            action_types=types,
            status_filter=status,
            priority=priority,
            days=days,
            page=page,
            page_size=page_size,
        ),
        request,
    )


@router.post("/teacher/classes/{course_id}/actions/batch")
def batch_actions(
    course_id: UUID,
    command: BatchAction,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return run_command(
        session,
        request,
        actor=user,
        operation=f"teacher.actions.batch:{course_id}",
        idempotency_key=key,
        payload=command.model_dump(mode="json"),
        execute=lambda: service.batch_actions(session, user, course_id, command, request),
    )


@router.post("/teacher/classes/{course_id}/actions/{action_id}/handle")
def handle_action(
    course_id: UUID,
    action_id: str,
    command: HandleAction,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return run_command(
        session,
        request,
        actor=user,
        operation=f"teacher.actions.handle:{course_id}:{action_id}",
        idempotency_key=key,
        payload=command.model_dump(mode="json"),
        execute=lambda: service.handle_action(
            session, user, course_id, action_id, command, request
        ),
    )


@router.post("/teacher/classes/{course_id}/actions/{action_id}/remind")
def remind_action(
    course_id: UUID,
    action_id: str,
    command: RemindAction,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return run_command(
        session,
        request,
        actor=user,
        operation=f"teacher.actions.remind:{course_id}:{action_id}",
        idempotency_key=key,
        payload=command.model_dump(mode="json"),
        execute=lambda: service.remind_action(
            session, user, course_id, action_id, command, request
        ),
    )
