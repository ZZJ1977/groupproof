"""HTTP endpoints for per-class teacher project monitor (Screen 61)."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Request

from app.modules.b import teacher_projects_service as service
from app.modules.b.common import (
    ERROR_RESPONSES,
    CurrentUser,
    Database,
    IdempotencyKey,
    envelope,
    private_response,
    run_command,
)
from app.modules.b.teacher_projects_schemas import ProjectRemindRequest

router = APIRouter(
    tags=["b-teacher-projects"],
    dependencies=[Depends(private_response)],
    responses=ERROR_RESPONSES,
)


@router.get("/teacher/classes/{course_id}/projects")
def list_class_projects(course_id: UUID, request: Request, session: Database, user: CurrentUser):
    return envelope(service.list_class_projects(session, user, course_id), request)


@router.get("/teacher/classes/{course_id}/projects/{group_id}")
def group_project_detail(
    course_id: UUID, group_id: UUID, request: Request, session: Database, user: CurrentUser
):
    return envelope(service.get_group_project_detail(session, user, course_id, group_id), request)


@router.post("/teacher/classes/{course_id}/projects/{group_id}/remind")
def remind_group_project(
    course_id: UUID,
    group_id: UUID,
    command: ProjectRemindRequest,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return run_command(
        session,
        request,
        actor=user,
        operation=f"teacher.projects.remind:{course_id}:{group_id}",
        idempotency_key=key,
        payload=command.model_dump(mode="json"),
        execute=lambda: service.remind_group_project(
            session, user, course_id, group_id, command.message, request
        ),
    )
