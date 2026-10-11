from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request

from app.api.responses import ErrorResponse, SuccessResponse, success
from app.modules.c.daily_schemas import DailyActivityFilters, DailyActivityPageDTO, DailyHomeDTO
from app.modules.c.daily_service import get_home_summary, list_personal_activity
from app.modules.c.evidence_router import CurrentUser, Database, private_response

router = APIRouter(
    tags=["c-daily"],
    dependencies=[Depends(private_response)],
    responses={
        401: {"model": ErrorResponse, "description": "Canonical authentication is required."},
        403: {"model": ErrorResponse, "description": "The current account is not active."},
        422: {
            "model": ErrorResponse,
            "description": "Invalid category, UUID, dates or pagination.",
        },
    },
)


@router.get("/home/summary", response_model=SuccessResponse[DailyHomeDTO])
def home_summary(request: Request, session: Database, user: CurrentUser):
    return success(get_home_summary(session, user), request)


@router.get("/me/activity", response_model=SuccessResponse[DailyActivityPageDTO])
def personal_activity(
    request: Request,
    session: Database,
    user: CurrentUser,
    filters: Annotated[DailyActivityFilters, Query()],
):
    return success(list_personal_activity(session, user, filters), request)
