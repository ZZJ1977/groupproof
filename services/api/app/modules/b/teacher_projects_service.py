"""Service logic for teacher per-class project cards and group reminders."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models.core import (
    Course,
    GroupMember,
    ProgressEvent,
    Project,
    ProjectGroup,
    Task,
    User,
)
from app.modules.a.audit import record_audit
from app.modules.a.inbox import notify
from app.modules.a.models import GithubActivity
from app.modules.b.milestones_service import milestone_briefs
from app.modules.b.models import BTaskMeta
from app.modules.b.teacher_permissions import effective_permissions
from app.modules.b.teacher_projects_schemas import (
    ProjectOverviewCardDTO,
    ProjectRemindResultDTO,
    TeacherProjectDetailDTO,
    TeacherProjectsListDTO,
)
from app.modules.d.models import Risk


def _load_course(session: Session, course_id: UUID) -> Course:
    course = session.get(Course, course_id)
    if course is None:
        raise ApiError(404, "COURSE_NOT_FOUND", "班级不存在。")
    return course


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _group_cards(session: Session, course_id: UUID) -> list[ProjectOverviewCardDTO]:
    groups = list(
        session.scalars(
            select(ProjectGroup)
            .where(ProjectGroup.course_id == course_id)
            .order_by(ProjectGroup.created_at.asc(), ProjectGroup.name.asc())
        ).all()
    )
    if not groups:
        return []

    group_ids = [g.id for g in groups]
    member_rows = session.execute(
        select(GroupMember.group_id, User.name, GroupMember.role)
        .join(User, User.id == GroupMember.user_id)
        .where(GroupMember.group_id.in_(group_ids), GroupMember.left_at.is_(None))
    ).all()
    member_counts: dict[UUID, int] = {}
    leader_names: dict[UUID, str] = {}
    for gid, uname, mrole in member_rows:
        member_counts[gid] = member_counts.get(gid, 0) + 1
        if mrole == "leader" and uname:
            leader_names[gid] = uname

    projects = list(
        session.scalars(
            select(Project).where(
                Project.course_id == course_id,
                Project.archived_at.is_(None),
            )
        ).all()
    )
    proj_by_group = {p.group_id: p for p in projects if p.group_id is not None}
    project_ids = [p.id for p in proj_by_group.values()]

    task_totals: dict[UUID, int] = {}
    task_done: dict[UUID, int] = {}
    planned_counts: dict[UUID, int] = {}
    code_counts: dict[UUID, int] = {}
    planned_weights: dict[UUID, float] = {}
    code_weights: dict[UUID, float] = {}
    latest_task: dict[UUID, datetime] = {}
    latest_prog: dict[UUID, datetime] = {}
    latest_gh: dict[UUID, datetime] = {}
    risk_by_proj: dict[UUID, str] = {}

    if project_ids:
        for pid, st, cnt in session.execute(
            select(Task.project_id, Task.status, func.count(Task.id))
            .where(Task.project_id.in_(project_ids))
            .group_by(Task.project_id, Task.status)
        ).all():
            task_totals[pid] = task_totals.get(pid, 0) + int(cnt)
            if st == "completed":
                task_done[pid] = task_done.get(pid, 0) + int(cnt)

        for pid, origin_val, weight_val in session.execute(
            select(Task.project_id, BTaskMeta.origin, Task.weight)
            .outerjoin(BTaskMeta, BTaskMeta.task_id == Task.id)
            .where(Task.project_id.in_(project_ids))
        ).all():
            if origin_val == "ai_code":
                code_counts[pid] = code_counts.get(pid, 0) + 1
                code_weights[pid] = code_weights.get(pid, 0.0) + float(weight_val)
            else:
                planned_counts[pid] = planned_counts.get(pid, 0) + 1
                planned_weights[pid] = planned_weights.get(pid, 0.0) + float(weight_val)

        for pid, ts in session.execute(
            select(Task.project_id, func.max(Task.updated_at))
            .where(Task.project_id.in_(project_ids))
            .group_by(Task.project_id)
        ).all():
            if ts:
                latest_task[pid] = ts

        for pid, ts in session.execute(
            select(ProgressEvent.project_id, func.max(ProgressEvent.created_at))
            .where(ProgressEvent.project_id.in_(project_ids))
            .group_by(ProgressEvent.project_id)
        ).all():
            if ts:
                latest_prog[pid] = ts

        for pid, ts in session.execute(
            select(GithubActivity.project_id, func.max(GithubActivity.occurred_at))
            .where(GithubActivity.project_id.in_(project_ids), GithubActivity.deleted.is_(False))
            .group_by(GithubActivity.project_id)
        ).all():
            if ts:
                latest_gh[pid] = ts

        rank = {"high": 3, "medium": 2, "low": 1}
        for pid, lvl in session.execute(
            select(Risk.project_id, Risk.level).where(
                Risk.project_id.in_(project_ids), Risk.status != "closed"
            )
        ).all():
            cur = risk_by_proj.get(pid)
            if cur is None or rank.get(lvl, 0) > rank.get(cur, 0):
                risk_by_proj[pid] = lvl

    cards: list[ProjectOverviewCardDTO] = []
    plaza_href = f"/teacher/courses/{course_id}/groups"
    for g in groups:
        proj = proj_by_group.get(g.id)
        if proj is None:
            cards.append(
                ProjectOverviewCardDTO(
                    group_id=g.id,
                    group_name=g.name,
                    member_count=member_counts.get(g.id, 0),
                    leader_name=leader_names.get(g.id),
                    has_project=False,
                    plaza_href=plaza_href,
                )
            )
            continue

        briefs = milestone_briefs(session, proj.id)
        done_t = task_done.get(proj.id, 0)
        total_t = task_totals.get(proj.id, 0)
        overdue = sum(1 for m in briefs if m.overdue)
        m_done = sum(1 for m in briefs if m.status == "completed")
        m_total = len(briefs)
        with_tasks = [
            m.progress_percent
            for m in briefs
            if m.task_count > 0 and m.progress_percent is not None
        ]
        if with_tasks:
            pct: int | None = round(sum(with_tasks) / len(with_tasks))
        elif total_t > 0:
            pct = round((done_t / total_t) * 100)
        else:
            pct = None

        rlevel = risk_by_proj.get(proj.id)
        if rlevel is None and overdue > 0:
            rlevel = "high" if overdue >= 2 else "medium"

        timestamps = [
            _as_utc(latest_task.get(proj.id)),
            _as_utc(latest_prog.get(proj.id)),
            _as_utc(latest_gh.get(proj.id)),
            _as_utc(proj.updated_at),
        ]
        clean_ts = [t for t in timestamps if t is not None]
        last_act = max(clean_ts) if clean_ts else None

        p_count = planned_counts.get(proj.id, 0)
        c_count = code_counts.get(proj.id, 0)
        p_weight = planned_weights.get(proj.id, 0.0)
        c_weight = code_weights.get(proj.id, 0.0)
        w_total = p_weight + c_weight
        c_share = round(c_weight / w_total, 4) if w_total > 0 else 0.0

        cards.append(
            ProjectOverviewCardDTO(
                group_id=g.id,
                group_name=g.name,
                member_count=member_counts.get(g.id, 0),
                leader_name=leader_names.get(g.id),
                has_project=True,
                project_id=proj.id,
                project_name=proj.name,
                project_href=f"/projects/{proj.id}",
                plaza_href=plaza_href,
                progress_percent=pct,
                completed_tasks=done_t,
                total_tasks=total_t,
                planned_task_count=p_count,
                code_discovered_task_count=c_count,
                code_discovered_weight_share=c_share,
                high_expansion_warning=c_share > 0.20,
                milestones_completed=m_done,
                milestones_total=m_total,
                overdue_milestones=overdue,
                risk_level=rlevel,  # type: ignore[arg-type]
                last_activity_at=last_act,
            )
        )
    return cards


def list_class_projects(session: Session, user: User, course_id: UUID) -> TeacherProjectsListDTO:
    effective_permissions(session, user, course_id)
    course = _load_course(session, course_id)
    cards = _group_cards(session, course_id)
    counts = {
        "all": len(cards),
        "initialized": sum(1 for c in cards if c.has_project),
        "uninitialized": sum(1 for c in cards if not c.has_project),
        "at_risk": sum(
            1 for c in cards if c.risk_level in {"high", "medium"} or c.overdue_milestones > 0
        ),
    }
    return TeacherProjectsListDTO(
        course_id=course_id,
        can_remind=(course.status == "active"),
        counts=counts,
        items=cards,
    )


def get_group_project_detail(
    session: Session, user: User, course_id: UUID, group_id: UUID
) -> TeacherProjectDetailDTO:
    effective_permissions(session, user, course_id)
    _load_course(session, course_id)
    cards = {c.group_id: c for c in _group_cards(session, course_id)}
    card = cards.get(group_id)
    if card is None:
        raise ApiError(404, "GROUP_NOT_FOUND", "小组不存在。")

    members = [
        (name or "成员")
        for name in session.scalars(
            select(User.name)
            .join(GroupMember, GroupMember.user_id == User.id)
            .where(GroupMember.group_id == group_id, GroupMember.left_at.is_(None))
        ).all()
    ]
    milestones = milestone_briefs(session, card.project_id) if card.project_id else []
    recent_events: list[str] = []
    if card.project_id:
        for ev_status, ev_ts in session.execute(
            select(ProgressEvent.to_status, ProgressEvent.created_at)
            .where(ProgressEvent.project_id == card.project_id)
            .order_by(ProgressEvent.created_at.desc())
            .limit(10)
        ).all():
            recent_events.append(
                f"{ev_ts.strftime('%m-%d %H:%M')} · 状态更新为 {ev_status or '进行中'}"
            )

    return TeacherProjectDetailDTO(
        card=card,
        members=members,
        milestones=milestones,
        recent_events=recent_events,
    )


def remind_group_project(
    session: Session,
    user: User,
    course_id: UUID,
    group_id: UUID,
    message: str | None = None,
    request=None,
) -> ProjectRemindResultDTO:
    effective_permissions(session, user, course_id)
    course = _load_course(session, course_id)
    if course.status != "active":
        raise ApiError(409, "COURSE_NOT_ACTIVE", "课程已结课，当前为只读状态。")

    group = session.get(ProjectGroup, group_id)
    if group is None or group.course_id != course_id:
        raise ApiError(404, "GROUP_NOT_FOUND", "小组不存在。")

    proj = session.scalar(
        select(Project).where(
            Project.course_id == course_id,
            Project.group_id == group_id,
            Project.archived_at.is_(None),
        )
    )
    member_ids = list(
        session.scalars(
            select(GroupMember.user_id).where(
                GroupMember.group_id == group_id, GroupMember.left_at.is_(None)
            )
        ).all()
    )

    custom = message.strip() if message else ""
    if proj is not None:
        title = f"[项目催办] 「{proj.name}」进展提醒"
        desc = custom or f"老师提醒小组「{group.name}」尽快推进项目任务并更新里程碑进度。"
        category = "project"
        target = {"kind": "project", "id": proj.id, "project_id": proj.id}
    else:
        title = f"[立项催办] 小组「{group.name}」请尽快完成立项"
        desc = custom or f"「{course.name}」老师提醒您尽快完成小组项目初始化。"
        category = "course"
        target = {"kind": "course", "id": course_id, "course_id": course_id}

    for uid in member_ids:
        notify(
            session,
            recipient=uid,
            category=category,
            title=title[:290],
            description=desc,
            target=target,
        )

    record_audit(
        session,
        actor=user,
        action="course.group.project_reminded",
        target=("project_group", group_id),
        course_id=course_id,
        project_id=proj.id if proj else None,
        after={"notified_count": len(member_ids)},
        request=request,
    )
    return ProjectRemindResultDTO(group_id=group_id, notified_count=len(member_ids))
