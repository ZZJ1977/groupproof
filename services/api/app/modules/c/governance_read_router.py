from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request

from app.api.responses import SuccessResponse, success
from app.modules.c.evidence_router import ERROR_RESPONSES, CurrentUser, Database, private_response
from app.modules.c.governance_read_ports import GovernanceReadPort, get_governance_read_port
from app.modules.c.governance_read_schemas import (
    AuditFilters,
    AuditPageDTO,
    AuditRecord,
    UsageFilters,
    UsageSummaryDTO,
)
from app.modules.c.governance_read_service import audit_detail, audit_list, usage_summary
from app.modules.c.shared_audit import SharedAuditFilters, SharedAuditPage, shared_audit_page

router = APIRouter(
    tags=["c-governance-reads"], dependencies=[Depends(private_response)], responses=ERROR_RESPONSES
)
ReadSources = Annotated[GovernanceReadPort, Depends(get_governance_read_port)]


@router.get("/admin/shared-audit-events", response_model=SuccessResponse[SharedAuditPage])
def shared_audit_collection(
    request: Request,
    session: Database,
    user: CurrentUser,
    filters: Annotated[SharedAuditFilters, Query()],
):
    return success(shared_audit_page(session, user, filters), request)


@router.get("/admin/audit-logs", response_model=SuccessResponse[AuditPageDTO])
def audit_collection(
    request: Request,
    session: Database,
    user: CurrentUser,
    sources: ReadSources,
    filters: Annotated[AuditFilters, Query()],
):
    return success(audit_list(session, user, filters, sources), request)


@router.get("/admin/audit-logs/{record_id}", response_model=SuccessResponse[AuditRecord])
def audit_record(
    record_id: UUID, request: Request, session: Database, user: CurrentUser, sources: ReadSources
):
    return success(audit_detail(session, user, record_id, sources), request)


@router.get("/admin/ai-usage", response_model=SuccessResponse[UsageSummaryDTO])
def usage(
    request: Request,
    session: Database,
    user: CurrentUser,
    sources: ReadSources,
    filters: Annotated[UsageFilters, Query()],
):
    return success(usage_summary(session, user, filters, sources), request)
