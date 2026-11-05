"""B-2 HTTP routes (mounted under /api/v1)."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request

from app.modules.b import groups_service as service
from app.modules.b.common import (
    ERROR_RESPONSES,
    CurrentUser,
    Database,
    IdempotencyKey,
    envelope,
    private_response,
    run_command,
)
from app.modules.b.groups_schemas import (
    ConfirmLeaderChange,
    CreateGroup,
    DecideInvitation,
    Invite,
    RespondInvitation,
    StartLeaderChange,
)

router = APIRouter(
    tags=["b-groups"], dependencies=[Depends(private_response)], responses=ERROR_RESPONSES
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


@router.get("/courses/{course_id}/groups")
def groups(course_id: UUID, request: Request, session: Database, user: CurrentUser):
    return envelope(service.list_groups(session, user, course_id), request)


@router.post("/courses/{course_id}/groups", status_code=201)
def create_group(
    course_id: UUID,
    command: CreateGroup,
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
        f"group.create:{course_id}",
        command.model_dump(),
        lambda: service.create_group(session, user, course_id, command, request),
        201,
    )


@router.get("/courses/{course_id}/ungrouped-students")
def ungrouped(
    course_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
    q: str | None = Query(default=None, max_length=100),
):
    return envelope(service.ungrouped_students(session, user, course_id, q), request)


@router.get("/courses/{course_id}/group-invitations")
def awaiting_teacher(course_id: UUID, request: Request, session: Database, user: CurrentUser):
    return envelope(service.course_invitations_awaiting_teacher(session, user, course_id), request)


@router.get("/groups/{group_id}")
def group(group_id: UUID, request: Request, session: Database, user: CurrentUser):
    return envelope(service.group_detail(session, user, group_id), request)


@router.post("/groups/{group_id}/join")
def join(
    group_id: UUID, request: Request, session: Database, user: CurrentUser, key: IdempotencyKey
):
    return _write(
        session,
        request,
        user,
        key,
        f"group.join:{group_id}",
        {},
        lambda: service.join_group(session, user, group_id, request),
    )


@router.post("/groups/{group_id}/invitations", status_code=201)
def invite(
    group_id: UUID,
    command: Invite,
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
        f"group.invite:{group_id}",
        command.model_dump(),
        lambda: service.invite(session, user, group_id, command, request),
        201,
    )


@router.get("/me/group-invitations")
def my_invitations(request: Request, session: Database, user: CurrentUser):
    return envelope(service.my_invitations(session, user), request)


@router.post("/group-invitations/{invitation_id}/response")
def respond(
    invitation_id: UUID,
    command: RespondInvitation,
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
        f"group.invite.respond:{invitation_id}",
        command.model_dump(),
        lambda: service.respond_invitation(session, user, invitation_id, command, request),
    )


@router.post("/group-invitations/{invitation_id}/decision")
def decide(
    invitation_id: UUID,
    command: DecideInvitation,
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
        f"group.invite.decide:{invitation_id}",
        command.model_dump(),
        lambda: service.decide_invitation(session, user, invitation_id, command, request),
    )


@router.post("/groups/{group_id}/leader-changes", status_code=201)
def start_leader_change(
    group_id: UUID,
    command: StartLeaderChange,
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
        f"group.leader_change:{group_id}",
        command.model_dump(),
        lambda: service.start_leader_change(session, user, group_id, command, request),
        201,
    )


@router.post("/leader-changes/{request_id}/confirmations")
def confirm_leader_change(
    request_id: UUID,
    command: ConfirmLeaderChange,
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
        f"group.leader_change.confirm:{request_id}",
        command.model_dump(),
        lambda: service.confirm_leader_change(session, user, request_id, command, request),
    )
