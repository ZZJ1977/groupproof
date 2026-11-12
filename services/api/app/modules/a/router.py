"""A 的 HTTP 接口：文件上传（A4-04）。

前端上传流程：
1. ``POST /api/v1/storage/uploads`` 拿上传链接；
2. 浏览器把文件 PUT 到 ``upload_url``；
3. ``POST /api/v1/storage/uploads/{receipt_id}/complete``，通过后把 receipt_id 交给业务接口。
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.api.responses import SuccessResponse, success
from app.db.models import User
from app.db.session import get_session
from app.modules.a import (
    access_grants,
    ai,
    code_analysis,
    feishu,
    github,
    github_activity,
    github_sync,
    permissions,
    projects,
    storage,
)
from app.modules.a.ai import usage as ai_usage

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
    commits: int = 0
    pulls: int = 0
    ci_runs: int = 0
    deleted_sources: int = 0
    associated: int = 0


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


class AnalyzeCodeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    requirements: list[ai.ImplRequirement] = Field(min_length=1, max_length=50)


@router.post(
    "/api/v1/a/projects/{project_id}/github/analyze",
    response_model=SuccessResponse[ai.ImplementationAnalysisResult],
    dependencies=[Depends(_private)],
)
def analyze_github_code(
    project_id: UUID,
    payload: AnalyzeCodeRequest,
    request: Request,
    session: Database,
    user: CurrentUser,
):
    """分析已同步的代码是否实现了给定需求。结果只是建议，需要人确认。"""
    result = code_analysis.analyze_project_code(session, user, project_id, payload.requirements)
    return success(result, request)


class AiUsageDTO(BaseModel):
    id: UUID
    occurred_at: datetime
    user_id: UUID | None
    project_id: UUID | None
    feature: str
    provider: str | None
    model: str | None
    success: bool
    error_code: str | None
    input_tokens: int | None
    output_tokens: int | None
    cost: Decimal | None
    currency: str | None
    latency_ms: int | None


class AiUsagePageDTO(BaseModel):
    items: list[AiUsageDTO]
    total: int
    page: int
    page_size: int


class AiUsageSummaryDTO(BaseModel):
    feature: str
    model: str | None
    currency: str | None
    calls: int
    failures: int
    input_tokens: int
    output_tokens: int
    cost: Decimal


@router.get(
    "/api/v1/a/ai-usage",
    response_model=SuccessResponse[AiUsagePageDTO],
    dependencies=[Depends(_private)],
)
def list_ai_usage_events(
    request: Request,
    session: Database,
    user: CurrentUser,
    user_id: UUID | None = None,
    project_id: UUID | None = None,
    feature: str | None = Query(default=None, max_length=60),
    success_only: bool | None = Query(default=None, alias="success"),
    since: AwareDatetime | None = None,
    until: AwareDatetime | None = None,
    page: int = Query(default=1, ge=1, le=1_000_000),
    page_size: int = Query(default=20, ge=1, le=100),
):
    """管理员查看 AI 调用记录（谁、哪个功能、哪个模型、成败、token、费用）。"""
    permissions.require_admin(user)
    found = ai_usage.list_ai_usage(
        session,
        user_id=user_id,
        project_id=project_id,
        feature=feature,
        success=success_only,
        since=since,
        until=until,
        page=page,
        page_size=page_size,
    )
    return success(
        AiUsagePageDTO(
            items=[AiUsageDTO.model_validate(row, from_attributes=True) for row in found.items],
            total=found.total,
            page=page,
            page_size=page_size,
        ),
        request,
    )


@router.get(
    "/api/v1/a/ai-usage/summary",
    response_model=SuccessResponse[list[AiUsageSummaryDTO]],
    dependencies=[Depends(_private)],
)
def summarize_ai_usage_events(
    request: Request,
    session: Database,
    user: CurrentUser,
    user_id: UUID | None = None,
    project_id: UUID | None = None,
    feature: str | None = Query(default=None, max_length=60),
    since: AwareDatetime | None = None,
    until: AwareDatetime | None = None,
):
    """管理员查看 AI 用量汇总：按功能、模型、币种统计调用数、失败数、token 和费用。"""
    permissions.require_admin(user)
    rows = ai_usage.summarize_ai_usage(
        session,
        user_id=user_id,
        project_id=project_id,
        feature=feature,
        since=since,
        until=until,
    )
    return success([AiUsageSummaryDTO(**row) for row in rows], request)


class GithubActivityDTO(BaseModel):
    id: UUID
    kind: Literal["commit", "pull_request", "ci_run"]
    external_id: str
    title: str
    summary: str
    state: str | None
    author_login: str | None
    author_name: str | None
    author_user_id: UUID | None
    url: str | None
    occurred_at: datetime
    deleted: bool


class GithubActivityPageDTO(BaseModel):
    items: list[GithubActivityDTO]
    total: int
    page: int
    page_size: int


@router.get(
    "/api/v1/a/projects/{project_id}/github/activity",
    response_model=SuccessResponse[GithubActivityPageDTO],
    dependencies=[Depends(_private)],
)
def list_github_activity(
    project_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
    kind: Literal["commit", "pull_request", "ci_run"] | None = None,
    author_id: UUID | None = None,
    page: int = Query(default=1, ge=1, le=1_000_000),
    page_size: int = Query(default=20, ge=1, le=100),
):
    """项目成员查看本项目已同步的提交、合并请求和 CI 运行（新的在前）。"""
    rows, total = github_activity.list_activity(
        session, user, project_id, kind=kind, author_id=author_id, page=page, page_size=page_size
    )
    return success(
        GithubActivityPageDTO(
            items=[GithubActivityDTO.model_validate(row, from_attributes=True) for row in rows],
            total=total,
            page=page,
            page_size=page_size,
        ),
        request,
    )


class GithubLoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    login: str | None = Field(default=None, max_length=120)


class GithubLoginDTO(BaseModel):
    login: str | None


@router.put(
    "/api/v1/a/me/github-login",
    response_model=SuccessResponse[GithubLoginDTO],
    dependencies=[Depends(_private)],
)
def set_my_github_login(
    payload: GithubLoginRequest, request: Request, session: Database, user: CurrentUser
):
    """声明自己的 GitHub 用户名，让提交作者能对应到本站账号；传空则清除。"""
    link = github_activity.set_github_login(session, user, payload.login)
    session.commit()
    return success(GithubLoginDTO(login=link.login if link else None), request)


class FeishuAttachmentDTO(BaseModel):
    id: UUID
    file_key: str
    kind: Literal["image", "file", "audio", "media"]
    name: str | None
    size_bytes: int | None
    content_sha256: str | None
    verified_at: datetime | None
    available: bool


class FeishuMessageVersionDTO(BaseModel):
    version_no: int
    content_hash: str
    text: str
    deleted: bool
    recorded_at: datetime


class FeishuMessageDetailDTO(BaseModel):
    id: UUID
    chat_id: str
    message_id: str
    msg_type: str
    text: str
    deleted: bool
    version_no: int
    content_hash: str
    occurred_at: datetime
    versions: list[FeishuMessageVersionDTO]
    attachments: list[FeishuAttachmentDTO]


@router.get(
    "/api/v1/a/projects/{project_id}/feishu/messages/{message_row_id}",
    response_model=SuccessResponse[FeishuMessageDetailDTO],
    dependencies=[Depends(_private)],
)
def get_feishu_message(
    project_id: UUID, message_row_id: UUID, request: Request, session: Database, user: CurrentUser
):
    """项目成员查看一条飞书消息的脱敏全文、所有版本和附件引用。"""
    detail = feishu.get_message_detail(session, user, project_id, message_row_id)
    message = detail.message
    return success(
        FeishuMessageDetailDTO(
            id=message.id,
            chat_id=message.chat_id,
            message_id=message.message_id,
            msg_type=message.msg_type,
            text=message.text,
            deleted=message.deleted,
            version_no=message.version_no,
            content_hash=message.content_hash,
            occurred_at=message.occurred_at,
            versions=[
                FeishuMessageVersionDTO.model_validate(v, from_attributes=True)
                for v in detail.versions
            ],
            attachments=[
                FeishuAttachmentDTO.model_validate(a, from_attributes=True)
                for a in detail.attachments
            ],
        ),
        request,
    )


@router.post(
    "/api/v1/a/projects/{project_id}/feishu/attachments/{attachment_id}/verify",
    response_model=SuccessResponse[FeishuAttachmentDTO],
    dependencies=[Depends(_private)],
)
def verify_feishu_attachment(
    project_id: UUID, attachment_id: UUID, request: Request, session: Database, user: CurrentUser
):
    """下载附件并记录 SHA-256 指纹，之后可用来核对附件没有被替换。"""
    reader = feishu.get_feishu_reader()
    try:
        attachment = feishu.verify_attachment(session, user, project_id, attachment_id, reader)
    finally:
        if isinstance(reader, feishu.FeishuClient):
            reader.close()
    session.commit()
    return success(FeishuAttachmentDTO.model_validate(attachment, from_attributes=True), request)


class RevokeGrantRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: str = Field(min_length=1, max_length=2000)


class AccessGrantDTO(BaseModel):
    id: UUID
    request_id: UUID
    applicant_id: UUID
    project_id: UUID
    resource_type: Literal["project", "task", "evidence"]
    resource_id: UUID
    expires_at: datetime
    revoked_at: datetime | None
    revoke_reason: str | None


@router.post(
    "/api/v1/a/access-grants/{grant_id}/revoke",
    response_model=SuccessResponse[AccessGrantDTO],
    dependencies=[Depends(_private)],
)
def revoke_access_grant(
    grant_id: UUID,
    payload: RevokeGrantRequest,
    request: Request,
    session: Database,
    user: CurrentUser,
):
    """管理员撤销一份临时只读授权；撤销后下一次读取立即失效，重复撤销不改写原记录。"""
    grant = access_grants.revoke_grant(session, user, grant_id, payload.reason)
    session.commit()
    return success(AccessGrantDTO.model_validate(grant, from_attributes=True), request)
