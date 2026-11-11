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
from app.modules.a import feishu, github, github_sync, projects, storage

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


# ------------------------------------------------------------------ A6 飞书只读同步


class BindFeishuChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    chat_id: str = Field(min_length=1, max_length=200)


class FeishuChatLinkDTO(BaseModel):
    project_id: UUID
    chat_id: str


class FeishuSyncDTO(BaseModel):
    chats: int
    created: int
    updated: int
    deleted: int
    seen: int


@router.post(
    "/api/v1/a/projects/{project_id}/feishu/chats",
    response_model=SuccessResponse[FeishuChatLinkDTO],
    status_code=201,
    dependencies=[Depends(_private)],
)
def bind_feishu_chat(
    project_id: UUID,
    payload: BindFeishuChatRequest,
    request: Request,
    session: Database,
    user: CurrentUser,
):
    link = feishu.link_chat(session, user, project_id, payload.chat_id)
    session.commit()
    return success(FeishuChatLinkDTO(project_id=project_id, chat_id=link.chat_id), request)


@router.post(
    "/api/v1/a/projects/{project_id}/feishu/sync",
    response_model=SuccessResponse[FeishuSyncDTO],
    dependencies=[Depends(_private)],
)
def sync_feishu(project_id: UUID, request: Request, session: Database, user: CurrentUser):
    reader = feishu.get_feishu_reader()
    try:
        totals = feishu.sync_project(session, user, project_id, reader)
    except Exception:
        session.rollback()
        raise
    finally:
        if isinstance(reader, feishu.FeishuClient):
            reader.close()
    session.commit()
    return success(FeishuSyncDTO(**totals), request)


# ------------------------------------------------------------------ 项目创建与组长转让


class CreatePersonalProjectRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)


class PersonalProjectDTO(BaseModel):
    project_id: UUID
    name: str
    kind: Literal["personal"]


class TransferLeadershipRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    new_leader_id: UUID


@router.post(
    "/api/v1/a/projects",
    response_model=SuccessResponse[PersonalProjectDTO],
    status_code=201,
    dependencies=[Depends(_private)],
)
def create_personal_project(
    payload: CreatePersonalProjectRequest, request: Request, session: Database, user: CurrentUser
):
    project = projects.create_personal_project(
        session, user, name=payload.name, description=payload.description
    )
    session.commit()
    return success(
        PersonalProjectDTO(project_id=project.id, name=project.name, kind="personal"), request
    )


@router.post(
    "/api/v1/a/projects/{project_id}/leader",
    response_model=SuccessResponse[dict],
    dependencies=[Depends(_private)],
)
def transfer_leader(
    project_id: UUID,
    payload: TransferLeadershipRequest,
    request: Request,
    session: Database,
    user: CurrentUser,
):
    projects.transfer_personal_leadership(
        session, user, project_id, new_leader_id=payload.new_leader_id
    )
    session.commit()
    return success(
        {"project_id": str(project_id), "leader_id": str(payload.new_leader_id)}, request
    )


class FeishuAvailableChatDTO(BaseModel):
    chat_id: str
    name: str


@router.get(
    "/api/v1/a/projects/{project_id}/feishu/available-chats",
    response_model=SuccessResponse[list[FeishuAvailableChatDTO]],
    dependencies=[Depends(_private)],
)
def list_feishu_available_chats(
    project_id: UUID, request: Request, session: Database, user: CurrentUser
):
    reader = feishu.get_feishu_reader()
    try:
        chats = feishu.list_available_chats(session, user, project_id, reader)
    finally:
        if isinstance(reader, feishu.FeishuClient):
            reader.close()
    return success([FeishuAvailableChatDTO(chat_id=c.chat_id, name=c.name) for c in chats], request)


class LinkedFeishuChatDTO(BaseModel):
    chat_id: str
    linked_at: datetime


@router.get(
    "/api/v1/a/projects/{project_id}/feishu/chats",
    response_model=SuccessResponse[list[LinkedFeishuChatDTO]],
    dependencies=[Depends(_private)],
)
def list_linked_feishu_chats(
    project_id: UUID, request: Request, session: Database, user: CurrentUser
):
    links = feishu.list_linked_chats(session, user, project_id)
    return success(
        [LinkedFeishuChatDTO(chat_id=link.chat_id, linked_at=link.linked_at) for link in links],
        request,
    )


# ------------------------------------------------------------------ A5 GitHub 只读接入


class BindGithubRepoRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    repo_url: str = Field(min_length=1, max_length=300)


class GithubRepoDTO(BaseModel):
    owner: str
    repo: str
    default_branch: str
    linked_at: datetime
    last_synced_at: datetime | None


class GithubSyncDTO(BaseModel):
    repos: int
    files: int
    fetched: int
    removed: int
    skipped: int


def _repo_dto(link) -> GithubRepoDTO:
    return GithubRepoDTO(
        owner=link.owner,
        repo=link.repo,
        default_branch=link.default_branch,
        linked_at=link.linked_at,
        last_synced_at=link.last_synced_at,
    )


@router.post(
    "/api/v1/a/projects/{project_id}/github/repos",
    response_model=SuccessResponse[GithubRepoDTO],
    status_code=201,
    dependencies=[Depends(_private)],
)
def bind_github_repo(
    project_id: UUID,
    payload: BindGithubRepoRequest,
    request: Request,
    session: Database,
    user: CurrentUser,
):
    client = github.get_github_client()
    try:
        link = github_sync.link_repo(session, user, project_id, payload.repo_url, client)
    finally:
        if client is not None:
            client.close()
    session.commit()
    return success(_repo_dto(link), request)


@router.get(
    "/api/v1/a/projects/{project_id}/github/repos",
    response_model=SuccessResponse[list[GithubRepoDTO]],
    dependencies=[Depends(_private)],
)
def list_github_repos(project_id: UUID, request: Request, session: Database, user: CurrentUser):
    links = github_sync.list_linked_repos(session, user, project_id)
    return success([_repo_dto(link) for link in links], request)


@router.post(
    "/api/v1/a/projects/{project_id}/github/sync",
    response_model=SuccessResponse[GithubSyncDTO],
    dependencies=[Depends(_private)],
)
def sync_github(project_id: UUID, request: Request, session: Database, user: CurrentUser):
    client = github.get_github_client()
    try:
        totals = github_sync.sync_project_repos(session, user, project_id, client)
    except Exception:
        session.rollback()
        raise
    finally:
        if client is not None:
            client.close()
    session.commit()
    return success(GithubSyncDTO(**totals), request)
