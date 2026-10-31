"""Project file transactions. Callers own commit/rollback; no storage bytes are written here."""

from datetime import UTC, datetime
from pathlib import PurePosixPath
from uuid import UUID, uuid4

from sqlalchemy import case, func, or_, select, update
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import User
from app.modules.c.files_models import FileDecision, FileVersion, LogicalFile
from app.modules.c.files_schemas import (
    AppendFileVersion,
    DesignateFileVersion,
    FilePurpose,
    FileSort,
    FileStatus,
    RegisterFile,
)
from app.modules.c.files_storage import StoragePort, UploadReceipt, resolve_receipt, signed_link
from app.modules.c.integration_events import claim_request, emit_event, finish_request
from app.modules.c.permissions import get_project_access


def file_access(session: Session, user: User, project_id: UUID, *, write: bool = False):
    access = get_project_access(session, user, project_id, lock=write)
    if write:
        if not access.member:
            raise ApiError(
                403, "FILE_WRITE_DENIED", "Only project members may change project files."
            )
        if access.project.lifecycle != "active":
            raise ApiError(403, "PROJECT_READ_ONLY", "The project is read-only.")
        if access.course is not None and access.course.status != "active":
            raise ApiError(403, "COURSE_READ_ONLY", "The course is read-only.")
    return access


def file_in_project(session: Session, project_id: UUID, file_id: UUID) -> LogicalFile:
    row = session.scalar(
        select(LogicalFile)
        .where(
            LogicalFile.id == file_id,
            LogicalFile.project_id == project_id,
        )
        .execution_options(populate_existing=True)
    )
    if row is None:
        raise ApiError(404, "FILE_NOT_FOUND", "File not found in this project.")
    return row


def version_in_file(session: Session, row: LogicalFile, version_id: UUID) -> FileVersion:
    version = session.scalar(
        select(FileVersion).where(
            FileVersion.id == version_id,
            FileVersion.file_id == row.id,
        )
    )
    if version is None:
        raise ApiError(404, "FILE_VERSION_NOT_FOUND", "Version not found in this file.")
    return version


def version_data(row: LogicalFile, version: FileVersion) -> dict:
    status = (
        "current"
        if version.version_no == row.official_version_no
        else "draft"
        if version.version_no == row.latest_version_no
        else "superseded"
    )
    return {
        "id": str(version.id),
        "file_id": str(row.id),
        "version_no": version.version_no,
        "original_name": version.original_name,
        "extension": version.extension,
        "mime_type": version.mime_type,
        "size_bytes": version.size_bytes,
        "content_hash": version.content_hash,
        "uploaded_by": str(version.uploaded_by),
        "created_at": version.created_at.isoformat(),
        "status": status,
    }


def file_data(session: Session, row: LogicalFile, *, history: bool = False) -> dict:
    versions = list(
        session.scalars(
            select(FileVersion)
            .where(
                FileVersion.file_id == row.id,
            )
            .order_by(FileVersion.version_no.desc())
        )
    )
    result = {
        "id": str(row.id),
        "project_id": str(row.project_id),
        "name": row.name,
        "category": row.category,
        "latest_version_no": row.latest_version_no,
        "official_version_no": row.official_version_no,
        "lock_version": row.lock_version,
        "created_by": str(row.created_by),
        "created_at": row.created_at.isoformat(),
        "updated_at": row.updated_at.isoformat(),
        "versions": [version_data(row, version) for version in versions],
    }
    if history:
        result["decisions"] = [
            {
                "id": str(d.id),
                "version_id": str(d.version_id),
                "actor_id": str(d.actor_id),
                "action": d.action,
                "reason": d.reason,
                "resulting_lock_version": d.resulting_lock_version,
                "previous_official_version_no": d.previous_official_version_no,
                "created_at": d.created_at.isoformat(),
            }
            for d in session.scalars(
                select(FileDecision)
                .where(
                    FileDecision.file_id == row.id,
                )
                .order_by(FileDecision.resulting_lock_version, FileDecision.id)
            )
        ]
    return result


def _register_version(
    session: Session,
    row: LogicalFile,
    user: User,
    receipt: UploadReceipt,
) -> FileVersion:
    if session.scalar(select(FileVersion.id).where(FileVersion.receipt_id == receipt.receipt_id)):
        raise ApiError(409, "RECEIPT_ALREADY_USED", "This receipt is already registered.")
    version = FileVersion(
        id=uuid4(),
        file_id=row.id,
        version_no=row.latest_version_no,
        receipt_id=receipt.receipt_id,
        storage_provider=receipt.provider,
        storage_object_id=receipt.object_id,
        storage_revision=receipt.revision,
        content_hash=receipt.content_hash,
        original_name=receipt.filename,
        extension=PurePosixPath(receipt.filename).suffix.removeprefix(".").lower(),
        mime_type=receipt.mime_type,
        size_bytes=receipt.size_bytes,
        uploaded_by=user.id,
    )
    session.add(version)
    session.flush()
    return version


def _record(
    session: Session,
    row: LogicalFile,
    version: FileVersion,
    user: User,
    action: str,
    reason: str,
    previous_official: int | None,
) -> None:
    decision = FileDecision(
        id=uuid4(),
        file_id=row.id,
        version_id=version.id,
        actor_id=user.id,
        action=action,
        reason=reason,
        resulting_lock_version=row.lock_version,
        previous_official_version_no=previous_official,
    )
    session.add(decision)
    emit_event(
        session,
        project_id=row.project_id,
        aggregate_id=row.id,
        event_type=f"file.{action}",
        payload={
            "file_id": str(row.id),
            "version_id": str(version.id),
            "version_no": version.version_no,
            "actor_id": str(user.id),
            "decision_id": str(decision.id),
            "reason": reason,
            "previous_official_version_no": previous_official,
            "official_version_no": row.official_version_no,
            "lock_version": row.lock_version,
        },
    )
    session.flush()


def _cas(session: Session, row: LogicalFile, expected: int, **values) -> None:
    changed = session.execute(
        update(LogicalFile)
        .where(
            LogicalFile.id == row.id,
            LogicalFile.lock_version == expected,
        )
        .values(**values, lock_version=expected + 1, updated_at=datetime.now(UTC))
        .execution_options(synchronize_session=False)
    )
    if changed.rowcount != 1:
        raise ApiError(
            409,
            "VERSION_CONFLICT",
            "File changed; reload and retry.",
            {"latest_version": row.lock_version},
        )
    session.refresh(row)


def register_file(
    session: Session,
    user: User,
    project_id: UUID,
    command: RegisterFile,
    key: str,
    storage: StoragePort,
) -> dict:
    file_access(session, user, project_id, write=True)
    request, replay = claim_request(
        session,
        actor_id=user.id,
        project_id=project_id,
        operation="file.register",
        key=key,
        payload=command.model_dump(mode="json"),
    )
    if replay is not None:
        return file_data(session, file_in_project(session, project_id, UUID(replay["id"])))
    receipt = resolve_receipt(
        storage, project_id=project_id, actor_id=user.id, receipt_id=command.receipt_id
    )
    name_key = receipt.filename.casefold()
    if session.scalar(
        select(LogicalFile.id).where(
            LogicalFile.project_id == project_id,
            LogicalFile.name_key == name_key,
        )
    ):
        raise ApiError(409, "FILE_NAME_EXISTS", "Append a version to the existing logical file.")
    row = LogicalFile(
        id=uuid4(),
        project_id=project_id,
        name=receipt.filename,
        name_key=name_key,
        category=command.category,
        latest_version_no=1,
        created_by=user.id,
    )
    session.add(row)
    session.flush()
    version = _register_version(session, row, user, receipt)
    _record(session, row, version, user, "created", command.reason, None)
    return finish_request(session, request, file_data(session, row))


def append_version(
    session: Session,
    user: User,
    project_id: UUID,
    file_id: UUID,
    command: AppendFileVersion,
    key: str,
    storage: StoragePort,
) -> dict:
    file_access(session, user, project_id, write=True)
    row = file_in_project(session, project_id, file_id)
    request, replay = claim_request(
        session,
        actor_id=user.id,
        project_id=project_id,
        operation="file.append",
        key=key,
        payload={"file_id": str(file_id), **command.model_dump(mode="json")},
    )
    if replay is not None:
        return file_data(session, row)
    if row.lock_version != command.expected_version:
        raise ApiError(
            409,
            "VERSION_CONFLICT",
            "File changed; reload and retry.",
            {"latest_version": row.lock_version},
        )
    receipt = resolve_receipt(
        storage, project_id=project_id, actor_id=user.id, receipt_id=command.receipt_id
    )
    previous = row.official_version_no
    _cas(session, row, command.expected_version, latest_version_no=row.latest_version_no + 1)
    version = _register_version(session, row, user, receipt)
    _record(session, row, version, user, "appended", command.reason, previous)
    return finish_request(session, request, file_data(session, row))


def designate_version(
    session: Session,
    user: User,
    project_id: UUID,
    file_id: UUID,
    command: DesignateFileVersion,
    key: str,
) -> dict:
    file_access(session, user, project_id, write=True)
    row = file_in_project(session, project_id, file_id)
    request, replay = claim_request(
        session,
        actor_id=user.id,
        project_id=project_id,
        operation="file.designate",
        key=key,
        payload={"file_id": str(file_id), **command.model_dump(mode="json")},
    )
    if replay is not None:
        return file_data(session, row)
    version = version_in_file(session, row, command.version_id)
    if row.lock_version != command.expected_version:
        raise ApiError(
            409,
            "VERSION_CONFLICT",
            "File changed; reload and retry.",
            {"latest_version": row.lock_version},
        )
    if version.version_no != row.latest_version_no or version.version_no == row.official_version_no:
        raise ApiError(409, "FILE_NOT_DRAFT", "Only the latest draft may become official.")
    previous = row.official_version_no
    _cas(session, row, command.expected_version, official_version_no=version.version_no)
    _record(session, row, version, user, "designated", command.reason, previous)
    return finish_request(session, request, file_data(session, row))


def list_files(
    session: Session,
    user: User,
    project_id: UUID,
    *,
    category: str = "all",
    q: str | None = None,
    file_type: str | None = None,
    status: FileStatus | None = None,
    sort: FileSort = "updated_desc",
    page: int = 1,
    page_size: int = 10,
) -> dict:
    file_access(session, user, project_id)
    if page < 1 or not 1 <= page_size <= 100:
        raise ApiError(422, "INVALID_PAGINATION", "Invalid page or page_size.")
    derived_status = case(
        (FileVersion.version_no == LogicalFile.official_version_no, "current"),
        (FileVersion.version_no == LogicalFile.latest_version_no, "draft"),
        else_="superseded",
    )
    query = (
        select(LogicalFile, FileVersion)
        .join(FileVersion)
        .where(
            LogicalFile.project_id == project_id,
        )
    )
    if category == "archived":
        query = query.where(derived_status == "superseded")
    elif category in {"all", "documents", "images", "exports"}:
        if category != "all":
            query = query.where(LogicalFile.category == category)
        if status != "superseded":
            query = query.where(derived_status != "superseded")
    else:
        raise ApiError(422, "INVALID_FILE_CATEGORY", "Invalid file category.")
    if status:
        query = query.where(derived_status == status)
    if file_type:
        query = query.where(FileVersion.extension == file_type.lower())
    if q and q.strip():
        pattern = (
            "%" + q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        )
        query = query.where(
            or_(
                LogicalFile.name.ilike(pattern, escape="\\"),
                FileVersion.original_name.ilike(pattern, escape="\\"),
            )
        )
    total = session.scalar(select(func.count()).select_from(query.subquery())) or 0
    page = min(page, max(1, (total + page_size - 1) // page_size))
    ordering = {
        "updated_desc": LogicalFile.updated_at.desc(),
        "updated_asc": LogicalFile.updated_at.asc(),
        "name_asc": LogicalFile.name_key.asc(),
        "size_desc": FileVersion.size_bytes.desc(),
    }
    if sort not in ordering:
        raise ApiError(422, "INVALID_FILE_SORT", "Invalid file sort.")
    results = session.execute(
        query.order_by(
            ordering[sort],
            LogicalFile.id,
            FileVersion.version_no.desc(),
        )
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    return {
        "items": [
            {
                **version_data(row, version),
                "project_id": str(row.project_id),
                "name": row.name,
                "category": row.category,
                "lock_version": row.lock_version,
            }
            for row, version in results
        ],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


def get_signed_link(
    session: Session,
    user: User,
    project_id: UUID,
    file_id: UUID,
    version_id: UUID,
    purpose: FilePurpose,
    storage: StoragePort,
) -> dict:
    file_access(session, user, project_id)
    row = file_in_project(session, project_id, file_id)
    version = version_in_file(session, row, version_id)
    link = signed_link(
        storage,
        project_id=project_id,
        actor_id=user.id,
        provider=version.storage_provider,
        object_id=version.storage_object_id,
        revision=version.storage_revision,
        purpose=purpose,
    )
    return {
        "version_id": str(version.id),
        "purpose": purpose,
        "url": link.url,
        "expires_at": link.expires_at.isoformat(),
    }
