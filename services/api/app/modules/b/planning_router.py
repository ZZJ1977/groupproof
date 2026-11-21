"""B-6 HTTP routes (mounted under /api/v1): page 10 task planning."""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request

from app.modules.b import planning_service
from app.modules.b.common import (
    ERROR_RESPONSES,
    CurrentUser,
    Database,
    IdempotencyKey,
    envelope,
    private_response,
    run_command,
)
from app.modules.b.planning_schemas import (
    AdoptSuggestion,
    ConfirmAssignment,
    DeleteTask,
    FreezePlan,
    TaskInput,
    UnlockPlan,
    UpdateTask,
)
from app.modules.b.ports import VerificationPort, get_verification_port

Verification = Annotated[VerificationPort, Depends(get_verification_port)]

router = APIRouter(
    tags=["b-planning"], dependencies=[Depends(private_response)], responses=ERROR_RESPONSES
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


@router.get("/projects/{project_id}/plan")
def plan(project_id: UUID, request: Request, session: Database, user: CurrentUser):
    return envelope(planning_service.plan_view(session, user, project_id), request)


@router.post("/projects/{project_id}/plan/tasks", status_code=201)
def create_task(
    project_id: UUID,
    command: TaskInput,
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
        f"plan.task.create:{project_id}",
        command.model_dump(mode="json"),
        lambda: planning_service.create_task(
            session, user, project_id, command, verification, request
        ),
        201,
    )


@router.put("/projects/{project_id}/plan/tasks/{task_id}")
def update_task(
    project_id: UUID,
    task_id: UUID,
    command: UpdateTask,
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
        f"plan.task.update:{task_id}",
        command.model_dump(mode="json"),
        lambda: planning_service.update_task(
            session, user, project_id, task_id, command, verification, request
        ),
    )


@router.delete("/projects/{project_id}/plan/tasks/{task_id}")
def delete_task(
    project_id: UUID,
    task_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
    expected_version: Annotated[int, Query(ge=0)],
):
    command = DeleteTask(expected_version=expected_version)
    return _write(
        session,
        request,
        user,
        key,
        f"plan.task.delete:{task_id}",
        command.model_dump(mode="json"),
        lambda: planning_service.delete_task(session, user, project_id, task_id, command, request),
    )


@router.get("/projects/{project_id}/plan/tasks/{task_id}/versions")
def task_versions(
    project_id: UUID, task_id: UUID, request: Request, session: Database, user: CurrentUser
):
    return envelope(planning_service.task_versions(session, user, project_id, task_id), request)


@router.post("/projects/{project_id}/plan/confirmations/me")
def confirm_mine(
    project_id: UUID,
    command: ConfirmAssignment,
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
        f"plan.confirm:{project_id}",
        command.model_dump(mode="json"),
        lambda: planning_service.confirm_mine(session, user, project_id, command, request),
    )


@router.post("/projects/{project_id}/plan/freeze")
def freeze(
    project_id: UUID,
    command: FreezePlan,
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
        f"plan.freeze:{project_id}",
        command.model_dump(mode="json"),
        lambda: planning_service.freeze(session, user, project_id, command, request),
    )


@router.post("/projects/{project_id}/plan/unlock")
def unlock(
    project_id: UUID,
    command: UnlockPlan,
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
        f"plan.unlock:{project_id}",
        command.model_dump(mode="json"),
        lambda: planning_service.unlock(session, user, project_id, command, request),
    )


@router.get("/projects/{project_id}/plan/suggestions")
def suggestions(
    project_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
    status: str = "pending",
):
    return envelope(planning_service.list_suggestions(session, user, project_id, status), request)


@router.post("/projects/{project_id}/plan/suggestions")
def generate_suggestions(
    project_id: UUID, request: Request, session: Database, user: CurrentUser, key: IdempotencyKey
):
    return _write(
        session,
        request,
        user,
        key,
        f"plan.suggest:{project_id}",
        {},
        lambda: planning_service.generate_suggestions(session, user, project_id, None, request),
    )


@router.post("/projects/{project_id}/plan/suggestions/{suggestion_id}/adopt", status_code=201)
def adopt_suggestion(
    project_id: UUID,
    suggestion_id: UUID,
    command: AdoptSuggestion,
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
        f"plan.suggestion.adopt:{suggestion_id}",
        command.model_dump(mode="json"),
        lambda: planning_service.adopt_suggestion(
            session, user, project_id, suggestion_id, command, verification, request
        ),
        201,
    )


@router.post("/projects/{project_id}/plan/suggestions/{suggestion_id}/dismiss")
def dismiss_suggestion(
    project_id: UUID,
    suggestion_id: UUID,
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
        f"plan.suggestion.dismiss:{suggestion_id}",
        {},
        lambda: planning_service.dismiss_suggestion(
            session, user, project_id, suggestion_id, request
        ),
    )
