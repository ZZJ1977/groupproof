from typing import Annotated, Literal
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import Response

from app.api.responses import SuccessResponse, success
from app.modules.c.evidence_router import (
    ERROR_RESPONSES,
    CurrentUser,
    Database,
    IdempotencyKey,
    commit_command,
    private_response,
)
from app.modules.c.external_files_sync import (
    read_internal_file_content,
    sync_external_project_files,
)
from app.modules.c.files_schemas import (
    AppendFileVersion,
    DesignateFileVersion,
    ExternalFilesSyncDTO,
    FileDetailDTO,
    FilePageDTO,
    FilePurpose,
    FileSort,
    FileStatus,
    LogicalFileDTO,
    RegisterFile,
    SignedFileLinkDTO,
)
from app.modules.c.files_service import (
    append_version,
    designate_version,
    file_access,
    file_data,
    file_in_project,
    get_signed_link,
    list_files,
    register_file,
)
from app.modules.c.files_storage import StoragePort, get_storage_port
from app.modules.c.notification_delivery import NotificationWriter

router = APIRouter(
    tags=["c-files"], dependencies=[Depends(private_response)], responses=ERROR_RESPONSES
)
Storage = Annotated[StoragePort, Depends(get_storage_port)]


@router.get("/projects/{project_id}/files", response_model=SuccessResponse[FilePageDTO])
def collection(
    project_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
    category: Literal["all", "documents", "images", "exports", "archived"] = "all",
    q: str | None = Query(default=None, max_length=200),
    file_type: str | None = Query(default=None, pattern=r"^[a-zA-Z0-9]{1,16}$"),
    status: FileStatus | None = None,
    sort: FileSort = "updated_desc",
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=10, ge=1, le=100),
):
    return success(
        list_files(
            session,
            user,
            project_id,
            category=category,
            q=q,
            file_type=file_type,
            status=status,
            sort=sort,
            page=page,
            page_size=page_size,
        ),
        request,
    )


@router.get("/projects/{project_id}/files/{file_id}", response_model=SuccessResponse[FileDetailDTO])
def detail(project_id: UUID, file_id: UUID, request: Request, session: Database, user: CurrentUser):
    file_access(session, user, project_id)
    return success(
        file_data(session, file_in_project(session, project_id, file_id), history=True), request
    )


@router.post(
    "/projects/{project_id}/files", status_code=201, response_model=SuccessResponse[LogicalFileDTO]
)
def register(
    project_id: UUID,
    command: RegisterFile,
    request: Request,
    session: Database,
    user: CurrentUser,
    storage: Storage,
    idempotency_key: IdempotencyKey,
):
    return success(
        commit_command(
            session,
            lambda: register_file(
                session,
                user,
                project_id,
                command,
                idempotency_key,
                storage,
            ),
        ),
        request,
    )


@router.post(
    "/projects/{project_id}/files/{file_id}/versions",
    status_code=201,
    response_model=SuccessResponse[LogicalFileDTO],
)
def append(
    project_id: UUID,
    file_id: UUID,
    command: AppendFileVersion,
    request: Request,
    session: Database,
    user: CurrentUser,
    storage: Storage,
    idempotency_key: IdempotencyKey,
):
    return success(
        commit_command(
            session,
            lambda: append_version(
                session,
                user,
                project_id,
                file_id,
                command,
                idempotency_key,
                storage,
            ),
        ),
        request,
    )


@router.post(
    "/projects/{project_id}/files/{file_id}/designate",
    response_model=SuccessResponse[LogicalFileDTO],
)
def designate(
    project_id: UUID,
    file_id: UUID,
    command: DesignateFileVersion,
    writer: NotificationWriter,
    request: Request,
    session: Database,
    user: CurrentUser,
    idempotency_key: IdempotencyKey,
):
    return success(
        commit_command(
            session,
            lambda: designate_version(
                session,
                user,
                project_id,
                file_id,
                command,
                idempotency_key,
                writer=writer,
            ),
        ),
        request,
    )


@router.get(
    "/projects/{project_id}/files/{file_id}/versions/{version_id}/link",
    response_model=SuccessResponse[SignedFileLinkDTO],
)
def link(
    project_id: UUID,
    file_id: UUID,
    version_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
    storage: Storage,
    purpose: FilePurpose = "download",
):
    return success(
        get_signed_link(session, user, project_id, file_id, version_id, purpose, storage), request
    )


@router.get("/projects/{project_id}/files/{file_id}/versions/{version_id}/content")
def content(
    project_id: UUID,
    file_id: UUID,
    version_id: UUID,
    session: Database,
    purpose: FilePurpose = "preview",
    exp: int = Query(ge=0),
    sig: str = Query(min_length=16, max_length=128),
):
    data, media_type, filename = read_internal_file_content(
        session,
        project_id,
        file_id,
        version_id,
        purpose=purpose,
        exp=exp,
        sig=sig,
    )
    return Response(
        content=data,
        media_type=media_type,
        headers=internal_content_headers(purpose, media_type, filename),
    )


# 只有这些类型允许在同源页面内联展示；其余类型（如 text/html、xml）即使申请预览
# 也按附件下发，避免同源脚本执行。
_INLINE_PREVIEW_TYPES = frozenset(
    {
        "application/json",
        "application/pdf",
        "image/gif",
        "image/jpeg",
        "image/png",
        "image/svg+xml",
        "image/webp",
        "text/csv",
        "text/markdown",
        "text/plain",
    }
)


def internal_content_headers(purpose: str, media_type: str, filename: str) -> dict[str, str]:
    base_type = media_type.split(";", 1)[0].strip().lower()
    inline = purpose == "preview" and base_type in _INLINE_PREVIEW_TYPES
    headers = {
        "Content-Disposition": (
            f"{'inline' if inline else 'attachment'}; filename*=UTF-8''{quote(filename)}"
        ),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
    }
    if inline and base_type != "application/pdf":
        # 文本/图片预览不需要脚本、外链或嵌套浏览上下文；PDF 查看器与 sandbox 不兼容，故排除。
        headers["Content-Security-Policy"] = (
            "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox"
        )
    return headers


@router.post(
    "/projects/{project_id}/files/sync-external",
    response_model=SuccessResponse[ExternalFilesSyncDTO],
)
def sync_external(
    project_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
):
    return success(
        commit_command(
            session,
            lambda: sync_external_project_files(session, user, project_id).model_dump(mode="json"),
        ),
        request,
    )
