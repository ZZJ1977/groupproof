"""Fine-grained course staff permission helpers for Module B teacher workflows."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import Course, CourseStaff, User
from app.modules.a import permissions

ALL_PERMISSIONS: tuple[str, ...] = (
    "approve_joins",
    "manage_groups",
    "manage_files",
    "approve_changes",
    "export_reports",
    "post_announcements",
)


def _all_true() -> dict[str, bool]:
    return {key: True for key in ALL_PERMISSIONS}


def _ta_map(raw: dict | None) -> dict[str, bool]:
    source = raw or {}
    return {key: bool(source.get(key, False)) for key in ALL_PERMISSIONS}


def _load_course(session: Session, course_id: UUID) -> Course:
    course = session.get(Course, course_id)
    if course is None:
        raise ApiError(404, "COURSE_NOT_FOUND", "班级不存在。")
    return course


def effective_permissions(
    session: Session, user: User, course_id: UUID
) -> tuple[str, bool, dict[str, bool]]:
    """Return (course_role, is_owner, permissions_map) or raise 403 COURSE_STAFF_REQUIRED."""
    permissions.require_active(user)
    course = _load_course(session, course_id)
    if user.global_role == "teacher" and course.owner_id == user.id:
        return "teacher", True, _all_true()

    staff = session.scalar(
        select(CourseStaff).where(
            CourseStaff.course_id == course_id,
            CourseStaff.user_id == user.id,
            CourseStaff.left_at.is_(None),
        )
    )
    if staff is not None:
        if staff.role == "teacher" and user.global_role == "teacher":
            return "teacher", False, _all_true()
        if staff.role == "ta" and user.global_role in {"teacher", "ta"}:
            return "ta", False, _ta_map(staff.permissions)

    raise ApiError(403, "COURSE_STAFF_REQUIRED", "只有本课程教师或助教可以执行此操作。")


def has_staff_permission(session: Session, user: User, course_id: UUID, permission: str) -> bool:
    if permission not in ALL_PERMISSIONS:
        return False
    try:
        _role, _is_owner, perms = effective_permissions(session, user, course_id)
    except ApiError:
        return False
    return bool(perms.get(permission, False))


def require_staff_permission(
    session: Session, user: User, course_id: UUID, permission: str
) -> User:
    if permission not in ALL_PERMISSIONS:
        raise ApiError(403, "PERMISSION_DENIED", f"未知权限：{permission}")
    _role, _is_owner, perms = effective_permissions(session, user, course_id)
    if not perms.get(permission, False):
        raise ApiError(
            403,
            "PERMISSION_DENIED",
            f"缺少课程操作权限：{permission}",
            details={"permission": permission},
        )
    return user


def require_course_owner(session: Session, user: User, course_id: UUID) -> Course:
    permissions.require_course_teacher(session, user, course_id)
    course = _load_course(session, course_id)
    if course.owner_id != user.id:
        raise ApiError(403, "COURSE_OWNER_REQUIRED", "只有课程创建者可以管理助教及授权。")
    return course
