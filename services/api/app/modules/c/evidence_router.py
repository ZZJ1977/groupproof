from __future__ import annotations

from collections.abc import Callable
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.api.errors import ApiError
from app.api.responses import ErrorResponse, SuccessResponse, success
from app.db.models import User
from app.db.session import get_session
from app.modules.c.evidence_schemas import (
    CheckEvidenceSource,
    CreateEvidence,
    DecideEvidence,
    EvidenceDetailDTO,
    EvidenceDTO,
    EvidencePageDTO,
    EvidenceSourceType,
)
from app.modules.c.evidence_service import (
    check_source,
    create_evidence,
    decide_evidence,
    evidence_data,
    evidence_in_project,
    list_evidence,
)
from app.modules.c.permissions import get_project_access
from app.modules.c.source_ports import SourcePort, get_source_port


def private_response(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


ERROR_RESPONSES = {
    status: {"model": ErrorResponse, "description": description}
    for status, description in {
        401: "Verified A authentication is required.",
        403: "No project permission or resource is read-only.",
        404: "Resource not found in the requested project.",
        409: "Stale lock version, idempotency conflict, or invalid state transition.",
        422: "Invalid UUID, missing reason, or invalid task/source/criterion binding.",
        503: "A file storage or verified external source adapter is not connected.",
    }.items()
}

router = APIRouter(
    tags=["c-evidence"], dependencies=[Depends(private_response)], responses=ERROR_RESPONSES
)
CurrentUser = Annotated[User, Depends(get_current_user)]
Database = Annotated[Session, Depends(get_session)]
Sources = Annotated[SourcePort, Depends(get_source_port)]
IdempotencyKey = Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=128)]


def commit_command(session: Session, execute: Callable[[], dict]) -> dict:
    """Every mutation, snapshot, audit decision, replay and outbox row commits together."""
    try:
        result = execute()
        session.commit()
        return result
    except IntegrityError as exc:
        session.rollback()
        raise ApiError(
            409, "CONCURRENT_WRITE_CONFLICT", "The resource changed; reload and retry."
        ) from exc
    except Exception:
        session.rollback()
        raise


@router.get("/projects/{project_id}/evidence", response_model=SuccessResponse[EvidencePageDTO])
def collection(
    project_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
    task_id: UUID | None = None,
    author_id: UUID | None = None,
    criterion_id: UUID | None = None,
    q: str | None = Query(default=None, max_length=200),
    status: Literal["candidate", "pending_confirmation", "formal", "withdrawn", "void"]
    | None = None,
    source_type: EvidenceSourceType | None = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=100),
    offset: int | None = Query(default=None, ge=0, deprecated=True),
    limit: int | None = Query(default=None, ge=1, le=100, deprecated=True),
):
    return success(
        list_evidence(
            session,
            user,
            project_id,
            task_id=task_id,
            status=status,
            source_type=source_type,
            author_id=author_id,
            criterion_id=criterion_id,
            q=q,
            page=page,
            page_size=page_size,
            offset=offset,
            limit=limit,
        ),
        request,
    )


@router.get(
    "/projects/{project_id}/evidence/effective", response_model=SuccessResponse[EvidencePageDTO]
)
def effective_collection(
    project_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
    task_id: UUID | None = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=100),
):
    """D/B read contract: only formal evidence with an unchanged captured source."""
    return success(
        list_evidence(
            session,
            user,
            project_id,
            effective_only=True,
            task_id=task_id,
            page=page,
            page_size=page_size,
        ),
        request,
    )


@router.get(
    "/projects/{project_id}/evidence/{evidence_id}",
    response_model=SuccessResponse[EvidenceDetailDTO],
)
def detail(
    project_id: UUID,
    evidence_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
):
    get_project_access(session, user, project_id)
    row = evidence_in_project(session, evidence_id, project_id)
    return success(evidence_data(session, row, history=True), request)


@router.post(
    "/projects/{project_id}/evidence", status_code=201, response_model=SuccessResponse[EvidenceDTO]
)
def create(
    project_id: UUID,
    command: CreateEvidence,
    request: Request,
    session: Database,
    user: CurrentUser,
    sources: Sources,
    idempotency_key: IdempotencyKey,
):
    return success(
        commit_command(
            session,
            lambda: create_evidence(session, user, project_id, command, idempotency_key, sources),
        ),
        request,
    )


@router.post(
    "/projects/{project_id}/evidence/{evidence_id}/adopt",
    response_model=SuccessResponse[EvidenceDTO],
)
def adopt(
    project_id: UUID,
    evidence_id: UUID,
    command: DecideEvidence,
    request: Request,
    session: Database,
    user: CurrentUser,
    idempotency_key: IdempotencyKey,
):
    return success(
        commit_command(
            session,
            lambda: decide_evidence(
                session, user, project_id, evidence_id, command, idempotency_key, decision="adopted"
            ),
        ),
        request,
    )


@router.post(
    "/projects/{project_id}/evidence/{evidence_id}/withdraw",
    response_model=SuccessResponse[EvidenceDTO],
)
def withdraw(
    project_id: UUID,
    evidence_id: UUID,
    command: DecideEvidence,
    request: Request,
    session: Database,
    user: CurrentUser,
    idempotency_key: IdempotencyKey,
):
    return success(
        commit_command(
            session,
            lambda: decide_evidence(
                session,
                user,
                project_id,
                evidence_id,
                command,
                idempotency_key,
                decision="withdrawn",
            ),
        ),
        request,
    )


@router.post(
    "/projects/{project_id}/evidence/{evidence_id}/check-source",
    response_model=SuccessResponse[EvidenceDTO],
)
def source_check(
    project_id: UUID,
    evidence_id: UUID,
    command: CheckEvidenceSource,
    request: Request,
    session: Database,
    user: CurrentUser,
    sources: Sources,
    idempotency_key: IdempotencyKey,
):
    return success(
        commit_command(
            session,
            lambda: check_source(
                session, user, project_id, evidence_id, command, idempotency_key, sources
            ),
        ),
        request,
    )
