from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request

from app.api.responses import SuccessResponse, success
from app.modules.c.course_files_schemas import (
    AppendCourseFileVersion,
    CourseFileDetailDTO,
    CourseFileDTO,
    CourseFilePageDTO,
    FilePurpose,
    FileSort,
    FileStatus,
    PublishCourseFileVersion,
    RegisterCourseFile,
    SignedCourseFileLinkDTO,
)
from app.modules.c.course_files_service import (
    append_version,
    get_file,
    get_signed_link,
    list_files,
    publish_version,
    register_file,
)
from app.modules.c.course_files_storage import CourseStoragePort, get_course_storage_port
from app.modules.c.evidence_router import (
    ERROR_RESPONSES,
    CurrentUser,
    Database,
    IdempotencyKey,
    commit_command,
    private_response,
)

router = APIRouter(
    tags=["c-course-files"], dependencies=[Depends(private_response)], responses=ERROR_RESPONSES
)
Storage = Annotated[CourseStoragePort, Depends(get_course_storage_port)]


@router.get("/courses/{course_id}/files", response_model=SuccessResponse[CourseFilePageDTO])
def collection(
    course_id: UUID,
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
            course_id,
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


@router.get(
    "/courses/{course_id}/files/{file_id}", response_model=SuccessResponse[CourseFileDetailDTO]
)
def detail(course_id: UUID, file_id: UUID, request: Request, session: Database, user: CurrentUser):
    return success(get_file(session, user, course_id, file_id), request)


@router.post(
    "/courses/{course_id}/files", status_code=201, response_model=SuccessResponse[CourseFileDTO]
)
def register(
    course_id: UUID,
    command: RegisterCourseFile,
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
                course_id,
                command,
                idempotency_key,
                storage,
            ),
        ),
        request,
    )


@router.post(
    "/courses/{course_id}/files/{file_id}/versions",
    status_code=201,
    response_model=SuccessResponse[CourseFileDTO],
)
def append(
    course_id: UUID,
    file_id: UUID,
    command: AppendCourseFileVersion,
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
                course_id,
                file_id,
                command,
                idempotency_key,
                storage,
            ),
        ),
        request,
    )


@router.post(
    "/courses/{course_id}/files/{file_id}/publish",
    response_model=SuccessResponse[CourseFileDTO],
)
def publish(
    course_id: UUID,
    file_id: UUID,
    command: PublishCourseFileVersion,
    request: Request,
    session: Database,
    user: CurrentUser,
    idempotency_key: IdempotencyKey,
):
    return success(
        commit_command(
            session,
            lambda: publish_version(
                session,
                user,
                course_id,
                file_id,
                command,
                idempotency_key,
            ),
        ),
        request,
    )


@router.get(
    "/courses/{course_id}/files/{file_id}/versions/{version_id}/link",
    response_model=SuccessResponse[SignedCourseFileLinkDTO],
)
def link(
    course_id: UUID,
    file_id: UUID,
    version_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
    storage: Storage,
    purpose: FilePurpose = "download",
):
    return success(
        get_signed_link(session, user, course_id, file_id, version_id, purpose, storage), request
    )
