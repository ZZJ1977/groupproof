from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request

from app.api.responses import SuccessResponse, success
from app.modules.c.evidence_router import (
    ERROR_RESPONSES,
    CurrentUser,
    Database,
    IdempotencyKey,
    commit_command,
    private_response,
)
from app.modules.c.files_schemas import (
    AppendFileVersion,
    DesignateFileVersion,
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
