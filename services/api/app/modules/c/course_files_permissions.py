"""Course-file authority uses real enrollment/staff ownership, never project proxies."""

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import Course, CourseMember, CourseStaff, User
from app.modules.c.permissions import require_verified_email


@dataclass(frozen=True)
class CourseFileAccess:
    course: Course
    owner: bool
    staff: bool
    student: bool
    can_write: bool

    @property
    def can_read_drafts(self) -> bool:
        return self.owner or self.staff


def course_access(session: Session, user: User, course_id: UUID, *, write: bool = False):
    if user.status != "active":
        raise ApiError(403, "ACCOUNT_INACTIVE", "The account is not active.")
    statement = select(Course).where(Course.id == course_id)
    if write:
        statement = statement.with_for_update()
    course = session.scalar(statement.execution_options(populate_existing=True))
    if course is None:
        raise ApiError(404, "COURSE_NOT_FOUND", "Course not found.")
    owner = user.global_role == "teacher" and course.owner_id == user.id
    staff_row = session.scalar(
        select(CourseStaff)
        .where(
            CourseStaff.course_id == course.id,
            CourseStaff.user_id == user.id,
            CourseStaff.left_at.is_(None),
        )
        .execution_options(populate_existing=True)
    )
    staff = user.global_role in {"teacher", "ta"} and staff_row is not None
    enrollment = session.scalar(
        select(CourseMember)
        .where(
            CourseMember.course_id == course.id,
            CourseMember.user_id == user.id,
            CourseMember.role == "student",
            CourseMember.status == "active",
            CourseMember.left_at.is_(None),
        )
        .execution_options(populate_existing=True)
    )
    student = user.global_role == "student" and enrollment is not None
    if not (owner or staff or student):
        raise ApiError(403, "COURSE_FILE_ACCESS_DENIED", "Course file access is denied.")
    can_write = owner and user.email_verified_at is not None and course.status != "ended"
    if write:
        if not owner:
            raise ApiError(
                403, "COURSE_FILE_WRITE_DENIED", "Only the course owner may change files."
            )
        require_verified_email(user)
        if course.status == "ended":
            raise ApiError(403, "COURSE_READ_ONLY", "The course has ended and is read-only.")
    return CourseFileAccess(course, owner, staff, student, can_write)
