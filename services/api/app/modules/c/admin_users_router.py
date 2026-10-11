from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request

from app.api.responses import ErrorResponse, SuccessResponse, success
from app.modules.c.admin_users_schemas import (
    AdminUserDetailDTO,
    AdminUserFilters,
    AdminUserPageDTO,
)
from app.modules.c.admin_users_service import get_admin_user, list_admin_users
from app.modules.c.evidence_router import CurrentUser, Database, private_response

router = APIRouter(
    prefix="/admin/users",
    tags=["c-admin-users"],
    dependencies=[Depends(private_response)],
    responses={
        status: {"model": ErrorResponse, "description": description}
        for status, description in {
            401: "Canonical authentication is required.",
            403: "An active administrator account is required.",
            404: "The user does not exist.",
            422: "Invalid UUID or directory filters; page size is fixed at 10.",
        }.items()
    },
)


@router.get("", response_model=SuccessResponse[AdminUserPageDTO])
def collection(
    request: Request,
    session: Database,
    user: CurrentUser,
    filters: Annotated[AdminUserFilters, Query()],
):
    return success(list_admin_users(session, user, filters), request)


@router.get("/{user_id}", response_model=SuccessResponse[AdminUserDetailDTO])
def detail(user_id: UUID, request: Request, session: Database, user: CurrentUser):
    return success(get_admin_user(session, user, user_id), request)
