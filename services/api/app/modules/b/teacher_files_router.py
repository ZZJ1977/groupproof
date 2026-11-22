"""HTTP endpoints for teacher course materials center and visibility-scoped student reads."""

from __future__ import annotations

from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, Response

from app.modules.b import teacher_files_service as service
from app.modules.b.common import (
    ERROR_RESPONSES,
    CurrentUser,
    Database,
    IdempotencyKey,
    envelope,
    private_response,
    run_command,
)
from app.modules.b.teacher_files_schemas import (
    AppendMaterialVersionRequest,
    BatchMaterialRequest,
    CreateFolderRequest,
    MaterialVisibility,
    UpdateFolderRequest,
    UpdateMaterialRequest,
    UploadMaterialRequest,
)

router = APIRouter(
    tags=["b-teacher-files"],
    dependencies=[Depends(private_response)],
    responses=ERROR_RESPONSES,
)


def _download_response(filename: str, mime_type: str, data: bytes) -> Response:
    quoted = quote(filename or "material")
    return Response(
        content=data,
        media_type=mime_type or "application/octet-stream",
        headers={
            "Content-Disposition": f"attachment; filename=\"material\"; filename*=UTF-8''{quoted}"
        },
    )


@router.get("/teacher/classes/{course_id}/files")
def list_teacher_files(
    course_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
    folder_id: UUID | None = None,
    q: str | None = Query(default=None, max_length=120),
    visibility: MaterialVisibility | None = None,
    include_all: bool = False,
):
    return envelope(
        service.list_teacher_files(
            session,
            user,
            course_id,
            folder_id=folder_id,
            q=q,
            visibility=visibility,
            include_all=include_all,
        ),
        request,
    )


@router.post("/teacher/classes/{course_id}/files/folders", status_code=201)
def create_folder(
    course_id: UUID,
    command: CreateFolderRequest,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return run_command(
        session,
        request,
        actor=user,
        operation=f"teacher.files.folder.create:{course_id}",
        idempotency_key=key,
        payload=command.model_dump(mode="json"),
        execute=lambda: service.create_folder(session, user, course_id, command, request),
        status_code=201,
    )


@router.patch("/teacher/classes/{course_id}/files/folders/{folder_id}")
def update_folder(
    course_id: UUID,
    folder_id: UUID,
    command: UpdateFolderRequest,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return run_command(
        session,
        request,
        actor=user,
        operation=f"teacher.files.folder.update:{course_id}:{folder_id}",
        idempotency_key=key,
        payload=command.model_dump(mode="json"),
        execute=lambda: service.update_folder(
            session, user, course_id, folder_id, command, request
        ),
    )


@router.delete("/teacher/classes/{course_id}/files/folders/{folder_id}")
def delete_folder(
    course_id: UUID,
    folder_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return run_command(
        session,
        request,
        actor=user,
        operation=f"teacher.files.folder.delete:{course_id}:{folder_id}",
        idempotency_key=key,
        payload={"folder_id": str(folder_id)},
        execute=lambda: service.delete_folder(session, user, course_id, folder_id, request),
    )


@router.post("/teacher/classes/{course_id}/files/upload", status_code=201)
def upload_material(
    course_id: UUID,
    command: UploadMaterialRequest,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return run_command(
        session,
        request,
        actor=user,
        operation=f"teacher.files.upload:{course_id}",
        idempotency_key=key,
        payload={
            "name": command.name,
            "folder_id": str(command.folder_id) if command.folder_id else None,
            "visibility": command.visibility,
            "size_bytes": command.size_bytes,
            "has_b64": command.content_base64 is not None,
        },
        execute=lambda: service.upload_material(session, user, course_id, command, request),
        status_code=201,
    )


@router.post("/teacher/classes/{course_id}/files/batch")
def batch_materials(
    course_id: UUID,
    command: BatchMaterialRequest,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return run_command(
        session,
        request,
        actor=user,
        operation=f"teacher.files.batch:{course_id}",
        idempotency_key=key,
        payload=command.model_dump(mode="json"),
        execute=lambda: service.batch_materials(session, user, course_id, command, request),
    )


@router.get("/teacher/classes/{course_id}/files/{material_id}/versions")
def material_versions(
    course_id: UUID, material_id: UUID, request: Request, session: Database, user: CurrentUser
):
    return envelope(service.get_material_detail(session, user, course_id, material_id), request)


@router.post("/teacher/classes/{course_id}/files/{material_id}/versions", status_code=201)
def append_material_version(
    course_id: UUID,
    material_id: UUID,
    command: AppendMaterialVersionRequest,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return run_command(
        session,
        request,
        actor=user,
        operation=f"teacher.files.version:{course_id}:{material_id}",
        idempotency_key=key,
        payload={
            "original_name": command.original_name,
            "size_bytes": command.size_bytes,
            "change_note": command.change_note,
            "has_b64": command.content_base64 is not None,
        },
        execute=lambda: service.append_material_version(
            session, user, course_id, material_id, command, request
        ),
        status_code=201,
    )


@router.patch("/teacher/classes/{course_id}/files/{material_id}")
def update_material(
    course_id: UUID,
    material_id: UUID,
    command: UpdateMaterialRequest,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return run_command(
        session,
        request,
        actor=user,
        operation=f"teacher.files.update:{course_id}:{material_id}",
        idempotency_key=key,
        payload=command.model_dump(mode="json"),
        execute=lambda: service.update_material(
            session, user, course_id, material_id, command, request
        ),
    )


@router.delete("/teacher/classes/{course_id}/files/{material_id}")
def delete_material(
    course_id: UUID,
    material_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return run_command(
        session,
        request,
        actor=user,
        operation=f"teacher.files.delete:{course_id}:{material_id}",
        idempotency_key=key,
        payload={"material_id": str(material_id)},
        execute=lambda: service.delete_material(session, user, course_id, material_id, request),
    )


@router.get("/teacher/classes/{course_id}/files/{material_id}/download")
def download_teacher_material(
    course_id: UUID,
    material_id: UUID,
    session: Database,
    user: CurrentUser,
    version_no: int | None = Query(default=None, ge=1),
):
    name, mime, payload = service.download_material_content(
        session, user, course_id, material_id, version_no=version_no, staff_only=True
    )
    return _download_response(name, mime, payload)


@router.get("/courses/{course_id}/materials")
def list_student_materials(course_id: UUID, request: Request, session: Database, user: CurrentUser):
    return envelope(service.list_student_materials(session, user, course_id), request)


@router.get("/courses/{course_id}/materials/{material_id}/download")
def download_student_material(
    course_id: UUID,
    material_id: UUID,
    session: Database,
    user: CurrentUser,
    version_no: int | None = Query(default=None, ge=1),
):
    name, mime, payload = service.download_material_content(
        session, user, course_id, material_id, version_no=version_no, staff_only=False
    )
    return _download_response(name, mime, payload)
