"""B-5 HTTP routes (mounted under /api/v1): page 09 requirement management.

Edits go through ``PATCH /projects/{id}/requirements/{rid}`` (requirements_router):
after the freeze that call needs a ``reason`` and creates a new version.
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request

from app.modules.b import manage_service as service
from app.modules.b.common import ERROR_RESPONSES, CurrentUser, Database, envelope, private_response
from app.modules.b.ports import VerificationPort, get_verification_port

Verification = Annotated[VerificationPort, Depends(get_verification_port)]

router = APIRouter(
    tags=["b-requirements-manage"],
    dependencies=[Depends(private_response)],
    responses=ERROR_RESPONSES,
)


@router.get("/projects/{project_id}/requirements")
def list_requirements(
    project_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
    code: str | None = Query(default=None, max_length=20),
    q: str | None = Query(default=None, max_length=100),
    source: str | None = Query(default=None, max_length=64),
    module: UUID | None = None,
    status: str | None = Query(default=None, max_length=32),
    include_excluded: bool = False,
    page: int = Query(default=1, ge=1, le=100_000),
    page_size: int = Query(default=20, ge=1, le=100),
):
    return envelope(
        service.list_requirements(
            session,
            user,
            project_id,
            code=code,
            q=q,
            source=source,
            module=module,
            status=status,
            include_excluded=include_excluded,
            page=page,
            page_size=page_size,
        ),
        request,
    )


@router.get("/projects/{project_id}/requirements/{requirement_id}")
def requirement_detail(
    project_id: UUID, requirement_id: UUID, request: Request, session: Database, user: CurrentUser
):
    return envelope(service.detail(session, user, project_id, requirement_id), request)


@router.post("/projects/{project_id}/requirements/{requirement_id}/impact-preview")
def impact_preview(
    project_id: UUID, requirement_id: UUID, request: Request, session: Database, user: CurrentUser
):
    # Read-only: lists what a save would flag; nothing is written.
    return envelope(service.impact(session, user, project_id, requirement_id), request)


@router.get("/projects/{project_id}/requirements/{requirement_id}/versions")
def requirement_versions(
    project_id: UUID,
    requirement_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
    from_no: int | None = Query(default=None, alias="from", ge=1),
    to_no: int | None = Query(default=None, alias="to", ge=1),
):
    return envelope(
        service.versions(session, user, project_id, requirement_id, from_no=from_no, to_no=to_no),
        request,
    )


@router.get("/projects/{project_id}/requirements/{requirement_id}/trace")
def requirement_trace(
    project_id: UUID,
    requirement_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
    verification: Verification,
):
    return envelope(service.trace(session, user, project_id, requirement_id, verification), request)


@router.get("/projects/{project_id}/criteria-rechecks")
def criteria_rechecks(
    project_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
    task_id: UUID | None = None,
):
    return envelope(service.rechecks(session, user, project_id, task_id), request)
