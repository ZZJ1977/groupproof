"""Cross-class aggregation service for the teacher DingTalk-style dashboard (Screen 58)."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models.core import Course, CourseStaff, ProgressEvent, Project, User
from app.modules.a import permissions
from app.modules.a.models import GithubActivity
from app.modules.b.models import BCourseAnnouncement, BCourseAppeal
from app.modules.b.teacher_actions_service import _collect_actions
from app.modules.b.teacher_dashboard_schemas import (
    DashboardActionsDTO,
    DashboardActivityDTO,
    DashboardActivityFeedDTO,
    DashboardClassDTO,
    DashboardRisksDTO,
    TeacherDashboardDTO,
)
from app.modules.b.teacher_reports_service import _compute_risks, get_overview


def _require_teacher_role(user: User) -> None:
    permissions.require_active(user)
    if user.global_role not in {"teacher", "ta"}:
        raise ApiError(403, "TEACHER_ROLE_REQUIRED", "仅教师或助教可访问教师工作台。")


def _managed_courses(session: Session, user: User) -> list[Course]:
    _require_teacher_role(user)
    staff_cids = list(
        session.scalars(
            select(CourseStaff.course_id).where(
                CourseStaff.user_id == user.id, CourseStaff.left_at.is_(None)
            )
        ).all()
    )
    return list(
        session.scalars(
            select(Course)
            .where(
                Course.archived_at.is_(None),
                or_(Course.owner_id == user.id, Course.id.in_(staff_cids)),
            )
            .order_by(Course.created_at.desc())
        ).all()
    )


def _as_utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _collect_activity(
    session: Session, courses: list[Course], *, limit: int = 20
) -> list[DashboardActivityDTO]:
    if not courses:
        return []
    course_names = {c.id: c.name for c in courses}
    course_ids = list(course_names.keys())

    projects = list(
        session.scalars(
            select(Project).where(Project.course_id.in_(course_ids), Project.archived_at.is_(None))
        ).all()
    )
    proj_map = {p.id: p for p in projects}
    project_ids = list(proj_map.keys())

    events: list[DashboardActivityDTO] = []
    actor_ids: set[UUID] = set()

    anns = session.scalars(
        select(BCourseAnnouncement)
        .where(
            BCourseAnnouncement.course_id.in_(course_ids),
            BCourseAnnouncement.status == "published",
        )
        .order_by(BCourseAnnouncement.created_at.desc())
        .limit(limit)
    ).all()
    for a in anns:
        actor_ids.add(a.published_by)
        events.append(
            DashboardActivityDTO(
                id=f"ann:{a.id}",
                course_id=a.course_id,
                course_name=course_names.get(a.course_id, ""),
                kind="announcement",
                title=f"发布公告：{a.title}",
                actor_name=str(a.published_by),
                occurred_at=_as_utc(a.published_at or a.created_at),
                href=f"/teacher/courses/{a.course_id}/announcements",
            )
        )

    appeals = session.scalars(
        select(BCourseAppeal)
        .where(BCourseAppeal.course_id.in_(course_ids))
        .order_by(BCourseAppeal.created_at.desc())
        .limit(limit)
    ).all()
    for ap in appeals:
        actor_ids.add(ap.appellant_id)
        events.append(
            DashboardActivityDTO(
                id=f"appeal:{ap.id}",
                course_id=ap.course_id,
                course_name=course_names.get(ap.course_id, ""),
                kind="appeal",
                title=f"收到申诉：{ap.title}",
                actor_name=str(ap.appellant_id),
                occurred_at=_as_utc(ap.created_at),
                href=f"/teacher/courses/{ap.course_id}/appeals?appeal={ap.id}",
            )
        )

    if project_ids:
        prog_rows = session.scalars(
            select(ProgressEvent)
            .where(ProgressEvent.project_id.in_(project_ids))
            .order_by(ProgressEvent.created_at.desc())
            .limit(limit)
        ).all()
        for pe in prog_rows:
            proj = proj_map.get(pe.project_id)
            if proj is None or proj.course_id is None:
                continue
            actor_ids.add(pe.actor_id)
            events.append(
                DashboardActivityDTO(
                    id=f"prog:{pe.id}",
                    course_id=proj.course_id,
                    course_name=course_names.get(proj.course_id, ""),
                    kind="progress",
                    title=f"「{proj.name}」任务状态更新为 {pe.to_status or '进行中'}",
                    actor_name=str(pe.actor_id),
                    occurred_at=_as_utc(pe.created_at),
                    href=f"/teacher/courses/{proj.course_id}/projects",
                )
            )

        gh_rows = session.scalars(
            select(GithubActivity)
            .where(GithubActivity.project_id.in_(project_ids), GithubActivity.deleted.is_(False))
            .order_by(GithubActivity.occurred_at.desc())
            .limit(limit)
        ).all()
        for gh in gh_rows:
            proj = proj_map.get(gh.project_id)
            if proj is None or proj.course_id is None:
                continue
            if gh.author_user_id:
                actor_ids.add(gh.author_user_id)
            events.append(
                DashboardActivityDTO(
                    id=f"gh:{gh.id}",
                    course_id=proj.course_id,
                    course_name=course_names.get(proj.course_id, ""),
                    kind="github",
                    title=f"「{proj.name}」GitHub：{gh.title}",
                    actor_name=str(gh.author_user_id) if gh.author_user_id else gh.author_name,
                    occurred_at=_as_utc(gh.occurred_at),
                    href=f"/teacher/courses/{proj.course_id}/projects",
                )
            )

    names = (
        {
            u.id: (u.name or u.email or "")
            for u in session.scalars(select(User).where(User.id.in_(actor_ids))).all()
        }
        if actor_ids
        else {}
    )
    for ev in events:
        if ev.actor_name:
            try:
                uid = UUID(ev.actor_name)
                if uid in names:
                    ev.actor_name = names[uid]
            except ValueError:
                pass

    events.sort(key=lambda e: e.occurred_at, reverse=True)
    return events[:limit]


def get_dashboard(session: Session, user: User) -> TeacherDashboardDTO:
    courses = _managed_courses(session, user)
    class_cards: list[DashboardClassDTO] = []
    total_pending = 0
    total_students = 0
    total_groups = 0
    total_projects = 0
    high_risks = 0
    med_risks = 0

    for c in courses:
        ov = get_overview(session, user, c.id)
        pending = sum(1 for a in _collect_actions(session, user, c.id) if a.status == "pending")
        risk_cnt = ov.high_risk_groups + ov.medium_risk_groups
        total_pending += pending
        total_students += ov.student_count
        total_groups += ov.group_count
        total_projects += ov.project_count
        high_risks += ov.high_risk_groups
        med_risks += ov.medium_risk_groups

        class_cards.append(
            DashboardClassDTO(
                course_id=c.id,
                name=c.name,
                semester=c.semester,
                status=c.status,
                student_count=ov.student_count,
                group_count=ov.group_count,
                project_count=ov.project_count,
                overall_progress=ov.overall_progress,
                pending_actions=pending,
                risk_count=risk_cnt,
                href=f"/teacher/courses/{c.id}",
            )
        )

    return TeacherDashboardDTO(
        total_pending_actions=total_pending,
        total_classes=len(courses),
        total_students=total_students,
        total_groups=total_groups,
        total_projects=total_projects,
        high_risk_groups=high_risks,
        medium_risk_groups=med_risks,
        classes=class_cards,
        recent_activity=_collect_activity(session, courses, limit=20),
    )


def list_dashboard_actions(session: Session, user: User) -> DashboardActionsDTO:
    courses = _managed_courses(session, user)
    all_pending = []
    for c in courses:
        items = _collect_actions(session, user, c.id)
        for item in items:
            if item.status == "pending":
                all_pending.append(item)
    priority_rank = {"urgent": 0, "normal": 1, "low": 2}
    all_pending.sort(key=lambda a: (priority_rank.get(a.priority, 1), -a.created_at.timestamp()))
    return DashboardActionsDTO(total=len(all_pending), items=all_pending[:50])


def list_dashboard_risks(session: Session, user: User) -> DashboardRisksDTO:
    courses = _managed_courses(session, user)
    risks = []
    for c in courses:
        risks.extend(_compute_risks(session, c.id))
    risks.sort(key=lambda r: (0 if r.risk_level == "high" else 1, -r.overdue_milestones))
    return DashboardRisksDTO(total=len(risks), items=risks)


def list_dashboard_activity(session: Session, user: User) -> DashboardActivityFeedDTO:
    courses = _managed_courses(session, user)
    items = _collect_activity(session, courses, limit=50)
    return DashboardActivityFeedDTO(total=len(items), items=items)
