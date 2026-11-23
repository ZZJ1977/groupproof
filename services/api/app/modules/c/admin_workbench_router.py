"""GroupProof-specific Admin Workbench HTTP endpoints."""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request

from app.api.responses import SuccessResponse, success
from app.modules.c import admin_workbench_service as workbench
from app.modules.c.admin_workbench_schemas import (
    AccessGrantFilters,
    AdminAccessGrantPageDTO,
    AdminAiDiagnosticsDTO,
    AdminIntegrationsStatusDTO,
    AdminOverviewDTO,
    AdminUserProfile360DTO,
    AiDiagnosticsFilters,
    CourseMetricsRequest,
    CourseMetricsResponseDTO,
    ResolveLabelsDTO,
    ResolveLabelsRequest,
    RevokeUserSessionsDTO,
    RevokeUserSessionsRequest,
)
from app.modules.c.evidence_router import (
    ERROR_RESPONSES,
    CurrentUser,
    Database,
    commit_command,
    private_response,
)

router = APIRouter(
    prefix="/admin/workbench",
    tags=["c-admin-workbench"],
    dependencies=[Depends(private_response)],
    responses=ERROR_RESPONSES,
)


@router.get("/overview", response_model=SuccessResponse[AdminOverviewDTO])
def get_overview(request: Request, session: Database, user: CurrentUser):
    return success(workbench.admin_overview(session, user), request)


@router.get("/users/{user_id}/profile", response_model=SuccessResponse[AdminUserProfile360DTO])
def get_user_profile(user_id: UUID, request: Request, session: Database, user: CurrentUser):
    return success(workbench.user_profile_360(session, user, user_id), request)


@router.post(
    "/users/{user_id}/sessions/revoke",
    response_model=SuccessResponse[RevokeUserSessionsDTO],
)
def post_revoke_user_sessions(
    user_id: UUID,
    body: RevokeUserSessionsRequest,
    request: Request,
    session: Database,
    user: CurrentUser,
):
    return success(
        commit_command(
            session,
            lambda: workbench.revoke_user_sessions(
                session, user, user_id, body.reason, request=request
            ),
        ),
        request,
    )


@router.get("/access-grants", response_model=SuccessResponse[AdminAccessGrantPageDTO])
def get_access_grants(
    request: Request,
    session: Database,
    user: CurrentUser,
    filters: Annotated[AccessGrantFilters, Query()],
):
    return success(
        workbench.list_access_grants(
            session,
            user,
            page=filters.page,
            page_size=filters.page_size,
            status=filters.status,
        ),
        request,
    )


@router.get("/ai-diagnostics", response_model=SuccessResponse[AdminAiDiagnosticsDTO])
def get_ai_diagnostics(
    request: Request,
    session: Database,
    user: CurrentUser,
    filters: Annotated[AiDiagnosticsFilters, Query()],
):
    return success(
        workbench.ai_diagnostics(
            session,
            user,
            days=filters.days,
            user_id=filters.user_id,
            feature=filters.feature,
            model=filters.model,
        ),
        request,
    )


@router.get("/integrations", response_model=SuccessResponse[AdminIntegrationsStatusDTO])
def get_integrations(request: Request, session: Database, user: CurrentUser):
    return success(workbench.integrations_status(session, user), request)


@router.post("/resolve-labels", response_model=SuccessResponse[ResolveLabelsDTO])
def post_resolve_labels(
    body: ResolveLabelsRequest, request: Request, session: Database, user: CurrentUser
):
    return success(
        workbench.resolve_labels(
            session,
            user,
            user_ids=body.user_ids,
            course_ids=body.course_ids,
            project_ids=body.project_ids,
        ),
        request,
    )


@router.post("/courses/metrics", response_model=SuccessResponse[CourseMetricsResponseDTO])
def post_course_metrics(
    body: CourseMetricsRequest, request: Request, session: Database, user: CurrentUser
):
    return success(
        workbench.course_metrics(session, user, course_ids=body.course_ids),
        request,
    )
