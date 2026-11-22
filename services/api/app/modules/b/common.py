"""Shared B command plumbing: dependencies, idempotent commits, helpers."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Annotated, Any
from uuid import UUID

from fastapi import Depends, Header, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.api.errors import ApiError
from app.api.responses import ErrorResponse
from app.db.models import Course, Project, ProjectGroup, User
from app.db.session import get_session
from app.modules.a import permissions
from app.modules.b.models import BCommandReceipt

CurrentUser = Annotated[User, Depends(get_current_user)]
Database = Annotated[Session, Depends(get_session)]
IdempotencyKey = Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=128)]

ERROR_RESPONSES = {
    status: {"model": ErrorResponse, "description": description}
    for status, description in {
        401: "Authentication is required.",
        403: "No permission for this course, group or project.",
        404: "Resource not found or not visible to the caller.",
        409: "Stale version, idempotency conflict, duplicate or invalid state.",
        422: "Invalid input.",
        503: "A dependent service is not available.",
    }.items()
}


def private_response(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


def now() -> datetime:
    return datetime.now(UTC)


def envelope(data: Any, request: Request) -> dict[str, Any]:
    return {"data": jsonable_encoder(data), "meta": {"request_id": request.state.request_id}}


MAX_OPERATION_LENGTH = 100


def _receipt_operation(operation: str) -> str:
    """Keep operation within b_command_receipts.operation VARCHAR(100) without collisions."""
    if len(operation) <= MAX_OPERATION_LENGTH:
        return operation
    digest = hashlib.sha256(operation.encode()).hexdigest()[:32]
    return f"{operation[: MAX_OPERATION_LENGTH - 33]}:{digest}"


def _hash(payload: Any) -> str:
    raw = json.dumps(jsonable_encoder(payload), sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(raw.encode()).hexdigest()


def run_command(
    session: Session,
    request: Request,
    *,
    actor: User,
    operation: str,
    idempotency_key: str,
    payload: Any,
    execute: Callable[[], Any],
    status_code: int = 200,
    integrity_error: ApiError | None = None,
) -> JSONResponse:
    """Run one write once per (actor, operation, key) and commit it atomically.

    A replay with the same payload returns the stored response; a different payload
    under the same key is ``409 IDEMPOTENCY_CONFLICT``. Failures are not stored, so
    the caller may fix the input and retry with the same key.
    """
    request_hash = _hash(payload)
    stored_operation = _receipt_operation(operation)

    def stored() -> BCommandReceipt | None:
        return session.scalar(
            select(BCommandReceipt).where(
                BCommandReceipt.actor_id == actor.id,
                BCommandReceipt.operation == stored_operation,
                BCommandReceipt.idempotency_key == idempotency_key,
            )
        )

    def replay(receipt: BCommandReceipt) -> JSONResponse:
        if receipt.request_hash != request_hash:
            raise ApiError(
                409, "IDEMPOTENCY_CONFLICT", "同一个请求标识已用于不同的内容，请刷新后重试。"
            )
        body = {"data": receipt.response_json, "meta": {"request_id": request.state.request_id}}
        return JSONResponse(body, status_code=receipt.status_code)

    previous = stored()
    if previous is not None:
        return replay(previous)
    try:
        data = jsonable_encoder(execute())
        session.add(
            BCommandReceipt(
                actor_id=actor.id,
                operation=stored_operation,
                idempotency_key=idempotency_key,
                request_hash=request_hash,
                status_code=status_code,
                response_json=data,
            )
        )
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        previous = stored()
        if previous is not None:
            return replay(previous)
        raise integrity_error or ApiError(
            409, "CONCURRENT_WRITE_CONFLICT", "数据已被其他操作修改，请刷新后重试。"
        ) from exc
    except Exception:
        session.rollback()
        raise
    return JSONResponse(
        {"data": data, "meta": {"request_id": request.state.request_id}}, status_code=status_code
    )


def require_version(current: int, expected: int) -> None:
    if current != expected:
        raise ApiError(
            409,
            "VERSION_CONFLICT",
            "内容已被其他人修改，请刷新后再操作。",
            details={"current_version": current},
        )


def require_reason(reason: str | None, *, field: str = "reason") -> str:
    value = (reason or "").strip()
    if not value:
        raise ApiError(422, "REASON_REQUIRED", "请填写原因。", details={"field": field})
    return value


def lock_project_for_write(
    session: Session, user: User, project_id: UUID, *, leader: bool = False
) -> permissions.ProjectRelation:
    """Hold course/project facts through commit, then re-read current authorization.

    Course SHARE precedes project UPDATE, matching course closure's lock order.
    C execution's shared course lock is compatible with this shared lock.
    """
    probe = session.scalar(select(Project.id).where(Project.id == project_id))
    if probe is None:
        raise ApiError(404, "PROJECT_NOT_FOUND", "项目不存在。")
    course_id = session.scalar(select(Project.course_id).where(Project.id == project_id))
    if course_id is not None:
        session.scalar(
            select(Course)
            .where(Course.id == course_id)
            .with_for_update(read=True)
            .execution_options(populate_existing=True)
        )
    project = session.scalar(
        select(Project)
        .where(Project.id == project_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if project is None or project.course_id != course_id:
        raise ApiError(409, "INVALID_PROJECT_CONTEXT", "项目所属课程已变化，请刷新后重试。")
    if project.group_id is not None:
        session.scalar(
            select(ProjectGroup)
            .where(ProjectGroup.id == project.group_id)
            .with_for_update(read=True)
            .execution_options(populate_existing=True)
        )
    # A's relationship queries use populate_existing; a member removed while this
    # request waited for the project lock must not retain the earlier permission.
    guard = permissions.require_project_leader if leader else permissions.require_project_member
    return guard(session, user, project_id)
