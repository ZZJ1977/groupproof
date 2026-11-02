"""C7 read-only authentication audit, separate from the unconnected all-site log."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request

from app.api.responses import SuccessResponse, success
from app.modules.c.auth_audit_schemas import (
    AuthAuditFilters,
    AuthAuditId,
    AuthAuditLogDTO,
    AuthAuditPageDTO,
)
from app.modules.c.auth_audit_service import get_auth_audit_log, list_auth_audit_logs
from app.modules.c.evidence_router import ERROR_RESPONSES, CurrentUser, Database, private_response

router = APIRouter(
    tags=["c-authentication-audit"],
    dependencies=[Depends(private_response)],
    responses=ERROR_RESPONSES,
)


@router.get("/admin/auth-audit-logs", response_model=SuccessResponse[AuthAuditPageDTO])
def auth_audit_collection(
    request: Request,
    session: Database,
    user: CurrentUser,
    filters: Annotated[AuthAuditFilters, Query()],
):
    return success(list_auth_audit_logs(session, user, filters), request)


@router.get("/admin/auth-audit-logs/{record_id}", response_model=SuccessResponse[AuthAuditLogDTO])
def auth_audit_detail(
    record_id: AuthAuditId,
    request: Request,
    session: Database,
    user: CurrentUser,
):
    return success(get_auth_audit_log(session, user, record_id), request)
