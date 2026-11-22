"""HTTP endpoints for teacher course announcements and student unread banner reads."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Request

from app.modules.b import teacher_announcements_service as service
from app.modules.b.common import (
    ERROR_RESPONSES,
    CurrentUser,
    Database,
    IdempotencyKey,
    envelope,
    private_response,
    run_command,
)
from app.modules.b.teacher_announcements_schemas import (
    CreateAnnouncementRequest,
    UpdateAnnouncementRequest,
)

router = APIRouter(
    tags=["b-teacher-announcements"],
    dependencies=[Depends(private_response)],
    responses=ERROR_RESPONSES,
)


@router.get("/teacher/classes/{course_id}/announcements")
def list_announcements(course_id: UUID, request: Request, session: Database, user: CurrentUser):
    return envelope(service.list_teacher_announcements(session, user, course_id), request)


@router.post("/teacher/classes/{course_id}/announcements", status_code=201)
def create_announcement(
    course_id: UUID,
    command: CreateAnnouncementRequest,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return run_command(
        session,
        request,
        actor=user,
        operation=f"teacher.announcements.create:{course_id}",
        idempotency_key=key,
        payload=command.model_dump(mode="json"),
        execute=lambda: service.create_announcement(session, user, course_id, command, request),
        status_code=201,
    )


@router.patch("/teacher/classes/{course_id}/announcements/{announcement_id}")
def update_announcement(
    course_id: UUID,
    announcement_id: UUID,
    command: UpdateAnnouncementRequest,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return run_command(
        session,
        request,
        actor=user,
        operation=f"teacher.announcements.update:{course_id}:{announcement_id}",
        idempotency_key=key,
        payload=command.model_dump(mode="json"),
        execute=lambda: service.update_announcement(
            session, user, course_id, announcement_id, command, request
        ),
    )


@router.delete("/teacher/classes/{course_id}/announcements/{announcement_id}")
def delete_announcement(
    course_id: UUID,
    announcement_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return run_command(
        session,
        request,
        actor=user,
        operation=f"teacher.announcements.delete:{course_id}:{announcement_id}",
        idempotency_key=key,
        payload={"announcement_id": str(announcement_id)},
        execute=lambda: service.delete_announcement(
            session, user, course_id, announcement_id, request
        ),
    )


@router.get("/teacher/classes/{course_id}/announcements/{announcement_id}/reads")
def announcement_reads(
    course_id: UUID,
    announcement_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
):
    return envelope(
        service.get_announcement_reads(session, user, course_id, announcement_id), request
    )


@router.post("/teacher/classes/{course_id}/announcements/{announcement_id}/remind")
def remind_unread(
    course_id: UUID,
    announcement_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return run_command(
        session,
        request,
        actor=user,
        operation=f"teacher.announcements.remind:{course_id}:{announcement_id}",
        idempotency_key=key,
        payload={"announcement_id": str(announcement_id)},
        execute=lambda: service.remind_unread_students(
            session, user, course_id, announcement_id, request
        ),
    )


@router.get("/me/announcements/unread")
def my_unread_announcements(request: Request, session: Database, user: CurrentUser):
    return envelope(service.list_student_unread_announcements(session, user), request)


@router.post("/courses/{course_id}/announcements/{announcement_id}/read")
def mark_read(
    course_id: UUID,
    announcement_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return run_command(
        session,
        request,
        actor=user,
        operation=f"course.announcement.read:{course_id}:{announcement_id}",
        idempotency_key=key,
        payload={"announcement_id": str(announcement_id)},
        execute=lambda: service.mark_announcement_read(session, user, course_id, announcement_id),
    )
