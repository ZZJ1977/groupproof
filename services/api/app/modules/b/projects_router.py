"""B-3 HTTP routes (mounted under /api/v1): pages 35, 07 and 08 steps 1–2."""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request

from app.api.errors import ApiError
from app.api.responses import SuccessResponse
from app.modules.b import projects_service as service
from app.modules.b.common import (
    ERROR_RESPONSES,
    CurrentUser,
    Database,
    IdempotencyKey,
    envelope,
    private_response,
    run_command,
)
from app.modules.b.ports import MaterialTextPort, get_material_text_port
from app.modules.b.projects_schemas import (
    AddMaterial,
    CreatedProjectDTO,
    CreateProject,
    DraftDTO,
    MaterialDTO,
    OverviewDTO,
    ProjectTemplateDTO,
    SaveBasic,
    SaveDraft,
    SetProjectTemplate,
    SetupDTO,
)

router = APIRouter(
    tags=["b-projects"], dependencies=[Depends(private_response)], responses=ERROR_RESPONSES
)
MaterialTexts = Annotated[MaterialTextPort, Depends(get_material_text_port)]


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


@router.get(
    "/courses/{course_id}/project-template", response_model=SuccessResponse[ProjectTemplateDTO]
)
def project_template(course_id: UUID, request: Request, session: Database, user: CurrentUser):
    return envelope(service.get_template(session, user, course_id), request)


@router.put(
    "/courses/{course_id}/project-template", response_model=SuccessResponse[ProjectTemplateDTO]
)
def set_project_template(
    course_id: UUID,
    command: SetProjectTemplate,
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
        f"project_template.set:{course_id}",
        command.model_dump(mode="json"),
        lambda: service.set_template(session, user, course_id, command, request),
    )


@router.get("/groups/{group_id}/project-draft", response_model=SuccessResponse[DraftDTO])
def project_draft(group_id: UUID, request: Request, session: Database, user: CurrentUser):
    return envelope(service.get_draft(session, user, group_id), request)


@router.put("/groups/{group_id}/project-draft", response_model=SuccessResponse[DraftDTO])
def save_project_draft(
    group_id: UUID,
    command: SaveDraft,
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
        f"project_draft.save:{group_id}",
        command.model_dump(mode="json"),
        lambda: service.save_draft(session, user, group_id, command),
    )


@router.post(
    "/groups/{group_id}/projects",
    status_code=201,
    response_model=SuccessResponse[CreatedProjectDTO],
)
def create_project(
    group_id: UUID,
    command: CreateProject,
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
        f"project.create:{group_id}",
        command.model_dump(mode="json"),
        lambda: service.create_project(session, user, group_id, command, request),
        201,
        integrity_error=ApiError(409, "PROJECT_ALREADY_EXISTS", "本组已经创建了项目。"),
    )


@router.get("/projects/{project_id}/overview", response_model=SuccessResponse[OverviewDTO])
def project_overview(project_id: UUID, request: Request, session: Database, user: CurrentUser):
    return envelope(service.overview(session, user, project_id), request)


@router.get("/projects/{project_id}/setup", response_model=SuccessResponse[SetupDTO])
def project_setup(project_id: UUID, request: Request, session: Database, user: CurrentUser):
    return envelope(service.setup(session, user, project_id), request)


@router.patch("/projects/{project_id}/setup/basic", response_model=SuccessResponse[SetupDTO])
def save_basic(
    project_id: UUID,
    command: SaveBasic,
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
        f"project_setup.basic:{project_id}",
        command.model_dump(mode="json"),
        lambda: service.save_basic(session, user, project_id, command, request),
    )


@router.post(
    "/projects/{project_id}/materials", status_code=201, response_model=SuccessResponse[MaterialDTO]
)
def add_material(
    project_id: UUID,
    command: AddMaterial,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
    texts: MaterialTexts,
):
    return _write(
        session,
        request,
        user,
        key,
        f"project_material.add:{project_id}",
        command.model_dump(mode="json"),
        lambda: service.add_material(session, user, project_id, command, texts, request),
        201,
        integrity_error=ApiError(409, "MATERIAL_ALREADY_ADDED", "这个文件已经添加过了。"),
    )


@router.get(
    "/projects/{project_id}/materials/{material_id}", response_model=SuccessResponse[MaterialDTO]
)
def material(
    project_id: UUID, material_id: UUID, request: Request, session: Database, user: CurrentUser
):
    return envelope(service.material(session, user, project_id, material_id), request)
