# ruff: noqa: E501  (包含中文报告模板与 AI 提示词长句)
"""D4 project reports: 6-source fact bundle, OpenRouter AI authoring, and rich PDF/DOCX/MD export."""

from __future__ import annotations

import logging
import os
import re
import time
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from io import BytesIO
from secrets import token_urlsafe
from typing import Any
from urllib.parse import quote
from uuid import UUID
from xml.sax.saxutils import escape as xml_escape

import httpx
from celery.app.task import Task as CeleryTask
from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import (
    HRFlowable,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)
from sqlalchemy import inspect as sa_inspect
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.api.errors import ApiError
from app.api.responses import success
from app.db.models import (
    AcceptanceCriterion,
    BaselineVersion,
    FunctionalModule,
    Milestone,
    PlanVersion,
    Project,
    ProjectMember,
    Requirement,
    Task,
    TaskAssignee,
    TaskMilestone,
    User,
)
from app.db.session import get_session
from app.modules.a.ai.openrouter import (
    DEFAULT_MODEL,
    MODEL_ALIASES,
    OPENROUTER_BASE,
    OpenRouterProvider,
    _parse_json_object,
)
from app.modules.a.ai.usage import AIUsageContext, record_usage
from app.modules.c.models import Evidence
from app.modules.c.permissions import get_project_access
from app.modules.d.contribution import current_frozen_snapshot
from app.modules.d.models import (
    ContributionItem,
    ContributionSnapshot,
    FormalOutcome,
    Report,
    ReportArtifact,
    ReportDownload,
    ReportDownloadLink,
    ReportReview,
    ReportSnapshot,
    Risk,
    VerificationRun,
)
from app.modules.d.risk_read import risk_counts

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/projects/{project_id}/reports", tags=["d-reports"])

STALE_GENERATING_SECONDS = 120
AI_REPORT_TIMEOUT_SECONDS = 45.0
AI_REWRITE_TIMEOUT_SECONDS = 30.0
_WORKER_INSPECT_TTL_SECONDS = 15.0
_worker_inspect_cache: dict[str, tuple[float, bool]] = {}
_XML_ILLEGAL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")
_PDF_FONT_REGISTERED = False

CHAPTER_SPECS: tuple[tuple[str, str, str], ...] = (
    ("overview", "一、项目概述与目标范围", "项目概述"),
    ("workflow", "二、开发流程与团队协作机制", "开发流程"),
    ("progress", "三、项目进度与里程碑复盘", "进度与里程碑"),
    ("collaboration", "四、团队沟通协作与关键技术决策", "沟通与决策"),
    ("evidence", "五、证据链沉淀与质量验收成果", "证据与验收"),
    ("contribution", "六、成员个人贡献与分工画像", "成员贡献"),
    ("reflection", "七、风险复盘与后续改进建议", "风险与建议"),
)
CHAPTER_ORDER: list[str] = [key for key, _, _ in CHAPTER_SPECS]
CHAPTER_TITLE_MAP: dict[str, str] = {key: title for key, title, _ in CHAPTER_SPECS}
SECTION_LABELS: dict[str, str] = {
    **CHAPTER_TITLE_MAP,
    "tasks": "任务进展",
    "milestones": "里程碑执行",
    "risks": "风险记录",
    "risk_explanation": "风险分析与建议",
    "appendix": "附录：正式证据清单",
}

_TASK_STATUS_ZH: dict[str, str] = {
    "completed": "已完成",
    "pending_verification": "待人工确认",
    "pending_submission": "待提交",
    "in_progress": "进行中",
    "not_started": "未开始",
}
_MILESTONE_STATUS_ZH: dict[str, str] = {
    "completed": "已完成",
    "in_progress": "进行中",
    "not_started": "未开始",
    "at_risk": "存在风险",
}
_EVIDENCE_SOURCE_ZH: dict[str, str] = {
    "github": "GitHub 代码/PR/CI",
    "feishu": "飞书协作消息/文档",
    "file": "项目文件资料",
    "discussion": "项目讨论区结论",
    "manual": "人工提交证据",
}
_FEISHU_CATEGORY_ZH: dict[str, str] = {
    "division_confirm": "分工与方案确认",
    "task_progress": "任务推进与阶段交付",
    "doc_review": "文档与规范同步",
    "decision": "关键技术与排期决策",
    "blocker": "阻塞与待跟进事项",
}
_RISK_LEVEL_ZH: dict[str, str] = {"high": "高", "medium": "中", "low": "低"}


class RefreshInput(BaseModel):
    includes_appendix: bool = False


class EditSection(BaseModel):
    section: str
    body: str = Field(min_length=1, max_length=25000)
    expected_version: int


class RewriteSectionInput(BaseModel):
    instruction: str = Field(default="", max_length=1000)


class ExportInput(BaseModel):
    version: int = Field(ge=1)
    file_format: str = Field(pattern="^(pdf|docx)$")


class ReviewInput(BaseModel):
    action: str = Field(pattern="^(return|approve)$")
    reason: str = Field(min_length=1, max_length=2000)


class RestoreInput(BaseModel):
    version: int = Field(ge=1)


def require_editor(access) -> None:
    if not (access.leader or access.teacher):
        raise ApiError(403, "REPORT_WRITE_DENIED", "Only the leader or teacher may edit reports.")
    if access.project.lifecycle != "active":
        raise ApiError(403, "PROJECT_READ_ONLY", "This project is read-only.")


def report_for(session: Session, project_id: UUID) -> Report | None:
    return session.scalar(select(Report).where(Report.project_id == project_id).with_for_update())


def versions(session: Session, report_id: UUID) -> list[ReportSnapshot]:
    return list(
        session.scalars(
            select(ReportSnapshot)
            .where(ReportSnapshot.report_id == report_id)
            .order_by(ReportSnapshot.version_no.desc())
        )
    )


def _has_table(session: Session, table_name: str) -> bool:
    try:
        bind = session.get_bind()
        return bool(sa_inspect(bind).has_table(table_name))
    except Exception:
        return False


def _fmt_date(value: datetime | None) -> str:
    if value is None:
        return "—"
    return value.strftime("%Y-%m-%d")


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _ordered_section_entries(data: dict) -> list[tuple[str, str, str]]:
    """Return ordered (key, heading_title, body) tuples resilient to JSONB key shuffling."""
    sections = data.get("sections") if isinstance(data.get("sections"), dict) else {}
    raw_order = data.get("chapter_order")
    if isinstance(raw_order, list) and raw_order:
        keys = [str(k) for k in raw_order if str(k) in sections]
    else:
        canonical = [k for k in CHAPTER_ORDER if k in sections]
        legacy_order = ["tasks", "milestones", "risks", "risk_explanation", "appendix"]
        rest = [k for k in legacy_order if k in sections and k not in canonical]
        extras = [k for k in sections if k not in canonical and k not in rest]
        keys = canonical + rest + extras
    return [
        (key, SECTION_LABELS.get(key, key.replace("_", " ").title()), str(sections.get(key) or ""))
        for key in keys
    ]


def collect_project_facts(session: Session, project_id: UUID, project_name: str) -> dict[str, Any]:
    """Gather a grounded 6-source fact bundle from real database records."""
    project = session.get(Project, project_id)
    members_rows = session.scalars(
        select(ProjectMember).where(
            ProjectMember.project_id == project_id, ProjectMember.left_at.is_(None)
        )
    ).all()
    modules = session.scalars(
        select(FunctionalModule)
        .where(FunctionalModule.project_id == project_id)
        .order_by(FunctionalModule.sort_order, FunctionalModule.name, FunctionalModule.id)
    ).all()
    requirements = session.scalars(
        select(Requirement)
        .where(Requirement.project_id == project_id)
        .order_by(Requirement.priority, Requirement.title, Requirement.id)
    ).all()
    tasks = session.scalars(
        select(Task).where(Task.project_id == project_id).order_by(Task.id)
    ).all()
    milestones = session.scalars(
        select(Milestone)
        .where(Milestone.project_id == project_id)
        .order_by(
            Milestone.sort_order,
            Milestone.deadline.asc().nulls_last(),
            Milestone.title,
            Milestone.id,
        )
    ).all()
    risks = session.scalars(
        select(Risk).where(Risk.project_id == project_id).order_by(Risk.created_at.desc(), Risk.id)
    ).all()
    active_risks = [r for r in risks if r.status != "closed"]
    closed_risks = [r for r in risks if r.status == "closed"]

    evidence = session.scalars(
        select(Evidence)
        .where(
            Evidence.project_id == project_id,
            Evidence.status == "formal",
            Evidence.source_changed.is_(False),
        )
        .order_by(Evidence.created_at.desc(), Evidence.id)
    ).all()

    latest_baseline = session.scalar(
        select(BaselineVersion)
        .where(BaselineVersion.project_id == project_id)
        .order_by(BaselineVersion.version_no.desc())
        .limit(1)
    )
    latest_plan = session.scalar(
        select(PlanVersion)
        .where(PlanVersion.project_id == project_id)
        .order_by(PlanVersion.version_no.desc())
        .limit(1)
    )

    task_ids = [t.id for t in tasks]
    milestone_ids = [m.id for m in milestones]
    assignees_rows = (
        session.scalars(
            select(TaskAssignee).where(
                TaskAssignee.task_id.in_(task_ids), TaskAssignee.unassigned_at.is_(None)
            )
        ).all()
        if task_ids
        else []
    )
    task_milestones = (
        session.scalars(
            select(TaskMilestone).where(TaskMilestone.milestone_id.in_(milestone_ids))
        ).all()
        if milestone_ids
        else []
    )
    criteria_rows = (
        session.scalars(
            select(AcceptanceCriterion).where(AcceptanceCriterion.task_id.in_(task_ids))
        ).all()
        if task_ids
        else []
    )
    verification_runs = session.scalars(
        select(VerificationRun).where(VerificationRun.project_id == project_id)
    ).all()
    formal_outcomes = session.scalars(
        select(FormalOutcome).where(
            FormalOutcome.project_id == project_id, FormalOutcome.invalidated_at.is_(None)
        )
    ).all()

    # Contribution snapshots (frozen for official archive, latest draft for portrait reference)
    frozen_contribution = current_frozen_snapshot(session, project_id)
    latest_contribution = frozen_contribution or session.scalar(
        select(ContributionSnapshot)
        .where(ContributionSnapshot.project_id == project_id)
        .order_by(ContributionSnapshot.version_no.desc())
        .limit(1)
    )
    contrib_items = (
        session.scalars(
            select(ContributionItem)
            .where(ContributionItem.snapshot_id == latest_contribution.id)
            .order_by(ContributionItem.share.desc(), ContributionItem.user_id)
        ).all()
        if latest_contribution is not None
        else []
    )
    frozen_items = contrib_items if frozen_contribution is not None else []

    # Resolve all referenced user records once
    user_ids: set[UUID] = {m.user_id for m in members_rows}
    user_ids |= {a.user_id for a in assignees_rows}
    user_ids |= {mod.owner_id for mod in modules if mod.owner_id}
    user_ids |= {item.user_id for item in contrib_items}
    user_ids |= {r.owner_id for r in risks if r.owner_id}
    users_by_id = (
        {u.id: u for u in session.scalars(select(User).where(User.id.in_(user_ids))).all()}
        if user_ids
        else {}
    )

    def _uname(uid: UUID | None) -> str:
        if uid is None:
            return "未指派"
        user = users_by_id.get(uid)
        if user is None:
            return str(uid)
        return (user.name or user.email or user.username or str(uid)).strip()

    # Optional cross-module: B milestone deliverables
    deliverables_by_milestone: dict[UUID, list[dict[str, Any]]] = {}
    if milestone_ids and _has_table(session, "b_milestone_deliverables"):
        from app.modules.b.models import BMilestoneDeliverable

        for item in session.scalars(
            select(BMilestoneDeliverable)
            .where(BMilestoneDeliverable.milestone_id.in_(milestone_ids))
            .order_by(BMilestoneDeliverable.sort_order, BMilestoneDeliverable.id)
        ).all():
            deliverables_by_milestone.setdefault(item.milestone_id, []).append(
                {"title": item.title, "done": bool(item.done)}
            )

    # Optional cross-module: A GitHub repos & activities
    github_repos: list[dict[str, Any]] = []
    github_stats: dict[str, Any] = {
        "repo_count": 0,
        "commits": 0,
        "pull_requests": 0,
        "merged_prs": 0,
        "ci_runs": 0,
        "ci_success": 0,
        "additions": 0,
        "deletions": 0,
        "by_member": {},
        "recent_highlights": [],
    }
    github_login_by_user: dict[UUID, str] = {}
    if _has_table(session, "a_github_user_links") and user_ids:
        from app.modules.a.models import GithubUserLink

        for link in session.scalars(
            select(GithubUserLink).where(GithubUserLink.user_id.in_(user_ids))
        ).all():
            github_login_by_user[link.user_id] = link.login.lower()
    for uid, u in users_by_id.items():
        if uid not in github_login_by_user and u.github_username:
            github_login_by_user[uid] = u.github_username.strip().lower()

    login_to_uid = {login: uid for uid, login in github_login_by_user.items()}
    email_to_uid = {
        (u.email or "").strip().lower(): uid for uid, u in users_by_id.items() if u.email
    }
    name_to_uid = {(u.name or "").strip().lower(): uid for uid, u in users_by_id.items() if u.name}

    if _has_table(session, "a_github_repo_links"):
        from app.modules.a.models import GithubRepoLink

        for repo in session.scalars(
            select(GithubRepoLink).where(GithubRepoLink.project_id == project_id)
        ).all():
            github_repos.append(
                {
                    "full_name": f"{repo.owner}/{repo.repo}",
                    "default_branch": repo.default_branch,
                    "last_synced_at": _fmt_date(repo.last_synced_at),
                }
            )
        github_stats["repo_count"] = len(github_repos)

    if _has_table(session, "a_github_activities"):
        from app.modules.a.models import GithubActivity

        gh_rows = session.scalars(
            select(GithubActivity)
            .where(GithubActivity.project_id == project_id, GithubActivity.deleted.is_(False))
            .order_by(GithubActivity.occurred_at.desc(), GithubActivity.id)
        ).all()
        by_member: dict[str, dict[str, int]] = {}
        for act in gh_rows:
            uid = act.author_user_id
            if uid is None and act.author_login:
                uid = login_to_uid.get(act.author_login.strip().lower())
            if uid is None and act.author_email:
                uid = email_to_uid.get(act.author_email.strip().lower())
            if uid is None and act.author_name:
                uid = name_to_uid.get(act.author_name.strip().lower())
            member_key = _uname(uid) if uid in users_by_id else None
            detail = act.detail if isinstance(act.detail, dict) else {}
            stats = detail.get("stats") if isinstance(detail.get("stats"), dict) else {}
            adds = _safe_int(detail.get("additions", stats.get("additions", 0)))
            dels = _safe_int(detail.get("deletions", stats.get("deletions", 0)))
            if act.kind == "commit":
                github_stats["commits"] += 1
                github_stats["additions"] += adds
                github_stats["deletions"] += dels
                if member_key:
                    mstat = by_member.setdefault(
                        member_key, {"commits": 0, "prs": 0, "additions": 0, "deletions": 0}
                    )
                    mstat["commits"] += 1
                    mstat["additions"] += adds
                    mstat["deletions"] += dels
            elif act.kind == "pull_request":
                github_stats["pull_requests"] += 1
                if (act.state or "").lower() == "merged":
                    github_stats["merged_prs"] += 1
                if member_key:
                    mstat = by_member.setdefault(
                        member_key, {"commits": 0, "prs": 0, "additions": 0, "deletions": 0}
                    )
                    mstat["prs"] += 1
            elif act.kind == "ci_run":
                github_stats["ci_runs"] += 1
                if (act.state or "").lower() in {"success", "completed", "passed"}:
                    github_stats["ci_success"] += 1

            if (
                act.kind in {"commit", "pull_request"}
                and len(github_stats["recent_highlights"]) < 10
            ):
                github_stats["recent_highlights"].append(
                    {
                        "kind": act.kind,
                        "date": _fmt_date(act.occurred_at),
                        "author": member_key or act.author_name or act.author_login or "成员",
                        "title": act.title[:120],
                        "additions": adds,
                        "deletions": dels,
                    }
                )
        github_stats["by_member"] = by_member

    # Optional cross-module: A Feishu messages & AI collaboration conclusions
    feishu_stats: dict[str, Any] = {
        "chat_count": 0,
        "total_messages": 0,
        "date_range": "",
        "total_conclusions": 0,
        "overview": "",
        "categories": {},
        "highlights": [],
    }
    if _has_table(session, "a_feishu_chat_links"):
        from app.modules.a.models import FeishuChatLink

        chats = session.scalars(
            select(FeishuChatLink).where(FeishuChatLink.project_id == project_id)
        ).all()
        feishu_stats["chat_count"] = len(chats)

    if _has_table(session, "a_feishu_messages"):
        from app.modules.a.models import FeishuMessage

        msg_dates = session.scalars(
            select(FeishuMessage.occurred_at)
            .where(FeishuMessage.project_id == project_id, FeishuMessage.deleted.is_(False))
            .order_by(FeishuMessage.occurred_at.asc())
        ).all()
        feishu_stats["total_messages"] = len(msg_dates)
        if msg_dates:
            feishu_stats["date_range"] = f"{_fmt_date(msg_dates[0])} 至 {_fmt_date(msg_dates[-1])}"

    if _has_table(session, "a_activity_summaries"):
        from app.modules.a.models import ActivitySummary

        collab_summary = session.scalar(
            select(ActivitySummary)
            .where(
                ActivitySummary.project_id == project_id,
                ActivitySummary.source_type == "feishu_collab",
                ActivitySummary.status == "ready",
            )
            .order_by(ActivitySummary.updated_at.desc())
            .limit(1)
        )
        if collab_summary and isinstance(collab_summary.result_json, dict):
            res = collab_summary.result_json
            items = res.get("items") if isinstance(res.get("items"), list) else []
            feishu_stats["overview"] = str(res.get("overview") or "")[:400]
            feishu_stats["total_conclusions"] = len(items)
            cat_counts: dict[str, int] = {}
            for item in items:
                if not isinstance(item, dict):
                    continue
                cat = str(item.get("category") or "decision")
                cat_counts[cat] = cat_counts.get(cat, 0) + 1
            feishu_stats["categories"] = cat_counts
            # Pick diverse top highlights across categories (up to 12)
            for item in items[:12]:
                if not isinstance(item, dict):
                    continue
                feishu_stats["highlights"].append(
                    {
                        "title": str(item.get("title") or "")[:100],
                        "category": str(item.get("category") or "decision"),
                        "status": str(item.get("status") or "completed"),
                        "summary": str(item.get("summary") or "")[:180],
                        "confirmed_count": _safe_int(item.get("confirmed_count", 0)),
                        "task_codes": list(item.get("task_codes") or [])[:5],
                    }
                )

    # Assemble tasks by module & milestones with REAL progress + deliverables
    tasks_by_id = {t.id: t for t in tasks}
    module_by_id = {mod.id: mod for mod in modules}
    assignees_by_task: dict[UUID, list[UUID]] = {}
    tasks_by_user: dict[UUID, list[Task]] = {}
    for row in assignees_rows:
        assignees_by_task.setdefault(row.task_id, []).append(row.user_id)
        if row.task_id in tasks_by_id:
            tasks_by_user.setdefault(row.user_id, []).append(tasks_by_id[row.task_id])

    module_facts: list[dict[str, Any]] = []
    for mod in modules:
        mod_tasks = [t for t in tasks if t.module_id == mod.id]
        mod_reqs = [r for r in requirements if r.module_id == mod.id]
        done_cnt = sum(1 for t in mod_tasks if t.status == "completed")
        weight_sum = round(sum(float(t.weight) for t in mod_tasks), 1)
        module_facts.append(
            {
                "name": mod.name,
                "owner": _uname(mod.owner_id),
                "core": bool(mod.core),
                "requirements_count": len(mod_reqs),
                "tasks_total": len(mod_tasks),
                "tasks_completed": done_cnt,
                "weight_sum": weight_sum,
                "sample_tasks": [t.title for t in mod_tasks[:5]],
            }
        )

    tasks_by_milestone: dict[UUID, list[Task]] = {}
    for link in task_milestones:
        if link.task_id in tasks_by_id:
            tasks_by_milestone.setdefault(link.milestone_id, []).append(tasks_by_id[link.task_id])

    milestone_facts: list[dict[str, Any]] = []
    for ms in milestones:
        linked_tasks = tasks_by_milestone.get(ms.id, [])
        delivs = deliverables_by_milestone.get(ms.id, [])
        delivs_done = sum(1 for d in delivs if d["done"])
        delivs_total = len(delivs)
        if ms.status == "completed":
            progress = 100
        elif linked_tasks:
            total_w = sum(float(t.weight) for t in linked_tasks) or len(linked_tasks)
            weighted = sum(
                (100 if t.status == "completed" else int(t.progress_percent)) * float(t.weight)
                for t in linked_tasks
            )
            progress = round(weighted / total_w)
        else:
            progress = int(ms.progress_percent)
        milestone_facts.append(
            {
                "title": ms.title,
                "status": ms.status,
                "status_label": _MILESTONE_STATUS_ZH.get(ms.status, ms.status),
                "deadline": _fmt_date(ms.deadline),
                "progress_percent": progress,
                "deliverables_done": delivs_done,
                "deliverables_total": delivs_total,
                "deliverable_titles": [d["title"] for d in delivs[:4]],
                "linked_tasks_total": len(linked_tasks),
                "linked_tasks_completed": sum(1 for t in linked_tasks if t.status == "completed"),
            }
        )

    # Evidence source breakdown
    ev_by_source: dict[str, int] = {}
    ev_by_task: dict[UUID, int] = {}
    for item in evidence:
        ev_by_source[item.source_type] = ev_by_source.get(item.source_type, 0) + 1
        ev_by_task[item.task_id] = ev_by_task.get(item.task_id, 0) + 1

    # Member portraits (combine ProjectMember + ContributionItem + Tasks + GitHub + Modules)
    share_by_uid = {item.user_id: item for item in contrib_items}
    owned_modules_by_uid: dict[UUID, list[str]] = {}
    for mod in modules:
        if mod.owner_id:
            owned_modules_by_uid.setdefault(mod.owner_id, []).append(mod.name)

    member_portraits: list[dict[str, Any]] = []
    for pm in sorted(
        members_rows, key=lambda m: (0 if m.role == "leader" else 1, _uname(m.user_id))
    ):
        name = _uname(pm.user_id)
        c_item = share_by_uid.get(pm.user_id)
        assigned = tasks_by_user.get(pm.user_id, [])
        gh = github_stats["by_member"].get(name, {})
        member_portraits.append(
            {
                "name": name,
                "role": "组长" if pm.role == "leader" else "成员",
                "github_login": github_login_by_user.get(pm.user_id),
                "share_percent": round(float(c_item.share), 1) if c_item else 0.0,
                "task_credit": round(float(c_item.task_credit), 1) if c_item else 0.0,
                "tasks_assigned": len(assigned),
                "tasks_completed": sum(1 for t in assigned if t.status == "completed"),
                "owned_modules": owned_modules_by_uid.get(pm.user_id, []),
                "github_commits": int(gh.get("commits", 0)),
                "github_prs": int(gh.get("prs", 0)),
                "github_additions": int(gh.get("additions", 0)),
                "github_deletions": int(gh.get("deletions", 0)),
                "key_tasks": [t.title for t in assigned[:6]],
            }
        )

    completed_tasks = sum(1 for t in tasks if t.status == "completed")
    return {
        "project": {
            "name": project_name,
            "description": (project.description or "").strip()[:400] if project else "",
            "lifecycle": project.lifecycle if project else "active",
            "setup_status": project.setup_status if project else "draft",
            "final_deadline": _fmt_date(project.final_deadline) if project else "—",
            "baseline_version": latest_baseline.version_no if latest_baseline else None,
            "baseline_status": latest_baseline.status if latest_baseline else None,
            "plan_version": latest_plan.version_no if latest_plan else None,
            "plan_status": latest_plan.status if latest_plan else None,
            "modules_count": len(modules),
            "requirements_count": len(requirements),
            "requirements_high": sum(1 for r in requirements if r.priority == "high"),
        },
        "counts": {
            "members": len(members_rows),
            "tasks": len(tasks),
            "completed_tasks": completed_tasks,
            "evidence": len(evidence),
            "risks": risk_counts(active_risks)["total"],
            "contribution_members": sum(1 for item in frozen_items if item.share > 0),
        },
        "contribution_snapshot_id": str(frozen_contribution.id) if frozen_contribution else None,
        "contribution_meta": {
            "is_frozen": frozen_contribution is not None,
            "version": latest_contribution.version_no if latest_contribution else None,
            "status": latest_contribution.status if latest_contribution else "none",
        },
        "modules": module_facts,
        "milestones": milestone_facts,
        "tasks_brief": [
            {
                "title": t.title,
                "module": module_by_id[t.module_id].name if t.module_id in module_by_id else "",
                "status": t.status,
                "status_label": _TASK_STATUS_ZH.get(t.status, t.status),
                "progress_percent": int(t.progress_percent),
                "weight": round(float(t.weight), 1),
                "assignees": [_uname(uid) for uid in assignees_by_task.get(t.id, [])],
            }
            for t in tasks
        ],
        "github": github_stats,
        "github_repos": github_repos,
        "feishu": feishu_stats,
        "evidence": {
            "total_formal": len(evidence),
            "by_source": ev_by_source,
            "tasks_with_evidence": len(ev_by_task),
            "criteria_total": len(criteria_rows),
            "verification_runs": len(verification_runs),
            "formal_outcomes": len(formal_outcomes),
            "highlights": [
                {"title": item.title[:120], "source_type": item.source_type}
                for item in evidence[:10]
            ],
        },
        "evidence_records": [
            {"id": str(item.id), "task_id": str(item.task_id), "title": item.title}
            for item in evidence
        ],
        "members": member_portraits,
        "risks": {
            "active_count": len(active_risks),
            "closed_count": len(closed_risks),
            "counts": risk_counts(active_risks),
            "active": [
                {
                    "title": r.title,
                    "level": r.level,
                    "level_label": _RISK_LEVEL_ZH.get(r.level, r.level),
                    "status": r.status,
                    "owner": _uname(r.owner_id),
                    "description": (r.description or "")[:200],
                }
                for r in active_risks[:10]
            ],
            "closed": [
                {"title": r.title, "level": r.level, "owner": _uname(r.owner_id)}
                for r in closed_risks[:6]
            ],
        },
    }


def _md_cell(value: object) -> str:
    return _sanitize_text(value).replace("\n", " ").replace("|", "\\|").strip() or "—"


def render_fallback_chapters(facts: dict[str, Any]) -> dict[str, str]:
    """Deterministically generate all 7 rich Chinese Markdown chapters from grounded facts."""
    proj = facts["project"]
    counts = facts["counts"]
    modules = facts["modules"]
    milestones = facts["milestones"]
    github = facts["github"]
    repos = facts["github_repos"]
    feishu = facts["feishu"]
    ev = facts["evidence"]
    members = facts["members"]
    risks = facts["risks"]
    cmeta = facts["contribution_meta"]

    total_tasks = counts["tasks"]
    done_tasks = counts["completed_tasks"]
    completion_rate = round(done_tasks * 100 / total_tasks, 1) if total_tasks else 0.0
    ms_done = sum(1 for m in milestones if m["status"] == "completed")
    deliv_done = sum(m["deliverables_done"] for m in milestones)
    deliv_total = sum(m["deliverables_total"] for m in milestones)

    # 1. Overview
    overview_lines = [
        f"**{proj['name']}** 共有 **{counts['members']} 名** 核心成员协作推进，"
        f"围绕 **{proj['modules_count']} 个功能模块** 与 **{proj['requirements_count']} 条需求条目**"
        f"完成工程化交付。截至快照生成时，团队已完成 **{done_tasks}/{total_tasks} 项任务**"
        f"（完成率 **{completion_rate}%**），达成 **{ms_done}/{len(milestones)} 个里程碑**，"
        f"沉淀有效正式证据 **{counts['evidence']} 条**，当前活跃风险 **{counts['risks']} 项**。",
    ]
    if proj.get("description"):
        overview_lines.extend(["", f"> 项目定位：{proj['description']}"])
    overview_lines.extend(
        [
            "",
            "### 核心交付指标总览",
            "",
            "| 维度 | 当前状态与量化结果 | 说明 |",
            "| --- | --- | --- |",
            f"| 团队规模与治理 | {counts['members']} 名成员 | 项目状态：{proj['lifecycle']}，初始化：{proj['setup_status']} |",
            f"| 需求与计划基线 | 需求基线 v{proj['baseline_version'] or '—'}（{proj['baseline_status'] or '未建'}） / 计划 v{proj['plan_version'] or '—'}（{proj['plan_status'] or '未建'}） | 覆盖 {proj['modules_count']} 个模块、{proj['requirements_count']} 条需求（高优先级 {proj['requirements_high']} 条） |",
            f"| 任务与里程碑完成 | 任务 {done_tasks}/{total_tasks}（{completion_rate}%） | 里程碑 {ms_done}/{len(milestones)} 完成，交付物勾选 {deliv_done}/{deliv_total} |",
            f"| 工程研发与协作沉淀 | GitHub 提交 {github['commits']} 次 · 飞书消息 {feishu['total_messages']} 条 | AI 提炼协作结论 {feishu['total_conclusions']} 项，正式证据 {ev['total_formal']} 条 |",
        ]
    )
    if modules:
        overview_lines.extend(
            [
                "",
                "### 功能模块与范围划分",
                "",
                "| 功能模块 | 负责人 | 需求数 | 任务完成 | 权重合计 |",
                "| --- | --- | ---: | ---: | ---: |",
            ]
        )
        for mod in modules:
            overview_lines.append(
                f"| {_md_cell(mod['name'])} | {_md_cell(mod['owner'])} | {mod['requirements_count']} "
                f"| {mod['tasks_completed']}/{mod['tasks_total']} | {mod['weight_sum']} |"
            )

    # 2. Workflow
    repo_names = "、".join(f"`{r['full_name']}`（默认分支 `{r['default_branch']}`）" for r in repos)
    workflow_lines = [
        "团队采用 **「需求基线冻结 → 任务规划与权重分配 → GitHub 代码与飞书协作留痕 → 规则+AI 验收与全员人工确认 → 贡献核算与结项归档」** 的闭环研发流程：",
        "",
        "- **代码协作与集成**："
        + (
            f"已接入 {len(repos)} 个 GitHub 仓库（{repo_names}），"
            f"累计同步 **{github['commits']} 次提交**、**{github['pull_requests']} 个 PR**"
            f"（已合并 {github['merged_prs']} 个），代码累计改动 **+{github['additions']} / -{github['deletions']} 行**。"
            if repos or github["commits"] > 0
            else "项目支持 GitHub 仓库关联与提交/PR 自动同步，结合任务单追踪研发活动。"
        ),
        "- **沟通与文档治理**："
        + (
            f"绑定 {feishu['chat_count']} 个飞书协作群，归档 **{feishu['total_messages']} 条** 有效群聊记录"
            + (f"（时间跨度 {feishu['date_range']}）" if feishu["date_range"] else "")
            + f"，并沉淀 **{feishu['total_conclusions']} 项** 结构化协作结论。"
            if feishu["total_messages"] > 0 or feishu["chat_count"] > 0
            else "通过项目讨论区与群聊沉淀需求评审、分工确认与技术决策。"
        ),
        f"- **质量与验收把关**：共定义 **{ev['criteria_total']} 条** 任务验收标准，"
        f"执行 **{ev['verification_runs']} 次** 规则+AI 验收核验，"
        f"形成 **{ev['formal_outcomes']} 项** 经人工确认生效的正式成果。",
    ]
    if github["recent_highlights"]:
        workflow_lines.extend(
            [
                "",
                "### 代表性工程提交与变更记录",
                "",
                "| 日期 | 作者 | 类型 | 变更摘要 | 代码增删 |",
                "| --- | --- | --- | --- | ---: |",
            ]
        )
        for item in github["recent_highlights"][:6]:
            kind_label = "PR" if item["kind"] == "pull_request" else "Commit"
            workflow_lines.append(
                f"| {item['date']} | {_md_cell(item['author'])} | {kind_label} "
                f"| {_md_cell(item['title'])} | +{item['additions']} / -{item['deletions']} |"
            )

    # 3. Progress & Milestones
    progress_lines = [
        f"项目按阶段拆分为 **{len(milestones)} 个里程碑** 与 **{total_tasks} 项核心任务**，"
        f"当前任务整体完成率为 **{completion_rate}%**（{done_tasks}/{total_tasks}），"
        f"阶段交付物累计完成 **{deliv_done}/{deliv_total}**。",
    ]
    if milestones:
        progress_lines.extend(
            [
                "",
                "### 里程碑阶段达成复盘",
                "",
                "| 里程碑阶段 | 截止日期 | 状态 | 进度 | 交付物 | 关联任务 |",
                "| --- | --- | --- | ---: | ---: | ---: |",
            ]
        )
        for ms in milestones:
            deliv_str = (
                f"{ms['deliverables_done']}/{ms['deliverables_total']}"
                if ms["deliverables_total"] > 0
                else "—"
            )
            task_str = (
                f"{ms['linked_tasks_completed']}/{ms['linked_tasks_total']}"
                if ms["linked_tasks_total"] > 0
                else "—"
            )
            progress_lines.append(
                f"| {_md_cell(ms['title'])} | {ms['deadline']} | {ms['status_label']} "
                f"| {ms['progress_percent']}% | {deliv_str} | {task_str} |"
            )
    if modules:
        progress_lines.extend(["", "### 分模块任务执行明细", ""])
        for mod in modules:
            sample = "；".join(mod["sample_tasks"][:4]) or "暂无任务"
            progress_lines.append(
                f"- **{mod['name']}**（负责人：{mod['owner']}，完成 {mod['tasks_completed']}/{mod['tasks_total']}，权重 {mod['weight_sum']}）：{sample}"
            )

    # 4. Collaboration & Decisions
    collab_lines: list[str] = []
    if feishu["total_conclusions"] > 0 or feishu["total_messages"] > 0:
        collab_lines.append(
            f"在项目周期内，团队通过飞书群累计开展 **{feishu['total_messages']} 条** 工程沟通"
            + (f"（{feishu['date_range']}）" if feishu["date_range"] else "")
            + f"，系统结合任务上下文提炼出 **{feishu['total_conclusions']} 项** 可溯源的团队协作结论。"
        )
        if feishu["overview"]:
            collab_lines.extend(["", f"> 协作态势总览：{feishu['overview']}"])
        if feishu["categories"]:
            collab_lines.extend(
                [
                    "",
                    "### 协作结论分类分布",
                    "",
                    "| 结论类别 | 数量 | 说明 |",
                    "| --- | ---: | --- |",
                ]
            )
            for cat, cnt in sorted(feishu["categories"].items(), key=lambda kv: -kv[1]):
                collab_lines.append(
                    f"| {_FEISHU_CATEGORY_ZH.get(cat, cat)} | {cnt} | 均绑定真实群聊上下文记录 |"
                )
        if feishu["highlights"]:
            collab_lines.extend(["", "### 关键分工确认与技术决策摘录", ""])
            for h in feishu["highlights"][:8]:
                cat_zh = _FEISHU_CATEGORY_ZH.get(h["category"], h["category"])
                codes = f"（关联任务：{'、'.join(h['task_codes'])}）" if h["task_codes"] else ""
                collab_lines.append(f"- **[{cat_zh}] {h['title']}**{codes}：{h['summary']}")
    else:
        collab_lines.append(
            "当前项目尚未同步飞书协作摘要记录；团队协作沟通依托任务评论、讨论区及需求/计划确认机制完成留痕。"
        )

    # 5. Evidence & Quality Acceptance
    ev_lines = [
        f"项目严格执行 **「候选证据采集 → 审核采纳为正式证据 → 规则完整性检查 → 人工确认生效」** 机制，"
        f"累计沉淀有效正式证据 **{ev['total_formal']} 条**（覆盖 **{ev['tasks_with_evidence']}/{total_tasks}** 项任务），"
        f"通过验收标准 **{ev['criteria_total']} 条** 的核验流程，产出 **{ev['formal_outcomes']} 项** 有效正式成果。",
    ]
    if ev["by_source"]:
        ev_lines.extend(
            [
                "",
                "### 正式证据来源分布",
                "",
                "| 证据来源类型 | 有效正式证据数 | 占比 |",
                "| --- | ---: | ---: |",
            ]
        )
        for src, cnt in sorted(ev["by_source"].items(), key=lambda kv: -kv[1]):
            pct = round(cnt * 100 / ev["total_formal"], 1) if ev["total_formal"] else 0.0
            ev_lines.append(f"| {_EVIDENCE_SOURCE_ZH.get(src, src)} | {cnt} | {pct}% |")
    if ev["highlights"]:
        ev_lines.extend(["", "### 代表性正式证据成果", ""])
        for item in ev["highlights"][:6]:
            src_zh = _EVIDENCE_SOURCE_ZH.get(item["source_type"], item["source_type"])
            ev_lines.append(f"- **[{src_zh}]** {item['title']}")

    # 6. Member Contribution Portrait
    if cmeta["is_frozen"]:
        snap_banner = f"当前引用 **已冻结正式贡献快照（v{cmeta['version']}）**，所有权重经团队确认并可用于结项评审。"
    elif cmeta["version"] is not None:
        snap_banner = (
            f"当前尚未冻结正式贡献快照，以下引用最新 **贡献草稿（v{cmeta['version']}）** 及真实任务/代码统计作为参考；"
            "建议在提交教师定稿前于「贡献数据分析」页点击「确认并冻结贡献快照」。"
        )
    else:
        snap_banner = (
            "当前尚未生成贡献计算快照，以下基于项目成员指派任务与 GitHub 提交记录汇总客观协作画像。"
        )

    contrib_lines = [
        snap_banner,
        "",
        "### 全员贡献与分工画像总表",
        "",
        "| 成员 | 角色 | 正式贡献权重 | 积分 | 完成/指派任务 | GitHub 提交 / PR | 代码增删 | 负责模块 |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ]
    for m in members:
        mods_text = "、".join(m["owned_modules"]) if m["owned_modules"] else "协作支持"
        contrib_lines.append(
            f"| {_md_cell(m['name'])} | {m['role']} | {m['share_percent']:.1f}% "
            f"| {m['task_credit']:.1f} | {m['tasks_completed']}/{m['tasks_assigned']} "
            f"| {m['github_commits']} / {m['github_prs']} "
            f"| +{m['github_additions']} / -{m['github_deletions']} | {_md_cell(mods_text)} |"
        )
    if members:
        contrib_lines.extend(["", "### 成员职责与交付亮点", ""])
        for m in members:
            task_preview = "、".join(m["key_tasks"][:3]) if m["key_tasks"] else "参与项目协同与评审"
            contrib_lines.append(
                f"- **{m['name']}（{m['role']}）**：正式权重 **{m['share_percent']:.1f}%**，"
                f"完成 **{m['tasks_completed']}/{m['tasks_assigned']}** 项任务，"
                f"贡献 **{m['github_commits']} 次** 代码提交（+{m['github_additions']}/-{m['github_deletions']} 行），"
                f"核心交付涵盖：{task_preview}。"
            )

    # 7. Reflection & Recommendations
    refl_lines: list[str] = []
    if risks["active_count"] == 0:
        refl_lines.append(
            f"截至当前快照，项目 **无活跃未关闭风险**（历史已关闭风险 {risks['closed_count']} 项），"
            f"全部 **{done_tasks}/{total_tasks} 项任务** 与 **{ms_done}/{len(milestones)} 个里程碑** 推进有序，整体交付风险可控。"
        )
    else:
        rc = risks["counts"]
        refl_lines.append(
            f"当前项目存在 **{risks['active_count']} 项活跃风险**"
            f"（高风险 {rc['high']} 项 / 中风险 {rc['medium']} 项 / 低风险 {rc['low']} 项），"
            f"另已关闭历史风险 {risks['closed_count']} 项。"
        )
        refl_lines.extend(
            [
                "",
                "### 当前活跃风险清单",
                "",
                "| 风险事项 | 等级 | 状态 | 负责人 | 说明 |",
                "| --- | --- | --- | --- | --- |",
            ]
        )
        for r in risks["active"]:
            refl_lines.append(
                f"| {_md_cell(r['title'])} | {r['level_label']} | {r['status']} "
                f"| {_md_cell(r['owner'])} | {_md_cell(r['description'])} |"
            )

    suggestions: list[str] = []
    if not cmeta["is_frozen"]:
        suggestions.append(
            "**冻结正式贡献快照**：当前贡献度仍为草稿状态，建议团队全体核对占比后在贡献页完成冻结，再刷新一次正式报告快照以绑定归档。"
        )
    if done_tasks < total_tasks:
        suggestions.append(
            f"**收尾剩余任务与验收**：尚有 {total_tasks - done_tasks} 项任务未进入已完成状态，建议优先补齐对应正式证据并完成人工确认。"
        )
    if risks["active_count"] > 0:
        suggestions.append(
            "**闭环处置高/中等级风险**：针对清单中的活跃风险逐项明确缓解措施、责任人及复检时间，避免影响课程结项答辩。"
        )
    suggestions.append(
        "**答辩演示与回归保障**：建议围绕端到端主链路（需求基线 → 任务验收 → 证据溯源 → 贡献核算 → 报告导出）做好演示脚本与自动化回归检查。"
    )
    suggestions.append(
        "**持续工程规范沉淀**：保留当前 GitHub 提交规范、飞书决策留痕与正式证据版本管理机制，作为后续迭代维护的基线标准。"
    )
    refl_lines.extend(["", "### 后续改进与答辩准备建议", ""])
    for idx, tip in enumerate(suggestions, start=1):
        refl_lines.append(f"{idx}. {tip}")

    return {
        "overview": "\n".join(overview_lines),
        "workflow": "\n".join(workflow_lines),
        "progress": "\n".join(progress_lines),
        "collaboration": "\n".join(collab_lines),
        "evidence": "\n".join(ev_lines),
        "contribution": "\n".join(contrib_lines),
        "reflection": "\n".join(refl_lines),
    }


def _openrouter_config() -> tuple[str, str] | None:
    if os.getenv("AI_PROVIDER", "").strip().lower() != "openrouter":
        return None
    api_key = os.getenv("AI_API_KEY", "").strip()
    if not api_key:
        return None
    raw_model = os.getenv("AI_MODEL", "").strip() or DEFAULT_MODEL
    model = MODEL_ALIASES.get(raw_model.lower(), raw_model)
    return api_key, model


def _call_openrouter_json(
    *,
    system_prompt: str,
    user_payload: dict[str, Any],
    timeout: float,
    feature: str,
    actor_id: UUID | None,
    project_id: UUID,
) -> tuple[dict[str, Any] | None, str | None]:
    """Call OpenRouter chat completions expecting a JSON object, recording metered usage."""
    cfg = _openrouter_config()
    if cfg is None:
        return None, None
    api_key, model = cfg
    body: dict[str, Any] = {
        "model": model,
        "temperature": 0.25,
        "response_format": {"type": "json_object"},
        "usage": {"include": True},
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": _compact_json(user_payload)},
        ],
    }
    started = time.perf_counter()
    call_meta: dict[str, Any] = {"provider": "openrouter", "model": model, "usage": None}
    ok = False
    error_code: str | None = None
    try:
        with httpx.Client(base_url=OPENROUTER_BASE, timeout=timeout) as client:
            response = client.post(
                "/api/v1/chat/completions",
                json=body,
                headers={"Authorization": f"Bearer {api_key}", "X-Title": "GroupProof"},
            )
            if response.status_code == 400 and "response_format" in response.text.lower():
                fallback_body = {k: v for k, v in body.items() if k != "response_format"}
                response = client.post(
                    "/api/v1/chat/completions",
                    json=fallback_body,
                    headers={"Authorization": f"Bearer {api_key}", "X-Title": "GroupProof"},
                )
        response.raise_for_status()
        payload_json = response.json()
        call_meta["usage"] = OpenRouterProvider._read_usage(payload_json)
        content = payload_json["choices"][0]["message"]["content"]
        parsed = _parse_json_object(content)
        ok = True
        return parsed, model
    except Exception as exc:  # noqa: BLE001
        error_code = type(exc).__name__[:40]
        logger.warning("OpenRouter %s failed for project %s: %s", feature, project_id, exc)
        return None, model
    finally:
        latency_ms = int((time.perf_counter() - started) * 1000)
        if actor_id is not None:
            record_usage(
                AIUsageContext(user_id=actor_id, project_id=project_id),
                feature=feature,
                call=call_meta,
                success=ok,
                error_code=error_code,
                latency_ms=latency_ms,
            )


def _compact_json(obj: Any) -> str:
    import json

    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _compact_facts_for_llm(facts: dict[str, Any]) -> dict[str, Any]:
    """Trim verbose arrays so the 6-source fact bundle stays concise and fast for LLM authoring."""
    return {
        "project": facts["project"],
        "counts": facts["counts"],
        "contribution_meta": facts["contribution_meta"],
        "modules": facts["modules"][:12],
        "milestones": facts["milestones"][:16],
        "tasks_summary": [
            {
                "title": t["title"][:80],
                "module": t["module"][:40],
                "status": t["status_label"],
                "progress": t["progress_percent"],
                "weight": t["weight"],
                "assignees": t["assignees"][:4],
            }
            for t in facts["tasks_brief"][:36]
        ],
        "github": {
            "repos": facts["github_repos"][:5],
            "commits": facts["github"]["commits"],
            "pull_requests": facts["github"]["pull_requests"],
            "merged_prs": facts["github"]["merged_prs"],
            "ci_runs": facts["github"]["ci_runs"],
            "ci_success": facts["github"]["ci_success"],
            "additions": facts["github"]["additions"],
            "deletions": facts["github"]["deletions"],
            "recent_highlights": facts["github"]["recent_highlights"][:8],
        },
        "feishu": {
            "chat_count": facts["feishu"]["chat_count"],
            "total_messages": facts["feishu"]["total_messages"],
            "date_range": facts["feishu"]["date_range"],
            "total_conclusions": facts["feishu"]["total_conclusions"],
            "overview": facts["feishu"]["overview"],
            "categories": facts["feishu"]["categories"],
            "highlights": facts["feishu"]["highlights"][:10],
        },
        "evidence": {
            "total_formal": facts["evidence"]["total_formal"],
            "by_source": facts["evidence"]["by_source"],
            "tasks_with_evidence": facts["evidence"]["tasks_with_evidence"],
            "criteria_total": facts["evidence"]["criteria_total"],
            "verification_runs": facts["evidence"]["verification_runs"],
            "formal_outcomes": facts["evidence"]["formal_outcomes"],
            "highlights": facts["evidence"]["highlights"][:8],
        },
        "members": facts["members"],
        "risks": facts["risks"],
    }


def _author_report_with_ai(
    facts: dict[str, Any], *, actor_id: UUID | None, project_id: UUID
) -> tuple[dict[str, str] | None, str | None]:
    """Use OpenRouter to author all 7 structured Chinese Markdown chapters from real facts."""
    system_prompt = (
        "你是高校软件工程课程项目答辩与工程管理领域的资深技术写作专家。"
        "请严格基于用户提供的 6 源真实工程事实 JSON，撰写一份「高校课程答辩正式报告结构 + 真实软件工程数据与证据引用」"
        "风格的小组结项合作报告。\n\n"
        "输出要求：\n"
        "1. 只输出一个合法 JSON 对象，必须且只能包含这 7 个字符串键："
        "overview, workflow, progress, collaboration, evidence, contribution, reflection。\n"
        "2. 每个键的值为该章节的**纯中文 Markdown 正文**（不要重复写「一、...」一级/二级大标题，可用 ### 子标题、加粗、无序/有序列表、GFM Markdown 表格 `| ... |`）。\n"
        "3. 各章核心内容要求：\n"
        "   - overview（一、项目概述与目标范围）：项目背景定位、核心指标总览表、需求与计划基线及模块边界。\n"
        "   - workflow（二、开发流程与团队协作机制）：GitHub 研发流/提交与 PR 统计、飞书协同与验收治理闭环、代表性工程变更。\n"
        "   - progress（三、项目进度与里程碑复盘）：按时间顺序呈现里程碑达成表（含截止日期/状态/进度/交付物）、分模块任务完成复盘。\n"
        "   - collaboration（四、团队沟通协作与关键技术决策）：基于飞书消息与 AI 结论分布表，提炼关键分工确认、规范同步与技术决策案例。\n"
        "   - evidence（五、证据链沉淀与质量验收成果）：正式证据来源分布表、验收标准与人工确认闭环成效、代表性证据成果。\n"
        "   - contribution（六、成员个人贡献与分工画像）：明确标注贡献快照状态（已冻结或草稿参考），给出全员多维对比表（正式权重/任务完成/GitHub提交/代码增删/负责模块）及每人客观画像。\n"
        "   - reflection（七、风险复盘与后续改进建议）：如实汇报活跃风险与已关闭风险，给出具体可执行的工程优化与答辩准备建议。\n"
        "4. 绝对事实约束：严格依据输入 JSON 的真实数字、成员姓名、模块名、里程碑、提交数与飞书结论，严禁编造不存在的数据、成员、PR 或结论；不要包含附录；保持客观冷静、专业精炼，每章约 260–520 字。"
    )
    parsed, model = _call_openrouter_json(
        system_prompt=system_prompt,
        user_payload=_compact_facts_for_llm(facts),
        timeout=AI_REPORT_TIMEOUT_SECONDS,
        feature="generate_project_report",
        actor_id=actor_id,
        project_id=project_id,
    )
    if not isinstance(parsed, dict):
        return None, model
    authored: dict[str, str] = {}
    for key in CHAPTER_ORDER:
        val = parsed.get(key)
        if isinstance(val, str) and len(val.strip()) >= 40:
            authored[key] = _sanitize_text(val.strip())
    if not authored:
        return None, model
    return authored, model


def _rewrite_section_with_ai(
    facts: dict[str, Any],
    *,
    section_key: str,
    current_body: str,
    instruction: str,
    actor_id: UUID | None,
    project_id: UUID,
) -> tuple[str | None, str | None]:
    chapter_title = SECTION_LABELS.get(section_key, section_key)
    system_prompt = (
        "你是高校软件工程课程结项报告的资深技术编辑。"
        f"请严格基于项目真实工程事实 JSON，重写报告章节「{chapter_title}」（键名 {section_key}）。\n"
        "要求：\n"
        '1. 只输出一个合法 JSON 对象：`{"content": "<Markdown 正文>"}`。\n'
        "2. 正文使用规范中文 Markdown（可用 ### 小节、加粗、列表、GFM 表格），不要重复写章级大标题。\n"
        "3. 严格依据输入事实，严禁编造数字、成员或事件；客观冷静，结构清晰，约 280–600 字。\n"
        "4. 充分响应用户的改写要求（若提供）。"
    )
    payload = {
        "target_section": section_key,
        "target_title": chapter_title,
        "user_instruction": instruction.strip()
        or "提升语言专业度与结构清晰度，保留全部真实工程数据与表格。",
        "current_content": current_body[:6000],
        "project_facts": _compact_facts_for_llm(facts),
    }
    parsed, model = _call_openrouter_json(
        system_prompt=system_prompt,
        user_payload=payload,
        timeout=AI_REWRITE_TIMEOUT_SECONDS,
        feature="rewrite_report_section",
        actor_id=actor_id,
        project_id=project_id,
    )
    if isinstance(parsed, dict):
        content = parsed.get("content") or parsed.get(section_key)
        if isinstance(content, str) and len(content.strip()) >= 30:
            return _sanitize_text(content.strip()), model
    return None, model


def _legacy_tasks_text(facts: dict[str, Any]) -> str:
    return (
        "\n".join(
            f"{item['title']}: {item['status']} ({item['progress_percent']}%)"
            for item in facts["tasks_brief"]
        )
        or "暂无任务记录。"
    )


def build_report_snapshot_data(
    session: Session,
    project_id: UUID,
    project_name: str,
    appendix: bool,
    *,
    actor_id: UUID | None = None,
    use_ai: bool = False,
) -> dict[str, Any]:
    """Build complete frozen report data_snapshot with 7 ordered chapters."""
    facts = collect_project_facts(session, project_id, project_name)
    chapters = render_fallback_chapters(facts)
    authoring_mode = "fallback"
    model_used: str | None = None

    if use_ai:
        ai_chapters, model_used = _author_report_with_ai(
            facts, actor_id=actor_id, project_id=project_id
        )
        if ai_chapters:
            chapters.update(ai_chapters)
            authoring_mode = "ai"

    chapter_order = list(CHAPTER_ORDER)
    sections: dict[str, str] = {key: chapters[key] for key in CHAPTER_ORDER}
    # Preserve legacy frozen `tasks` key for existing unit test invariants; omitted from chapter_order.
    sections["tasks"] = _legacy_tasks_text(facts)
    if appendix:
        sections["appendix"] = (
            "\n".join(item["title"] for item in facts["evidence_records"]) or "暂无正式证据。"
        )
        chapter_order.append("appendix")

    return {
        "project_name": project_name,
        "contribution_snapshot_id": facts["contribution_snapshot_id"],
        "counts": facts["counts"],
        "chapter_order": chapter_order,
        "sections": sections,
        "evidence_records": facts["evidence_records"],
        "meta": {
            "authoring_mode": authoring_mode,
            "model": model_used,
            "generated_at": datetime.now(UTC).isoformat(),
            "contribution_status": facts["contribution_meta"]["status"],
            "milestones_completed": sum(
                1 for m in facts["milestones"] if m["status"] == "completed"
            ),
            "milestones_total": len(facts["milestones"]),
            "github_commits": facts["github"]["commits"],
            "feishu_conclusions": facts["feishu"]["total_conclusions"],
        },
    }


def snapshot_data(session: Session, project_id: UUID, project_name: str, appendix: bool) -> dict:
    """Deterministic snapshot builder (used by sync callers and tests)."""
    return build_report_snapshot_data(
        session, project_id, project_name, appendix, actor_id=None, use_ai=False
    )


def serialize(version: ReportSnapshot) -> dict:
    return {
        "id": str(version.id),
        "version": version.version_no,
        "status": version.status,
        "created_by": str(version.created_by) if version.created_by else None,
        "created_at": version.created_at.isoformat() if version.created_at else None,
        "data": version.data_snapshot,
    }


@router.get("")
def list_reports(
    project_id: UUID,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    get_project_access(session, user, project_id)
    report = session.scalar(select(Report).where(Report.project_id == project_id))
    report_versions = versions(session, report.id) if report else []
    downloads = (
        session.scalars(
            select(ReportDownload)
            .where(ReportDownload.snapshot_id.in_([item.id for item in report_versions]))
            .order_by(ReportDownload.created_at.desc())
        ).all()
        if report_versions
        else []
    )
    artifacts = (
        session.scalars(
            select(ReportArtifact)
            .where(ReportArtifact.snapshot_id.in_([item.id for item in report_versions]))
            .order_by(ReportArtifact.created_at.desc())
        ).all()
        if report_versions
        else []
    )
    reviews = (
        session.scalars(
            select(ReportReview)
            .where(ReportReview.report_id == report.id)
            .order_by(ReportReview.created_at.desc())
        ).all()
        if report
        else []
    )
    version_by_id = {item.id: item.version_no for item in report_versions}
    people = (
        {item.created_by for item in report_versions if item.created_by}
        | {item.requested_by for item in artifacts}
        | {item.user_id for item in downloads}
        | {item.actor_id for item in reviews}
    )
    names = (
        {
            person.id: person.name
            for person in session.scalars(select(User).where(User.id.in_(people)))
        }
        if people
        else {}
    )
    return success(
        {
            "status": report.status if report else "draft",
            "versions": [
                {**serialize(item), "created_by_name": names.get(item.created_by)}
                for item in report_versions
            ],
            "downloads": [
                {
                    "version": next(
                        item.version_no for item in report_versions if item.id == row.snapshot_id
                    ),
                    "user_id": str(row.user_id),
                    "user_name": names.get(row.user_id),
                    "format": row.file_format,
                    "created_at": row.created_at.isoformat() if row.created_at else None,
                }
                for row in downloads
            ],
            "artifacts": [
                {
                    "id": str(row.id),
                    "version": version_by_id[row.snapshot_id],
                    "format": row.file_format,
                    "status": row.status,
                    "error": row.error,
                    "requested_by": str(row.requested_by),
                    "requested_by_name": names.get(row.requested_by),
                    "created_at": row.created_at.isoformat() if row.created_at else None,
                }
                for row in artifacts
            ],
            "reviews": [
                {
                    "action": row.action,
                    "reason": row.reason,
                    "actor_id": str(row.actor_id),
                    "actor_name": names.get(row.actor_id),
                    "created_at": row.created_at.isoformat() if row.created_at else None,
                }
                for row in reviews
            ],
        },
        request,
    )


@router.post("/refresh", status_code=202)
def refresh_report(
    project_id: UUID,
    payload: RefreshInput,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    try:
        access = get_project_access(session, user, project_id, lock=True)
        require_editor(access)
        report = report_for(session, project_id)
        if report is None:
            report = Report(project_id=project_id, created_by=user.id, status="draft")
            session.add(report)
            session.flush()
        previous = versions(session, report.id)
        if report.status == "generating":
            if _recover_stale_generating(report, previous):
                session.flush()
            else:
                raise ApiError(
                    409, "REPORT_GENERATING", "Report preview is already being generated."
                )
        if report.status in {"submitted", "finalized"}:
            raise ApiError(409, "REPORT_READ_ONLY", "Report is awaiting review or finalized.")
        baseline = session.scalar(
            select(BaselineVersion)
            .where(BaselineVersion.project_id == project_id, BaselineVersion.status == "frozen")
            .order_by(BaselineVersion.version_no.desc())
            .limit(1)
        )
        plan = session.scalar(
            select(PlanVersion)
            .where(PlanVersion.project_id == project_id, PlanVersion.status == "frozen")
            .order_by(PlanVersion.version_no.desc())
            .limit(1)
        )
        contribution = current_frozen_snapshot(session, project_id)
        version = ReportSnapshot(
            report_id=report.id,
            created_by=user.id,
            version_no=previous[0].version_no + 1 if previous else 1,
            status="generating",
            baseline_version_id=baseline.id if baseline else None,
            plan_version_id=plan.id if plan else None,
            contribution_snapshot_id=contribution.id if contribution else None,
            data_snapshot={},
        )
        session.add(version)
        session.flush()
        report.status = "generating"
        report.includes_appendix = payload.includes_appendix
        report.lock_version += 1
        session.commit()
        from app.modules.d.report_tasks import generate_preview

        if _should_run_inline(generate_preview, "app.modules.d.report_tasks.generate_preview"):
            _complete_preview_inline_safe(
                session,
                version=version,
                report=report,
                project=access.project,
                appendix=payload.includes_appendix,
                actor_id=user.id,
            )
            return success(serialize(version), request)
        try:
            generate_preview.delay(str(version.id), payload.includes_appendix)
        except Exception:
            if _allow_inline_worker_fallback():
                _complete_preview_inline_safe(
                    session,
                    version=version,
                    report=report,
                    project=access.project,
                    appendix=payload.includes_appendix,
                    actor_id=user.id,
                )
                return success(serialize(version), request)
            version.status = "failed"
            report.status = "failed"
            session.commit()
            raise ApiError(
                503, "REPORT_WORKER_UNAVAILABLE", "Report worker is unavailable."
            ) from None
        return success(serialize(version), request)
    except Exception:
        session.rollback()
        raise


@router.post("/sections", status_code=201)
def edit_section(
    project_id: UUID,
    payload: EditSection,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    try:
        access = get_project_access(session, user, project_id, lock=True)
        require_editor(access)
        report = report_for(session, project_id)
        if report is None or report.status not in {"generated", "returned"}:
            raise ApiError(409, "REPORT_NOT_EDITABLE", "Generate a draft report first.")
        latest = versions(session, report.id)[0]
        if latest.status != "generated":
            raise ApiError(409, "REPORT_NOT_READY", "Wait for report generation to finish.")
        if latest.version_no != payload.expected_version:
            raise ApiError(
                409, "REPORT_VERSION_CONFLICT", "Report changed; refresh before editing."
            )
        if payload.section not in latest.data_snapshot.get("sections", {}):
            raise ApiError(422, "REPORT_SECTION_INVALID", "Unknown report section.")
        data = {
            **latest.data_snapshot,
            "sections": {**latest.data_snapshot["sections"], payload.section: payload.body.strip()},
        }
        version = ReportSnapshot(
            report_id=report.id,
            created_by=user.id,
            version_no=latest.version_no + 1,
            status="generated",
            baseline_version_id=latest.baseline_version_id,
            plan_version_id=latest.plan_version_id,
            contribution_snapshot_id=latest.contribution_snapshot_id,
            data_snapshot=data,
        )
        session.add(version)
        report.lock_version += 1
        session.commit()
        return success(serialize(version), request)
    except Exception:
        session.rollback()
        raise


@router.post("/versions/{version_no}/sections/{section_key}/ai-rewrite", status_code=201)
def ai_rewrite_section(
    project_id: UUID,
    version_no: int,
    section_key: str,
    payload: RewriteSectionInput,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    try:
        access = get_project_access(session, user, project_id, lock=True)
        require_editor(access)
        report = report_for(session, project_id)
        if report is None or report.status not in {"generated", "returned"}:
            raise ApiError(409, "REPORT_NOT_EDITABLE", "Generate a draft report first.")
        source = session.scalar(
            select(ReportSnapshot).where(
                ReportSnapshot.report_id == report.id,
                ReportSnapshot.version_no == version_no,
                ReportSnapshot.status.in_(["generated", "finalized"]),
            )
        )
        if source is None:
            raise ApiError(404, "REPORT_VERSION_NOT_FOUND", "Report version not found.")
        sections_map = source.data_snapshot.get("sections") or {}
        if section_key not in sections_map:
            raise ApiError(422, "REPORT_SECTION_INVALID", "Unknown report section.")

        facts = collect_project_facts(session, project_id, access.project.name)
        current_body = str(sections_map.get(section_key) or "")
        rewritten, model_used = _rewrite_section_with_ai(
            facts,
            section_key=section_key,
            current_body=current_body,
            instruction=payload.instruction,
            actor_id=user.id,
            project_id=project_id,
        )
        authoring_mode = "ai"
        if rewritten is None:
            fallback_chapters = render_fallback_chapters(facts)
            if section_key in fallback_chapters:
                rewritten = fallback_chapters[section_key]
                authoring_mode = "fallback"
            else:
                raise ApiError(
                    503,
                    "AI_UNAVAILABLE",
                    "AI 重写服务暂时不可用，请稍后重试或手动编辑。",
                )

        latest = versions(session, report.id)[0]
        prev_meta = (
            dict(source.data_snapshot.get("meta"))
            if isinstance(source.data_snapshot.get("meta"), dict)
            else {}
        )
        prev_meta["last_rewritten_section"] = section_key
        prev_meta["last_rewritten_mode"] = authoring_mode
        if model_used:
            prev_meta["model"] = model_used
        data = {
            **source.data_snapshot,
            "sections": {**sections_map, section_key: rewritten},
            "meta": prev_meta,
        }
        created = ReportSnapshot(
            report_id=report.id,
            created_by=user.id,
            version_no=latest.version_no + 1,
            status="generated",
            baseline_version_id=source.baseline_version_id,
            plan_version_id=source.plan_version_id,
            contribution_snapshot_id=source.contribution_snapshot_id,
            data_snapshot=data,
        )
        session.add(created)
        report.status = "generated"
        report.lock_version += 1
        session.commit()
        return success(
            {
                **serialize(created),
                "rewritten_section": section_key,
                "authoring_mode": authoring_mode,
            },
            request,
        )
    except Exception:
        session.rollback()
        raise


@router.post("/restore", status_code=201)
def restore_report_version(
    project_id: UUID,
    payload: RestoreInput,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    try:
        access = get_project_access(session, user, project_id, lock=True)
        require_editor(access)
        report = report_for(session, project_id)
        if report is None or report.status not in {"generated", "returned", "failed"}:
            raise ApiError(409, "REPORT_NOT_EDITABLE", "Report cannot be restored now.")
        source = session.scalar(
            select(ReportSnapshot).where(
                ReportSnapshot.report_id == report.id,
                ReportSnapshot.version_no == payload.version,
                ReportSnapshot.status.in_(["generated", "finalized"]),
            )
        )
        if source is None:
            raise ApiError(404, "REPORT_VERSION_NOT_FOUND", "Report version not found.")
        latest = versions(session, report.id)[0]
        restored = ReportSnapshot(
            report_id=report.id,
            created_by=user.id,
            version_no=latest.version_no + 1,
            status="generated",
            baseline_version_id=source.baseline_version_id,
            plan_version_id=source.plan_version_id,
            contribution_snapshot_id=source.contribution_snapshot_id,
            data_snapshot=source.data_snapshot,
        )
        session.add(restored)
        report.status = "generated"
        report.lock_version += 1
        session.commit()
        return success(serialize(restored), request)
    except Exception:
        session.rollback()
        raise


@router.post("/submit")
def submit_report(
    project_id: UUID,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    try:
        access = get_project_access(session, user, project_id, lock=True)
        if not access.leader:
            raise ApiError(
                403, "REPORT_FINALIZE_DENIED", "Only the group leader may submit the report."
            )
        report = report_for(session, project_id)
        if report is None or not versions(session, report.id):
            raise ApiError(409, "REPORT_MISSING", "Generate a report before submitting it.")
        if report.status not in {"generated", "returned"}:
            raise ApiError(409, "REPORT_NOT_READY", "Generate a report before submitting it.")
        latest = versions(session, report.id)[0]
        if latest.status != "generated":
            raise ApiError(409, "REPORT_NOT_READY", "Wait for report generation to finish.")
        report.status = "submitted"
        report.lock_version += 1
        session.add(
            ReportReview(
                report_id=report.id,
                snapshot_id=latest.id,
                actor_id=user.id,
                action="submitted",
                reason="Submitted for teacher review",
            )
        )
        session.commit()
        return success(serialize(latest), request)
    except Exception:
        session.rollback()
        raise


@router.post("/review")
def review_report(
    project_id: UUID,
    payload: ReviewInput,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    try:
        access = get_project_access(session, user, project_id, lock=True)
        if not access.teacher:
            raise ApiError(403, "REPORT_REVIEW_DENIED", "Only this course's teacher may review.")
        report = report_for(session, project_id)
        if report is None or report.status != "submitted":
            raise ApiError(409, "REPORT_NOT_SUBMITTED", "Report is not awaiting review.")
        latest = versions(session, report.id)[0]
        action = "returned" if payload.action == "return" else "finalized"
        report.status = action
        report.lock_version += 1
        if action == "finalized":
            latest.status = "finalized"
            latest.finalized_at = datetime.now(UTC)
        session.add(
            ReportReview(
                report_id=report.id,
                snapshot_id=latest.id,
                actor_id=user.id,
                action=action,
                reason=payload.reason.strip(),
            )
        )
        session.commit()
        return success({"status": action, "version": latest.version_no}, request)
    except Exception:
        session.rollback()
        raise


def _allow_inline_worker_fallback() -> bool:
    return os.getenv("APP_MODE", "dev").strip().lower() != "real"


def _is_default_celery_delay(task_obj) -> bool:
    delay_fn = getattr(task_obj, "delay", None)
    return getattr(delay_fn, "__func__", None) is CeleryTask.delay


def _has_registered_report_worker(task_name: str) -> bool:
    now = time.monotonic()
    cached = _worker_inspect_cache.get(task_name)
    if cached is not None and now - cached[0] < _WORKER_INSPECT_TTL_SECONDS:
        return cached[1]
    registered_ok = False
    try:
        from app.modules.d.report_tasks import celery_app

        insp = celery_app.control.inspect(timeout=0.5)
        registered = insp.registered() or {}
        registered_ok = any(task_name in (tasks or ()) for tasks in registered.values())
    except Exception:
        registered_ok = False
    _worker_inspect_cache[task_name] = (now, registered_ok)
    return registered_ok


def _should_run_inline(task_obj, task_name: str) -> bool:
    flag = os.getenv("REPORT_INLINE_MODE", "").strip().lower()
    if flag in {"1", "true", "yes"}:
        return True
    if flag in {"0", "false", "no"}:
        return False
    # Preserve unit tests that monkeypatch task.delay(...) to assert async dispatch.
    if not _is_default_celery_delay(task_obj):
        return False
    return not _has_registered_report_worker(task_name)


def _recover_stale_generating(report: Report, previous: list[ReportSnapshot]) -> bool:
    now = datetime.now(UTC)
    cutoff = now - timedelta(seconds=STALE_GENERATING_SECONDS)
    generating_rows = [item for item in previous if item.status == "generating"]
    if not generating_rows:
        report.status = "failed"
        return True
    latest_gen = generating_rows[0]
    created_at = latest_gen.created_at
    if created_at is not None and created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=UTC)
    if created_at is None or created_at <= cutoff:
        for row in generating_rows:
            row.status = "failed"
        report.status = "failed"
        return True
    return False


def _deterministic_risk_explanation(data: dict, active_risks: list[Risk]) -> str:
    counts = data.get("counts") if isinstance(data.get("counts"), dict) else {}
    total_tasks = int(counts.get("tasks", 0))
    completed_tasks = int(counts.get("completed_tasks", 0))
    evidence_count = int(counts.get("evidence", 0))
    if not active_risks:
        return (
            f"当前项目无活跃风险记录，已完成 {completed_tasks}/{total_tasks} 项任务，"
            f"有效正式证据 {evidence_count} 条，整体进展稳定。\n"
            "建议在正式提交定稿前复核里程碑交付物、贡献度冻结快照与正式证据完整性。\n"
            "AI advice requires human review."
        )
    high = sum(1 for r in active_risks if r.level == "high")
    medium = sum(1 for r in active_risks if r.level == "medium")
    low = sum(1 for r in active_risks if r.level == "low")
    top_titles = "、".join(r.title for r in active_risks[:5])
    return (
        f"当前存在 {len(active_risks)} 项活跃风险（高 {high} / 中 {medium} / 低 {low}），"
        f"任务完成进度 {completed_tasks}/{total_tasks}。\n"
        f"重点关注风险：{top_titles}。\n"
        "建议优先跟踪高/中等级风险并补充缓解说明后再提交定稿。\n"
        "AI advice requires human review."
    )


def _complete_preview_inline(
    session: Session,
    *,
    version: ReportSnapshot,
    report: Report,
    project,
    appendix: bool,
    actor_id: UUID,
) -> None:
    from app.modules.d.contribution_week7 import archive_contribution

    data = build_report_snapshot_data(
        session,
        project.id,
        project.name,
        appendix,
        actor_id=actor_id,
        use_ai=True,
    )
    contribution_id = data.get("contribution_snapshot_id")
    version.contribution_snapshot_id = UUID(contribution_id) if contribution_id else None
    if version.contribution_snapshot_id is not None:
        archive_contribution(
            session,
            project.id,
            "report",
            version.id,
            version.contribution_snapshot_id,
        )
    version.data_snapshot = data
    version.status = "generated"
    report.status = "generated"
    session.commit()


def _complete_preview_inline_safe(
    session: Session,
    *,
    version: ReportSnapshot,
    report: Report,
    project,
    appendix: bool,
    actor_id: UUID,
) -> None:
    try:
        _complete_preview_inline(
            session,
            version=version,
            report=report,
            project=project,
            appendix=appendix,
            actor_id=actor_id,
        )
    except Exception as exc:
        logger.exception("Inline report preview generation failed for project %s", project.id)
        session.rollback()
        failed_version = session.get(ReportSnapshot, version.id)
        failed_report = session.get(Report, report.id)
        if failed_version is not None:
            failed_version.status = "failed"
        if failed_report is not None:
            failed_report.status = "failed"
        session.commit()
        raise ApiError(
            500, "REPORT_PREVIEW_FAILED", "Report preview generation failed; please retry."
        ) from exc


def _sanitize_text(value: object) -> str:
    return _XML_ILLEGAL_RE.sub("", str(value or ""))


def _content_disposition(project_name: str, version_no: int | None, file_format: str) -> str:
    ext = "md" if file_format in {"md", "markdown"} else file_format
    ascii_stem = f"report-v{version_no}" if version_no is not None else "report"
    clean_name = (
        re.sub(r'[\\/:*?"<>|\r\n]+', "-", _sanitize_text(project_name)).strip() or "GroupProof"
    )
    utf8_name = (
        f"{clean_name}-结项报告-v{version_no}.{ext}"
        if version_no is not None
        else f"{clean_name}-结项报告.{ext}"
    )
    return f"attachment; filename=\"{ascii_stem}.{ext}\"; filename*=UTF-8''{quote(utf8_name)}"


def _ensure_pdf_font() -> None:
    global _PDF_FONT_REGISTERED
    if not _PDF_FONT_REGISTERED:
        pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
        _PDF_FONT_REGISTERED = True


_MD_HEADING_RE = re.compile(r"^\s*(#{1,6})\s+(.*?)\s*#*\s*$")
_MD_TABLE_SEP_RE = re.compile(r"^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$")
_MD_UL_RE = re.compile(r"^\s*[-*+]\s+(.*)$")
_MD_OL_RE = re.compile(r"^\s*\d+[.)]\s+(.*)$")
_MD_BOLD_RE = re.compile(r"\*\*(.+?)\*\*")
_MD_CODE_RE = re.compile(r"`([^`]+)`")


def _split_md_row(line: str) -> list[str]:
    text = line.strip()
    if text.startswith("|"):
        text = text[1:]
    if text.endswith("|") and not text.endswith("\\|"):
        text = text[:-1]
    return [cell.strip().replace("\\|", "|") for cell in re.split(r"(?<!\\)\|", text)]


def _parse_markdown_blocks(markdown_text: str) -> list[dict[str, Any]]:
    """Lightweight GFM block parser for DOCX and PDF rendering."""
    lines = _sanitize_text(markdown_text).replace("\r\n", "\n").split("\n")
    blocks: list[dict[str, Any]] = []
    idx = 0
    total = len(lines)
    while idx < total:
        raw = lines[idx]
        stripped = raw.strip()
        if not stripped:
            idx += 1
            continue
        hm = _MD_HEADING_RE.match(raw)
        if hm:
            blocks.append({"type": "heading", "level": len(hm.group(1)), "text": hm.group(2)})
            idx += 1
            continue
        if (
            "|" in raw
            and idx + 1 < total
            and _MD_TABLE_SEP_RE.match(lines[idx + 1])
            and "-" in lines[idx + 1]
        ):
            head = _split_md_row(raw)
            rows: list[list[str]] = []
            idx += 2
            while idx < total and lines[idx].strip() and "|" in lines[idx]:
                rows.append(_split_md_row(lines[idx]))
                idx += 1
            blocks.append({"type": "table", "head": head, "rows": rows})
            continue
        if stripped.startswith(">"):
            quote_lines: list[str] = []
            while idx < total and lines[idx].strip().startswith(">"):
                quote_lines.append(lines[idx].strip().lstrip(">").strip())
                idx += 1
            blocks.append({"type": "quote", "text": " ".join(quote_lines)})
            continue
        ul = _MD_UL_RE.match(raw)
        if ul:
            items: list[str] = []
            while idx < total:
                m = _MD_UL_RE.match(lines[idx])
                if not m:
                    break
                items.append(m.group(1).strip())
                idx += 1
            blocks.append({"type": "list", "ordered": False, "items": items})
            continue
        ol = _MD_OL_RE.match(raw)
        if ol:
            items = []
            while idx < total:
                m = _MD_OL_RE.match(lines[idx])
                if not m:
                    break
                items.append(m.group(1).strip())
                idx += 1
            blocks.append({"type": "list", "ordered": True, "items": items})
            continue
        para_lines = [stripped]
        idx += 1
        while idx < total:
            nxt = lines[idx]
            if (
                not nxt.strip()
                or _MD_HEADING_RE.match(nxt)
                or _MD_UL_RE.match(nxt)
                or _MD_OL_RE.match(nxt)
                or nxt.strip().startswith(">")
                or (
                    "|" in nxt
                    and idx + 1 < total
                    and _MD_TABLE_SEP_RE.match(lines[idx + 1])
                    and "-" in lines[idx + 1]
                )
            ):
                break
            para_lines.append(nxt.strip())
            idx += 1
        blocks.append({"type": "paragraph", "text": " ".join(para_lines)})
    return blocks


def _add_docx_rich_runs(paragraph, text: str) -> None:
    cleaned = _MD_CODE_RE.sub(r"\1", _sanitize_text(text))
    pos = 0
    for match in _MD_BOLD_RE.finditer(cleaned):
        if match.start() > pos:
            paragraph.add_run(cleaned[pos : match.start()])
        run = paragraph.add_run(match.group(1))
        run.bold = True
        pos = match.end()
    if pos < len(cleaned):
        paragraph.add_run(cleaned[pos:])


def _shade_docx_cell(cell, fill_hex: str) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill_hex)
    tc_pr.append(shd)


def _md_inline_to_rl_markup(text: str) -> str:
    cleaned = _MD_CODE_RE.sub(r"\1", _sanitize_text(text))
    parts: list[str] = []
    pos = 0
    for match in _MD_BOLD_RE.finditer(cleaned):
        if match.start() > pos:
            parts.append(xml_escape(cleaned[pos : match.start()]))
        parts.append(f"<b>{xml_escape(match.group(1))}</b>")
        pos = match.end()
    if pos < len(cleaned):
        parts.append(xml_escape(cleaned[pos:]))
    return "".join(parts)


def render_document(data: dict, file_format: str) -> tuple[bytes, str]:
    project_name = _sanitize_text(data.get("project_name") or "GroupProof")
    title = f"{project_name} 项目结项报告"
    counts = data.get("counts") if isinstance(data.get("counts"), dict) else None
    ordered_entries = _ordered_section_entries(data)
    evidence_records = (
        data.get("evidence_records") if isinstance(data.get("evidence_records"), list) else []
    )
    has_appendix = any(key == "appendix" for key, _, _ in ordered_entries)

    if file_format in {"md", "markdown"}:
        lines: list[str] = [f"# {title}", ""]
        if counts:
            lines.extend(
                [
                    "| 指标 | 数值 |",
                    "| --- | ---: |",
                    f"| 项目成员 | {counts.get('members', 0)} |",
                    f"| 任务完成 | {counts.get('completed_tasks', 0)} / {counts.get('tasks', 0)} |",
                    f"| 正式证据 | {counts.get('evidence', 0)} |",
                    f"| 活跃风险 | {counts.get('risks', 0)} |",
                    "",
                ]
            )
        for _key, label, body in ordered_entries:
            lines.append(f"## {label}")
            lines.append("")
            lines.append(_sanitize_text(body))
            lines.append("")
        if has_appendix and evidence_records:
            lines.extend(
                [
                    "### 正式证据明细表",
                    "",
                    "| 证据标题 | 关联任务 ID |",
                    "| --- | --- |",
                ]
            )
            for item in evidence_records:
                ev_title = _sanitize_text(item.get("title", "")).replace("|", "\\|")
                ev_task = _sanitize_text(item.get("task_id", "")).replace("|", "\\|")
                lines.append(f"| {ev_title} | {ev_task} |")
            lines.append("")
        return "\n".join(lines).encode("utf-8"), "text/markdown; charset=utf-8"

    if file_format == "docx":
        document = Document()
        document.add_heading(title, 0)
        if counts:
            summary_table = document.add_table(rows=2, cols=5)
            summary_table.style = "Table Grid"
            headers = ["成员数", "任务总数", "已完成任务", "正式证据", "活跃风险"]
            values = [
                str(counts.get("members", 0)),
                str(counts.get("tasks", 0)),
                str(counts.get("completed_tasks", 0)),
                str(counts.get("evidence", 0)),
                str(counts.get("risks", 0)),
            ]
            for idx, text_val in enumerate(headers):
                hcell = summary_table.cell(0, idx)
                hcell.text = text_val
                _shade_docx_cell(hcell, "F1F5F9")
                summary_table.cell(1, idx).text = values[idx]
        for _key, label, body in ordered_entries:
            document.add_heading(_sanitize_text(label), level=1)
            for block in _parse_markdown_blocks(body):
                btype = block["type"]
                if btype == "heading":
                    lvl = min(4, max(2, int(block["level"]) - 1))
                    document.add_heading(_sanitize_text(block["text"]), level=lvl)
                elif btype == "table":
                    head = block["head"]
                    rows = block["rows"]
                    cols = max(len(head), max((len(r) for r in rows), default=0))
                    if cols > 0:
                        tbl = document.add_table(rows=len(rows) + 1, cols=cols)
                        tbl.style = "Table Grid"
                        for c_idx in range(cols):
                            cell = tbl.cell(0, c_idx)
                            cell.text = ""
                            _shade_docx_cell(cell, "F1F5F9")
                            run = cell.paragraphs[0].add_run(
                                _sanitize_text(head[c_idx] if c_idx < len(head) else "")
                            )
                            run.bold = True
                        for r_idx, row in enumerate(rows, start=1):
                            for c_idx in range(cols):
                                cell = tbl.cell(r_idx, c_idx)
                                cell.text = ""
                                _add_docx_rich_runs(
                                    cell.paragraphs[0],
                                    row[c_idx] if c_idx < len(row) else "",
                                )
                elif btype == "list":
                    style_name = "List Number" if block["ordered"] else "List Bullet"
                    for item_text in block["items"]:
                        p = document.add_paragraph(style=style_name)
                        _add_docx_rich_runs(p, item_text)
                elif btype == "quote":
                    p = document.add_paragraph()
                    _add_docx_rich_runs(p, block["text"])
                else:
                    p = document.add_paragraph()
                    _add_docx_rich_runs(p, block["text"])
        if has_appendix and evidence_records:
            document.add_heading("正式证据明细表", level=2)
            ev_table = document.add_table(rows=len(evidence_records) + 1, cols=2)
            ev_table.style = "Table Grid"
            ev_table.cell(0, 0).text = "证据标题"
            ev_table.cell(0, 1).text = "关联任务 ID"
            _shade_docx_cell(ev_table.cell(0, 0), "F1F5F9")
            _shade_docx_cell(ev_table.cell(0, 1), "F1F5F9")
            for row_idx, item in enumerate(evidence_records, start=1):
                ev_table.cell(row_idx, 0).text = _sanitize_text(item.get("title", ""))
                ev_table.cell(row_idx, 1).text = _sanitize_text(item.get("task_id", ""))
        stream = BytesIO()
        document.save(stream)
        return (
            stream.getvalue(),
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )

    # Rich PDF via ReportLab Platypus (styled headings, CJK wrapping, real GFM tables)
    _ensure_pdf_font()
    stream = BytesIO()
    page_w, _ = A4
    margin = 40.0
    usable_w = page_w - margin * 2
    doc = SimpleDocTemplate(
        stream,
        pagesize=A4,
        leftMargin=margin,
        rightMargin=margin,
        topMargin=44.0,
        bottomMargin=46.0,
        title=title,
    )
    st_title = ParagraphStyle(
        "GPTitle",
        fontName="STSong-Light",
        fontSize=16,
        leading=22,
        textColor=colors.HexColor("#0F172A"),
        spaceAfter=8,
        wordWrap="CJK",
    )
    st_h1 = ParagraphStyle(
        "GPH1",
        fontName="STSong-Light",
        fontSize=13,
        leading=19,
        textColor=colors.HexColor("#0369A1"),
        spaceBefore=12,
        spaceAfter=6,
        wordWrap="CJK",
    )
    st_h2 = ParagraphStyle(
        "GPH2",
        fontName="STSong-Light",
        fontSize=11,
        leading=16,
        textColor=colors.HexColor("#1E293B"),
        spaceBefore=8,
        spaceAfter=4,
        wordWrap="CJK",
    )
    st_body = ParagraphStyle(
        "GPBody",
        fontName="STSong-Light",
        fontSize=10,
        leading=15,
        textColor=colors.HexColor("#334155"),
        spaceAfter=5,
        wordWrap="CJK",
    )
    st_quote = ParagraphStyle(
        "GPQuote",
        fontName="STSong-Light",
        fontSize=9.5,
        leading=14.5,
        leftIndent=10,
        textColor=colors.HexColor("#475569"),
        spaceAfter=5,
        wordWrap="CJK",
    )
    st_cell = ParagraphStyle(
        "GPCell",
        fontName="STSong-Light",
        fontSize=8.5,
        leading=12.5,
        textColor=colors.HexColor("#1E293B"),
        wordWrap="CJK",
    )
    st_cell_head = ParagraphStyle(
        "GPCellHead",
        fontName="STSong-Light",
        fontSize=8.5,
        leading=12.5,
        textColor=colors.HexColor("#0F172A"),
        wordWrap="CJK",
    )

    story: list[Any] = [
        Paragraph(xml_escape(title), st_title),
        HRFlowable(width="100%", thickness=1, color=colors.HexColor("#CBD5E1"), spaceAfter=8),
    ]

    if counts:
        kpi_data = [
            [
                Paragraph("<b>成员数</b>", st_cell_head),
                Paragraph("<b>任务完成</b>", st_cell_head),
                Paragraph("<b>正式证据</b>", st_cell_head),
                Paragraph("<b>活跃风险</b>", st_cell_head),
            ],
            [
                Paragraph(f"{counts.get('members', 0)} 人", st_cell),
                Paragraph(
                    f"{counts.get('completed_tasks', 0)} / {counts.get('tasks', 0)}", st_cell
                ),
                Paragraph(f"{counts.get('evidence', 0)} 条", st_cell),
                Paragraph(f"{counts.get('risks', 0)} 项", st_cell),
            ],
        ]
        kpi_table = Table(kpi_data, colWidths=[usable_w / 4] * 4)
        kpi_table.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F1F5F9")),
                    ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#CBD5E1")),
                    ("TOPPADDING", (0, 0), (-1, -1), 5),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                    ("LEFTPADDING", (0, 0), (-1, -1), 6),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ]
            )
        )
        story.extend([kpi_table, Spacer(1, 8)])

    for _key, label, body in ordered_entries:
        story.append(Paragraph(f"<b>{xml_escape(_sanitize_text(label))}</b>", st_h1))
        for block in _parse_markdown_blocks(body):
            btype = block["type"]
            if btype == "heading":
                story.append(Paragraph(f"<b>{_md_inline_to_rl_markup(block['text'])}</b>", st_h2))
            elif btype == "table":
                head = block["head"]
                rows = block["rows"]
                cols = max(len(head), max((len(r) for r in rows), default=0))
                if cols > 0:
                    table_rows = [
                        [
                            Paragraph(
                                f"<b>{_md_inline_to_rl_markup(head[c] if c < len(head) else '')}</b>",
                                st_cell_head,
                            )
                            for c in range(cols)
                        ]
                    ]
                    for row in rows:
                        table_rows.append(
                            [
                                Paragraph(
                                    _md_inline_to_rl_markup(row[c] if c < len(row) else ""),
                                    st_cell,
                                )
                                for c in range(cols)
                            ]
                        )
                    tbl = Table(table_rows, colWidths=[usable_w / cols] * cols, repeatRows=1)
                    tbl.setStyle(
                        TableStyle(
                            [
                                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F1F5F9")),
                                (
                                    "ROWBACKGROUNDS",
                                    (0, 1),
                                    (-1, -1),
                                    [colors.white, colors.HexColor("#F8FAFC")],
                                ),
                                ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#CBD5E1")),
                                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                                ("TOPPADDING", (0, 0), (-1, -1), 4),
                                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                            ]
                        )
                    )
                    story.extend([tbl, Spacer(1, 6)])
            elif btype == "list":
                for idx_item, item_text in enumerate(block["items"], start=1):
                    bullet = f"{idx_item}. " if block["ordered"] else "• "
                    story.append(
                        Paragraph(f"{bullet}{_md_inline_to_rl_markup(item_text)}", st_body)
                    )
            elif btype == "quote":
                story.append(Paragraph(_md_inline_to_rl_markup(block["text"]), st_quote))
            else:
                story.append(Paragraph(_md_inline_to_rl_markup(block["text"]), st_body))

    def _draw_footer(canvas_obj, doc_obj) -> None:
        canvas_obj.saveState()
        canvas_obj.setFont("STSong-Light", 8.5)
        canvas_obj.setFillColor(colors.HexColor("#64748B"))
        canvas_obj.drawRightString(
            page_w - margin, 22, f"GroupProof · {project_name[:30]} · 第 {doc_obj.page} 页"
        )
        canvas_obj.restoreState()

    doc.build(story, onFirstPage=_draw_footer, onLaterPages=_draw_footer)
    return stream.getvalue(), "application/pdf"


def _render_export_inline_safe(
    session: Session, artifact: ReportArtifact, data_snapshot: dict
) -> None:
    try:
        content, _ = render_document(data_snapshot, artifact.file_format)
        artifact.content = content
        artifact.status = "ready"
        artifact.error = None
        artifact.completed_at = datetime.now(UTC)
        session.commit()
    except Exception as render_err:
        logger.exception("Inline report export failed for artifact %s", artifact.id)
        artifact.status = "failed"
        artifact.error = "Report generation failed; retry from the export page."
        artifact.completed_at = datetime.now(UTC)
        session.commit()
        raise ApiError(500, "REPORT_EXPORT_FAILED", artifact.error) from render_err


@router.get("/versions/{version_no}/markdown")
def download_markdown(
    project_id: UUID,
    version_no: int,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    get_project_access(session, user, project_id)
    report = session.scalar(select(Report).where(Report.project_id == project_id))
    version = (
        session.scalar(
            select(ReportSnapshot).where(
                ReportSnapshot.report_id == report.id,
                ReportSnapshot.version_no == version_no,
            )
        )
        if report
        else None
    )
    if version is None:
        raise ApiError(404, "REPORT_VERSION_NOT_FOUND", "Report version not found.")
    if version.status not in {"generated", "finalized"}:
        raise ApiError(409, "REPORT_NOT_READY", "Wait for report preview to finish.")
    content, mime = render_document(version.data_snapshot, "md")
    project_name = str((version.data_snapshot or {}).get("project_name") or "GroupProof")
    disposition = _content_disposition(project_name, version.version_no, "md")
    return Response(
        content=content,
        media_type=mime,
        headers={"Content-Disposition": disposition},
    )


@router.post("/exports", status_code=202)
def request_export(
    project_id: UUID,
    payload: ExportInput,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    get_project_access(session, user, project_id)
    report = session.scalar(select(Report).where(Report.project_id == project_id))
    version = (
        session.scalar(
            select(ReportSnapshot).where(
                ReportSnapshot.report_id == report.id,
                ReportSnapshot.version_no == payload.version,
            )
        )
        if report
        else None
    )
    if version is None:
        raise ApiError(404, "REPORT_VERSION_NOT_FOUND", "Report version not found.")
    if version.status not in {"generated", "finalized"}:
        raise ApiError(409, "REPORT_NOT_READY", "Wait for report preview to finish.")
    artifact = ReportArtifact(
        snapshot_id=version.id,
        requested_by=user.id,
        file_format=payload.file_format,
        status="pending",
    )
    session.add(artifact)
    session.commit()
    from app.modules.d.report_tasks import generate_export

    if _should_run_inline(generate_export, "app.modules.d.report_tasks.generate_export"):
        _render_export_inline_safe(session, artifact, version.data_snapshot)
        return success({"id": str(artifact.id), "status": artifact.status}, request)
    try:
        generate_export.delay(str(artifact.id))
    except Exception:
        if _allow_inline_worker_fallback():
            _render_export_inline_safe(session, artifact, version.data_snapshot)
            return success({"id": str(artifact.id), "status": artifact.status}, request)
        artifact.status = "failed"
        artifact.error = "Report worker is unavailable; retry the export."
        session.commit()
        raise ApiError(503, "REPORT_WORKER_UNAVAILABLE", artifact.error) from None
    return success({"id": str(artifact.id), "status": artifact.status}, request)


@router.get("/exports/{artifact_id}")
def read_export(
    project_id: UUID,
    artifact_id: UUID,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    get_project_access(session, user, project_id)
    artifact = session.scalar(
        select(ReportArtifact)
        .join(ReportSnapshot, ReportArtifact.snapshot_id == ReportSnapshot.id)
        .join(Report, ReportSnapshot.report_id == Report.id)
        .where(ReportArtifact.id == artifact_id, Report.project_id == project_id)
    )
    if artifact is None:
        raise ApiError(404, "REPORT_EXPORT_NOT_FOUND", "Report export not found.")
    return success(
        {
            "id": str(artifact.id),
            "status": artifact.status,
            "format": artifact.file_format,
            "error": artifact.error,
        },
        request,
    )


@router.get("/exports/{artifact_id}/download")
def download_export(
    project_id: UUID,
    artifact_id: UUID,
    token: str,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    get_project_access(session, user, project_id)
    artifact = session.scalar(
        select(ReportArtifact)
        .join(ReportSnapshot, ReportArtifact.snapshot_id == ReportSnapshot.id)
        .join(Report, ReportSnapshot.report_id == Report.id)
        .where(ReportArtifact.id == artifact_id, Report.project_id == project_id)
    )
    if artifact is None:
        raise ApiError(404, "REPORT_EXPORT_NOT_FOUND", "Report export not found.")
    if artifact.status != "ready" or not artifact.content:
        raise ApiError(409, "REPORT_EXPORT_NOT_READY", "Report export is not ready.")
    link = session.scalar(
        select(ReportDownloadLink).where(
            ReportDownloadLink.artifact_id == artifact.id,
            ReportDownloadLink.user_id == user.id,
            ReportDownloadLink.token_hash == sha256(token.encode()).hexdigest(),
        )
    )
    expires = link.expires_at if link else None
    if expires is not None and expires.tzinfo is None:
        expires = expires.replace(tzinfo=UTC)
    if expires is None or expires <= datetime.now(UTC):
        raise ApiError(403, "REPORT_LINK_EXPIRED", "Request a new download link.")
    session.add(
        ReportDownload(
            snapshot_id=artifact.snapshot_id, user_id=user.id, file_format=artifact.file_format
        )
    )
    session.commit()
    snapshot = session.get(ReportSnapshot, artifact.snapshot_id)
    project_name = str(
        ((snapshot.data_snapshot or {}) if snapshot else {}).get("project_name") or "GroupProof"
    )
    version_no = snapshot.version_no if snapshot else None
    mime = (
        "application/pdf"
        if artifact.file_format == "pdf"
        else ("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    )
    return Response(
        content=artifact.content,
        media_type=mime,
        headers={
            "Content-Disposition": _content_disposition(
                project_name, version_no, artifact.file_format
            )
        },
    )


@router.post("/exports/{artifact_id}/download-link")
def create_download_link(
    project_id: UUID,
    artifact_id: UUID,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    get_project_access(session, user, project_id)
    artifact = session.scalar(
        select(ReportArtifact)
        .join(ReportSnapshot, ReportArtifact.snapshot_id == ReportSnapshot.id)
        .join(Report, ReportSnapshot.report_id == Report.id)
        .where(ReportArtifact.id == artifact_id, Report.project_id == project_id)
    )
    if artifact is None:
        raise ApiError(404, "REPORT_EXPORT_NOT_FOUND", "Report export not found.")
    if artifact.status != "ready" or not artifact.content:
        raise ApiError(409, "REPORT_EXPORT_NOT_READY", "Report export is not ready.")
    token = token_urlsafe(32)
    expires = datetime.now(UTC) + timedelta(minutes=10)
    session.add(
        ReportDownloadLink(
            artifact_id=artifact.id,
            user_id=user.id,
            token_hash=sha256(token.encode()).hexdigest(),
            expires_at=expires,
        )
    )
    session.commit()
    return success(
        {
            "url": (
                f"/api/v1/projects/{project_id}/reports/exports/{artifact_id}"
                f"/download?token={token}"
            ),
            "expires_at": expires.isoformat(),
        },
        request,
    )
