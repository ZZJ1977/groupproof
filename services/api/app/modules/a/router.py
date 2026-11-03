"""A 的 HTTP 接口：文件上传（A4-04）。

前端上传流程：
1. ``POST /api/v1/storage/uploads`` 拿上传链接；
2. 浏览器把文件 PUT 到 ``upload_url``；
3. ``POST /api/v1/storage/uploads/{receipt_id}/complete``，通过后把 receipt_id 交给业务接口。
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.api.responses import SuccessResponse, success
from app.db.models import User
from app.db.session import get_session
from app.modules.a import storage

router = APIRouter(tags=["a"])
CurrentUser = Annotated[User, Depends(get_current_user)]
Database = Annotated[Session, Depends(get_session)]


def _private(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


@router.get("/api/a/ready", include_in_schema=False)
def ready() -> dict[str, str]:
    return {"module": "a", "status": "ready"}


class CreateUploadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scope: Literal["project", "course"]
    scope_id: UUID
    filename: str = Field(min_length=1, max_length=255)
    mime_type: str = Field(min_length=1, max_length=200)
    size_bytes: int = Field(gt=0)


class UploadTicketDTO(BaseModel):
    receipt_id: UUID
    upload_url: str
    method: str
    expires_at: datetime


class UploadReceiptDTO(BaseModel):
    receipt_id: UUID
    scope: Literal["project", "course"]
    scope_id: UUID
    filename: str
    status: Literal["pending", "completed", "rejected"]
    content_hash: str | None
    size_bytes: int | None
    mime_type: str | None
    rejection_reason: str | None


@router.post(
    "/api/v1/storage/uploads",
    response_model=SuccessResponse[UploadTicketDTO],
    status_code=201,
    dependencies=[Depends(_private)],
)
def create_upload(
    payload: CreateUploadRequest, request: Request, session: Database, user: CurrentUser
):
    ticket = storage.create_upload(
        session,
        user,
        scope=payload.scope,
        scope_id=payload.scope_id,
        filename=payload.filename,
        mime_type=payload.mime_type,
        size_bytes=payload.size_bytes,
    )
    session.commit()
    return success(
        UploadTicketDTO(
            receipt_id=ticket.receipt_id,
            upload_url=ticket.upload_url,
            method=ticket.method,
            expires_at=ticket.expires_at,
        ),
        request,
    )


@router.post(
    "/api/v1/storage/uploads/{receipt_id}/complete",
    response_model=SuccessResponse[UploadReceiptDTO],
    dependencies=[Depends(_private)],
)
def complete_upload(receipt_id: UUID, request: Request, session: Database, user: CurrentUser):
    try:
        row = storage.complete_upload(session, user, receipt_id)
    except Exception:
        # 被拒绝的上传也要把“rejected”状态保存下来，避免同一凭证反复重试。
        session.commit()
        raise
    session.commit()
    return success(
        UploadReceiptDTO(
            receipt_id=row.id,
            scope=row.scope,
            scope_id=row.scope_id,
            filename=row.filename,
            status=row.status,
            content_hash=row.content_hash,
            size_bytes=row.size_bytes,
            mime_type=row.mime_type,
            rejection_reason=row.rejection_reason,
        ),
        request,
    )
