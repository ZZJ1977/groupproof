"""B-4 HTTP routes (mounted under /api/v1): page 08 steps 3–5."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Request
from starlette.background import BackgroundTask

from app.api.errors import ApiError
from app.modules.b import baseline_service, requirements_service
from app.modules.b.common import (
    ERROR_RESPONSES,
    CurrentUser,
    Database,
    IdempotencyKey,
    envelope,
    private_response,
    run_command,
)
from app.modules.b.requirements_schemas import (
    AdvanceSetup,
    CheckItem,
    ConfirmBaseline,
    CreateModule,
    CreateRequirement,
    ForceFreeze,
    ResolveConflict,
    SaveScope,
    UpdateModule,
    UpdateRequirement,
)

router = APIRouter(
    tags=["b-requirements"], dependencies=[Depends(private_response)], responses=ERROR_RESPONSES
)


def _write(session, request, user, key, operation, payload, execute, status_code=200, **extra):
    return run_command(
        session,
        request,
        actor=user,
        operation=operation,
        idempotency_key=key,
        payload=payload,
        execute=execute,
        status_code=status_code,
        **extra,
    )


# ---------------------------------------------------------------- B3-05 analysis + manual entry


@router.get("/projects/{project_id}/setup/requirements")
def requirements_board(project_id: UUID, request: Request, session: Database, user: CurrentUser):
    return envelope(requirements_service.board(session, user, project_id), request)


@router.post("/projects/{project_id}/analysis", status_code=202)
def start_analysis(
    project_id: UUID, request: Request, session: Database, user: CurrentUser, key: IdempotencyKey
):
    started: list[UUID] = []

    def execute():
        run = requirements_service.start_analysis(session, user, project_id, request)
        started.append(run.id)
        return requirements_service._run_dto(run)

    response = _write(
        session,
        request,
        user,
        key,
        f"project.analysis:{project_id}",
        {},
        execute,
        202,
        integrity_error=ApiError(409, "ANALYSIS_RUNNING", "分析正在进行中，请稍候。"),
    )
    if started:
        # Runs after the response is sent; the page polls GET .../analysis/{run_id}.
        response.background = BackgroundTask(
            requirements_service.run_analysis, session.get_bind(), started[0]
        )
    return response


@router.get("/projects/{project_id}/analysis/{run_id}")
def analysis(
    project_id: UUID, run_id: UUID, request: Request, session: Database, user: CurrentUser
):
    return envelope(requirements_service.analysis(session, user, project_id, run_id), request)


@router.post("/projects/{project_id}/modules", status_code=201)
def create_module(
    project_id: UUID,
    command: CreateModule,
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
        f"module.create:{project_id}",
        command.model_dump(mode="json"),
        lambda: requirements_service.create_module(session, user, project_id, command, request),
        201,
        integrity_error=ApiError(409, "MODULE_NAME_TAKEN", "已有同名模块。"),
    )


@router.patch("/projects/{project_id}/modules/{module_id}")
def update_module(
    project_id: UUID,
    module_id: UUID,
    command: UpdateModule,
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
        f"module.update:{module_id}",
        command.model_dump(mode="json"),
        lambda: requirements_service.update_module(
            session, user, project_id, module_id, command, request
        ),
        integrity_error=ApiError(409, "MODULE_NAME_TAKEN", "已有同名模块。"),
    )


@router.delete("/projects/{project_id}/modules/{module_id}")
def delete_module(
    project_id: UUID,
    module_id: UUID,
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
        f"module.delete:{module_id}",
        {},
        lambda: requirements_service.delete_module(session, user, project_id, module_id, request),
    )


@router.post("/projects/{project_id}/requirements", status_code=201)
def create_requirement(
    project_id: UUID,
    command: CreateRequirement,
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
        f"requirement.create:{project_id}",
        command.model_dump(mode="json"),
        lambda: requirements_service.create_requirement(
            session, user, project_id, command, request
        ),
        201,
    )


@router.patch("/projects/{project_id}/requirements/{requirement_id}")
def update_requirement(
    project_id: UUID,
    requirement_id: UUID,
    command: UpdateRequirement,
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
        f"requirement.update:{requirement_id}",
        command.model_dump(mode="json"),
        lambda: requirements_service.update_requirement(
            session, user, project_id, requirement_id, command, request
        ),
    )


# ---------------------------------------------------------------- B3-06 conflicts + steps


@router.post("/projects/{project_id}/conflicts/{conflict_id}/resolution")
def resolve_conflict(
    project_id: UUID,
    conflict_id: UUID,
    command: ResolveConflict,
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
        f"conflict.resolve:{conflict_id}",
        command.model_dump(mode="json"),
        lambda: requirements_service.resolve_conflict(
            session, user, project_id, conflict_id, command, request
        ),
    )


@router.post("/projects/{project_id}/setup/advance")
def advance(
    project_id: UUID,
    command: AdvanceSetup,
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
        f"setup.advance:{project_id}",
        command.model_dump(mode="json"),
        lambda: requirements_service.advance(session, user, project_id, command),
    )


# ---------------------------------------------------------------- B3-07 checklist


@router.get("/projects/{project_id}/baseline/checklist")
def checklist(project_id: UUID, request: Request, session: Database, user: CurrentUser):
    return envelope(baseline_service.checklist(session, user, project_id), request)


@router.put("/projects/{project_id}/baseline/scope")
def save_scope(
    project_id: UUID,
    command: SaveScope,
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
        f"baseline.scope:{project_id}",
        command.model_dump(mode="json"),
        lambda: baseline_service.save_scope(session, user, project_id, command, request),
    )


@router.put("/projects/{project_id}/baseline/checklist/{item_key}")
def set_check(
    project_id: UUID,
    item_key: str,
    command: CheckItem,
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
        f"baseline.check:{project_id}:{item_key[:40]}",
        command.model_dump(mode="json"),
        lambda: baseline_service.set_check(session, user, project_id, item_key, command),
    )


# ---------------------------------------------------------------- B3-08 baseline


@router.get("/projects/{project_id}/baselines/current")
def current_baseline(project_id: UUID, request: Request, session: Database, user: CurrentUser):
    return envelope(baseline_service.current(session, user, project_id), request)


@router.post("/projects/{project_id}/baselines", status_code=201)
def submit_baseline(
    project_id: UUID, request: Request, session: Database, user: CurrentUser, key: IdempotencyKey
):
    return _write(
        session,
        request,
        user,
        key,
        f"baseline.submit:{project_id}",
        {},
        lambda: baseline_service.submit(session, user, project_id, request),
        201,
        integrity_error=ApiError(409, "BASELINE_IN_CONFIRMATION", "基线已经提交，正在等待确认。"),
    )


@router.put("/projects/{project_id}/baselines/{baseline_id}/confirmations/{member_id}")
def confirm_baseline(
    project_id: UUID,
    baseline_id: UUID,
    member_id: UUID,
    command: ConfirmBaseline,
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
        f"baseline.confirm:{baseline_id}:{member_id}",
        command.model_dump(mode="json"),
        lambda: baseline_service.confirm(
            session, user, project_id, baseline_id, member_id, command, request
        ),
    )


@router.post("/projects/{project_id}/baselines/{baseline_id}/force-freeze")
def force_freeze(
    project_id: UUID,
    baseline_id: UUID,
    command: ForceFreeze,
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
        f"baseline.force:{baseline_id}",
        command.model_dump(mode="json"),
        lambda: baseline_service.force_freeze(
            session, user, project_id, baseline_id, command, request
        ),
    )
