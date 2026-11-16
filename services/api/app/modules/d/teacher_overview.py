"""Read-only teacher overview from canonical course and project records."""

from uuid import UUID

from fastapi import APIRouter, Depends, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.api.errors import ApiError
from app.api.responses import success
from app.db.models import Course, CourseStaff, ProgressEvent, Project, ProjectGroup, Task, User
from app.db.session import get_session
from app.modules.d.models import Risk
from app.modules.d.risk_read import risk_counts

router = APIRouter(prefix="/api/v1/courses", tags=["d-teacher-overview"])


@router.get("/{course_id}/teacher-overview")
def teacher_overview(
    course_id: UUID,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    course = session.get(Course, course_id)
    if course is None:
        raise ApiError(404, "COURSE_NOT_FOUND", "Course not found.")
    staff = session.scalar(
        select(CourseStaff).where(
            CourseStaff.course_id == course_id,
            CourseStaff.user_id == user.id,
            CourseStaff.left_at.is_(None),
        )
    )
    if (
        user.status != "active"
        or user.global_role not in {"teacher", "ta"}
        or (course.owner_id != user.id and staff is None)
    ):
        raise ApiError(403, "COURSE_ACCESS_DENIED", "This course is not assigned to you.")
    projects = session.scalars(select(Project).where(Project.course_id == course_id)).all()
    groups = {
        group.id: group
        for group in session.scalars(
            select(ProjectGroup).where(ProjectGroup.course_id == course_id)
        )
    }
    entries = []
    for project in projects:
        tasks = session.scalars(select(Task).where(Task.project_id == project.id)).all()
        risks = session.scalars(select(Risk).where(Risk.project_id == project.id)).all()
        recent = session.scalar(
            select(ProgressEvent.created_at)
            .where(ProgressEvent.project_id == project.id)
            .order_by(ProgressEvent.created_at.desc())
            .limit(1)
        )
        group = groups.get(project.group_id)
        entries.append(
            {
                "project_id": str(project.id),
                "project_name": project.name,
                "group_name": group.name if group else None,
                "tasks": len(tasks),
                "completed_tasks": sum(task.status == "completed" for task in tasks),
                "progress": round(sum(task.progress_percent for task in tasks) / len(tasks))
                if tasks
                else None,
                "risks": risk_counts(risks),
                "recent_activity_at": recent.isoformat() if recent else None,
            }
        )
    return success({"course_name": course.name, "projects": entries}, request)
