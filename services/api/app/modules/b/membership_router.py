"""B-8 HTTP routes (mounted under /api/v1): member removal/leaving and approval."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Request

from app.modules.b import membership_service as service
from app.modules.b.common import (
    ERROR_RESPONSES,
    CurrentUser,
    Database,
    IdempotencyKey,
    envelope,
    private_response,
    run_command,
)
from app.modules.b.membership_schemas import (
    DecideMembershipChange,
    EditMembershipChange,
    StartMembershipChange,
)

router = APIRouter(
    tags=["b-membership"], dependencies=[Depends(private_response)], responses=ERROR_RESPONSES
)


def _write(session, request, user, key, operation, payload, execute, status_code=200):
    return run_command(
        session,
        request,
        actor=user,
        operation=operation,
        idempotency_key=key,
        payload=payload,
        execute=execute,
        status_code=status_code,
    )


@router.get("/groups/{group_id}/members/{member_id}/open-tasks")
def open_tasks(
    group_id: UUID, member_id: UUID, request: Request, session: Database, user: CurrentUser
):
    return envelope(service.open_tasks(session, user, group_id, member_id), request)


@router.get("/groups/{group_id}/membership-changes")
def group_changes(group_id: UUID, request: Request, session: Database, user: CurrentUser):
    return envelope(service.group_changes(session, user, group_id), request)


@router.post("/groups/{group_id}/membership-changes", status_code=201)
def start(
    group_id: UUID,
    command: StartMembershipChange,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return _write(
        session,
        request,
        user,
        key,
        f"membership.start:{group_id}",
        command.model_dump(mode="json"),
        lambda: service.start(session, user, group_id, command, request),
        201,
    )


@router.put("/membership-changes/{request_id}")
def edit(
    request_id: UUID,
    command: EditMembershipChange,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return _write(
        session,
        request,
        user,
        key,
        f"membership.edit:{request_id}",
        command.model_dump(mode="json"),
        lambda: service.edit(session, user, request_id, command, request),
    )


@router.post("/membership-changes/{request_id}/decide")
def decide(
    request_id: UUID,
    command: DecideMembershipChange,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return _write(
        session,
        request,
        user,
        key,
        f"membership.decide:{request_id}",
        command.model_dump(mode="json"),
        lambda: service.decide(session, user, request_id, command, request),
    )


@router.get("/courses/{course_id}/membership-changes")
def course_changes(
    course_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
    status: str | None = None,
):
    return envelope(service.course_changes(session, user, course_id, status), request)
