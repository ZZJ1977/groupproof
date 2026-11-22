"""B-1 HTTP routes (mounted under /api/v1)."""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request

from app.modules.b import courses_service as service
from app.modules.b.common import (
    ERROR_RESPONSES,
    CurrentUser,
    Database,
    IdempotencyKey,
    envelope,
    private_response,
    run_command,
)
from app.modules.b.courses_schemas import (
    DecideJoin,
    InviteCode,
    JoinCourse,
    JoinRequestFilters,
    MyCourseFilters,
    SetJoinPolicy,
)

router = APIRouter(
    tags=["b-courses"], dependencies=[Depends(private_response)], responses=ERROR_RESPONSES
)


@router.get("/me/courses")
def my_courses(
    request: Request,
    session: Database,
    user: CurrentUser,
    filters: Annotated[MyCourseFilters, Query()],
):
    return envelope(service.my_courses(session, user, filters), request)


@router.get("/me/courses/{course_id}")
def my_course(course_id: UUID, request: Request, session: Database, user: CurrentUser):
    return envelope(service.my_course(session, user, course_id), request)


@router.post("/course-joins/preview")
def preview(command: InviteCode, request: Request, session: Database, user: CurrentUser):
    # Read-only, but POST keeps the invite code out of URLs and access logs.
    result = service.preview(session, user, command.invite_code)
    session.rollback()  # release C's course share lock
    return envelope(result, request)


@router.post("/course-joins", status_code=201)
def join(
    command: JoinCourse,
    request: Request,
    session: Database,
    user: CurrentUser,
    idempotency_key: IdempotencyKey,
):
    return run_command(
        session,
        request,
        actor=user,
        operation="course.join",
        idempotency_key=idempotency_key,
        payload=command.model_dump(),
        execute=lambda: service.join(session, user, command, request),
        status_code=201,
        integrity_error=service.join_conflict_error(session, user, command.invite_code),
    )


@router.get("/courses/{course_id}/join-requests")
def join_requests(
    course_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
    filters: Annotated[JoinRequestFilters, Query()],
):
    return envelope(service.list_join_requests(session, user, course_id, filters), request)


@router.post("/course-joins/{request_id}/decision")
def decide(
    request_id: UUID,
    command: DecideJoin,
    request: Request,
    session: Database,
    user: CurrentUser,
    idempotency_key: IdempotencyKey,
):
    return run_command(
        session,
        request,
        actor=user,
        operation=f"course.join.decide:{request_id}",
        idempotency_key=idempotency_key,
        payload=command.model_dump(),
        execute=lambda: service.decide_join(session, user, request_id, command, request),
    )


@router.get("/courses/{course_id}/join-policy")
def join_policy(course_id: UUID, request: Request, session: Database, user: CurrentUser):
    return envelope(service.get_join_policy(session, user, course_id), request)


@router.put("/courses/{course_id}/join-policy")
def set_join_policy(
    course_id: UUID,
    command: SetJoinPolicy,
    request: Request,
    session: Database,
    user: CurrentUser,
    idempotency_key: IdempotencyKey,
):
    return run_command(
        session,
        request,
        actor=user,
        operation=f"course.join_policy:{course_id}",
        idempotency_key=idempotency_key,
        payload=command.model_dump(),
        execute=lambda: service.set_join_policy(session, user, course_id, command, request),
    )
