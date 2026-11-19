"""Business logic for course TA staff invitations, fine-grained permissions, and removal."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import Course, CourseMember, CourseStaff, User
from app.modules.a import permissions
from app.modules.a.audit import record_audit
from app.modules.a.inbox import notify
from app.modules.b.common import now, require_reason
from app.modules.b.teacher_permissions import (
    ALL_PERMISSIONS,
    effective_permissions,
    require_course_owner,
)
from app.modules.b.teacher_staff_schemas import (
    InviteStaff,
    MyPermissionsDTO,
    RemoveStaff,
    RemoveStaffResultDTO,
    StaffListDTO,
    StaffMemberDTO,
    StaffPermissionsDTO,
    UpdatePermissions,
)


def _active_course(session: Session, course_id: UUID, *, lock: bool = False) -> Course:
    stmt = select(Course).where(Course.id == course_id)
    if lock:
        stmt = stmt.with_for_update()
    course = session.scalar(stmt)
    if course is None:
        raise ApiError(404, "COURSE_NOT_FOUND", "班级不存在。")
    return course


def _require_course_open(course: Course) -> None:
    if course.status != "active":
        raise ApiError(409, "COURSE_NOT_ACTIVE", "只有进行中的班级可执行此操作。")


def _dto_from_row(course: Course, user: User, staff: CourseStaff | None) -> StaffMemberDTO:
    is_owner = user.id == course.owner_id
    role: str = "teacher" if is_owner or (staff and staff.role == "teacher") else "ta"
    if role == "teacher":
        perms = StaffPermissionsDTO(**{key: True for key in ALL_PERMISSIONS})
    else:
        raw = (staff.permissions if staff else None) or {}
        perms = StaffPermissionsDTO(**{key: bool(raw.get(key, False)) for key in ALL_PERMISSIONS})
    joined_at = staff.joined_at if staff is not None else course.created_at
    return StaffMemberDTO(
        user_id=user.id,
        name=user.name or user.email or "—",
        email=user.email,
        role="teacher" if role == "teacher" else "ta",
        permissions=perms,
        joined_at=joined_at,
        is_owner=is_owner,
    )


def list_staff(session: Session, user: User, course_id: UUID) -> StaffListDTO:
    permissions.require_active(user)
    course = _active_course(session, course_id)
    permissions.require_course_staff(session, user, course_id)

    staff_rows = session.scalars(
        select(CourseStaff)
        .where(CourseStaff.course_id == course_id, CourseStaff.left_at.is_(None))
        .order_by(CourseStaff.joined_at.asc())
    ).all()
    staff_by_uid = {row.user_id: row for row in staff_rows}
    user_ids = {course.owner_id, *staff_by_uid.keys()}
    users = {u.id: u for u in session.scalars(select(User).where(User.id.in_(user_ids))).all()}
    items: list[StaffMemberDTO] = []
    if course.owner_id in users:
        items.append(
            _dto_from_row(course, users[course.owner_id], staff_by_uid.get(course.owner_id))
        )
    for row in staff_rows:
        if row.user_id == course.owner_id:
            continue
        target_user = users.get(row.user_id)
        if target_user is not None:
            items.append(_dto_from_row(course, target_user, row))
    return StaffListDTO(
        items=items,
        total=len(items),
        can_manage_staff=course.owner_id == user.id and user.global_role == "teacher",
    )


def invite_staff(
    session: Session, user: User, course_id: UUID, command: InviteStaff, request=None
) -> StaffMemberDTO:
    course = require_course_owner(session, user, course_id)
    _require_course_open(course)
    email = command.email.strip().lower()
    target = session.scalar(select(User).where(func.lower(User.email) == email))
    if target is None:
        raise ApiError(404, "USER_NOT_FOUND", "未找到该邮箱对应的注册账号。")
    if target.status != "active" or target.global_role not in {"teacher", "ta"}:
        raise ApiError(
            422,
            "NOT_TEACHER_OR_TA",
            "被邀请人须为已激活的教师或助教账号。",
            details={"field": "email"},
        )
    if target.id == course.owner_id:
        raise ApiError(409, "ALREADY_STAFF", "该用户已经是本班级负责人。")

    existing = session.get(CourseStaff, (course_id, target.id))
    if existing is not None and existing.left_at is None:
        raise ApiError(409, "ALREADY_STAFF", "该用户已经是本班级教职成员。")

    ts = now()
    if existing is not None:
        existing.role = command.role
        existing.permissions = {}
        existing.joined_at = ts
        existing.left_at = None
        staff = existing
    else:
        staff = CourseStaff(
            course_id=course_id,
            user_id=target.id,
            role=command.role,
            permissions={},
            joined_at=ts,
        )
        session.add(staff)

    member = session.scalar(
        select(CourseMember).where(
            CourseMember.course_id == course_id,
            CourseMember.user_id == target.id,
        )
    )
    if member is None:
        session.add(
            CourseMember(
                course_id=course_id,
                user_id=target.id,
                role=command.role,
                status="active",
                joined_at=ts,
            )
        )
    else:
        member.role = command.role
        member.status = "active"
        member.left_at = None
        member.joined_at = ts

    session.flush()
    notify(
        session,
        recipient=target.id,
        category="course",
        title=f"你已被添加为「{course.name}」的{'教师' if command.role == 'teacher' else '助教'}",
        description=f"由 {user.name or user.email} 邀请加入课程教学团队。",
        target={"kind": "course", "id": course_id, "course_id": course_id},
    )
    record_audit(
        session,
        actor=user,
        action="staff.invited",
        target=("course_staff", f"{course_id}:{target.id}"),
        course_id=course_id,
        after={"user_id": str(target.id), "role": command.role},
        request=request,
    )
    return _dto_from_row(course, target, staff)


def update_permissions(
    session: Session,
    user: User,
    course_id: UUID,
    staff_user_id: UUID,
    command: UpdatePermissions,
    request=None,
) -> StaffMemberDTO:
    course = require_course_owner(session, user, course_id)
    _require_course_open(course)
    if staff_user_id == course.owner_id:
        raise ApiError(422, "CANNOT_MODIFY_OWNER", "不能修改课程创建者自身的权限。")

    staff = session.get(CourseStaff, (course_id, staff_user_id))
    if staff is None or staff.left_at is not None:
        raise ApiError(404, "STAFF_NOT_FOUND", "该用户不是当前班级的教职成员。")
    target = session.get(User, staff_user_id)
    if target is None:
        raise ApiError(404, "USER_NOT_FOUND", "用户不存在。")

    before = dict(staff.permissions or {})
    merged = {key: bool(before.get(key, False)) for key in ALL_PERMISSIONS}
    updates = command.model_dump(exclude_none=True)
    for key, val in updates.items():
        if key in ALL_PERMISSIONS:
            merged[key] = bool(val)
    staff.permissions = dict(merged)
    session.flush()

    notify(
        session,
        recipient=staff_user_id,
        category="course",
        title=f"你在「{course.name}」的助教权限已更新",
        description="课程创建者调整了你的管理权限，刷新后生效。",
        target={"kind": "course", "id": course_id, "course_id": course_id},
    )
    record_audit(
        session,
        actor=user,
        action="staff.permissions_updated",
        target=("course_staff", f"{course_id}:{staff_user_id}"),
        course_id=course_id,
        before=before,
        after=merged,
        request=request,
    )
    return _dto_from_row(course, target, staff)


def remove_staff(
    session: Session,
    user: User,
    course_id: UUID,
    staff_user_id: UUID,
    command: RemoveStaff,
    request=None,
) -> RemoveStaffResultDTO:
    course = require_course_owner(session, user, course_id)
    reason = require_reason(command.reason)
    if staff_user_id == course.owner_id:
        raise ApiError(422, "CANNOT_REMOVE_OWNER", "不能移出课程创建者。")

    staff = session.get(CourseStaff, (course_id, staff_user_id))
    if staff is None or staff.left_at is not None:
        raise ApiError(404, "STAFF_NOT_FOUND", "该用户不在当前教学团队中。")

    ts = now()
    staff.left_at = ts
    member = session.scalar(
        select(CourseMember).where(
            CourseMember.course_id == course_id,
            CourseMember.user_id == staff_user_id,
            CourseMember.left_at.is_(None),
        )
    )
    if member is not None:
        member.left_at = ts
        member.status = "left"
    session.flush()

    notify(
        session,
        recipient=staff_user_id,
        category="course",
        title=f"你已被移出「{course.name}」教学团队",
        description=f"原因：{reason}",
        target={"kind": "course", "id": course_id, "course_id": course_id},
    )
    record_audit(
        session,
        actor=user,
        action="staff.removed",
        target=("course_staff", f"{course_id}:{staff_user_id}"),
        course_id=course_id,
        reason=reason,
        request=request,
    )
    return RemoveStaffResultDTO(removed=True, user_id=staff_user_id)


def my_permissions(session: Session, user: User, course_id: UUID) -> MyPermissionsDTO:
    role, is_owner, perms = effective_permissions(session, user, course_id)
    return MyPermissionsDTO(
        role="teacher" if role == "teacher" else "ta",
        is_owner=is_owner,
        can_manage=role == "teacher",
        permissions=StaffPermissionsDTO(**perms),
    )
