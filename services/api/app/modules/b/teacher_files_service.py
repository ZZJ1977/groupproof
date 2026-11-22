"""Teacher course material folders, versioned uploads, and visibility-scoped student reads."""

from __future__ import annotations

import base64
import binascii
import hashlib
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import Course, CourseMember, GroupMember, ProjectGroup, User
from app.modules.a import permissions
from app.modules.a.audit import record_audit
from app.modules.b.models import (
    BCourseFileFolder,
    BCourseMaterialItem,
    BCourseMaterialVersion,
)
from app.modules.b.teacher_files_schemas import (
    AppendMaterialVersionRequest,
    BatchMaterialRequest,
    BatchMaterialResultDTO,
    CreateFolderRequest,
    DeleteResultDTO,
    FolderDTO,
    FolderRefDTO,
    MaterialDetailDTO,
    MaterialItemDTO,
    MaterialVersionDTO,
    StudentMaterialsDTO,
    TeacherFilesTreeDTO,
    UpdateFolderRequest,
    UpdateMaterialRequest,
    UploadMaterialRequest,
)
from app.modules.b.teacher_permissions import effective_permissions, require_staff_permission

MAX_INLINE_BYTES = 15 * 1024 * 1024


def _load_course(session: Session, course_id: UUID) -> Course:
    course = session.get(Course, course_id)
    if course is None:
        raise ApiError(404, "COURSE_NOT_FOUND", "班级不存在。")
    return course


def _require_active_course(session: Session, course_id: UUID) -> Course:
    course = _load_course(session, course_id)
    if course.status != "active":
        raise ApiError(409, "COURSE_NOT_ACTIVE", "课程已结课或未激活，当前为只读状态。")
    return course


def _user_names(session: Session, user_ids: set[UUID]) -> dict[UUID, str]:
    if not user_ids:
        return {}
    rows = session.execute(select(User.id, User.name).where(User.id.in_(user_ids))).all()
    return {uid: (name or "") for uid, name in rows}


def _decode_content(
    content_base64: str | None, fallback_name: str, declared_size: int | None
) -> tuple[bytes | None, int, str]:
    if content_base64 is None:
        raw_size = declared_size if declared_size is not None else 0
        checksum = hashlib.sha256(fallback_name.encode("utf-8")).hexdigest()
        return None, raw_size, checksum
    try:
        raw = base64.b64decode(content_base64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ApiError(422, "INVALID_FILE_CONTENT", "文件内容编码无效。") from exc
    if len(raw) > MAX_INLINE_BYTES:
        raise ApiError(422, "FILE_TOO_LARGE", "单次上传资料不能超过 15 MB。")
    checksum = hashlib.sha256(raw).hexdigest()
    return raw, len(raw), checksum


def _validate_folder_belongs(
    session: Session, course_id: UUID, folder_id: UUID | None
) -> BCourseFileFolder | None:
    if folder_id is None:
        return None
    folder = session.get(BCourseFileFolder, folder_id)
    if folder is None or folder.course_id != course_id:
        raise ApiError(404, "FOLDER_NOT_FOUND", "目标文件夹不存在。")
    return folder


def _ensure_unique_sibling_name(
    session: Session,
    course_id: UUID,
    parent_id: UUID | None,
    name: str,
    *,
    exclude_folder_id: UUID | None = None,
) -> None:
    """Check sibling uniqueness in Python so parent_id=NULL behaves uniformly."""
    target = name.strip().lower()
    if not target:
        raise ApiError(422, "INVALID_FOLDER_NAME", "文件夹名称不能为空。")
    siblings = session.scalars(
        select(BCourseFileFolder).where(BCourseFileFolder.course_id == course_id)
    ).all()
    for sib in siblings:
        if sib.parent_id != parent_id:
            continue
        if exclude_folder_id is not None and sib.id == exclude_folder_id:
            continue
        if sib.name.strip().lower() == target:
            raise ApiError(409, "FOLDER_NAME_DUPLICATE", "同一目录下已存在同名文件夹。")


def _folder_breadcrumbs(
    folders_by_id: dict[UUID, BCourseFileFolder], current_folder_id: UUID | None
) -> list[FolderRefDTO]:
    chain: list[FolderRefDTO] = []
    seen: set[UUID] = set()
    cursor = current_folder_id
    while cursor is not None and cursor in folders_by_id and cursor not in seen:
        seen.add(cursor)
        folder = folders_by_id[cursor]
        chain.append(FolderRefDTO(id=folder.id, name=folder.name, parent_id=folder.parent_id))
        cursor = folder.parent_id
    chain.reverse()
    return chain


def _material_dto(
    item: BCourseMaterialItem, names: dict[UUID, str], *, student_route: bool = False
) -> MaterialItemDTO:
    href = (
        f"/api/v1/courses/{item.course_id}/materials/{item.id}/download"
        if student_route
        else f"/api/v1/teacher/classes/{item.course_id}/files/{item.id}/download"
    )
    return MaterialItemDTO(
        id=item.id,
        course_id=item.course_id,
        folder_id=item.folder_id,
        name=item.name,
        visibility=item.visibility,  # type: ignore[arg-type]
        status=item.status,  # type: ignore[arg-type]
        latest_version_no=item.latest_version_no,
        mime_type=item.mime_type,
        size_bytes=item.size_bytes,
        uploaded_by=item.uploaded_by,
        uploader_name=names.get(item.uploaded_by),
        created_at=item.created_at,
        updated_at=item.updated_at,
        download_href=href,
    )


def list_teacher_files(
    session: Session,
    user: User,
    course_id: UUID,
    *,
    folder_id: UUID | None = None,
    q: str | None = None,
    visibility: str | None = None,
    include_all: bool = False,
) -> TeacherFilesTreeDTO:
    _role, _is_owner, perms = effective_permissions(session, user, course_id)
    folders = session.scalars(
        select(BCourseFileFolder)
        .where(BCourseFileFolder.course_id == course_id)
        .order_by(
            BCourseFileFolder.sort_order.asc(),
            BCourseFileFolder.created_at.asc(),
            BCourseFileFolder.name.asc(),
        )
    ).all()
    folders_by_id = {f.id: f for f in folders}
    if folder_id is not None and folder_id not in folders_by_id:
        raise ApiError(404, "FOLDER_NOT_FOUND", "文件夹不存在。")

    count_rows = session.execute(
        select(BCourseMaterialItem.folder_id, func.count(BCourseMaterialItem.id))
        .where(BCourseMaterialItem.course_id == course_id)
        .group_by(BCourseMaterialItem.folder_id)
    ).all()
    folder_counts = {fid: cnt for fid, cnt in count_rows}

    query = select(BCourseMaterialItem).where(BCourseMaterialItem.course_id == course_id)
    search_term = q.strip().lower() if q else ""
    if not include_all and not search_term:
        if folder_id is None:
            query = query.where(BCourseMaterialItem.folder_id.is_(None))
        else:
            query = query.where(BCourseMaterialItem.folder_id == folder_id)
    if visibility is not None:
        query = query.where(BCourseMaterialItem.visibility == visibility)

    all_items = session.scalars(query.order_by(BCourseMaterialItem.updated_at.desc())).all()
    if search_term:
        all_items = [item for item in all_items if search_term in item.name.lower()]

    names = _user_names(session, {item.uploaded_by for item in all_items})
    folder_dtos = [
        FolderDTO(
            id=f.id,
            course_id=f.course_id,
            name=f.name,
            parent_id=f.parent_id,
            sort_order=f.sort_order,
            item_count=int(folder_counts.get(f.id, 0)),
            created_at=f.created_at,
        )
        for f in folders
    ]
    return TeacherFilesTreeDTO(
        course_id=course_id,
        can_manage=bool(perms.get("manage_files", False)),
        current_folder_id=folder_id,
        breadcrumbs=_folder_breadcrumbs(folders_by_id, folder_id),
        folders=folder_dtos,
        items=[_material_dto(item, names) for item in all_items],
    )


def create_folder(
    session: Session, user: User, course_id: UUID, command: CreateFolderRequest, request=None
) -> FolderDTO:
    require_staff_permission(session, user, course_id, "manage_files")
    _require_active_course(session, course_id)
    _validate_folder_belongs(session, course_id, command.parent_id)
    cleaned_name = command.name.strip()
    _ensure_unique_sibling_name(session, course_id, command.parent_id, cleaned_name)

    folder = BCourseFileFolder(
        course_id=course_id,
        parent_id=command.parent_id,
        name=cleaned_name,
        sort_order=command.sort_order,
        created_by=user.id,
    )
    session.add(folder)
    session.flush()
    record_audit(
        session,
        actor=user,
        action="course.folder.created",
        target=("course_folder", folder.id),
        course_id=course_id,
        after={
            "name": folder.name,
            "parent_id": str(folder.parent_id) if folder.parent_id else None,
        },
        request=request,
    )
    return FolderDTO(
        id=folder.id,
        course_id=folder.course_id,
        name=folder.name,
        parent_id=folder.parent_id,
        sort_order=folder.sort_order,
        item_count=0,
        created_at=folder.created_at,
    )


def update_folder(
    session: Session,
    user: User,
    course_id: UUID,
    folder_id: UUID,
    command: UpdateFolderRequest,
    request=None,
) -> FolderDTO:
    require_staff_permission(session, user, course_id, "manage_files")
    _require_active_course(session, course_id)
    folder = _validate_folder_belongs(session, course_id, folder_id)
    assert folder is not None

    new_parent_id = folder.parent_id
    if command.move_to_root:
        new_parent_id = None
    elif command.parent_id is not None:
        if command.parent_id == folder.id:
            raise ApiError(409, "FOLDER_CYCLE", "不能将文件夹移动到自身下。")
        parent = _validate_folder_belongs(session, course_id, command.parent_id)
        # Prevent moving a folder inside its own subtree
        all_folders = {
            f.id: f
            for f in session.scalars(
                select(BCourseFileFolder).where(BCourseFileFolder.course_id == course_id)
            ).all()
        }
        cursor: BCourseFileFolder | None = parent
        while cursor is not None:
            if cursor.id == folder.id:
                raise ApiError(409, "FOLDER_CYCLE", "不能将文件夹移动到其子文件夹下。")
            cursor = all_folders.get(cursor.parent_id) if cursor.parent_id else None
        new_parent_id = command.parent_id

    new_name = command.name.strip() if command.name is not None else folder.name
    _ensure_unique_sibling_name(
        session, course_id, new_parent_id, new_name, exclude_folder_id=folder.id
    )

    folder.name = new_name
    folder.parent_id = new_parent_id
    if command.sort_order is not None:
        folder.sort_order = command.sort_order
    session.flush()

    cnt = (
        session.scalar(
            select(func.count(BCourseMaterialItem.id)).where(
                BCourseMaterialItem.course_id == course_id,
                BCourseMaterialItem.folder_id == folder.id,
            )
        )
        or 0
    )
    record_audit(
        session,
        actor=user,
        action="course.folder.updated",
        target=("course_folder", folder.id),
        course_id=course_id,
        after={
            "name": folder.name,
            "parent_id": str(folder.parent_id) if folder.parent_id else None,
        },
        request=request,
    )
    return FolderDTO(
        id=folder.id,
        course_id=folder.course_id,
        name=folder.name,
        parent_id=folder.parent_id,
        sort_order=folder.sort_order,
        item_count=int(cnt),
        created_at=folder.created_at,
    )


def delete_folder(
    session: Session, user: User, course_id: UUID, folder_id: UUID, request=None
) -> DeleteResultDTO:
    require_staff_permission(session, user, course_id, "manage_files")
    _require_active_course(session, course_id)
    folder = _validate_folder_belongs(session, course_id, folder_id)
    assert folder is not None

    # Move child folders and materials up to parent_id so deleting a folder never strands content
    child_folders = session.scalars(
        select(BCourseFileFolder).where(
            BCourseFileFolder.course_id == course_id, BCourseFileFolder.parent_id == folder.id
        )
    ).all()
    for child in child_folders:
        child.parent_id = folder.parent_id

    child_items = session.scalars(
        select(BCourseMaterialItem).where(
            BCourseMaterialItem.course_id == course_id, BCourseMaterialItem.folder_id == folder.id
        )
    ).all()
    for item in child_items:
        item.folder_id = folder.parent_id

    folder_name = folder.name
    session.delete(folder)
    session.flush()
    record_audit(
        session,
        actor=user,
        action="course.folder.deleted",
        target=("course_folder", folder_id),
        course_id=course_id,
        before={"name": folder_name},
        request=request,
    )
    return DeleteResultDTO(deleted=True, id=folder_id)


def upload_material(
    session: Session, user: User, course_id: UUID, command: UploadMaterialRequest, request=None
) -> MaterialDetailDTO:
    require_staff_permission(session, user, course_id, "manage_files")
    _require_active_course(session, course_id)
    _validate_folder_belongs(session, course_id, command.folder_id)
    cleaned_name = command.name.strip()
    if not cleaned_name:
        raise ApiError(422, "INVALID_FILE_NAME", "资料名称不能为空。")

    raw, size_bytes, checksum = _decode_content(
        command.content_base64, cleaned_name, command.size_bytes
    )
    stored_b64 = base64.b64encode(raw).decode("ascii") if raw is not None else None

    item = BCourseMaterialItem(
        course_id=course_id,
        folder_id=command.folder_id,
        name=cleaned_name,
        visibility=command.visibility,
        status=command.status,
        latest_version_no=1,
        mime_type=command.mime_type,
        size_bytes=size_bytes,
        uploaded_by=user.id,
    )
    session.add(item)
    session.flush()

    version = BCourseMaterialVersion(
        material_id=item.id,
        version_no=1,
        original_name=cleaned_name,
        mime_type=command.mime_type,
        size_bytes=size_bytes,
        checksum=checksum,
        content_base64=stored_b64,
        change_note=command.change_note.strip() if command.change_note else "初始上传",
        uploaded_by=user.id,
    )
    session.add(version)
    session.flush()

    record_audit(
        session,
        actor=user,
        action="course.material.uploaded",
        target=("course_material", item.id),
        course_id=course_id,
        after={"name": item.name, "visibility": item.visibility, "version_no": 1},
        request=request,
    )
    return get_material_detail(session, user, course_id, item.id)


def get_material_detail(
    session: Session, user: User, course_id: UUID, material_id: UUID
) -> MaterialDetailDTO:
    effective_permissions(session, user, course_id)
    item = session.get(BCourseMaterialItem, material_id)
    if item is None or item.course_id != course_id:
        raise ApiError(404, "MATERIAL_NOT_FOUND", "资料不存在。")
    versions = session.scalars(
        select(BCourseMaterialVersion)
        .where(BCourseMaterialVersion.material_id == material_id)
        .order_by(BCourseMaterialVersion.version_no.desc())
    ).all()
    uid_set = {item.uploaded_by, *(v.uploaded_by for v in versions)}
    names = _user_names(session, uid_set)
    return MaterialDetailDTO(
        item=_material_dto(item, names),
        versions=[
            MaterialVersionDTO(
                id=v.id,
                version_no=v.version_no,
                original_name=v.original_name,
                mime_type=v.mime_type,
                size_bytes=v.size_bytes,
                checksum=v.checksum,
                change_note=v.change_note,
                uploaded_by=v.uploaded_by,
                uploader_name=names.get(v.uploaded_by),
                created_at=v.created_at,
                has_content=v.content_base64 is not None,
            )
            for v in versions
        ],
    )


def append_material_version(
    session: Session,
    user: User,
    course_id: UUID,
    material_id: UUID,
    command: AppendMaterialVersionRequest,
    request=None,
) -> MaterialDetailDTO:
    require_staff_permission(session, user, course_id, "manage_files")
    _require_active_course(session, course_id)
    item = session.get(BCourseMaterialItem, material_id)
    if item is None or item.course_id != course_id:
        raise ApiError(404, "MATERIAL_NOT_FOUND", "资料不存在。")

    next_ver = item.latest_version_no + 1
    orig_name = command.original_name.strip() if command.original_name else item.name
    mime = command.mime_type or item.mime_type
    raw, size_bytes, checksum = _decode_content(
        command.content_base64, f"{orig_name}:v{next_ver}", command.size_bytes
    )
    stored_b64 = base64.b64encode(raw).decode("ascii") if raw is not None else None

    version = BCourseMaterialVersion(
        material_id=item.id,
        version_no=next_ver,
        original_name=orig_name,
        mime_type=mime,
        size_bytes=size_bytes,
        checksum=checksum,
        content_base64=stored_b64,
        change_note=(
            command.change_note.strip() if command.change_note else f"上传新版本 v{next_ver}"
        ),
        uploaded_by=user.id,
    )
    session.add(version)
    item.latest_version_no = next_ver
    item.mime_type = mime
    item.size_bytes = size_bytes
    item.uploaded_by = user.id
    session.flush()

    record_audit(
        session,
        actor=user,
        action="course.material.version_appended",
        target=("course_material", item.id),
        course_id=course_id,
        after={"version_no": next_ver, "size_bytes": size_bytes},
        request=request,
    )
    return get_material_detail(session, user, course_id, item.id)


def update_material(
    session: Session,
    user: User,
    course_id: UUID,
    material_id: UUID,
    command: UpdateMaterialRequest,
    request=None,
) -> MaterialItemDTO:
    require_staff_permission(session, user, course_id, "manage_files")
    _require_active_course(session, course_id)
    item = session.get(BCourseMaterialItem, material_id)
    if item is None or item.course_id != course_id:
        raise ApiError(404, "MATERIAL_NOT_FOUND", "资料不存在。")

    if command.name is not None:
        cleaned = command.name.strip()
        if not cleaned:
            raise ApiError(422, "INVALID_FILE_NAME", "资料名称不能为空。")
        item.name = cleaned
    if command.move_to_root:
        item.folder_id = None
    elif command.folder_id is not None:
        _validate_folder_belongs(session, course_id, command.folder_id)
        item.folder_id = command.folder_id
    if command.visibility is not None:
        item.visibility = command.visibility
    if command.status is not None:
        item.status = command.status
    session.flush()

    record_audit(
        session,
        actor=user,
        action="course.material.updated",
        target=("course_material", item.id),
        course_id=course_id,
        after={"visibility": item.visibility, "status": item.status, "name": item.name},
        request=request,
    )
    names = _user_names(session, {item.uploaded_by})
    return _material_dto(item, names)


def delete_material(
    session: Session, user: User, course_id: UUID, material_id: UUID, request=None
) -> DeleteResultDTO:
    require_staff_permission(session, user, course_id, "manage_files")
    _require_active_course(session, course_id)
    item = session.get(BCourseMaterialItem, material_id)
    if item is None or item.course_id != course_id:
        raise ApiError(404, "MATERIAL_NOT_FOUND", "资料不存在。")
    name = item.name
    session.delete(item)
    session.flush()
    record_audit(
        session,
        actor=user,
        action="course.material.deleted",
        target=("course_material", material_id),
        course_id=course_id,
        before={"name": name},
        request=request,
    )
    return DeleteResultDTO(deleted=True, id=material_id)


def batch_materials(
    session: Session, user: User, course_id: UUID, command: BatchMaterialRequest, request=None
) -> BatchMaterialResultDTO:
    require_staff_permission(session, user, course_id, "manage_files")
    _require_active_course(session, course_id)
    if command.action == "move" and command.folder_id is not None:
        _validate_folder_belongs(session, course_id, command.folder_id)
    if command.action == "set_visibility" and command.visibility is None:
        raise ApiError(422, "VISIBILITY_REQUIRED", "批量设置可见范围时必须提供 visibility。")

    items = session.scalars(
        select(BCourseMaterialItem).where(
            BCourseMaterialItem.course_id == course_id,
            BCourseMaterialItem.id.in_(command.ids),
        )
    ).all()
    affected = 0
    for item in items:
        if command.action == "move":
            item.folder_id = command.folder_id
        elif command.action == "set_visibility" and command.visibility is not None:
            item.visibility = command.visibility
        elif command.action == "delete":
            session.delete(item)
        affected += 1
    session.flush()
    record_audit(
        session,
        actor=user,
        action=f"course.material.batch_{command.action}",
        target=("course", course_id),
        course_id=course_id,
        after={"affected": affected, "ids": [str(mid) for mid in command.ids]},
        request=request,
    )
    return BatchMaterialResultDTO(affected=affected, action=command.action)


def _student_access_context(session: Session, user: User, course_id: UUID) -> tuple[bool, set[str]]:
    permissions.require_active(user)
    _load_course(session, course_id)
    try:
        effective_permissions(session, user, course_id)
        return True, {"all", "grouped", "staff"}
    except ApiError:
        pass

    member = session.scalar(
        select(CourseMember).where(
            CourseMember.course_id == course_id,
            CourseMember.user_id == user.id,
            CourseMember.status == "active",
            CourseMember.left_at.is_(None),
        )
    )
    if member is None:
        raise ApiError(403, "COURSE_MEMBER_REQUIRED", "你不是该班级成员，无权查看课程资料。")
    grouped = session.scalar(
        select(GroupMember.id)
        .join(ProjectGroup, ProjectGroup.id == GroupMember.group_id)
        .where(
            ProjectGroup.course_id == course_id,
            GroupMember.user_id == user.id,
            GroupMember.left_at.is_(None),
        )
    )
    is_grouped = grouped is not None
    allowed = {"all", "grouped"} if is_grouped else {"all"}
    return is_grouped, allowed


def list_student_materials(session: Session, user: User, course_id: UUID) -> StudentMaterialsDTO:
    is_grouped, allowed = _student_access_context(session, user, course_id)
    folders = session.scalars(
        select(BCourseFileFolder)
        .where(BCourseFileFolder.course_id == course_id)
        .order_by(
            BCourseFileFolder.sort_order.asc(),
            BCourseFileFolder.created_at.asc(),
            BCourseFileFolder.name.asc(),
        )
    ).all()
    items = session.scalars(
        select(BCourseMaterialItem)
        .where(
            BCourseMaterialItem.course_id == course_id,
            BCourseMaterialItem.status == "published",
            BCourseMaterialItem.visibility.in_(allowed),
        )
        .order_by(BCourseMaterialItem.updated_at.desc())
    ).all()
    names = _user_names(session, {item.uploaded_by for item in items})
    return StudentMaterialsDTO(
        course_id=course_id,
        is_grouped=is_grouped,
        folders=[FolderRefDTO(id=f.id, name=f.name, parent_id=f.parent_id) for f in folders],
        items=[_material_dto(item, names, student_route=True) for item in items],
    )


def download_material_content(
    session: Session,
    user: User,
    course_id: UUID,
    material_id: UUID,
    *,
    version_no: int | None = None,
    staff_only: bool = False,
) -> tuple[str, str, bytes]:
    if staff_only:
        effective_permissions(session, user, course_id)
        allowed = {"all", "grouped", "staff"}
    else:
        _is_grouped, allowed = _student_access_context(session, user, course_id)

    item = session.get(BCourseMaterialItem, material_id)
    if item is None or item.course_id != course_id:
        raise ApiError(404, "MATERIAL_NOT_FOUND", "资料不存在。")
    if not staff_only and (item.status != "published" or item.visibility not in allowed):
        raise ApiError(403, "MATERIAL_FORBIDDEN", "当前身份无权下载该课程资料。")

    target_v = version_no if version_no is not None else item.latest_version_no
    version = session.scalar(
        select(BCourseMaterialVersion).where(
            BCourseMaterialVersion.material_id == item.id,
            BCourseMaterialVersion.version_no == target_v,
        )
    )
    if version is None:
        raise ApiError(404, "MATERIAL_VERSION_NOT_FOUND", "指定资料版本不存在。")

    if version.content_base64 is not None:
        payload = base64.b64decode(version.content_base64)
    else:
        payload = f"{version.original_name} (v{version.version_no})".encode()
    return version.original_name, version.mime_type, payload
