from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request

from app.api.responses import SuccessResponse, success
from app.modules.c import governance_access_service as access
from app.modules.c import governance_course_service as courses
from app.modules.c.evidence_router import (
    ERROR_RESPONSES,
    CurrentUser,
    Database,
    IdempotencyKey,
    commit_command,
    private_response,
)
from app.modules.c.governance_ports import AuthorizationPort, get_authorization_port
from app.modules.c.governance_schemas import (
    AccessFilters,
    AccessRequestDetailDTO,
    AccessRequestPageDTO,
    CourseDetailDTO,
    CourseFilters,
    CoursePageDTO,
    CreateAccessRequest,
    CreateCourse,
    DecideAccessRequest,
    TransitionCourse,
)

router = APIRouter(
    tags=["c-governance"], dependencies=[Depends(private_response)], responses=ERROR_RESPONSES
)
Authorization = Annotated[AuthorizationPort, Depends(get_authorization_port)]


@router.get("/admin/courses", response_model=SuccessResponse[CoursePageDTO])
def course_list(
    request: Request,
    session: Database,
    user: CurrentUser,
    filters: Annotated[CourseFilters, Query()],
):
    return success(courses.list_courses(session, user, filters), request)


@router.post("/admin/courses", status_code=201, response_model=SuccessResponse[CourseDetailDTO])
def course_create(
    command: CreateCourse,
    request: Request,
    session: Database,
    user: CurrentUser,
    idempotency_key: IdempotencyKey,
):
    return success(
        commit_command(
            session, lambda: courses.create_course(session, user, command, idempotency_key)
        ),
        request,
    )


@router.get("/admin/courses/{course_id}", response_model=SuccessResponse[CourseDetailDTO])
def course_detail(course_id: UUID, request: Request, session: Database, user: CurrentUser):
    return success(courses.get_course(session, user, course_id), request)


@router.post(
    "/admin/courses/{course_id}/transitions", response_model=SuccessResponse[CourseDetailDTO]
)
def course_transition(
    course_id: UUID,
    command: TransitionCourse,
    request: Request,
    session: Database,
    user: CurrentUser,
    idempotency_key: IdempotencyKey,
):
    return success(
        commit_command(
            session,
            lambda: courses.transition_course(session, user, course_id, command, idempotency_key),
        ),
        request,
    )


@router.get("/me/access-requests", response_model=SuccessResponse[AccessRequestPageDTO])
def own_requests(
    request: Request,
    session: Database,
    user: CurrentUser,
    filters: Annotated[AccessFilters, Query()],
):
    return success(access.list_requests(session, user, filters), request)


@router.post(
    "/me/access-requests", status_code=201, response_model=SuccessResponse[AccessRequestDetailDTO]
)
def request_access(
    command: CreateAccessRequest,
    request: Request,
    session: Database,
    user: CurrentUser,
    idempotency_key: IdempotencyKey,
    authorization: Authorization,
):
    return success(
        commit_command(
            session,
            lambda: access.create_request(session, user, command, idempotency_key, authorization),
        ),
        request,
    )


@router.get("/admin/access-requests", response_model=SuccessResponse[AccessRequestPageDTO])
def admin_requests(
    request: Request,
    session: Database,
    user: CurrentUser,
    filters: Annotated[AccessFilters, Query()],
):
    return success(access.list_requests(session, user, filters, admin=True), request)


@router.get(
    "/admin/access-requests/{request_id}", response_model=SuccessResponse[AccessRequestDetailDTO]
)
def request_detail(request_id: UUID, request: Request, session: Database, user: CurrentUser):
    return success(access.get_request(session, user, request_id), request)


@router.post(
    "/admin/access-requests/{request_id}/decisions",
    response_model=SuccessResponse[AccessRequestDetailDTO],
)
def request_decision(
    request_id: UUID,
    command: DecideAccessRequest,
    request: Request,
    session: Database,
    user: CurrentUser,
    idempotency_key: IdempotencyKey,
    authorization: Authorization,
):
    return success(
        commit_command(
            session,
            lambda: access.decide_request(
                session, user, request_id, command, idempotency_key, authorization
            ),
        ),
        request,
    )
