"""D6 teacher group list, lazy module detail, and course action queue."""

from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.api.errors import ApiError
from app.api.responses import success
from app.db.models import Course, CourseStaff, FunctionalModule, Project, ProjectGroup, Task, User
from app.db.session import get_session
from app.modules.a.access_grants import has_read_grant
from app.modules.a.models import ActionItem
from app.modules.c.models import Evidence
from app.modules.c.permissions import get_project_access
from app.modules.d.models import FormalOutcome, Risk

router = APIRouter(prefix="/api/v1/courses", tags=["d-teacher-workspace"])
project_router = APIRouter(prefix="/api/v1/projects", tags=["d-teacher-workspace"])


def course_staff(session: Session, user: User, course_id: UUID) -> tuple[Course, bool]:
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
    teacher = user.global_role == "teacher" and (
        course.owner_id == user.id or (staff is not None and staff.role == "teacher")
    )
    if user.status != "active" or not (teacher or (staff and user.global_role == "ta")):
        raise ApiError(403, "COURSE_ACCESS_DENIED", "This course is not assigned to you.")
    return course, teacher


def allowed_project_ids(session: Session, user: User, course_id: UUID, teacher: bool) -> list[UUID]:
    ids = list(session.scalars(select(Project.id).where(Project.course_id == course_id)))
    return (
        ids
        if teacher
        else [id for id in ids if has_read_grant(session, user.id, id, "project", None)]
    )


@router.get("/{course_id}/teacher-groups")
def teacher_groups(
    course_id: UUID,
    request: Request,
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=100),
    sort: str = Query(default="name", pattern="^(name|progress|risk)$"),
    search: str = "",
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    _, teacher = course_staff(session, user, course_id)
    ids = allowed_project_ids(session, user, course_id, teacher)
    if not ids:
        return success({"total": 0, "page": page, "items": []}, request)
    progress = (
        select(
            Task.project_id.label("pid"),
            func.count(Task.id).label("tasks"),
            func.sum(Task.progress_percent).label("points"),
            func.sum(case((Task.status == "completed", 1), else_=0)).label("completed"),
        )
        .where(Task.project_id.in_(ids))
        .group_by(Task.project_id)
        .subquery()
    )
    risks = (
        select(Risk.project_id.label("pid"), func.count(Risk.id).label("risk_count"))
        .where(Risk.project_id.in_(ids), Risk.status != "closed")
        .group_by(Risk.project_id)
        .subquery()
    )
    query = (
        select(
            Project,
            ProjectGroup.name,
            progress.c.tasks,
            progress.c.points,
            progress.c.completed,
            risks.c.risk_count,
        )
        .outerjoin(ProjectGroup, ProjectGroup.id == Project.group_id)
        .outerjoin(progress, progress.c.pid == Project.id)
        .outerjoin(risks, risks.c.pid == Project.id)
        .where(Project.id.in_(ids))
    )
    if search.strip():
        query = query.where(Project.name.ilike(f"%{search.strip()}%"))
    count = session.scalar(select(func.count()).select_from(query.subquery())) or 0
    order = {
        "name": Project.name.asc(),
        "progress": (func.coalesce(progress.c.points, 0) / func.nullif(progress.c.tasks, 0))
        .desc()
        .nullslast(),
        "risk": func.coalesce(risks.c.risk_count, 0).desc(),
    }[sort]
    rows = session.execute(
        query.order_by(order, Project.id).offset((page - 1) * size).limit(size)
    ).all()
    return success(
        {
            "total": count,
            "page": page,
            "items": [
                {
                    "project_id": str(project.id),
                    "group_id": str(project.group_id) if project.group_id else None,
                    "project_name": project.name,
                    "group_name": group_name,
                    "tasks": task_count or 0,
                    "completed": completed or 0,
                    "progress": round(points / task_count) if task_count else None,
                    "risks": risk_count or 0,
                }
                for project, group_name, task_count, points, completed, risk_count in rows
            ],
        },
        request,
    )


@router.get("/{course_id}/groups/{group_id}/teacher-project")
def teacher_group_project(
    course_id: UUID,
    group_id: UUID,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    _, teacher = course_staff(session, user, course_id)
    project = session.scalar(
        select(Project)
        .where(Project.course_id == course_id, Project.group_id == group_id)
        .order_by(Project.created_at.desc())
        .limit(1)
    )
    if project is None:
        raise ApiError(404, "GROUP_PROJECT_NOT_FOUND", "Group project not found.")
    if not teacher and not has_read_grant(session, user.id, project.id):
        raise ApiError(403, "GROUP_ACCESS_DENIED", "This group is outside your authorization.")
    return success({"project_id": str(project.id), "project_name": project.name}, request)


@project_router.get("/{project_id}/teacher-modules")
def teacher_modules(
    project_id: UUID,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    access = get_project_access(session, user, project_id)
    if not access.staff:
        raise ApiError(403, "TEACHER_VIEW_DENIED", "Course staff access required.")
    if user.global_role == "ta" and not has_read_grant(session, user.id, project_id):
        raise ApiError(403, "GROUP_ACCESS_DENIED", "This group is outside your authorization.")
    modules = session.scalars(
        select(FunctionalModule)
        .where(FunctionalModule.project_id == project_id)
        .order_by(FunctionalModule.sort_order)
    ).all()
    return success(
        [
            {"id": str(row.id), "name": row.name, "progress": row.progress_percent}
            for row in modules
        ],
        request,
    )


@project_router.get("/{project_id}/teacher-modules/{module_id}")
def teacher_module_detail(
    project_id: UUID,
    module_id: UUID,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    access = get_project_access(session, user, project_id)
    if not access.staff:
        raise ApiError(403, "TEACHER_VIEW_DENIED", "Course staff access required.")
    if user.global_role == "ta" and not has_read_grant(session, user.id, project_id):
        raise ApiError(403, "GROUP_ACCESS_DENIED", "This group is outside your authorization.")
    module = session.scalar(
        select(FunctionalModule).where(
            FunctionalModule.id == module_id, FunctionalModule.project_id == project_id
        )
    )
    if module is None:
        raise ApiError(404, "MODULE_NOT_FOUND", "Module not found.")
    tasks = session.scalars(
        select(Task).where(Task.module_id == module_id, Task.project_id == project_id)
    ).all()
    task_ids = [task.id for task in tasks]
    evidence = (
        session.scalars(
            select(Evidence).where(Evidence.task_id.in_(task_ids), Evidence.status == "formal")
        )
        if tasks
        else []
    )
    outcomes = (
        session.scalars(
            select(FormalOutcome).where(
                FormalOutcome.task_id.in_(task_ids), FormalOutcome.invalidated_at.is_(None)
            )
        )
        if tasks
        else []
    )
    evidence_count = {id: 0 for id in task_ids}
    outcome_count = {id: 0 for id in task_ids}
    for row in evidence:
        evidence_count[row.task_id] += 1
    for row in outcomes:
        outcome_count[row.task_id] += 1
    return success(
        {
            "module": module.name,
            "tasks": [
                {
                    "id": str(task.id),
                    "title": task.title,
                    "status": task.status,
                    "progress": task.progress_percent,
                    "formal_evidence": evidence_count[task.id],
                    "formal_acceptance": outcome_count[task.id],
                }
                for task in tasks
            ],
        },
        request,
    )


@router.get("/{course_id}/teacher-actions")
def teacher_actions(
    course_id: UUID,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    course_staff(session, user, course_id)
    rows = session.scalars(
        select(ActionItem)
        .where(ActionItem.recipient_id == user.id, ActionItem.status == "pending")
        .order_by(ActionItem.due_at.asc().nullslast(), ActionItem.created_at.asc())
    ).all()
    priorities = {"high": 0, "medium": 1, "low": 2}
    matched = [row for row in rows if row.target_json.get("course_id") == str(course_id)]
    matched.sort(
        key=lambda row: (
            row.due_at is None,
            row.due_at or row.created_at,
            priorities.get(row.priority, 9),
        )
    )
    return success(
        [
            {
                "id": str(row.id),
                "title": row.title,
                "category": row.category,
                "priority": row.priority,
                "due_at": row.due_at.isoformat() if row.due_at else None,
                "target": row.target_json,
            }
            for row in matched
        ],
        request,
    )
