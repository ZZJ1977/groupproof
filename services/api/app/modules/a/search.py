"""A 全局搜索服务：按当前登录用户的真实权限边界检索课程、项目、任务、证据与项目文件。

安全边界：
- 仅 status='active' 的账号可调用；
- 平台管理员（admin）仅检索治理范围（课程与用户目录），绝不泄露项目内部内容；
- 教师/助教与学生严格按 ProjectMember / CourseStaff / CourseMember 及 visibility='course'
  区分“项目内容可读”与“仅项目公开总览可读”（仅总览可读时不返回任务、证据与文件）。
"""

from __future__ import annotations

from typing import Literal
from urllib.parse import quote_plus
from uuid import UUID

from pydantic import BaseModel
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.db.models import (
    Course,
    CourseMember,
    CourseStaff,
    Project,
    ProjectMember,
    Task,
    User,
)
from app.modules.a import permissions
from app.modules.c.files_models import LogicalFile
from app.modules.c.models import Evidence

SearchItemKind = Literal["course", "project", "task", "evidence", "file", "user"]


class SearchResultItemDTO(BaseModel):
    id: UUID
    kind: SearchItemKind
    title: str
    subtitle: str | None = None
    href: str


class GlobalSearchResponseDTO(BaseModel):
    query: str
    items: list[SearchResultItemDTO]


def _escape_like(term: str) -> str:
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped.lower()}%"


def _ilike(column, pattern: str):
    return func.lower(func.coalesce(column, "")).like(pattern, escape="\\")


def search_workspace(
    session: Session,
    user: User,
    query: str,
    *,
    limit: int = 12,
) -> GlobalSearchResponseDTO:
    permissions.require_active(user)
    cleaned = query.strip()
    if not cleaned:
        return GlobalSearchResponseDTO(query="", items=[])

    max_items = max(1, min(limit, 30))
    per_kind = max(3, min(max_items, 6))
    pattern = _escape_like(cleaned)

    if permissions.is_admin(user):
        return _search_admin(session, cleaned, pattern, max_items=max_items, per_kind=per_kind)

    staff_course_ids: set[UUID] = set()
    student_course_ids: set[UUID] = set()

    if user.global_role == "teacher":
        staff_course_ids.update(
            session.scalars(select(Course.id).where(Course.owner_id == user.id)).all()
        )
    if user.global_role in {"teacher", "ta"}:
        staff_course_ids.update(
            session.scalars(
                select(CourseStaff.course_id).where(
                    CourseStaff.user_id == user.id,
                    CourseStaff.left_at.is_(None),
                )
            ).all()
        )
    if user.global_role == "student":
        student_course_ids.update(
            session.scalars(
                select(CourseMember.course_id).where(
                    CourseMember.user_id == user.id,
                    CourseMember.status == "active",
                    CourseMember.left_at.is_(None),
                )
            ).all()
        )

    accessible_course_ids = staff_course_ids | student_course_ids

    member_project_ids = set(
        session.scalars(
            select(ProjectMember.project_id).where(
                ProjectMember.user_id == user.id,
                ProjectMember.left_at.is_(None),
            )
        ).all()
    )
    staff_project_ids = (
        set(
            session.scalars(select(Project.id).where(Project.course_id.in_(staff_course_ids))).all()
        )
        if staff_course_ids
        else set()
    )
    content_project_ids = member_project_ids | staff_project_ids

    summary_only_project_ids = (
        set(
            session.scalars(
                select(Project.id).where(
                    Project.course_id.in_(student_course_ids),
                    Project.visibility == "course",
                )
            ).all()
        )
        - content_project_ids
        if student_course_ids
        else set()
    )
    readable_project_ids = content_project_ids | summary_only_project_ids

    items: list[SearchResultItemDTO] = []

    if accessible_course_ids:
        courses = session.scalars(
            select(Course)
            .where(
                Course.id.in_(accessible_course_ids),
                or_(
                    _ilike(Course.name, pattern),
                    _ilike(Course.code, pattern),
                    _ilike(Course.semester, pattern),
                ),
            )
            .order_by(Course.updated_at.desc(), Course.name.asc())
            .limit(per_kind)
        ).all()
        for course in courses:
            href = (
                f"/teacher/courses/{course.id}"
                if course.id in staff_course_ids
                else f"/courses/{course.id}/groups"
            )
            items.append(
                SearchResultItemDTO(
                    id=course.id,
                    kind="course",
                    title=course.name,
                    subtitle=f"{course.code} · {course.semester}",
                    href=href,
                )
            )

    project_names: dict[UUID, str] = {}
    if content_project_ids:
        for pid, pname in session.execute(
            select(Project.id, Project.name).where(Project.id.in_(content_project_ids))
        ).all():
            project_names[pid] = pname

    if readable_project_ids:
        projects = session.scalars(
            select(Project)
            .where(
                Project.id.in_(readable_project_ids),
                or_(
                    _ilike(Project.name, pattern),
                    _ilike(Project.description, pattern),
                    _ilike(Project.project_type, pattern),
                ),
            )
            .order_by(Project.updated_at.desc(), Project.name.asc())
            .limit(per_kind)
        ).all()
        for project in projects:
            items.append(
                SearchResultItemDTO(
                    id=project.id,
                    kind="project",
                    title=project.name,
                    subtitle=project.project_type or project.lifecycle,
                    href=f"/projects/{project.id}",
                )
            )

    if content_project_ids:
        tasks = session.scalars(
            select(Task)
            .where(
                Task.project_id.in_(content_project_ids),
                or_(_ilike(Task.title, pattern), _ilike(Task.description, pattern)),
            )
            .order_by(Task.updated_at.desc(), Task.title.asc())
            .limit(per_kind)
        ).all()
        for task in tasks:
            items.append(
                SearchResultItemDTO(
                    id=task.id,
                    kind="task",
                    title=task.title,
                    subtitle=project_names.get(task.project_id),
                    href=f"/projects/{task.project_id}/tasks/{task.id}",
                )
            )

        evidences = session.scalars(
            select(Evidence)
            .where(
                Evidence.project_id.in_(content_project_ids),
                Evidence.status != "void",
                _ilike(Evidence.title, pattern),
            )
            .order_by(Evidence.created_at.desc(), Evidence.title.asc())
            .limit(per_kind)
        ).all()
        for ev in evidences:
            items.append(
                SearchResultItemDTO(
                    id=ev.id,
                    kind="evidence",
                    title=ev.title,
                    subtitle=project_names.get(ev.project_id),
                    href=f"/projects/{ev.project_id}/evidence?q={quote_plus(ev.title)}",
                )
            )

        files = session.scalars(
            select(LogicalFile)
            .where(
                LogicalFile.project_id.in_(content_project_ids),
                _ilike(LogicalFile.name, pattern),
            )
            .order_by(LogicalFile.updated_at.desc(), LogicalFile.name.asc())
            .limit(per_kind)
        ).all()
        for logical_file in files:
            items.append(
                SearchResultItemDTO(
                    id=logical_file.id,
                    kind="file",
                    title=logical_file.name,
                    subtitle=project_names.get(logical_file.project_id),
                    href=f"/projects/{logical_file.project_id}/files?q={quote_plus(logical_file.name)}",
                )
            )

    return GlobalSearchResponseDTO(query=cleaned, items=items[:max_items])


def _search_admin(
    session: Session,
    cleaned: str,
    pattern: str,
    *,
    max_items: int,
    per_kind: int,
) -> GlobalSearchResponseDTO:
    items: list[SearchResultItemDTO] = []
    courses = session.scalars(
        select(Course)
        .where(
            or_(
                _ilike(Course.name, pattern),
                _ilike(Course.code, pattern),
                _ilike(Course.semester, pattern),
            )
        )
        .order_by(Course.updated_at.desc(), Course.name.asc())
        .limit(per_kind)
    ).all()
    for course in courses:
        items.append(
            SearchResultItemDTO(
                id=course.id,
                kind="course",
                title=course.name,
                subtitle=f"{course.code} · {course.semester}",
                href=f"/admin/courses?q={quote_plus(course.code)}",
            )
        )

    users = session.scalars(
        select(User)
        .where(
            or_(
                _ilike(User.name, pattern),
                _ilike(User.email, pattern),
                _ilike(User.student_id, pattern),
                _ilike(User.college, pattern),
            )
        )
        .order_by(User.updated_at.desc())
        .limit(per_kind)
    ).all()
    for person in users:
        label = person.name or person.email or person.student_id or str(person.id)
        items.append(
            SearchResultItemDTO(
                id=person.id,
                kind="user",
                title=label,
                subtitle=person.college or person.global_role,
                href=f"/admin/users?user={person.id}&q={quote_plus(label)}",
            )
        )

    return GlobalSearchResponseDTO(query=cleaned, items=items[:max_items])
