"""C task execution permissions derived from canonical, current relationships.

The A authentication dependency remains the identity boundary. These helpers never
read a role or actor ID from request JSON and never grant project content to admins.
"""

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import (
    Course,
    CourseStaff,
    PlanVersion,
    Project,
    ProjectGroup,
    ProjectMember,
    User,
)
from app.modules.c.school_email import has_verified_school_email


@dataclass(frozen=True)
class ExecutionPermissions:
    member: bool = False
    responsible: bool = False
    leader: bool = False
    staff: bool = False
    email_verified: bool = False

    @property
    def can_read(self) -> bool:
        return self.member or self.staff

    @property
    def can_start(self) -> bool:
        return self.member and self.responsible and self.email_verified

    @property
    def can_update_progress(self) -> bool:
        return self.member and (self.responsible or self.leader) and self.email_verified


@dataclass(frozen=True)
class ProjectAccess:
    project: Project
    course: Course | None
    member: bool
    leader: bool
    teacher: bool
    staff: bool
    latest_plan: PlanVersion | None = None


def get_project_access(
    session: Session, user: User, project_id: UUID, *, lock: bool = False
) -> ProjectAccess:
    """Load actual relationships for C execution and evidence operations.

    lock=True serializes C writers on the project and protects membership/course
    facts with row locks until the caller commits. Teachers/TA may read their own
    course; platform administrator status grants no access to project content.
    """
    if user.status != "active":
        raise ApiError(403, "ACCOUNT_INACTIVE", "The account is not active.")
    if lock:
        require_verified_email(has_verified_school_email(session, user, lock=True))

    def one(statement, *, project_lock: bool = False):
        if lock:
            statement = statement.with_for_update(read=not project_lock)
        return session.scalar(statement.execution_options(populate_existing=True))

    project = one(select(Project).where(Project.id == project_id), project_lock=True)
    if project is None:
        raise ApiError(404, "PROJECT_NOT_FOUND", "Project not found.")
    course = (
        one(select(Course).where(Course.id == project.course_id)) if project.course_id else None
    )
    if project.course_id and course is None:
        raise ApiError(409, "INVALID_PROJECT_CONTEXT", "Project course does not exist.")
    membership = one(
        select(ProjectMember).where(
            ProjectMember.project_id == project.id,
            ProjectMember.user_id == user.id,
            ProjectMember.left_at.is_(None),
        )
    )
    staff_record = (
        one(
            select(CourseStaff).where(
                CourseStaff.course_id == course.id,
                CourseStaff.user_id == user.id,
                CourseStaff.left_at.is_(None),
            )
        )
        if course
        else None
    )
    member = user.global_role == "student" and membership is not None
    teacher = (
        user.global_role == "teacher"
        and course is not None
        and (
            course.owner_id == user.id
            or (staff_record is not None and staff_record.role == "teacher")
        )
    )
    staff = teacher or (user.global_role in {"teacher", "ta"} and staff_record is not None)
    if not member and not staff:
        raise ApiError(403, "PROJECT_ACCESS_DENIED", "Project access is denied.")
    group = (
        one(select(ProjectGroup).where(ProjectGroup.id == project.group_id))
        if project.group_id
        else None
    )
    if project.group_id and (group is None or group.course_id != project.course_id):
        raise ApiError(409, "INVALID_PROJECT_CONTEXT", "Project group is inconsistent.")
    leader = member and (group.leader_id == user.id if group else membership.role == "leader")
    latest_plan = one(
        select(PlanVersion)
        .where(PlanVersion.project_id == project.id)
        .order_by(PlanVersion.version_no.desc())
        .limit(1)
    )
    return ProjectAccess(project, course, member, leader, teacher, staff, latest_plan)


def task_in_frozen_plan(plan: PlanVersion | None, task_id: UUID) -> bool:
    if plan is None or plan.status != "frozen" or not isinstance(plan.snapshot_json, dict):
        return False
    entries = plan.snapshot_json.get("tasks")
    if not isinstance(entries, list):
        return False
    # Canonical seed uses UUID strings; structured task snapshots may retain an id.
    return any(
        (entry.get("id") if isinstance(entry, dict) else entry) == str(task_id) for entry in entries
    )


def require_task_plan(plan: PlanVersion | None, task_id: UUID) -> None:
    if plan is None or plan.status != "frozen":
        raise ApiError(409, "PLAN_NOT_FROZEN", "Confirm and freeze the latest task plan first.")
    if not task_in_frozen_plan(plan, task_id):
        raise ApiError(409, "TASK_NOT_IN_PLAN", "This task is not in the confirmed plan snapshot.")


def execution_permissions(
    user: User,
    *,
    active_member: bool,
    responsible: bool,
    project_leader: bool,
    course_teacher: bool,
    active_course_staff: bool,
    email_verified: bool,
) -> ExecutionPermissions:
    if user.status != "active":
        raise ApiError(403, "ACCOUNT_INACTIVE", "The account is not active.")
    student = user.global_role == "student"
    member = student and active_member
    return ExecutionPermissions(
        member=member,
        responsible=member and responsible,
        leader=member and project_leader,
        staff=(user.global_role == "teacher" and course_teacher)
        or (user.global_role in {"teacher", "ta"} and active_course_staff),
        email_verified=email_verified,
    )


def require_read(permissions: ExecutionPermissions) -> None:
    if not permissions.can_read:
        raise ApiError(403, "PROJECT_ACCESS_DENIED", "Project access is denied.")


def require_verified_email(verified: bool) -> None:
    if not verified:
        raise ApiError(403, "EMAIL_NOT_VERIFIED", "Verify your email before making changes.")


def require_execution_write(project: Project, course: Course | None) -> None:
    if project.lifecycle != "active":
        raise ApiError(403, "PROJECT_READ_ONLY", "This project is read-only.")
    if course is not None and course.status != "active":
        raise ApiError(403, "COURSE_READ_ONLY", "The course is not active.")
    if project.setup_status != "frozen":
        raise ApiError(409, "PROJECT_NOT_READY", "The project baseline is not frozen.")
