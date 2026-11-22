"""HTTP endpoints for course TA staff management and fine-grained permissions."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Request

from app.modules.b import teacher_staff_service as service
from app.modules.b.common import (
    ERROR_RESPONSES,
    CurrentUser,
    Database,
    IdempotencyKey,
    envelope,
    private_response,
    run_command,
)
from app.modules.b.teacher_staff_schemas import InviteStaff, RemoveStaff, UpdatePermissions

router = APIRouter(
    tags=["b-teacher-staff"],
    dependencies=[Depends(private_response)],
    responses=ERROR_RESPONSES,
)


@router.get("/teacher/classes/{course_id}/staff")
def list_staff(course_id: UUID, request: Request, session: Database, user: CurrentUser):
    return envelope(service.list_staff(session, user, course_id), request)


@router.post("/teacher/classes/{course_id}/staff/invite", status_code=201)
def invite_staff(
    course_id: UUID,
    command: InviteStaff,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return run_command(
        session,
        request,
        actor=user,
        operation=f"teacher.staff.invite:{course_id}",
        idempotency_key=key,
        payload=command.model_dump(mode="json"),
        execute=lambda: service.invite_staff(session, user, course_id, command, request),
        status_code=201,
    )


@router.patch("/teacher/classes/{course_id}/staff/{user_id}/permissions")
def update_permissions(
    course_id: UUID,
    user_id: UUID,
    command: UpdatePermissions,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return run_command(
        session,
        request,
        actor=user,
        operation=f"teacher.staff.permissions:{course_id}:{user_id}",
        idempotency_key=key,
        payload=command.model_dump(mode="json"),
        execute=lambda: service.update_permissions(
            session, user, course_id, user_id, command, request
        ),
    )


@router.post("/teacher/classes/{course_id}/staff/{user_id}/remove")
def remove_staff(
    course_id: UUID,
    user_id: UUID,
    command: RemoveStaff,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return run_command(
        session,
        request,
        actor=user,
        operation=f"teacher.staff.remove:{course_id}:{user_id}",
        idempotency_key=key,
        payload=command.model_dump(mode="json"),
        execute=lambda: service.remove_staff(session, user, course_id, user_id, command, request),
    )


@router.get("/teacher/classes/{course_id}/my-permissions")
def get_my_permissions(course_id: UUID, request: Request, session: Database, user: CurrentUser):
    return envelope(service.my_permissions(session, user, course_id), request)
