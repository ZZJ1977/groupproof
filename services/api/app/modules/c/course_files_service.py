"""Course file transactions. Callers own commit/rollback; no storage bytes are written here."""

from datetime import UTC, datetime
from pathlib import PurePosixPath
from uuid import UUID, uuid4

from sqlalchemy import case, func, or_, select, update
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import User
from app.modules.c.course_files_events import claim_request, emit_event, finish_request
from app.modules.c.course_files_models import CourseFile, CourseFileDecision, CourseFileVersion
from app.modules.c.course_files_permissions import course_access
from app.modules.c.course_files_schemas import (
    AppendCourseFileVersion,
    FilePurpose,
    FileSort,
    FileStatus,
    PublishCourseFileVersion,
    RegisterCourseFile,
)
from app.modules.c.course_files_storage import (
    CourseStoragePort,
    CourseUploadReceipt,
    resolve_receipt,
    signed_link,
)


def file_in_course(session: Session, course_id: UUID, file_id: UUID) -> CourseFile:
    row = session.scalar(
        select(CourseFile)
        .where(
            CourseFile.id == file_id,
            CourseFile.course_id == course_id,
        )
        .execution_options(populate_existing=True)
    )
    if row is None:
        raise ApiError(404, "FILE_NOT_FOUND", "File not found in this course.")
    return row


def version_in_file(session: Session, row: CourseFile, version_id: UUID) -> CourseFileVersion:
    version = session.scalar(
        select(CourseFileVersion).where(
            CourseFileVersion.id == version_id,
            CourseFileVersion.file_id == row.id,
        )
    )
    if version is None:
        raise ApiError(404, "FILE_VERSION_NOT_FOUND", "Version not found in this file.")
    return version


def version_data(row: CourseFile, version: CourseFileVersion) -> dict:
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


def published_versions():
    return select(CourseFileDecision.version_id).where(CourseFileDecision.action == "published")


def file_data(
    session: Session,
    row: CourseFile,
    *,
    history: bool = False,
    published_only: bool = False,
) -> dict:
    versions = list(
        session.scalars(
            select(CourseFileVersion)
            .where(
                CourseFileVersion.file_id == row.id,
                CourseFileVersion.id.in_(published_versions()) if published_only else True,
            )
            .order_by(CourseFileVersion.version_no.desc())
        )
    )
    if not versions:
        raise ApiError(404, "FILE_NOT_FOUND", "No published file is available in this course.")
    result = {
        "id": str(row.id),
        "course_id": str(row.course_id),
        "name": row.name,
        "category": row.category,
        "latest_version_no": versions[0].version_no if published_only else row.latest_version_no,
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
                select(CourseFileDecision)
                .where(
                    CourseFileDecision.file_id == row.id,
                    CourseFileDecision.action == "published" if published_only else True,
                )
                .order_by(CourseFileDecision.resulting_lock_version, CourseFileDecision.id)
            )
        ]
    return result


def get_file(session: Session, user: User, course_id: UUID, file_id: UUID) -> dict:
    access = course_access(session, user, course_id)
    return file_data(
        session,
        file_in_course(session, course_id, file_id),
        history=True,
        published_only=not access.can_read_drafts,
    )


def _register_version(
    session: Session,
    row: CourseFile,
    user: User,
    receipt: CourseUploadReceipt,
) -> CourseFileVersion:
    if session.scalar(
        select(CourseFileVersion.id).where(CourseFileVersion.receipt_id == receipt.receipt_id)
    ):
        raise ApiError(409, "RECEIPT_ALREADY_USED", "This receipt is already registered.")
    version = CourseFileVersion(
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
    row: CourseFile,
    version: CourseFileVersion,
    user: User,
    action: str,
    reason: str,
    previous_official: int | None,
) -> None:
    decision = CourseFileDecision(
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
        course_id=row.course_id,
        aggregate_id=row.id,
        event_type=f"course_file.{action}",
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


def _cas(session: Session, row: CourseFile, expected: int, **values) -> None:
    changed = session.execute(
        update(CourseFile)
        .where(
            CourseFile.id == row.id,
            CourseFile.lock_version == expected,
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
    course_id: UUID,
    command: RegisterCourseFile,
    key: str,
    storage: CourseStoragePort,
) -> dict:
    course_access(session, user, course_id, write=True)
    request, replay = claim_request(
        session,
        actor_id=user.id,
        course_id=course_id,
        operation="course_file.register",
        key=key,
        payload=command.model_dump(mode="json"),
    )
    if replay is not None:
        return file_data(session, file_in_course(session, course_id, UUID(replay["id"])))
    receipt = resolve_receipt(
        storage, course_id=course_id, actor_id=user.id, receipt_id=command.receipt_id
    )
    name_key = receipt.filename.casefold()
    if session.scalar(
        select(CourseFile.id).where(
            CourseFile.course_id == course_id,
            CourseFile.name_key == name_key,
        )
    ):
        raise ApiError(409, "FILE_NAME_EXISTS", "Append a version to the existing logical file.")
    row = CourseFile(
        id=uuid4(),
        course_id=course_id,
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
    course_id: UUID,
    file_id: UUID,
    command: AppendCourseFileVersion,
    key: str,
    storage: CourseStoragePort,
) -> dict:
    course_access(session, user, course_id, write=True)
    row = file_in_course(session, course_id, file_id)
    request, replay = claim_request(
        session,
        actor_id=user.id,
        course_id=course_id,
        operation="course_file.append",
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
        storage, course_id=course_id, actor_id=user.id, receipt_id=command.receipt_id
    )
    previous = row.official_version_no
    _cas(session, row, command.expected_version, latest_version_no=row.latest_version_no + 1)
    version = _register_version(session, row, user, receipt)
    _record(session, row, version, user, "appended", command.reason, previous)
    return finish_request(session, request, file_data(session, row))


def publish_version(
    session: Session,
    user: User,
    course_id: UUID,
    file_id: UUID,
    command: PublishCourseFileVersion,
    key: str,
) -> dict:
    course_access(session, user, course_id, write=True)
    row = file_in_course(session, course_id, file_id)
    request, replay = claim_request(
        session,
        actor_id=user.id,
        course_id=course_id,
        operation="course_file.publish",
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
    _record(session, row, version, user, "published", command.reason, previous)
    return finish_request(session, request, file_data(session, row))


def list_files(
    session: Session,
    user: User,
    course_id: UUID,
    *,
    category: str = "all",
    q: str | None = None,
    file_type: str | None = None,
    status: FileStatus | None = None,
    sort: FileSort = "updated_desc",
    page: int = 1,
    page_size: int = 10,
) -> dict:
    access = course_access(session, user, course_id)
    if page < 1 or not 1 <= page_size <= 100:
        raise ApiError(422, "INVALID_PAGINATION", "Invalid page or page_size.")
    derived_status = case(
        (CourseFileVersion.version_no == CourseFile.official_version_no, "current"),
        (CourseFileVersion.version_no == CourseFile.latest_version_no, "draft"),
        else_="superseded",
    )
    query = (
        select(CourseFile, CourseFileVersion)
        .join(CourseFileVersion)
        .where(
            CourseFile.course_id == course_id,
        )
    )
    if not access.can_read_drafts:
        query = query.where(CourseFileVersion.id.in_(published_versions()))
    if category == "archived":
        query = query.where(derived_status == "superseded")
    elif category in {"all", "documents", "images", "exports"}:
        if category != "all":
            query = query.where(CourseFile.category == category)
        if status != "superseded":
            query = query.where(derived_status != "superseded")
    else:
        raise ApiError(422, "INVALID_FILE_CATEGORY", "Invalid file category.")
    if status:
        query = query.where(derived_status == status)
    if file_type:
        query = query.where(CourseFileVersion.extension == file_type.lower())
    if q and q.strip():
        pattern = (
            "%" + q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        )
        query = query.where(
            or_(
                CourseFile.name.ilike(pattern, escape="\\"),
                CourseFileVersion.original_name.ilike(pattern, escape="\\"),
            )
        )
    total = session.scalar(select(func.count()).select_from(query.subquery())) or 0
    page = min(page, max(1, (total + page_size - 1) // page_size))
    ordering = {
        "updated_desc": CourseFile.updated_at.desc(),
        "updated_asc": CourseFile.updated_at.asc(),
        "name_asc": CourseFile.name_key.asc(),
        "size_desc": CourseFileVersion.size_bytes.desc(),
    }
    if sort not in ordering:
        raise ApiError(422, "INVALID_FILE_SORT", "Invalid file sort.")
    results = session.execute(
        query.order_by(
            ordering[sort],
            CourseFile.id,
            CourseFileVersion.version_no.desc(),
        )
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    return {
        "items": [
            {
                **version_data(row, version),
                "course_id": str(row.course_id),
                "name": row.name,
                "category": row.category,
                "lock_version": row.lock_version,
            }
            for row, version in results
        ],
        "total": total,
        "page": page,
        "page_size": page_size,
        "can_write": access.can_write,
    }


def get_signed_link(
    session: Session,
    user: User,
    course_id: UUID,
    file_id: UUID,
    version_id: UUID,
    purpose: FilePurpose,
    storage: CourseStoragePort,
) -> dict:
    access = course_access(session, user, course_id)
    row = file_in_course(session, course_id, file_id)
    version = version_in_file(session, row, version_id)
    if not access.can_read_drafts and not session.scalar(
        select(CourseFileDecision.id).where(
            CourseFileDecision.version_id == version.id,
            CourseFileDecision.action == "published",
        )
    ):
        raise ApiError(404, "FILE_VERSION_NOT_FOUND", "Published version not found in this course.")
    link = signed_link(
        storage,
        course_id=course_id,
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
