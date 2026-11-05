"""B-8 HTTP routes (mounted under /api/v1): pages 18–19 milestones."""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request

from app.modules.b import milestones_service as service
from app.modules.b.common import (
    ERROR_RESPONSES,
    CurrentUser,
    Database,
    IdempotencyKey,
    envelope,
    private_response,
    run_command,
)
from app.modules.b.milestones_schemas import (
    AddDeliverable,
    CheckDeliverable,
    CompleteMilestone,
    Reschedule,
)
from app.modules.b.ports import VerificationPort, get_verification_port

Verification = Annotated[VerificationPort, Depends(get_verification_port)]

router = APIRouter(
    tags=["b-milestones"], dependencies=[Depends(private_response)], responses=ERROR_RESPONSES
)
BASE = "/projects/{project_id}/milestones"


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


@router.get(BASE)
def milestones(project_id: UUID, request: Request, session: Database, user: CurrentUser):
    return envelope(service.list_milestones(session, user, project_id), request)


@router.get(BASE + "/{milestone_id}")
def milestone(
    project_id: UUID, milestone_id: UUID, request: Request, session: Database, user: CurrentUser
):
    return envelope(service.milestone_detail(session, user, project_id, milestone_id), request)


@router.post(BASE + "/{milestone_id}/deliverables", status_code=201)
def add_deliverable(
    project_id: UUID,
    milestone_id: UUID,
    command: AddDeliverable,
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
        f"milestone.deliverable.add:{milestone_id}",
        command.model_dump(mode="json"),
        lambda: service.add_deliverable(session, user, project_id, milestone_id, command, request),
        201,
    )


@router.post(BASE + "/{milestone_id}/deliverables/{deliverable_id}/check")
def check_deliverable(
    project_id: UUID,
    milestone_id: UUID,
    deliverable_id: UUID,
    command: CheckDeliverable,
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
        f"milestone.deliverable.check:{deliverable_id}",
        command.model_dump(mode="json"),
        lambda: service.check_deliverable(
            session, user, project_id, milestone_id, deliverable_id, command, request
        ),
    )


@router.post(BASE + "/{milestone_id}/complete")
def complete(
    project_id: UUID,
    milestone_id: UUID,
    command: CompleteMilestone,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
    verification: Verification,
):
    return _write(
        session,
        request,
        user,
        key,
        f"milestone.complete:{milestone_id}",
        command.model_dump(mode="json"),
        lambda: service.complete(
            session, user, project_id, milestone_id, command, verification, request
        ),
    )


@router.post(BASE + "/{milestone_id}/reschedule")
def reschedule(
    project_id: UUID,
    milestone_id: UUID,
    command: Reschedule,
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
        f"milestone.reschedule:{milestone_id}",
        command.model_dump(mode="json"),
        lambda: service.reschedule(session, user, project_id, milestone_id, command, request),
    )
