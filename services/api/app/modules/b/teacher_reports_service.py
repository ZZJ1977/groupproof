"""Read-only aggregation and export service for teacher data reports center."""

from __future__ import annotations

import csv
import io
import json
from statistics import median
from urllib.parse import quote
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models.core import (
    Course,
    CourseMember,
    GroupMember,
    ProgressEvent,
    Project,
    ProjectGroup,
    Task,
    TaskAssignee,
    User,
)
from app.modules.a.audit import record_audit
from app.modules.a.models import FeishuMessage, GithubActivity
from app.modules.b.milestones_service import milestone_briefs
from app.modules.b.teacher_permissions import effective_permissions, require_staff_permission
from app.modules.b.teacher_reports_schemas import (
    ContributionMemberDTO,
    ExportFormat,
    GroupMilestoneMatrixRowDTO,
    GroupProgressReportDTO,
    GroupRiskAlertDTO,
    MilestoneCellDTO,
    ProgressTone,
    ProjectContributionDTO,
    ReportExportDTO,
    ReportsActivityDTO,
    ReportsContributionDTO,
    ReportsMilestonesDTO,
    ReportsOverviewDTO,
    ReportsProgressDTO,
    ReportsRisksDTO,
    RiskEntryDTO,
    StudentActivityRankDTO,
)
from app.modules.d.models import ContributionItem, ContributionSnapshot, Risk


def _load_course(session: Session, course_id: UUID) -> Course:
    course = session.get(Course, course_id)
    if course is None:
        raise ApiError(404, "COURSE_NOT_FOUND", "班级不存在。")
    return course


def _course_groups_and_projects(
    session: Session, course_id: UUID
) -> tuple[list[ProjectGroup], dict[UUID, Project]]:
    groups = list(
        session.scalars(
            select(ProjectGroup)
            .where(ProjectGroup.course_id == course_id)
            .order_by(ProjectGroup.created_at.asc(), ProjectGroup.name.asc())
        ).all()
    )
    projects = list(
        session.scalars(
            select(Project)
            .where(Project.course_id == course_id, Project.archived_at.is_(None))
            .order_by(Project.created_at.asc())
        ).all()
    )
    proj_by_group: dict[UUID, Project] = {}
    for p in projects:
        if p.group_id is not None and p.group_id not in proj_by_group:
            proj_by_group[p.group_id] = p
    return groups, proj_by_group


def _project_task_counts(session: Session, project_ids: list[UUID]) -> dict[UUID, tuple[int, int]]:
    if not project_ids:
        return {}
    rows = session.execute(
        select(Task.project_id, Task.status, func.count(Task.id))
        .where(Task.project_id.in_(project_ids))
        .group_by(Task.project_id, Task.status)
    ).all()
    totals: dict[UUID, int] = {}
    completed: dict[UUID, int] = {}
    for pid, st, cnt in rows:
        totals[pid] = totals.get(pid, 0) + int(cnt)
        if st == "completed":
            completed[pid] = completed.get(pid, 0) + int(cnt)
    return {pid: (completed.get(pid, 0), totals.get(pid, 0)) for pid in project_ids}


def _progress_tone(
    *, has_project: bool, progress_percent: int | None, overdue_milestones: int
) -> ProgressTone:
    if not has_project:
        return "gray"
    if overdue_milestones > 0 or (progress_percent is not None and progress_percent < 40):
        return "red"
    if progress_percent is not None and progress_percent < 75:
        return "yellow"
    return "green"


def _compute_group_progress(
    session: Session, course_id: UUID
) -> tuple[list[GroupProgressReportDTO], dict[UUID, list]]:
    groups, proj_by_group = _course_groups_and_projects(session, course_id)
    project_ids = [p.id for p in proj_by_group.values()]
    task_counts = _project_task_counts(session, project_ids)
    briefs_by_proj = {pid: milestone_briefs(session, pid) for pid in project_ids}

    items: list[GroupProgressReportDTO] = []
    for g in groups:
        proj = proj_by_group.get(g.id)
        if proj is None:
            items.append(
                GroupProgressReportDTO(
                    group_id=g.id,
                    group_name=g.name,
                    has_project=False,
                    progress_percent=None,
                    completed_tasks=0,
                    total_tasks=0,
                    overdue_milestones=0,
                    milestones_completed=0,
                    milestones_total=0,
                    tone="gray",
                )
            )
            continue

        briefs = briefs_by_proj.get(proj.id, [])
        done_t, total_t = task_counts.get(proj.id, (0, 0))
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

        items.append(
            GroupProgressReportDTO(
                group_id=g.id,
                group_name=g.name,
                has_project=True,
                project_id=proj.id,
                project_name=proj.name,
                progress_percent=pct,
                completed_tasks=done_t,
                total_tasks=total_t,
                overdue_milestones=overdue,
                milestones_completed=m_done,
                milestones_total=m_total,
                tone=_progress_tone(
                    has_project=True, progress_percent=pct, overdue_milestones=overdue
                ),
            )
        )
    return items, briefs_by_proj


def _compute_risks(session: Session, course_id: UUID) -> list[GroupRiskAlertDTO]:
    groups, proj_by_group = _course_groups_and_projects(session, course_id)
    progress_items, _ = _compute_group_progress(session, course_id)
    progress_by_group = {p.group_id: p for p in progress_items}
    project_ids = [p.id for p in proj_by_group.values()]

    risks_by_proj: dict[UUID, list[Risk]] = {}
    if project_ids:
        risk_rows = session.scalars(
            select(Risk)
            .where(Risk.project_id.in_(project_ids), Risk.status != "closed")
            .order_by(Risk.created_at.desc())
        ).all()
        for r in risk_rows:
            risks_by_proj.setdefault(r.project_id, []).append(r)

    alerts: list[GroupRiskAlertDTO] = []
    for g in groups:
        proj = proj_by_group.get(g.id)
        prog = progress_by_group[g.id]
        if proj is None:
            continue
        open_risks = risks_by_proj.get(proj.id, [])
        has_high_d = any(r.level == "high" for r in open_risks)
        has_med_d = any(r.level == "medium" for r in open_risks)

        reasons: list[str] = []
        if prog.overdue_milestones > 0:
            reasons.append(f"存在 {prog.overdue_milestones} 个逾期里程碑")
        if has_high_d:
            reasons.append("存在未关闭的高风险条目")
        elif has_med_d:
            reasons.append("存在未关闭的中风险条目")
        if (
            prog.progress_percent is not None
            and prog.progress_percent < 40
            and prog.total_tasks > 0
        ):
            reasons.append(f"整体进度偏低（{prog.progress_percent}%）")

        if (
            has_high_d
            or prog.overdue_milestones >= 2
            or (
                prog.overdue_milestones >= 1
                and prog.progress_percent is not None
                and prog.progress_percent < 50
            )
        ):
            level: str | None = "high"
        elif reasons:
            level = "medium"
        else:
            level = None

        if level is None:
            continue

        alerts.append(
            GroupRiskAlertDTO(
                group_id=g.id,
                group_name=g.name,
                project_id=proj.id,
                project_name=proj.name,
                risk_level=level,  # type: ignore[arg-type]
                overdue_milestones=prog.overdue_milestones,
                progress_percent=prog.progress_percent,
                open_risk_count=len(open_risks),
                reasons=reasons,
                risks=[
                    RiskEntryDTO(
                        id=r.id, title=r.title, level=r.level, status=r.status, due_at=r.due_at
                    )
                    for r in open_risks
                ],
            )
        )
    alerts.sort(key=lambda a: (0 if a.risk_level == "high" else 1, -a.overdue_milestones))
    return alerts


def get_overview(session: Session, user: User, course_id: UUID) -> ReportsOverviewDTO:
    _role, _is_owner, perms = effective_permissions(session, user, course_id)
    course = _load_course(session, course_id)

    students = list(
        session.scalars(
            select(CourseMember.user_id).where(
                CourseMember.course_id == course_id,
                CourseMember.role == "student",
                CourseMember.status == "active",
                CourseMember.left_at.is_(None),
            )
        ).all()
    )
    student_set = set(students)

    groups, proj_by_group = _course_groups_and_projects(session, course_id)
    grouped_uids = set(
        session.scalars(
            select(GroupMember.user_id)
            .join(ProjectGroup, ProjectGroup.id == GroupMember.group_id)
            .where(ProjectGroup.course_id == course_id, GroupMember.left_at.is_(None))
        ).all()
    )
    ungrouped = len(student_set - grouped_uids)

    progress_items, _ = _compute_group_progress(session, course_id)
    risks = _compute_risks(session, course_id)
    pct_values = [p.progress_percent for p in progress_items if p.progress_percent is not None]
    overall_progress = round(sum(pct_values) / len(pct_values)) if pct_values else None

    return ReportsOverviewDTO(
        course_id=course_id,
        course_name=course.name,
        student_count=len(student_set),
        group_count=len(groups),
        project_count=len(proj_by_group),
        ungrouped_count=ungrouped,
        overall_progress=overall_progress,
        high_risk_groups=sum(1 for r in risks if r.risk_level == "high"),
        medium_risk_groups=sum(1 for r in risks if r.risk_level == "medium"),
        overdue_milestones=sum(p.overdue_milestones for p in progress_items),
        can_export=bool(perms.get("export_reports", False)),
    )


def get_progress(session: Session, user: User, course_id: UUID) -> ReportsProgressDTO:
    effective_permissions(session, user, course_id)
    _load_course(session, course_id)
    items, _ = _compute_group_progress(session, course_id)
    return ReportsProgressDTO(course_id=course_id, items=items)


def get_milestones(session: Session, user: User, course_id: UUID) -> ReportsMilestonesDTO:
    effective_permissions(session, user, course_id)
    _load_course(session, course_id)
    groups, proj_by_group = _course_groups_and_projects(session, course_id)
    _, briefs_by_proj = _compute_group_progress(session, course_id)

    rows: list[GroupMilestoneMatrixRowDTO] = []
    for g in groups:
        proj = proj_by_group.get(g.id)
        briefs = briefs_by_proj.get(proj.id, []) if proj else []
        rows.append(
            GroupMilestoneMatrixRowDTO(
                group_id=g.id,
                group_name=g.name,
                project_id=proj.id if proj else None,
                project_name=proj.name if proj else None,
                milestones=[
                    MilestoneCellDTO(
                        milestone_id=m.id,
                        title=m.title,
                        status=m.status,
                        overdue=m.overdue,
                        progress_percent=m.progress_percent,
                        deadline=m.deadline,
                        completed_task_count=m.completed_task_count,
                        task_count=m.task_count,
                    )
                    for m in briefs
                ],
            )
        )
    return ReportsMilestonesDTO(course_id=course_id, rows=rows)


def get_risks(session: Session, user: User, course_id: UUID) -> ReportsRisksDTO:
    effective_permissions(session, user, course_id)
    _load_course(session, course_id)
    return ReportsRisksDTO(course_id=course_id, items=_compute_risks(session, course_id))


def get_activity(session: Session, user: User, course_id: UUID) -> ReportsActivityDTO:
    effective_permissions(session, user, course_id)
    _load_course(session, course_id)
    groups, proj_by_group = _course_groups_and_projects(session, course_id)
    group_names = {g.id: g.name for g in groups}
    project_ids = [p.id for p in proj_by_group.values()]

    students = list(
        session.scalars(
            select(User)
            .join(CourseMember, CourseMember.user_id == User.id)
            .where(
                CourseMember.course_id == course_id,
                CourseMember.role == "student",
                CourseMember.status == "active",
                CourseMember.left_at.is_(None),
            )
            .order_by(User.student_id.asc(), User.name.asc())
        ).all()
    )

    member_group: dict[UUID, str] = {}
    for uid, gid in session.execute(
        select(GroupMember.user_id, GroupMember.group_id)
        .join(ProjectGroup, ProjectGroup.id == GroupMember.group_id)
        .where(ProjectGroup.course_id == course_id, GroupMember.left_at.is_(None))
    ).all():
        member_group[uid] = group_names.get(gid, "")

    github_counts: dict[UUID, int] = {}
    progress_counts: dict[UUID, int] = {}
    completed_tasks: dict[UUID, int] = {}
    feishu_count = 0

    if project_ids:
        for uid, cnt in session.execute(
            select(GithubActivity.author_user_id, func.count(GithubActivity.id))
            .where(
                GithubActivity.project_id.in_(project_ids),
                GithubActivity.deleted.is_(False),
                GithubActivity.author_user_id.is_not(None),
            )
            .group_by(GithubActivity.author_user_id)
        ).all():
            if uid is not None:
                github_counts[uid] = int(cnt)

        for uid, cnt in session.execute(
            select(ProgressEvent.actor_id, func.count(ProgressEvent.id))
            .where(ProgressEvent.project_id.in_(project_ids))
            .group_by(ProgressEvent.actor_id)
        ).all():
            progress_counts[uid] = int(cnt)

        for uid, cnt in session.execute(
            select(TaskAssignee.user_id, func.count(Task.id))
            .join(Task, Task.id == TaskAssignee.task_id)
            .where(
                Task.project_id.in_(project_ids),
                Task.status == "completed",
                TaskAssignee.unassigned_at.is_(None),
            )
            .group_by(TaskAssignee.user_id)
        ).all():
            completed_tasks[uid] = int(cnt)

        feishu_count = int(
            session.scalar(
                select(func.count(FeishuMessage.id)).where(
                    FeishuMessage.project_id.in_(project_ids),
                    FeishuMessage.deleted.is_(False),
                )
            )
            or 0
        )

    scores: list[int] = []
    raw_entries: list[tuple[User, int, int, int, int]] = []
    for stu in students:
        gh = github_counts.get(stu.id, 0)
        pe = progress_counts.get(stu.id, 0)
        ct = completed_tasks.get(stu.id, 0)
        total_score = gh + pe + ct
        scores.append(total_score)
        raw_entries.append((stu, gh, pe, ct, total_score))

    med = float(median(scores)) if scores else 0.0
    items = [
        StudentActivityRankDTO(
            user_id=stu.id,
            name=stu.name or stu.email or "",
            student_number=stu.student_id,
            group_name=member_group.get(stu.id),
            github_events=gh,
            progress_events=pe,
            completed_tasks=ct,
            total_score=total_score,
            low_activity=(total_score == 0 or (med >= 4 and total_score < med / 2)),
        )
        for stu, gh, pe, ct, total_score in raw_entries
    ]
    items.sort(key=lambda i: (-i.total_score, -i.completed_tasks, i.name))

    return ReportsActivityDTO(
        course_id=course_id,
        feishu_message_count=feishu_count,
        total_github_events=sum(github_counts.values()),
        total_progress_events=sum(progress_counts.values()),
        items=items,
    )


def get_contribution(session: Session, user: User, course_id: UUID) -> ReportsContributionDTO:
    effective_permissions(session, user, course_id)
    _load_course(session, course_id)
    groups, proj_by_group = _course_groups_and_projects(session, course_id)
    group_names = {g.id: g.name for g in groups}

    result_projects: list[ProjectContributionDTO] = []
    for g in groups:
        proj = proj_by_group.get(g.id)
        if proj is None:
            continue
        snap = session.scalar(
            select(ContributionSnapshot)
            .where(ContributionSnapshot.project_id == proj.id)
            .order_by(ContributionSnapshot.version_no.desc())
        )
        if snap is None:
            result_projects.append(
                ProjectContributionDTO(
                    project_id=proj.id,
                    project_name=proj.name,
                    group_id=g.id,
                    group_name=group_names.get(g.id),
                    items=[],
                )
            )
            continue

        rows = session.execute(
            select(ContributionItem, User)
            .join(User, User.id == ContributionItem.user_id)
            .where(ContributionItem.snapshot_id == snap.id)
            .order_by(ContributionItem.share.desc())
        ).all()
        result_projects.append(
            ProjectContributionDTO(
                project_id=proj.id,
                project_name=proj.name,
                group_id=g.id,
                group_name=group_names.get(g.id),
                snapshot_id=snap.id,
                version_no=snap.version_no,
                status=snap.status,
                frozen_at=snap.frozen_at,
                items=[
                    ContributionMemberDTO(
                        user_id=u.id,
                        name=u.name or u.email or "",
                        student_number=u.student_id,
                        share=float(item.share),
                        task_credit=float(item.task_credit),
                        collaboration_credit=float(item.collaboration_credit),
                        acceptance_rate=float(item.acceptance_rate),
                        status=item.status,
                        note=item.note,
                    )
                    for item, u in rows
                ],
            )
        )
    return ReportsContributionDTO(course_id=course_id, projects=result_projects)


def _render_export(
    session: Session, user: User, course_id: UUID, fmt: ExportFormat
) -> tuple[str, str, str]:
    overview = get_overview(session, user, course_id)
    progress = get_progress(session, user, course_id)
    activity = get_activity(session, user, course_id)
    risks = get_risks(session, user, course_id)
    safe_code = (overview.course_name or "class").replace("/", "-")

    if fmt == "json":
        payload = {
            "overview": overview.model_dump(mode="json"),
            "progress": progress.model_dump(mode="json"),
            "risks": risks.model_dump(mode="json"),
            "activity": activity.model_dump(mode="json"),
        }
        return (
            f"{safe_code}-report.json",
            "application/json; charset=utf-8",
            json.dumps(payload, ensure_ascii=False, indent=2),
        )

    if fmt == "markdown":
        overall_txt = (
            f"{overview.overall_progress}%" if overview.overall_progress is not None else "—"
        )
        lines = [
            f"# {overview.course_name} - 教学数据报告",
            "",
            f"- 学生总数：{overview.student_count}（未分组 {overview.ungrouped_count}）",
            f"- 小组总数：{overview.group_count}（已立项 {overview.project_count}）",
            f"- 整体进度：{overall_txt}",
            f"- 高/中风险队伍：{overview.high_risk_groups} / {overview.medium_risk_groups}",
            "",
            "## 小组进度明细",
            "| 队伍 | 项目 | 进度 | 完成任务 | 逾期里程碑 | 状态 |",
            "|---|---|---|---|---|---|",
        ]
        for p in progress.items:
            pct = f"{p.progress_percent}%" if p.progress_percent is not None else "—"
            lines.append(
                f"| {p.group_name} | {p.project_name or '未立项'} | {pct} | "
                f"{p.completed_tasks}/{p.total_tasks} | {p.overdue_milestones} | {p.tone} |"
            )
        lines.extend(
            [
                "",
                "## 学生活跃度排行",
                "| 姓名 | 所在小组 | GitHub | 进度记录 | 已完成任务 | 活跃度分 |",
            ]
        )
        lines.append("|---|---|---|---|---|---|")
        for a in activity.items:
            lines.append(
                f"| {a.name} | {a.group_name or '未分组'} | {a.github_events} | "
                f"{a.progress_events} | {a.completed_tasks} | {a.total_score} |"
            )
        return (
            f"{safe_code}-report.md",
            "text/markdown; charset=utf-8",
            "\n".join(lines),
        )

    buf = io.StringIO()
    buf.write("\ufeff")
    writer = csv.writer(buf)
    writer.writerow(
        ["类别", "对象名称", "项目/所属组", "进度/完成度", "已完成任务/GitHub", "逾期/状态备注"]
    )
    for p in progress.items:
        writer.writerow(
            [
                "队伍进度",
                p.group_name,
                p.project_name or "未立项",
                f"{p.progress_percent}%" if p.progress_percent is not None else "—",
                f"{p.completed_tasks}/{p.total_tasks}",
                f"逾期{p.overdue_milestones} · {p.tone}",
            ]
        )
    for a in activity.items:
        writer.writerow(
            [
                "学生活跃度",
                a.name,
                a.group_name or "未分组",
                f"总分 {a.total_score}",
                f"GH {a.github_events} / 任务 {a.completed_tasks}",
                "低活跃预警" if a.low_activity else "正常",
            ]
        )
    return f"{safe_code}-report.csv", "text/csv; charset=utf-8", buf.getvalue()


def export_report(
    session: Session, user: User, course_id: UUID, fmt: ExportFormat, request=None
) -> ReportExportDTO:
    require_staff_permission(session, user, course_id, "export_reports")
    filename, mime_type, content = _render_export(session, user, course_id, fmt)
    record_audit(
        session,
        actor=user,
        action="course.report.exported",
        target=("course", course_id),
        course_id=course_id,
        after={"format": fmt, "filename": filename},
        request=request,
    )
    return ReportExportDTO(
        format=fmt,
        filename=filename,
        mime_type=mime_type,
        content=content,
        download_href=f"/api/v1/teacher/classes/{course_id}/reports/export/download?format={fmt}",
    )


def download_report_bytes(
    session: Session, user: User, course_id: UUID, fmt: ExportFormat
) -> tuple[str, str, bytes]:
    require_staff_permission(session, user, course_id, "export_reports")
    filename, mime_type, content = _render_export(session, user, course_id, fmt)
    return filename, mime_type, content.encode()


def export_content_disposition(filename: str) -> str:
    return f"attachment; filename=\"report\"; filename*=UTF-8''{quote(filename)}"
