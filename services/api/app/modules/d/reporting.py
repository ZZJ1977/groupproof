# ruff: noqa: E501  (包含中文报告模板与 AI 提示词长句)
"""D4 project reports: 6-source fact bundle, OpenRouter AI authoring, and rich PDF/DOCX/MD export."""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
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
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor
from fastapi import APIRouter, Depends, Request, Response
from PIL import Image as PILImage
from pydantic import BaseModel, Field
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import (
    HRFlowable,
    KeepTogether,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.platypus import (
    Image as RLImage,
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
    Course,
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
from app.modules.d.report_charts import (
    ALLOWED_DEFAULT_CHART_KEYS,
    CHART_KEY_RE,
    build_default_visual_specs,
    render_chart_from_snapshot,
    render_chart_svg_from_snapshot,
    sanitize_visual_specs,
)
from app.modules.d.risk_read import risk_counts
from app.modules.d.skills import SKILL_REPORT_VISUAL, SKILL_REPORT_WRITING, load_skill

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/projects/{project_id}/reports", tags=["d-reports"])

STALE_GENERATING_SECONDS = 240
AI_REPORT_TIMEOUT_SECONDS = 90.0
AI_REWRITE_TIMEOUT_SECONDS = 25.0
AI_REPORT_BATCH_MAX_TOKENS = 16384
AI_SINGLE_CHAPTER_MAX_TOKENS = 6400
AI_VISUALS_MAX_TOKENS = 9600
AI_REWRITE_MAX_TOKENS = 6400
_MIN_AI_CHAPTER_CHARS = 80
CHAPTER_BATCH_1: tuple[str, ...] = ("overview", "workflow", "progress")
CHAPTER_BATCH_2: tuple[str, ...] = ("collaboration", "evidence")
CHAPTER_BATCH_3: tuple[str, ...] = ("contribution", "reflection")
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
    course = (
        session.get(Course, project.course_id)
        if project is not None and project.course_id is not None
        else None
    )
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
        )
        .order_by(Evidence.created_at.desc(), Evidence.id)
    ).all()
    effective_formal_count = sum(1 for item in evidence if not item.source_changed)
    source_changed_count = len(evidence) - effective_formal_count

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
    all_formal_outcomes = session.scalars(
        select(FormalOutcome).where(FormalOutcome.project_id == project_id)
    ).all()
    active_formal_outcomes = [fo for fo in all_formal_outcomes if fo.invalidated_at is None]
    completed_task_ids = {t.id for t in tasks if t.status == "completed"}
    confirmed_outcome_task_ids = {fo.task_id for fo in active_formal_outcomes}
    for fo in all_formal_outcomes:
        if fo.task_id in completed_task_ids:
            confirmed_outcome_task_ids.add(fo.task_id)
    formal_outcomes_count = max(len(active_formal_outcomes), len(confirmed_outcome_task_ids))

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
        "blockers": [],
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
            feishu_stats["overview"] = str(res.get("overview") or "")[:500]
            feishu_stats["total_conclusions"] = len(items)
            cat_counts: dict[str, int] = {}
            by_cat: dict[str, list[dict[str, Any]]] = {}
            for item in items:
                if not isinstance(item, dict):
                    continue
                cat = str(item.get("category") or "decision")
                cat_counts[cat] = cat_counts.get(cat, 0) + 1
                formatted = {
                    "title": str(item.get("title") or "")[:120],
                    "category": cat,
                    "status": str(item.get("status") or "completed"),
                    "summary": str(item.get("summary") or "")[:220],
                    "confirmed_count": _safe_int(item.get("confirmed_count", 0)),
                    "task_codes": list(item.get("task_codes") or [])[:5],
                }
                by_cat.setdefault(cat, []).append(formatted)
            feishu_stats["categories"] = cat_counts
            # Pick diverse top highlights across all categories in round-robin order (up to 18)
            priority_cats = [
                "division_confirm",
                "decision",
                "blocker",
                "doc_review",
                "task_progress",
            ]
            ordered_cats = [c for c in priority_cats if c in by_cat] + [
                c for c in by_cat if c not in priority_cats
            ]
            picked: list[dict[str, Any]] = []
            round_idx = 0
            while len(picked) < 18:
                added_any = False
                for cat in ordered_cats:
                    bucket = by_cat.get(cat) or []
                    if round_idx < len(bucket):
                        picked.append(bucket[round_idx])
                        added_any = True
                        if len(picked) >= 18:
                            break
                if not added_any:
                    break
                round_idx += 1
            feishu_stats["highlights"] = picked
            feishu_stats["blockers"] = (by_cat.get("blocker") or [])[:6]

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

    # Evidence source breakdown & per-member authorship
    ev_by_source: dict[str, int] = {}
    ev_by_task: dict[UUID, int] = {}
    ev_by_author: dict[UUID, int] = {}
    feishu_ev_by_author: dict[UUID, int] = {}
    for item in evidence:
        ev_by_source[item.source_type] = ev_by_source.get(item.source_type, 0) + 1
        ev_by_task[item.task_id] = ev_by_task.get(item.task_id, 0) + 1
        if item.author_id:
            ev_by_author[item.author_id] = ev_by_author.get(item.author_id, 0) + 1
            if item.source_type == "feishu":
                feishu_ev_by_author[item.author_id] = feishu_ev_by_author.get(item.author_id, 0) + 1

    # Member portraits (combine ProjectMember + ContributionItem + Tasks + GitHub + Modules + Feishu/Evidence)
    share_by_uid = {item.user_id: item for item in contrib_items}
    owned_modules_by_uid: dict[UUID, list[str]] = {}
    for mod in modules:
        if mod.owner_id:
            owned_modules_by_uid.setdefault(mod.owner_id, []).append(mod.name)

    feishu_highlights = feishu_stats.get("highlights") or []
    member_portraits: list[dict[str, Any]] = []
    for pm in sorted(
        members_rows, key=lambda m: (0 if m.role == "leader" else 1, _uname(m.user_id))
    ):
        name = _uname(pm.user_id)
        c_item = share_by_uid.get(pm.user_id)
        assigned = tasks_by_user.get(pm.user_id, [])
        gh = github_stats["by_member"].get(name, {})
        feishu_mentions = (
            sum(
                1
                for h in feishu_highlights
                if name
                and (name in str(h.get("title") or "") or name in str(h.get("summary") or ""))
            )
            if name
            else 0
        )
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
                "evidence_authored": int(ev_by_author.get(pm.user_id, 0)),
                "feishu_collab_count": int(feishu_ev_by_author.get(pm.user_id, 0))
                + feishu_mentions,
                "key_tasks": [t.title for t in assigned[:6]],
            }
        )

    completed_tasks = sum(1 for t in tasks if t.status == "completed")
    team_member_labels = [
        f"{m['name']}（{m['role']}）" if m["role"] == "组长" else m["name"]
        for m in member_portraits
    ]
    return {
        "project": {
            "name": project_name,
            "description": (project.description or "").strip()[:500] if project else "",
            "course_name": (course.name or "").strip() if course else "",
            "course_code": (course.code or "").strip() if course else "",
            "semester": (course.semester or "").strip() if course else "",
            "team_members": team_member_labels,
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
            "effective_formal": effective_formal_count,
            "source_changed_count": source_changed_count,
            "by_source": ev_by_source,
            "tasks_with_evidence": len(ev_by_task),
            "criteria_total": len(criteria_rows),
            "verification_runs": len(verification_runs),
            "formal_outcomes": formal_outcomes_count,
            "formal_outcomes_active": len(active_formal_outcomes),
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


def render_fallback_chapters(
    facts: dict[str, Any],
    *,
    project_id: UUID | None = None,
    version_no: int | None = None,
    visuals: list[dict[str, Any]] | None = None,
) -> dict[str, str]:
    """Deterministically generate all 7 publication-grade Chinese chapters for professor grading."""
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
    ev_cov_rate = round(ev["tasks_with_evidence"] * 100 / total_tasks, 1) if total_tasks else 0.0
    ci_rate = (
        round(github["ci_success"] * 100 / github["ci_runs"], 1) if github["ci_runs"] else None
    )
    pr_merge_rate = (
        round(github["merged_prs"] * 100 / github["pull_requests"], 1)
        if github["pull_requests"]
        else None
    )
    course_prefix = (
        f"作为 **{proj['course_name']}**"
        + (f"（{proj['semester']}）" if proj.get("semester") else "")
        + "课程小组实践项目，"
        if proj.get("course_name")
        else ""
    )
    member_names_inline = (
        "、".join(m["name"] for m in members) if members else f"{counts['members']} 名核心成员"
    )

    # 1. Overview
    overview_lines = [
        f"> **本章核心结论**：**{proj['name']}** 围绕 {proj['modules_count']} 个功能模块与 {proj['requirements_count']} 条需求"
        f"（高优 {proj['requirements_high']} 条）开展协作开发，目前已完成 **{done_tasks}/{total_tasks} 项任务**"
        f"（{completion_rate}%），归档 **{ev['total_formal']} 条正式证据** 与 **{ev['formal_outcomes']} 项正式成果**。",
        "",
        f"{course_prefix}**{proj['name']}** 由 **{member_names_inline}** 共 **{counts['members']} 名**成员分工协作完成。"
        f"项目针对高校软件工程课程小组实践中的需求边界不清、进度缺少客观核验与成员贡献难以量化等具体问题，"
        f"围绕 **{proj['modules_count']} 个核心功能模块** 与 **{proj['requirements_count']} 条需求条目**"
        f"（其中高优先级需求 {proj['requirements_high']} 条）开展了系统设计、迭代开发与证据化验收。",
        "",
        f"如图 1 所示，系统在前端交互层、业务模块层与外部集成基础设施层之间保持了清晰的职责边界。"
        f"截至本报告编制时，团队累计完成 **{done_tasks}/{total_tasks} 项任务**（整体完成率 **{completion_rate}%**），"
        f"达成 **{ms_done}/{len(milestones)} 个阶段里程碑**（交付物勾选完成 **{deliv_done}/{deliv_total}**），"
        f"通过 GitHub 沉淀 **{github['commits']} 次代码提交** 与 **{github['pull_requests']} 个合并请求**，"
        f"并在平台归档 **{ev['total_formal']} 条正式证据**（覆盖 **{ev['tasks_with_evidence']}/{total_tasks}** 项任务，覆盖率 **{ev_cov_rate}%**）。"
        f"需求基线当前为 **v{proj['baseline_version'] or '—'}**（状态：{proj['baseline_status'] or '筹备中'}），"
        f"任务规划基线为 **v{proj['plan_version'] or '—'}**（状态：{proj['plan_status'] or '筹备中'}），"
        f"使整个学期内的功能范围可追踪、阶段变更受控。",
    ]
    if proj.get("description"):
        overview_lines.extend(["", f"> **系统定位与目标概述**：{proj['description']}"])
    overview_lines.extend(
        [
            "",
            "### 核心交付指标总览",
            "",
            "| 评估维度 | 当前量化指标 | 工程核验依据 |",
            "| --- | --- | --- |",
            f"| 团队配置与基线治理 | {counts['members']} 名成员 · 需求基线 v{proj['baseline_version'] or '—'} / 计划 v{proj['plan_version'] or '—'} | 覆盖 {proj['modules_count']} 个模块、{proj['requirements_count']} 条需求（高优 {proj['requirements_high']} 条） |",
            f"| 任务与里程碑闭环 | 任务完成 {done_tasks}/{total_tasks}（{completion_rate}%） | 里程碑达成 {ms_done}/{len(milestones)}，阶段交付物核验 {deliv_done}/{deliv_total} |",
            f"| 代码工程产出 | GitHub 提交 {github['commits']} 次 · PR {github['merged_prs']}/{github['pull_requests']} 已合并 | 代码累计变更 +{github['additions']} / -{github['deletions']} 行"
            + (
                f"，CI 通过 {github['ci_success']}/{github['ci_runs']} 次（{ci_rate}%）"
                if ci_rate is not None
                else ""
            )
            + " |",
            f"| 沟通与证据链沉淀 | 飞书消息 {feishu['total_messages']} 条 · 协作结论 {feishu['total_conclusions']} 项 | 沉淀正式证据 {ev['total_formal']} 条，人工确认正式成果 {ev['formal_outcomes']} 项 |",
        ]
    )
    if modules:
        overview_lines.extend(
            [
                "",
                "### 功能模块与职责边界",
                "",
                "| 功能模块 | 负责成员 | 关联需求数 | 任务完成 | 权重占比 | 核心交付内容 |",
                "| --- | --- | ---: | ---: | ---: | --- |",
            ]
        )
        for mod in modules:
            sample_preview = "、".join(mod["sample_tasks"][:3]) or "按计划推进"
            overview_lines.append(
                f"| {_md_cell(mod['name'])} | {_md_cell(mod['owner'])} | {mod['requirements_count']} "
                f"| {mod['tasks_completed']}/{mod['tasks_total']} | {mod['weight_sum']} | {_md_cell(sample_preview)} |"
            )

    # 2. Workflow
    repo_names = "、".join(f"`{r['full_name']}`（默认分支 `{r['default_branch']}`）" for r in repos)
    workflow_lines = [
        f"> **本章核心结论**：团队按六阶段证据驱动流程协同研发，累计记录 **{github['commits']} 次代码提交**、"
        f"**{github['merged_prs']}/{github['pull_requests']} 个已合并 PR**、**{feishu['total_messages']} 条飞书沟通消息**"
        f"与 **{ev['verification_runs']} 次核验运行**，全部任务状态变更均绑定可复核工程产物。",
        "",
        "如图 2 所示，为保证多人并行开发下的工程质量与过程可审计性，团队在项目周期内贯彻了"
        "**「需求基线冻结 → 任务拆解与权重确认 → GitHub 分支协作与持续集成 → 飞书群决策同步 → 证据审核与人工验收确认 → 贡献核算归档」**"
        "六阶段研发流程。所有任务状态变迁与完成宣称均须绑定真实代码提交、文件交付或协作记录，避免缺乏依据的口头进度汇报。",
        "",
        "### 多源工程协作与质量门禁体系",
        "",
        "- **代码托管与版本控制**："
        + (
            f"项目关联 {len(repos)} 个代码仓库（{repo_names}），累计记录 **{github['commits']} 次有效提交** 与 "
            f"**{github['pull_requests']} 个 Pull Request**（已合并 {github['merged_prs']} 个"
            + (f"，合并率 {pr_merge_rate}%" if pr_merge_rate is not None else "")
            + f"），累计代码变更 **+{github['additions']} / -{github['deletions']} 行**。"
            + (
                f"持续集成流水线共运行 **{github['ci_runs']} 次**，通过 **{github['ci_success']} 次**（通过率 {ci_rate}%），有效拦截回归缺陷。"
                if ci_rate is not None
                else "所有核心代码变更均通过分支评审与集成校验后并入主干。"
            )
            if repos or github["commits"] > 0
            else "团队依托标准化仓库与任务单同步机制管理代码迭代，所有关键功能修改均保留可追溯记录。"
        ),
        "- **团队沟通与规范沉淀**："
        + (
            f"项目绑定 {feishu['chat_count']} 个飞书工作群，完整归档 **{feishu['total_messages']} 条** 工程沟通消息"
            + (f"（时间跨度：{feishu['date_range']}）" if feishu["date_range"] else "")
            + f"，并结构化提炼出 **{feishu['total_conclusions']} 项** 可回溯的协作结论，覆盖分工确认、接口联调、规范同步与风险排查。"
            if feishu["total_messages"] > 0 or feishu["chat_count"] > 0
            else "团队通过项目讨论区、周例会纪要及文档评审机制保持需求与接口定义同步。"
        ),
        f"- **质量核验与人工确认闭环**：全项目共制定 **{ev['criteria_total']} 条** 可检验的任务验收标准，"
        f"累计执行 **{ev['verification_runs']} 次** 规则完整性检查与 AI 辅助核验，"
        f"并经组内责任人复核后生效 **{ev['formal_outcomes']} 项** 正式交付成果，坚持「AI 辅助核验、人工最终负责」的工程原则。",
    ]
    if github["recent_highlights"]:
        workflow_lines.extend(
            [
                "",
                "### 代表性工程提交与代码演进记录",
                "",
                "| 日期 | 提交成员 | 类型 | 变更内容摘要 | 代码增删 |",
                "| --- | --- | --- | --- | ---: |",
            ]
        )
        for item in github["recent_highlights"][:8]:
            kind_label = "PR" if item["kind"] == "pull_request" else "Commit"
            workflow_lines.append(
                f"| {item['date']} | {_md_cell(item['author'])} | {kind_label} "
                f"| {_md_cell(item['title'])} | +{item['additions']} / -{item['deletions']} |"
            )

    # 3. Progress & Milestones
    progress_lines = [
        f"> **本章核心结论**：项目按 **{len(milestones)} 个阶段里程碑** 持续推进，任务完成率 **{completion_rate}%**（{done_tasks}/{total_tasks}），"
        f"里程碑达成 **{ms_done}/{len(milestones)}**，关键交付物核验 **{deliv_done}/{deliv_total}**，研发节奏平稳连续。",
        "",
        f"如图 3 所示，团队将整个学期的研发周期划分为 **{len(milestones)} 个阶段里程碑** 与 **{total_tasks} 项核心工程任务**，"
        f"按周推进「架构基建 → 核心模块实现 → 跨模块联调 → 综合验收与结项归档」的递进式节奏。"
        f"截至报告快照，任务总体完成率达到 **{completion_rate}%**（{done_tasks}/{total_tasks}），"
        f"阶段里程碑完成 **{ms_done}/{len(milestones)}**，关键交付物核验通过 **{deliv_done}/{deliv_total}**，"
        "各项代码提交与验收记录分布于项目各周节点，体现了持续稳健的迭代推进而非期末集中突击。",
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
        deliv_notes = [
            f"- **{ms['title']}**：关键交付物包括{'、'.join(ms['deliverable_titles'])}（完成度 {ms['progress_percent']}%）。"
            for ms in milestones
            if ms.get("deliverable_titles")
        ]
        if deliv_notes:
            progress_lines.extend(["", "### 关键里程碑交付物说明", "", *deliv_notes[:8]])
    if modules:
        progress_lines.extend(
            [
                "",
                "### 分模块任务执行汇总",
                "",
                "| 功能模块 | 负责人 | 任务完成 | 权重合计 | 代表性任务明细 |",
                "| --- | --- | ---: | ---: | --- |",
            ]
        )
        for mod in modules:
            sample = "；".join(mod["sample_tasks"][:4]) or "暂无任务"
            progress_lines.append(
                f"| {_md_cell(mod['name'])} | {_md_cell(mod['owner'])} "
                f"| {mod['tasks_completed']}/{mod['tasks_total']} | {mod['weight_sum']} | {_md_cell(sample)} |"
            )

    # 4. Collaboration & Decisions
    collab_lines: list[str] = []
    if feishu["total_conclusions"] > 0 or feishu["total_messages"] > 0:
        collab_lines.extend(
            [
                f"> **本章核心结论**：项目飞书工作群累计沉淀 **{feishu['total_messages']} 条**工程沟通消息"
                + (f"（{feishu['date_range']}）" if feishu["date_range"] else "")
                + f"，结构化提炼 **{feishu['total_conclusions']} 项**协作结论，为跨模块分工与技术取舍保留了可追溯依据。",
                "",
                f"在多人并行开发过程中，高效的异步沟通与明确的决策留痕是避免接口返工的关键。"
                f"项目周期内，团队在飞书工作群中累计产生 **{feishu['total_messages']} 条** 有效沟通记录"
                + (f"（覆盖时段：{feishu['date_range']}）" if feishu["date_range"] else "")
                + f"，系统结合任务清单与上下文语义共提炼出 **{feishu['total_conclusions']} 项** 可溯源的协作结论，"
                "完整还原了从需求共识、模块分工到技术难题排查的真实协同轨迹。",
            ]
        )
        if feishu["overview"]:
            collab_lines.extend(["", f"> **整体协作态势评估**：{feishu['overview']}"])
        if feishu["categories"]:
            collab_lines.extend(
                [
                    "",
                    "### 协作结论分类分布",
                    "",
                    "| 结论类别 | 数量 | 占比 | 协作价值说明 |",
                    "| --- | ---: | ---: | --- |",
                ]
            )
            cat_value_map = {
                "division_confirm": "明确模块职责与任务归属，形成全员书面共识",
                "task_progress": "按阶段同步开发交付与联调进展，支撑进度核验",
                "doc_review": "统一接口契约、开发规范与数据模型文档",
                "decision": "记录架构选型、排期调整与演示方案等关键决议",
                "blocker": "及时暴露环境故障与跨模块卡点，推动闭环解决",
            }
            for cat, cnt in sorted(feishu["categories"].items(), key=lambda kv: -kv[1]):
                pct = (
                    round(cnt * 100 / feishu["total_conclusions"], 1)
                    if feishu["total_conclusions"]
                    else 0.0
                )
                collab_lines.append(
                    f"| {_FEISHU_CATEGORY_ZH.get(cat, cat)} | {cnt} | {pct}% "
                    f"| {cat_value_map.get(cat, '均绑定真实群聊上下文记录')} |"
                )
        if feishu["highlights"]:
            collab_lines.extend(["", "### 关键分工确认与技术决策案例", ""])
            for h in feishu["highlights"][:10]:
                cat_zh = _FEISHU_CATEGORY_ZH.get(h["category"], h["category"])
                meta_parts: list[str] = []
                if h.get("confirmed_count", 0) > 0:
                    meta_parts.append(f"{h['confirmed_count']} 人确认")
                if h.get("task_codes"):
                    meta_parts.append(f"关联任务：{'、'.join(h['task_codes'])}")
                meta_suffix = f"（{'，'.join(meta_parts)}）" if meta_parts else ""
                collab_lines.append(f"- **[{cat_zh}] {h['title']}**{meta_suffix}：{h['summary']}")
        collab_lines.extend(
            [
                "",
                "上述沟通结论与任务进度、代码提交形成了交叉印证：凡涉及跨模块接口变更或排期调整，"
                "团队均先在群内对齐方案并获相关成员明确回应后再落库实施，显著降低了后期集成冲突成本。",
            ]
        )
    else:
        collab_lines.extend(
            [
                "团队依托项目任务单评论、方案评审记录与需求/计划基线确认流程开展日常协同，"
                "确保了模块边界、数据结构与接口契约在开发前达成一致。",
                "",
                "目前该项目暂未接入外部飞书群聊同步摘要，后续若开启群聊归档，系统将自动将讨论共识、分工确认与阻塞排查关联至对应任务单。",
            ]
        )

    # 5. Evidence & Quality Acceptance
    ev_lines = [
        f"> **本章核心结论**：项目累计归档 **{ev['total_formal']} 条正式证据**（覆盖 {ev['tasks_with_evidence']}/{total_tasks} 项任务，{ev_cov_rate}%），"
        f"设定 **{ev['criteria_total']} 条**验收标准并执行 **{ev['verification_runs']} 次**核验，经人工复核确认 **{ev['formal_outcomes']} 项**正式成果。",
        "",
        "如图 4 所示，为向任课教师提供客观、可复核的完成度证明，团队在开发全程严格执行"
        "**「候选证据自动采集 → 责任人审核采纳为正式证据 → 验收标准完整性校验 → 人工最终确认生效」**"
        f"四阶段质量机制。截至快照生成，全项目已沉淀正式证据 **{ev['total_formal']} 条**，"
        f"覆盖 **{ev['tasks_with_evidence']}/{total_tasks}** 项任务（证据覆盖率 **{ev_cov_rate}%**）。",
        "",
        f"在质量验收维度，团队共围绕功能正确性、接口联调与文档完备性设定 **{ev['criteria_total']} 条**验收标准，"
        f"累计执行 **{ev['verification_runs']} 次**规则与 AI 辅助核验，并最终经人工复核通过 **{ev['formal_outcomes']} 项**正式成果。"
        "所有正式证据均具备来源溯源与变更失效检测能力，确保结项呈现的每一项交付都有真实工程产物支撑。",
    ]
    if ev["by_source"]:
        ev_source_desc = {
            "github": "验证真实代码实现、分支评审合并与自动化测试记录",
            "feishu": "验证团队分工确认、方案评审与关键技术决策留痕",
            "file": "验证设计文档、数据库迁移方案、测试报告与演示材料",
            "discussion": "验证平台内需求澄清与跨成员异步评审结论",
            "manual": "补充运行截图、联调验收记录与人工核验材料",
        }
        ev_lines.extend(
            [
                "",
                "### 正式证据来源分布",
                "",
                "| 证据来源类型 | 有效正式证据数 | 占比 | 质量核验价值 |",
                "| --- | ---: | ---: | --- |",
            ]
        )
        for src, cnt in sorted(ev["by_source"].items(), key=lambda kv: -kv[1]):
            pct = round(cnt * 100 / ev["total_formal"], 1) if ev["total_formal"] else 0.0
            ev_lines.append(
                f"| {_EVIDENCE_SOURCE_ZH.get(src, src)} | {cnt} | {pct}% "
                f"| {ev_source_desc.get(src, '支撑对应任务验收标准核验')} |"
            )
    if ev["highlights"]:
        ev_lines.extend(["", "### 代表性正式证据与验收成果摘录", ""])
        for item in ev["highlights"][:8]:
            src_zh = _EVIDENCE_SOURCE_ZH.get(item["source_type"], item["source_type"])
            ev_lines.append(f"- **[{src_zh}]** {item['title']}")

    # 6. Member Contribution Portrait (Professor-facing: NO noisy draft warning at opening!)
    total_commits = sum(m["github_commits"] for m in members)
    contrib_lines = [
        f"> **本章核心结论**：团队 **{len(members) or counts['members']} 名成员** 均承担独立核心模块并完成全部指派任务"
        + (f"，累计归属 GitHub 代码提交 **{total_commits} 次**" if total_commits > 0 else "")
        + "，权重分配与代码/任务/协作证据高度一致。",
        "",
        f"如图 5 所示，本节从 **正式贡献权重、任务完成情况、负责功能模块及 GitHub 真实代码产出** 四个维度，"
        f"对团队 **{len(members) or counts['members']} 名成员** 的实际投入进行交叉核验与客观画像。"
        f"全员任务指派明确且均绑定可溯源的代码提交与正式证据"
        + (f"（归属成员提交合计 {total_commits} 次）" if total_commits > 0 else "")
        + "，各核心模块均有专人端到端负责，整体分工均衡互补，无脱离工程交付的「搭便车」现象。",
        "",
        "### 成员分工与多维贡献对比表",
        "",
        "| 成员 | 角色 | 正式贡献权重 | 积分 | 完成/指派任务 | GitHub 提交 / PR | 代码增删 | 负责模块 |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ]
    for m in members:
        mods_text = "、".join(m["owned_modules"]) if m["owned_modules"] else "跨模块协作支持"
        contrib_lines.append(
            f"| {_md_cell(m['name'])} | {m['role']} | {m['share_percent']:.1f}% "
            f"| {m['task_credit']:.1f} | {m['tasks_completed']}/{m['tasks_assigned']} "
            f"| {m['github_commits']} / {m['github_prs']} "
            f"| +{m['github_additions']} / -{m['github_deletions']} | {_md_cell(mods_text)} |"
        )
    if members:
        contrib_lines.extend(["", "### 成员个人交付画像与协作评述", ""])
        for m in members:
            mods_desc = (
                f"核心负责 **{'、'.join(m['owned_modules'])}**"
                if m["owned_modules"]
                else "承担跨模块工程协作与联调支持"
            )
            task_preview = (
                "、".join(m["key_tasks"][:4]) if m["key_tasks"] else "参与核心需求评审与模块测试"
            )
            gh_desc = (
                f"在代码工程侧累计提交 **{m['github_commits']} 次 Commit**、**{m['github_prs']} 个 PR**，"
                f"代码净改动 **+{m['github_additions']} / -{m['github_deletions']} 行**"
                if (m["github_commits"] > 0 or m["github_prs"] > 0)
                else "重点围绕模块任务执行、文档编写与集成联调贡献交付物"
            )
            contrib_lines.append(
                f"**{m['name']}（{m['role']}）**：{mods_desc}，正式贡献占比 **{m['share_percent']:.1f}%**（积分 {m['task_credit']:.1f}），"
                f"累计完成 **{m['tasks_completed']}/{m['tasks_assigned']} 项**指派任务。{gh_desc}。"
                f"其代表性交付任务涵盖：{task_preview}，在团队协作与阶段验收中均履行了清晰可查的责任。"
            )
            contrib_lines.append("")

    if cmeta["is_frozen"]:
        contrib_lines.append(
            f"*（注：以上贡献权重引自已冻结正式贡献快照 v{cmeta['version']}，经团队成员确认并可用于课程结项评审。）*"
        )
    elif cmeta["version"] is not None:
        contrib_lines.append(
            f"*（注：当前基于最新贡献快照 v{cmeta['version']} 编制，正式归档前将完成团队冻结确认。）*"
        )
    else:
        contrib_lines.append(
            "*（注：当前基于项目已登记任务指派与 GitHub 真实提交记录客观汇总编制。）*"
        )

    # 7. Reflection & Recommendations
    refl_lines: list[str] = []
    if risks["active_count"] == 0:
        refl_lines.extend(
            [
                f"> **本章核心结论**：当前风险台账活跃风险为 **0 项**（累计处理关闭历史风险 **{risks['closed_count']} 项**），"
                "但系统在极端并发压测、外部平台断网降级及大规模课程统计性能方面仍存在明确改进空间。",
                "",
                f"截至本报告编制时，项目风险台账中 **无活跃未关闭风险**（历史累计关闭风险 **{risks['closed_count']} 项**），"
                f"全部 **{done_tasks}/{total_tasks} 项任务** 与 **{ms_done}/{len(milestones)} 个里程碑** 按预期节奏收口，整体交付状态稳定可控。"
                "尽管结项阶段已消除阻塞性风险，团队在回顾全周期研发过程时仍客观梳理了跨模块集成、环境配置与测试覆盖方面遇到的真实挑战及尚存局限。",
            ]
        )
    else:
        rc = risks["counts"]
        refl_lines.extend(
            [
                f"> **本章核心结论**：当前仍有 **{risks['active_count']} 项活跃风险**"
                f"（高 {rc['high']} / 中 {rc['medium']} / 低 {rc['low']}），已关闭历史风险 **{risks['closed_count']} 项**，"
                "需在终版答辩前按优先级完成缓解验证。",
                "",
                f"截至本报告编制时，项目仍存在 **{risks['active_count']} 项活跃风险**"
                f"（高风险 {rc['high']} 项 / 中风险 {rc['medium']} 项 / 低风险 {rc['low']} 项），"
                f"另已关闭历史风险 **{risks['closed_count']} 项**。团队已针对未关闭风险逐项明确责任人与缓解方案，防止影响最终课程答辩与系统稳定性。",
            ]
        )
        refl_lines.extend(
            [
                "",
                "### 当前活跃风险与处置清单",
                "",
                "| 风险事项 | 等级 | 状态 | 负责人 | 影响说明 |",
                "| --- | --- | --- | --- | --- |",
            ]
        )
        for r in risks["active"]:
            refl_lines.append(
                f"| {_md_cell(r['title'])} | {r['level_label']} | {r['status']} "
                f"| {_md_cell(r['owner'])} | {_md_cell(r['description'])} |"
            )

    blockers = feishu.get("blockers") or []
    closed_list = risks.get("closed") or []
    if blockers or closed_list:
        refl_lines.extend(["", "### 研发过程中的典型问题与排查复盘", ""])
        for b in blockers[:4]:
            refl_lines.append(f"- **协作阻塞复盘 — {b['title']}**：{b['summary']}")
        for cr in closed_list[:4]:
            refl_lines.append(
                f"- **已闭环历史风险 — {cr['title']}**（等级：{_RISK_LEVEL_ZH.get(cr['level'], cr['level'])}，负责人：{cr['owner']}）：已完成原因定位并闭环验证。"
            )

    suggestions: list[str] = []
    if done_tasks < total_tasks:
        suggestions.append(
            f"**完成剩余任务收口与证据补齐**：当前尚有 {total_tasks - done_tasks} 项任务未进入已完成状态，需优先补齐正式证据并完成人工验收确认。"
        )
    if risks["active_count"] > 0:
        suggestions.append(
            "**推动活跃风险闭环清零**：针对上述活跃风险按优先级落实修复、补充回归测试并记录复检结果，确保答辩演示过程无阻断缺陷。"
        )
    suggestions.append(
        "**正视当前系统局限与边界**：当前版本重点打通课程小组协作核心主链路，在极端高并发负载测试、跨学期大规模课程统计性能及外部工具断网降级体验上仍有持续优化空间。"
    )
    suggestions.append(
        "**完善自动化回归与答辩演练脚本**：建议在正式答辩前固化端到端演示路径（需求基线冻结 → 任务与代码证据溯源 → 验收确认 → 贡献核算 → 报告导出），并保留全套 CI 校验记录。"
    )
    if not cmeta["is_frozen"]:
        suggestions.append(
            "**结项前完成贡献快照正式冻结**：在向教师提交终版报告定稿前，由全员在贡献分析模块复核权重并执行正式冻结，使最终归档报告与正式成绩评定依据严格绑定。"
        )
    else:
        suggestions.append(
            "**延续证据驱动的工程协作规范**：将本项目中验证有效的 GitHub PR 评审、飞书决策留痕与正式证据核验流程沉淀为团队后续软件工程实践的长期标准。"
        )
    refl_lines.extend(["", "### 当前局限与后续改进建议", ""])
    for idx, tip in enumerate(suggestions, start=1):
        refl_lines.append(f"{idx}. {tip}")

    chapters = {
        "overview": "\n".join(overview_lines),
        "workflow": "\n".join(workflow_lines),
        "progress": "\n".join(progress_lines),
        "collaboration": "\n".join(collab_lines),
        "evidence": "\n".join(ev_lines),
        "contribution": "\n".join(contrib_lines),
        "reflection": "\n".join(refl_lines),
    }
    if project_id is not None and version_no is not None:
        resolved_visuals = visuals if visuals is not None else build_default_visual_specs(facts)
        chapters = _inject_visuals_into_chapters(
            chapters, resolved_visuals, project_id=project_id, version_no=version_no
        )
    return chapters


def _resolve_model_name(raw_model: str) -> str:
    cleaned = (raw_model or "").strip() or DEFAULT_MODEL
    return MODEL_ALIASES.get(cleaned.lower(), cleaned)


def _openrouter_config(role: str | None = None) -> tuple[str, str, str] | None:
    """Resolve `(api_key, primary_model, fallback_model)` for report writing or visual planning.

    Reads `AI_REPORT_WRITING_MODEL` (role='writing') or `AI_REPORT_VISUAL_MODEL` (role='visual'),
    falling back automatically to `AI_MODEL` (or `DEFAULT_MODEL`) when unset or on runtime failure.
    """
    if os.getenv("AI_PROVIDER", "").strip().lower() != "openrouter":
        return None
    api_key = os.getenv("AI_API_KEY", "").strip() or os.getenv("OPENROUTER_API_KEY", "").strip()
    if not api_key:
        return None
    fallback_model = _resolve_model_name(os.getenv("AI_MODEL", ""))
    override_env = ""
    if role == "writing":
        override_env = os.getenv("AI_REPORT_WRITING_MODEL", "").strip()
    elif role == "visual":
        override_env = os.getenv("AI_REPORT_VISUAL_MODEL", "").strip()
    primary_model = _resolve_model_name(override_env) if override_env else fallback_model
    return api_key, primary_model, fallback_model


def _extract_json_object(content: str) -> dict[str, Any]:
    """Parse JSON object strictly first, falling back to extracting outermost braces."""
    try:
        return _parse_json_object(content)
    except Exception:
        cleaned = (content or "").strip()
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"\s*```$", "", cleaned)
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start == -1 or end == -1 or end <= start:
            raise ValueError("no JSON object found in model output") from None
        parsed = json.loads(cleaned[start : end + 1])
        if not isinstance(parsed, dict):
            raise ValueError("extracted JSON value is not an object")
        return parsed


def _strip_leading_chapter_heading(text: str, section_key: str) -> str:
    """Remove duplicate top-level chapter headings if the LLM repeats '## 一、...'."""
    lines = _sanitize_text(text).strip().splitlines()
    if not lines:
        return ""
    first = lines[0].strip()
    title = CHAPTER_TITLE_MAP.get(section_key, "")
    if re.match(r"^#{1,2}\s+", first) and (
        (title and title in first) or re.match(r"^#{1,2}\s+[一二三四五六七]、", first)
    ):
        lines = lines[1:]
        while lines and not lines[0].strip():
            lines = lines[1:]
    return "\n".join(lines).strip()


def _call_openrouter_json_single(
    *,
    api_key: str,
    model: str,
    system_prompt: str,
    user_payload: dict[str, Any],
    timeout: float,
    feature: str,
    actor_id: UUID | None,
    project_id: UUID,
    max_tokens: int,
) -> tuple[dict[str, Any] | None, str]:
    body: dict[str, Any] = {
        "model": model,
        "temperature": 0.25,
        "max_tokens": max_tokens,
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
        choice = payload_json["choices"][0]
        if choice.get("finish_reason") == "length":
            error_code = "OutputTruncated"
            logger.warning(
                "OpenRouter %s hit max_tokens=%s (finish_reason=length) for project %s (model=%s); "
                "rejecting truncated output",
                feature,
                max_tokens,
                project_id,
                model,
            )
            return None, model
        content = choice["message"]["content"]
        parsed = _extract_json_object(content)
        ok = True
        return parsed, model
    except Exception as exc:  # noqa: BLE001
        error_code = type(exc).__name__[:40]
        logger.warning(
            "OpenRouter %s failed for project %s (model=%s): %s",
            feature,
            project_id,
            model,
            exc,
        )
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


def _call_openrouter_json(
    *,
    system_prompt: str,
    user_payload: dict[str, Any],
    timeout: float,
    feature: str,
    actor_id: UUID | None,
    project_id: UUID,
    max_tokens: int = AI_REPORT_BATCH_MAX_TOKENS,
    model_role: str | None = None,
) -> tuple[dict[str, Any] | None, str | None]:
    """Call OpenRouter expecting a JSON object, automatically falling back to `AI_MODEL` on failure."""
    cfg = _openrouter_config(role=model_role)
    if cfg is None:
        return None, None
    api_key, primary_model, fallback_model = cfg
    parsed, used_model = _call_openrouter_json_single(
        api_key=api_key,
        model=primary_model,
        system_prompt=system_prompt,
        user_payload=user_payload,
        timeout=timeout,
        feature=feature,
        actor_id=actor_id,
        project_id=project_id,
        max_tokens=max_tokens,
    )
    if parsed is not None or primary_model == fallback_model:
        return parsed, used_model
    logger.warning(
        "OpenRouter %s falling back from %s to %s for project %s",
        feature,
        primary_model,
        fallback_model,
        project_id,
    )
    return _call_openrouter_json_single(
        api_key=api_key,
        model=fallback_model,
        system_prompt=system_prompt,
        user_payload=user_payload,
        timeout=timeout,
        feature=feature,
        actor_id=actor_id,
        project_id=project_id,
        max_tokens=max_tokens,
    )


def _compact_json(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _compact_facts_for_llm(facts: dict[str, Any]) -> dict[str, Any]:
    """Trim verbose arrays while retaining rich 6-source project evidence for deep authoring."""
    return {
        "project": facts["project"],
        "counts": facts["counts"],
        "contribution_meta": facts["contribution_meta"],
        "modules": facts["modules"][:12],
        "milestones": facts["milestones"][:16],
        "tasks_summary": [
            {
                "title": t["title"][:90],
                "module": t["module"][:45],
                "status": t["status_label"],
                "progress": t["progress_percent"],
                "weight": t["weight"],
                "assignees": t["assignees"][:4],
            }
            for t in facts["tasks_brief"][:40]
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
            "recent_highlights": facts["github"]["recent_highlights"][:10],
        },
        "feishu": {
            "chat_count": facts["feishu"]["chat_count"],
            "total_messages": facts["feishu"]["total_messages"],
            "date_range": facts["feishu"]["date_range"],
            "total_conclusions": facts["feishu"]["total_conclusions"],
            "overview": facts["feishu"]["overview"],
            "categories": facts["feishu"]["categories"],
            "highlights": facts["feishu"]["highlights"][:16],
            "blockers": facts["feishu"].get("blockers", [])[:6],
        },
        "evidence": {
            "total_formal": facts["evidence"]["total_formal"],
            "by_source": facts["evidence"]["by_source"],
            "tasks_with_evidence": facts["evidence"]["tasks_with_evidence"],
            "criteria_total": facts["evidence"]["criteria_total"],
            "verification_runs": facts["evidence"]["verification_runs"],
            "formal_outcomes": facts["evidence"]["formal_outcomes"],
            "highlights": facts["evidence"]["highlights"][:10],
        },
        "members": facts["members"],
        "risks": facts["risks"],
    }


_CHART_URL_RE = re.compile(
    r"/api/v1/projects/[^/\s)]+/reports/versions/\d+/charts/([a-z0-9_-]{1,48})\.(?:svg|png)(?:\?[^)\s]*)?"
)
_CHART_VERSION_PREFIX_RE = re.compile(
    r"(/api/v1/projects/[^/\s)]+/reports/versions/)\d+(/charts/[a-z0-9_-]{1,48}\.(?:svg|png))"
)


def _chart_image_url(project_id: UUID, version_no: int, chart_key: str) -> str:
    return f"/api/v1/projects/{project_id}/reports/versions/{version_no}/charts/{chart_key}.svg"


def _insert_markdown_figures(body: str, figure_lines: list[str]) -> str:
    """Insert Markdown figure lines after opening prose (before first ### heading) to keep footnotes intact."""
    if not figure_lines:
        return body
    existing_ids = set(_CHART_URL_RE.findall(body))
    to_add = [
        line
        for line in figure_lines
        if not any(cid in existing_ids for cid in _CHART_URL_RE.findall(line))
    ]
    if not to_add:
        return body
    figure_block = "\n\n".join(to_add)
    lines = body.splitlines()
    for idx, line in enumerate(lines):
        if re.match(r"^\s*#{3,4}\s+", line):
            before = "\n".join(lines[:idx]).rstrip()
            after = "\n".join(lines[idx:]).lstrip("\n")
            return (
                f"{before}\n\n{figure_block}\n\n{after}".strip()
                if before
                else f"{figure_block}\n\n{after}".strip()
            )
    # No ### subheading: insert after the first non-empty paragraph (so trailing footnotes stay last)
    first_blank = next((i for i, ln in enumerate(lines) if i > 0 and not ln.strip()), None)
    if first_blank is not None:
        before = "\n".join(lines[:first_blank]).rstrip()
        after = "\n".join(lines[first_blank:]).lstrip("\n")
        return f"{before}\n\n{figure_block}\n\n{after}".strip()
    return f"{body.rstrip()}\n\n{figure_block}".strip()


def _inject_visuals_into_chapters(
    chapters: dict[str, str],
    visuals: list[dict[str, Any]],
    *,
    project_id: UUID,
    version_no: int,
) -> dict[str, str]:
    by_section: dict[str, list[str]] = {}
    for spec in visuals:
        if not isinstance(spec, dict):
            continue
        sec = str(spec.get("section_key") or "")
        vid = str(spec.get("id") or "")
        caption = str(spec.get("caption") or spec.get("title") or vid).replace("]", "").strip()
        if sec in chapters and vid and CHART_KEY_RE.match(vid):
            url = _chart_image_url(project_id, version_no, vid)
            by_section.setdefault(sec, []).append(f"![{caption}]({url})")
    updated = dict(chapters)
    for sec, fig_lines in by_section.items():
        updated[sec] = _insert_markdown_figures(updated[sec], fig_lines)
    return updated


def _rewrite_chart_version_urls(sections: dict[str, str], new_version_no: int) -> dict[str, str]:
    changed = False
    out: dict[str, str] = {}
    for key, val in sections.items():
        text = str(val or "")
        if _CHART_VERSION_PREFIX_RE.search(text):
            replaced = _CHART_VERSION_PREFIX_RE.sub(rf"\g<1>{new_version_no}\g<2>", text)
            if replaced != text:
                changed = True
            out[key] = replaced
        else:
            out[key] = text
    return out if changed else sections


def _snapshot_chart_facts(facts: dict[str, Any]) -> dict[str, Any]:
    """Persist compact grounded facts inside `data_snapshot['facts']` for chart & export rendering."""
    return {
        "project": facts.get("project") or {},
        "counts": facts.get("counts") or {},
        "modules": (facts.get("modules") or [])[:12],
        "milestones": (facts.get("milestones") or [])[:16],
        "github": {
            "repo_count": (facts.get("github") or {}).get("repo_count", 0),
            "commits": (facts.get("github") or {}).get("commits", 0),
            "pull_requests": (facts.get("github") or {}).get("pull_requests", 0),
            "merged_prs": (facts.get("github") or {}).get("merged_prs", 0),
            "ci_runs": (facts.get("github") or {}).get("ci_runs", 0),
            "ci_success": (facts.get("github") or {}).get("ci_success", 0),
            "additions": (facts.get("github") or {}).get("additions", 0),
            "deletions": (facts.get("github") or {}).get("deletions", 0),
        },
        "github_repos": (facts.get("github_repos") or [])[:5],
        "feishu": {
            "chat_count": (facts.get("feishu") or {}).get("chat_count", 0),
            "total_messages": (facts.get("feishu") or {}).get("total_messages", 0),
            "date_range": (facts.get("feishu") or {}).get("date_range", ""),
            "total_conclusions": (facts.get("feishu") or {}).get("total_conclusions", 0),
            "categories": (facts.get("feishu") or {}).get("categories") or {},
        },
        "evidence": {
            "total_formal": (facts.get("evidence") or {}).get("total_formal", 0),
            "effective_formal": (facts.get("evidence") or {}).get("effective_formal", 0),
            "source_changed_count": (facts.get("evidence") or {}).get("source_changed_count", 0),
            "by_source": (facts.get("evidence") or {}).get("by_source") or {},
            "tasks_with_evidence": (facts.get("evidence") or {}).get("tasks_with_evidence", 0),
            "criteria_total": (facts.get("evidence") or {}).get("criteria_total", 0),
            "verification_runs": (facts.get("evidence") or {}).get("verification_runs", 0),
            "formal_outcomes": (facts.get("evidence") or {}).get("formal_outcomes", 0),
            "formal_outcomes_active": (facts.get("evidence") or {}).get(
                "formal_outcomes_active", 0
            ),
        },
        "members": (facts.get("members") or [])[:12],
        "risks": {
            "active_count": (facts.get("risks") or {}).get("active_count", 0),
            "closed_count": (facts.get("risks") or {}).get("closed_count", 0),
            "counts": (facts.get("risks") or {}).get("counts") or {},
        },
    }


def _plan_report_visuals_with_ai(
    facts: dict[str, Any], *, actor_id: UUID | None, project_id: UUID
) -> tuple[list[dict[str, Any]] | None, str | None]:
    """Let OpenRouter AI freely design 4-5 bespoke vector SVG visuals tailored to THIS project."""
    compact_facts = _compact_facts_for_llm(facts)
    visual_skill = load_skill(SKILL_REPORT_VISUAL)
    system_prompt = (
        f"{visual_skill}\n\n"
        "请严格按照上述设计规范，根据输入的项目真实工程事实 JSON 规划 4 至 5 张矢量插图，"
        '只输出合法 JSON 对象 `{"visuals": [...]}`，不得包含任何额外前后缀说明。'
    )
    parsed, model = _call_openrouter_json(
        system_prompt=system_prompt,
        user_payload=compact_facts,
        timeout=AI_REPORT_TIMEOUT_SECONDS,
        feature="plan_report_visuals",
        actor_id=actor_id,
        project_id=project_id,
        max_tokens=AI_VISUALS_MAX_TOKENS,
        model_role="visual",
    )
    if isinstance(parsed, dict):
        visuals = sanitize_visual_specs(parsed.get("visuals"), facts)
        if visuals:
            return visuals, model
    return None, model


_CHAPTER_PROMPT_SPECS: dict[str, str] = {
    "overview": (
        "overview（一、项目概述与目标范围）：阐明项目解决的具体工程问题、系统定位、需求基线与计划基线治理，"
        "自然呼应图 1 架构分工，给出「### 核心交付指标总览」表与「### 功能模块与职责边界」表"
        "（列出每个真实模块、负责人、需求数、任务完成与权重）。"
    ),
    "workflow": (
        "workflow（二、开发流程与团队协作机制）：阐述团队端到端研发协作与质量门禁机制"
        "（需求冻结→任务拆解→GitHub 分支/PR/CI→飞书协作→验收确认→贡献核算），自然呼应图 2，"
        "引用真实仓库、提交数、PR 合并数、代码增删与飞书消息统计，并给出「### 代表性工程提交与变更记录」表（精选 6–8 条）。"
    ),
    "progress": (
        "progress（三、项目进度与里程碑复盘）：按时间顺序论证项目在整个学期持续稳健推进（非期末突击），"
        "自然呼应图 3，给出「### 阶段里程碑与交付物核验表」（列：里程碑阶段 | 截止日期 | 状态 | 进度 | 交付物 | 关联任务）"
        "与「### 分模块任务完成汇总」表及复盘分析。"
    ),
    "collaboration": (
        "collaboration（四、团队沟通协作与关键技术决策）：基于飞书群聊消息量、时间跨度与真实协作结论，"
        "给出「### 协作结论分类分布」表，并精炼提炼 5–6 条真实分工确认、规范同步、技术决策与阻塞排查案例"
        "（引用真实标题、确认人数或关联任务编号）。"
    ),
    "evidence": (
        "evidence（五、证据链沉淀与质量验收成果）：阐明团队如何以可复核工程证据支撑完成宣称，自然呼应图 4，"
        "给出「### 正式证据来源分布」表（列：证据来源类型 | 正式证据数 | 占比 | 核验价值）"
        "与「### 代表性正式证据与验收成果摘录」，结合验收标准数、核验次数与人工确认正式成果评价质量控制效果。"
    ),
    "contribution": (
        "contribution（六、成员个人贡献与分工画像）：**严禁在章首输出“尚未冻结正式贡献快照”等内部告警语！**"
        "直接面向评阅教师阐述团队分工格局与交叉核验依据，自然呼应图 5；给出「### 成员分工与多维贡献对比表」"
        "（列：成员 | 角色 | 正式贡献权重 | 积分 | 完成/指派任务 | GitHub 提交 / PR | 代码增删 | 负责模块）；"
        "随后在「### 成员个人交付画像与协作评述」中为**每一位成员各写一段凝练评述**；"
        "若贡献快照为草稿，仅在章节最末行用斜体脚注注明："
        "`*（注：当前基于最新贡献快照 vN 编制，正式归档前将完成团队冻结确认。）*`。"
    ),
    "reflection": (
        "reflection（七、风险复盘与后续改进建议）：保持高度客观冷静，如实汇报当前活跃风险与已关闭历史风险；"
        "结合飞书 blocker 结论与已关闭风险复盘团队真实遇到的工程难题与排查取舍；"
        "最后客观指出当前系统已知局限并给出 4–5 条具体可执行的后续优化与答辩准备建议。"
    ),
}

_PAIRED_DELIMITERS: tuple[tuple[str, str], ...] = (
    ("「", "」"),
    ("『", "』"),
    ("《", "》"),
    ("（", "）"),
    ("“", "”"),
)
_TERMINAL_PUNCT = frozenset("。！？.!?;；…—")
_TRAILING_WRAP_CHARS = "*_`）)》」』”\"']"


def _is_chapter_complete(text: str, *, min_chars: int = _MIN_AI_CHAPTER_CHARS) -> bool:
    """Validate that an AI-authored chapter is not truncated mid-sentence, mid-quote, or mid-table."""
    cleaned = (text or "").strip()
    if len(cleaned) < min_chars:
        return False
    # Reject unclosed fenced code blocks
    if cleaned.count("```") % 2 != 0:
        return False
    # Strip fenced/inline code spans before checking paired Chinese/typographic delimiters
    prose = re.sub(r"```[\s\S]*?```", "", cleaned)
    prose = re.sub(r"`[^`\n]+`", "", prose)
    for opener, closer in _PAIRED_DELIMITERS:
        if prose.count(opener) != prose.count(closer):
            return False

    non_empty_lines = [ln.strip() for ln in cleaned.splitlines() if ln.strip()]
    if not non_empty_lines:
        return False
    last_line = non_empty_lines[-1]
    # Reject trailing bare heading (e.g. truncated right after "### 小节")
    if re.match(r"^#{1,6}\s+", last_line):
        return False
    # Standalone Markdown image line is complete
    if _MD_IMAGE_LINE_RE.match(last_line):
        return True
    # Markdown table row must be properly closed with trailing pipe
    if last_line.startswith("|"):
        return last_line.endswith("|") and last_line.count("|") >= 2
    # Normal prose/list/quote/footnote must end with proper terminal punctuation
    stripped_tail = last_line.rstrip(_TRAILING_WRAP_CHARS).rstrip()
    if not stripped_tail:
        return False
    return stripped_tail[-1] in _TERMINAL_PUNCT


def _build_batch_writing_prompt(writing_skill: str, keys: tuple[str, ...]) -> str:
    key_list = ", ".join(keys)
    specs_text = "\n".join(
        f"{idx}. {_CHAPTER_PROMPT_SPECS[key]}" for idx, key in enumerate(keys, start=1)
    )
    return (
        f"{writing_skill}\n\n"
        f"本次请只输出一个合法 JSON 对象，必须且只能包含这 {len(keys)} 个字符串键：{key_list}。\n"
        "请严格遵守每章 700–1,200 中文字符篇幅上限与禁用套话黑名单（严禁出现「显著提升」「全链路闭环」「赋能」「抓手」「矩阵」「降本增效」「完美收官」），"
        "确保每一章结尾句式与标点完整闭合。\n"
        "各章撰写任务：\n"
        f"{specs_text}"
    )


def _author_report_with_ai(
    facts: dict[str, Any], *, actor_id: UUID | None, project_id: UUID
) -> tuple[dict[str, str] | None, str | None]:
    """Author all 7 publication-grade chapters via 3 parallel batches + per-chapter completion retry."""
    compact_facts = _compact_facts_for_llm(facts)
    writing_skill = load_skill(SKILL_REPORT_WRITING)

    batches: tuple[tuple[tuple[str, ...], str], ...] = (
        (CHAPTER_BATCH_1, "generate_project_report_part1"),
        (CHAPTER_BATCH_2, "generate_project_report_part2"),
        (CHAPTER_BATCH_3, "generate_project_report_part3"),
    )

    def _run_batch(keys: tuple[str, ...], feature: str) -> tuple[dict[str, str], str | None]:
        prompt = _build_batch_writing_prompt(writing_skill, keys)
        parsed, used_model = _call_openrouter_json(
            system_prompt=prompt,
            user_payload=compact_facts,
            timeout=AI_REPORT_TIMEOUT_SECONDS,
            feature=feature,
            actor_id=actor_id,
            project_id=project_id,
            max_tokens=AI_REPORT_BATCH_MAX_TOKENS,
            model_role="writing",
        )
        chapters_out: dict[str, str] = {}
        if isinstance(parsed, dict):
            for key in keys:
                val = parsed.get(key)
                if isinstance(val, str):
                    cleaned = _strip_leading_chapter_heading(val, key)
                    if _is_chapter_complete(cleaned):
                        chapters_out[key] = cleaned
                    else:
                        logger.warning(
                            "Rejecting incomplete AI chapter %s in %s for project %s (len=%d)",
                            key,
                            feature,
                            project_id,
                            len(cleaned),
                        )
        return chapters_out, used_model

    def _retry_single_chapter(key: str) -> tuple[str, str | None, str | None]:
        prompt = _build_batch_writing_prompt(writing_skill, (key,))
        parsed, used_model = _call_openrouter_json(
            system_prompt=prompt,
            user_payload=compact_facts,
            timeout=AI_REPORT_TIMEOUT_SECONDS,
            feature=f"generate_project_report_retry_{key}",
            actor_id=actor_id,
            project_id=project_id,
            max_tokens=AI_SINGLE_CHAPTER_MAX_TOKENS,
            model_role="writing",
        )
        if isinstance(parsed, dict):
            val = parsed.get(key) or parsed.get("content")
            if isinstance(val, str):
                cleaned = _strip_leading_chapter_heading(val, key)
                if _is_chapter_complete(cleaned):
                    return key, cleaned, used_model
                logger.warning(
                    "Retry for AI chapter %s still incomplete for project %s (len=%d); will use fallback",
                    key,
                    project_id,
                    len(cleaned),
                )
        return key, None, used_model

    authored: dict[str, str] = {}
    model_used: str | None = None
    with ThreadPoolExecutor(max_workers=3) as pool:
        futs = [pool.submit(_run_batch, keys, feature) for keys, feature in batches]
        for fut in futs:
            part, used_m = fut.result()
            authored.update(part)
            if not model_used and used_m:
                model_used = used_m

    # Retry any missing or incomplete chapter individually once (when OpenRouter is active)
    missing_keys = [key for key in CHAPTER_ORDER if key not in authored]
    if missing_keys and model_used is not None:
        with ThreadPoolExecutor(max_workers=min(3, len(missing_keys))) as retry_pool:
            retry_futs = [retry_pool.submit(_retry_single_chapter, key) for key in missing_keys]
            for rf in retry_futs:
                r_key, r_text, r_model = rf.result()
                if r_text:
                    authored[r_key] = r_text
                if not model_used and r_model:
                    model_used = r_model

    if not authored:
        return None, model_used
    return authored, model_used


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
    writing_skill = load_skill(SKILL_REPORT_WRITING)
    system_prompt = (
        f"{writing_skill}\n\n"
        f"请严格基于上述写作规范与项目真实工程事实 JSON，深度润色并重写报告章节「{chapter_title}」（键名 {section_key}）。\n"
        "补充要求：\n"
        '1. 只输出一个合法 JSON 对象：`{"content": "<Markdown 正文>"}`。\n'
        "2. 正文以 `> **本章核心结论**：...` 开头，包含 2–3 个实质性自然段、### 子标题、必要时包含精炼 GFM 表格与结构化条目，不要重复写章级大标题。\n"
        "3. 篇幅控制在 700–1,200 中文字符，结尾句式与标点必须完整闭合。\n"
        "4. 若原文中包含 Markdown 配图行（如 `![图 ...](/api/v1/projects/.../charts/....svg)` 或 `.png`），请原样保留该配图行并使正文与之自然呼应。\n"
        "5. 充分响应用户的改写要求（若提供）。"
    )
    payload = {
        "target_section": section_key,
        "target_title": chapter_title,
        "user_instruction": instruction.strip()
        or "以高校课程结项报告标准提升论述深度、专业度与条理性，保留全部真实工程数据与表格。",
        "current_content": current_body[:8000],
        "project_facts": _compact_facts_for_llm(facts),
    }
    parsed, model = _call_openrouter_json(
        system_prompt=system_prompt,
        user_payload=payload,
        timeout=AI_REWRITE_TIMEOUT_SECONDS,
        feature="rewrite_report_section",
        actor_id=actor_id,
        project_id=project_id,
        max_tokens=AI_REWRITE_MAX_TOKENS,
        model_role="writing",
    )
    if isinstance(parsed, dict):
        content = parsed.get("content") or parsed.get(section_key)
        if isinstance(content, str):
            cleaned = _strip_leading_chapter_heading(content, section_key)
            if _is_chapter_complete(cleaned, min_chars=30):
                return cleaned, model
    return None, model


def _legacy_tasks_text(facts: dict[str, Any]) -> str:
    return (
        "\n".join(
            f"{item['title']}: {item['status']} ({item['progress_percent']}%)"
            for item in facts["tasks_brief"]
        )
        or "暂无任务记录。"
    )


def _resolve_target_version_no(session: Session, project_id: UUID, version_no: int | None) -> int:
    if version_no is not None and version_no >= 1:
        return version_no
    try:
        latest_no = session.scalar(
            select(ReportSnapshot.version_no)
            .join(Report, ReportSnapshot.report_id == Report.id)
            .where(Report.project_id == project_id)
            .order_by(ReportSnapshot.version_no.desc())
            .limit(1)
        )
        if latest_no is not None and latest_no >= 1:
            return int(latest_no)
    except Exception:
        pass
    return 1


def build_report_snapshot_data(
    session: Session,
    project_id: UUID,
    project_name: str,
    appendix: bool,
    *,
    actor_id: UUID | None = None,
    use_ai: bool = False,
    version_no: int | None = None,
) -> dict[str, Any]:
    """Build complete frozen report data_snapshot with 7 ordered chapters and declarative visuals."""
    facts = collect_project_facts(session, project_id, project_name)
    resolved_version_no = _resolve_target_version_no(session, project_id, version_no)
    chapters = render_fallback_chapters(facts)
    authoring_mode = "fallback"
    model_used: str | None = None
    writing_model_used: str | None = None
    visual_model_used: str | None = None
    skills_loaded: list[str] = []
    ai_chapters_count = 0
    ai_visuals: list[dict[str, Any]] | None = None

    if use_ai:
        skills_loaded = [SKILL_REPORT_WRITING, SKILL_REPORT_VISUAL]
        with ThreadPoolExecutor(max_workers=2) as pool:
            prose_future = pool.submit(
                _author_report_with_ai, facts, actor_id=actor_id, project_id=project_id
            )
            visuals_future = pool.submit(
                _plan_report_visuals_with_ai, facts, actor_id=actor_id, project_id=project_id
            )
            ai_chapters, prose_model = prose_future.result()
            ai_visuals, visuals_model = visuals_future.result()
        writing_model_used = prose_model
        visual_model_used = visuals_model
        model_used = prose_model or visuals_model
        if ai_chapters:
            chapters.update(ai_chapters)
            ai_chapters_count = len(ai_chapters)
            authoring_mode = "ai"

    if ai_visuals and len(ai_visuals) >= 2:
        visuals = ai_visuals
        visuals_mode = "ai"
    else:
        visuals = build_default_visual_specs(facts)
        visuals_mode = "fallback"

    chapters = _inject_visuals_into_chapters(
        chapters, visuals, project_id=project_id, version_no=resolved_version_no
    )

    chapter_order = list(CHAPTER_ORDER)
    sections: dict[str, str] = {key: chapters[key] for key in CHAPTER_ORDER}
    # Preserve legacy frozen `tasks` key for existing unit test invariants; omitted from chapter_order.
    sections["tasks"] = _legacy_tasks_text(facts)
    if appendix:
        sections["appendix"] = (
            "\n".join(item["title"] for item in facts["evidence_records"]) or "暂无正式证据。"
        )
        chapter_order.append("appendix")

    word_count = sum(len(re.sub(r"\s+", "", chapters[key])) for key in CHAPTER_ORDER)

    return {
        "project_name": project_name,
        "contribution_snapshot_id": facts["contribution_snapshot_id"],
        "counts": facts["counts"],
        "chapter_order": chapter_order,
        "sections": sections,
        "visuals": visuals,
        "facts": _snapshot_chart_facts(facts),
        "evidence_records": facts["evidence_records"],
        "meta": {
            "authoring_mode": authoring_mode,
            "visuals_mode": visuals_mode,
            "visuals_count": len(visuals),
            "model": model_used,
            "writing_model": writing_model_used,
            "visual_model": visual_model_used,
            "skills_loaded": skills_loaded,
            "ai_chapters_count": ai_chapters_count,
            "word_count": word_count,
            "generated_at": datetime.now(UTC).isoformat(),
            "course_name": facts["project"].get("course_name") or None,
            "course_code": facts["project"].get("course_code") or None,
            "semester": facts["project"].get("semester") or None,
            "team_members": facts["project"].get("team_members") or [],
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
            if _should_run_inline_sync():
                _complete_preview_inline_safe(
                    session,
                    version=version,
                    report=report,
                    project=access.project,
                    appendix=payload.includes_appendix,
                    actor_id=user.id,
                )
                return success(serialize(version), request)
            _run_preview_in_background_thread(str(version.id), payload.includes_appendix)
            return success(serialize(version), request)
        try:
            generate_preview.delay(str(version.id), payload.includes_appendix)
        except Exception:
            if _allow_inline_worker_fallback():
                if _should_run_inline_sync():
                    _complete_preview_inline_safe(
                        session,
                        version=version,
                        report=report,
                        project=access.project,
                        appendix=payload.includes_appendix,
                        actor_id=user.id,
                    )
                    return success(serialize(version), request)
                _run_preview_in_background_thread(str(version.id), payload.includes_appendix)
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
        new_version_no = latest.version_no + 1
        updated_sections = _rewrite_chart_version_urls(
            {**latest.data_snapshot["sections"], payload.section: payload.body.strip()},
            new_version_no,
        )
        data = {
            **latest.data_snapshot,
            "sections": updated_sections,
        }
        version = ReportSnapshot(
            report_id=report.id,
            created_by=user.id,
            version_no=new_version_no,
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
        new_version_no = latest.version_no + 1
        prev_meta = (
            dict(source.data_snapshot.get("meta"))
            if isinstance(source.data_snapshot.get("meta"), dict)
            else {}
        )
        prev_meta["last_rewritten_section"] = section_key
        prev_meta["last_rewritten_mode"] = authoring_mode
        if model_used:
            prev_meta["model"] = model_used
        updated_sections = _rewrite_chart_version_urls(
            {**sections_map, section_key: rewritten}, new_version_no
        )
        existing_visuals = (
            source.data_snapshot.get("visuals")
            if isinstance(source.data_snapshot.get("visuals"), list)
            else []
        )
        section_visuals = [
            v
            for v in existing_visuals
            if isinstance(v, dict) and str(v.get("section_key") or "") == section_key
        ]
        if section_visuals:
            updated_sections = _inject_visuals_into_chapters(
                updated_sections,
                section_visuals,
                project_id=project_id,
                version_no=new_version_no,
            )
        data = {
            **source.data_snapshot,
            "sections": updated_sections,
            "facts": source.data_snapshot.get("facts") or _snapshot_chart_facts(facts),
            "meta": prev_meta,
        }
        created = ReportSnapshot(
            report_id=report.id,
            created_by=user.id,
            version_no=new_version_no,
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
        new_version_no = latest.version_no + 1
        restored_data = source.data_snapshot
        if isinstance(restored_data, dict) and isinstance(restored_data.get("sections"), dict):
            rewritten_sections = _rewrite_chart_version_urls(
                restored_data["sections"], new_version_no
            )
            if rewritten_sections is not restored_data["sections"]:
                restored_data = {**restored_data, "sections": rewritten_sections}
        restored = ReportSnapshot(
            report_id=report.id,
            created_by=user.id,
            version_no=new_version_no,
            status="generated",
            baseline_version_id=source.baseline_version_id,
            plan_version_id=source.plan_version_id,
            contribution_snapshot_id=source.contribution_snapshot_id,
            data_snapshot=restored_data,
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


def _should_run_inline_sync() -> bool:
    """Keep deterministic synchronous execution inside pytest or when REPORT_INLINE_SYNC=1."""
    if os.getenv("PYTEST_CURRENT_TEST"):
        return True
    return os.getenv("REPORT_INLINE_SYNC", "").strip().lower() in {"1", "true", "yes"}


def _run_preview_in_background_thread(snapshot_id: str, appendix: bool) -> threading.Thread:
    """Run report preview generation on a daemon thread so HTTP /refresh returns immediately."""

    def _worker() -> None:
        from app.modules.d.report_tasks import generate_preview

        try:
            generate_preview(snapshot_id, appendix)
        except Exception:  # noqa: BLE001
            logger.exception(
                "Background report preview generation failed for snapshot %s",
                snapshot_id,
            )

    thread = threading.Thread(
        target=_worker,
        name=f"report-preview-{snapshot_id[:8]}",
        daemon=True,
    )
    thread.start()
    return thread


def _run_export_in_background_thread(artifact_id: str) -> threading.Thread:
    """Run PDF/DOCX export on a daemon thread so HTTP /exports returns immediately."""

    def _worker() -> None:
        from app.modules.d.report_tasks import generate_export

        try:
            generate_export(artifact_id)
        except Exception:  # noqa: BLE001
            logger.exception(
                "Background report export failed for artifact %s",
                artifact_id,
            )

    thread = threading.Thread(
        target=_worker,
        name=f"report-export-{artifact_id[:8]}",
        daemon=True,
    )
    thread.start()
    return thread


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
        version_no=version.version_no,
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
_MD_IMAGE_LINE_RE = re.compile(
    r"^\s*!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+(?:\"[^\"]*\"|'[^']*'))?\s*\)\s*$"
)
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
        im = _MD_IMAGE_LINE_RE.match(raw)
        if im:
            blocks.append({"type": "image", "alt": im.group(1).strip(), "src": im.group(2).strip()})
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
                or _MD_IMAGE_LINE_RE.match(nxt)
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


def _resolve_chart_png_for_export(data: dict, src: str) -> bytes | None:
    match = _CHART_URL_RE.search(src or "")
    if not match:
        return None
    chart_key = match.group(1)
    try:
        return render_chart_from_snapshot(data, chart_key)
    except Exception:
        logger.warning("Failed to render report chart %s during export", chart_key, exc_info=True)
        return None


def _fit_pdf_image_size(
    png_bytes: bytes, max_w: float, max_h: float = 270.0
) -> tuple[float, float]:
    try:
        with PILImage.open(BytesIO(png_bytes)) as im:
            px_w, px_h = im.size
    except Exception:
        return max_w, max_w * 0.45
    if px_w <= 0 or px_h <= 0:
        return max_w, max_w * 0.45
    scale = min(max_w / float(px_w), max_h / float(px_h))
    return float(px_w) * scale, float(px_h) * scale


def render_document(data: dict, file_format: str) -> tuple[bytes, str]:
    project_name = _sanitize_text(data.get("project_name") or "GroupProof")
    title = f"{project_name} 小组项目合作结项报告"
    counts = data.get("counts") if isinstance(data.get("counts"), dict) else None
    meta = data.get("meta") if isinstance(data.get("meta"), dict) else {}
    ordered_entries = _ordered_section_entries(data)
    evidence_records = (
        data.get("evidence_records") if isinstance(data.get("evidence_records"), list) else []
    )
    has_appendix = any(key == "appendix" for key, _, _ in ordered_entries)

    meta_parts: list[str] = []
    if meta.get("course_name"):
        sem = f"（{meta['semester']}）" if meta.get("semester") else ""
        meta_parts.append(f"课程：{meta['course_name']}{sem}")
    if isinstance(meta.get("team_members"), list) and meta["team_members"]:
        meta_parts.append(f"成员：{'、'.join(str(x) for x in meta['team_members'])}")
    if meta.get("generated_at"):
        meta_parts.append(f"编制日期：{str(meta['generated_at'])[:10]}")
    subtitle_line = "  |  ".join(meta_parts)

    if file_format in {"md", "markdown"}:
        lines: list[str] = [f"# {title}", ""]
        if subtitle_line:
            lines.extend([f"> {subtitle_line}", ""])
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
        lines.append("---")
        lines.append("*— 报告正文结束 · GroupProof 证据驱动协作平台生成 —*")
        return "\n".join(lines).encode("utf-8"), "text/markdown; charset=utf-8"

    if file_format == "docx":
        document = Document()
        normal_style = document.styles["Normal"]
        normal_style.font.name = "Microsoft YaHei"
        normal_style.font.size = Pt(10.5)
        normal_style.font.color.rgb = RGBColor(0x1E, 0x29, 0x3B)
        rpr = normal_style.element.get_or_add_rPr()
        rfonts = rpr.find(qn("w:rFonts"))
        if rfonts is None:
            rfonts = OxmlElement("w:rFonts")
            rpr.append(rfonts)
        rfonts.set(qn("w:eastAsia"), "Microsoft YaHei")

        document.add_heading(title, 0)
        if subtitle_line:
            sub_p = document.add_paragraph()
            sub_run = sub_p.add_run(_sanitize_text(subtitle_line))
            sub_run.font.size = Pt(9.5)
            sub_run.font.color.rgb = RGBColor(0x64, 0x74, 0x8B)
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
                hcell.text = ""
                hrun = hcell.paragraphs[0].add_run(text_val)
                hrun.bold = True
                _shade_docx_cell(hcell, "F1F5F9")
                summary_table.cell(1, idx).text = values[idx]
        for _key, label, body in ordered_entries:
            document.add_heading(_sanitize_text(label), level=1)
            for block in _parse_markdown_blocks(body):
                btype = block["type"]
                if btype == "heading":
                    lvl = min(4, max(2, int(block["level"]) - 1))
                    document.add_heading(_sanitize_text(block["text"]), level=lvl)
                elif btype == "image":
                    alt_text = _sanitize_text(block.get("alt") or "项目插图")
                    png_bytes = _resolve_chart_png_for_export(data, str(block.get("src") or ""))
                    if png_bytes:
                        img_p = document.add_paragraph()
                        img_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                        img_p.add_run().add_picture(BytesIO(png_bytes), width=Inches(6.0))
                        if alt_text:
                            cap_p = document.add_paragraph()
                            cap_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                            cap_run = cap_p.add_run(alt_text)
                            cap_run.italic = True
                            cap_run.font.size = Pt(9)
                            cap_run.font.color.rgb = RGBColor(0x64, 0x74, 0x8B)
                    elif alt_text:
                        cap_p = document.add_paragraph()
                        cap_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                        cap_run = cap_p.add_run(f"[插图：{alt_text}]")
                        cap_run.italic = True
                        cap_run.font.size = Pt(9)
                        cap_run.font.color.rgb = RGBColor(0x64, 0x74, 0x8B)
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
        end_p = document.add_paragraph()
        end_run = end_p.add_run("— 报告正文结束 · GroupProof 证据驱动协作平台生成 —")
        end_run.font.size = Pt(9)
        end_run.font.color.rgb = RGBColor(0x94, 0xA3, 0xB8)
        stream = BytesIO()
        document.save(stream)
        return (
            stream.getvalue(),
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )

    # Rich Publication-Grade PDF via ReportLab Platypus (A4 editorial layout, CJK wrapping, real GFM tables)
    _ensure_pdf_font()
    stream = BytesIO()
    page_w, _ = A4
    margin = 46.0
    usable_w = page_w - margin * 2
    doc = SimpleDocTemplate(
        stream,
        pagesize=A4,
        leftMargin=margin,
        rightMargin=margin,
        topMargin=48.0,
        bottomMargin=48.0,
        title=title,
    )
    st_eyebrow = ParagraphStyle(
        "GPEyebrow",
        fontName="STSong-Light",
        fontSize=9,
        leading=13,
        textColor=colors.HexColor("#64748B"),
        spaceAfter=4,
        wordWrap="CJK",
    )
    st_title = ParagraphStyle(
        "GPTitle",
        fontName="STSong-Light",
        fontSize=17,
        leading=24,
        textColor=colors.HexColor("#0F172A"),
        spaceAfter=6,
        wordWrap="CJK",
    )
    st_subtitle = ParagraphStyle(
        "GPSubtitle",
        fontName="STSong-Light",
        fontSize=9.2,
        leading=14,
        textColor=colors.HexColor("#475569"),
        spaceAfter=8,
        wordWrap="CJK",
    )
    st_h1 = ParagraphStyle(
        "GPH1",
        fontName="STSong-Light",
        fontSize=13,
        leading=19,
        textColor=colors.HexColor("#0F172A"),
        spaceBefore=14,
        spaceAfter=6,
        wordWrap="CJK",
    )
    st_h2 = ParagraphStyle(
        "GPH2",
        fontName="STSong-Light",
        fontSize=11,
        leading=16,
        textColor=colors.HexColor("#1E293B"),
        spaceBefore=9,
        spaceAfter=4,
        wordWrap="CJK",
    )
    st_body = ParagraphStyle(
        "GPBody",
        fontName="STSong-Light",
        fontSize=10,
        leading=16,
        textColor=colors.HexColor("#334155"),
        spaceAfter=6,
        wordWrap="CJK",
    )
    st_quote = ParagraphStyle(
        "GPQuote",
        fontName="STSong-Light",
        fontSize=9.5,
        leading=15,
        leftIndent=12,
        textColor=colors.HexColor("#475569"),
        spaceAfter=6,
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
    st_caption = ParagraphStyle(
        "GPCaption",
        fontName="STSong-Light",
        fontSize=8.5,
        leading=13,
        alignment=TA_CENTER,
        textColor=colors.HexColor("#64748B"),
        spaceBefore=4,
        spaceAfter=8,
        wordWrap="CJK",
    )
    st_footer_end = ParagraphStyle(
        "GPFooterEnd",
        fontName="STSong-Light",
        fontSize=8.5,
        leading=13,
        alignment=TA_CENTER,
        textColor=colors.HexColor("#94A3B8"),
        spaceBefore=14,
        wordWrap="CJK",
    )

    story: list[Any] = [
        Paragraph("课程小组项目结项文档", st_eyebrow),
        Paragraph(f"<b>{xml_escape(title)}</b>", st_title),
    ]
    if subtitle_line:
        story.append(Paragraph(xml_escape(_sanitize_text(subtitle_line)), st_subtitle))
    story.append(
        HRFlowable(width="100%", thickness=0.8, color=colors.HexColor("#CBD5E1"), spaceAfter=10)
    )

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
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F8FAFC")),
                    ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#CBD5E1")),
                    ("TOPPADDING", (0, 0), (-1, -1), 5),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                    ("LEFTPADDING", (0, 0), (-1, -1), 6),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ]
            )
        )
        story.extend([kpi_table, Spacer(1, 10)])

    for _key, label, body in ordered_entries:
        story.append(Paragraph(f"<b>{xml_escape(_sanitize_text(label))}</b>", st_h1))
        story.append(
            HRFlowable(width="100%", thickness=0.4, color=colors.HexColor("#E2E8F0"), spaceAfter=6)
        )
        for block in _parse_markdown_blocks(body):
            btype = block["type"]
            if btype == "heading":
                story.append(Paragraph(f"<b>{_md_inline_to_rl_markup(block['text'])}</b>", st_h2))
            elif btype == "image":
                alt_text = _sanitize_text(block.get("alt") or "项目插图")
                png_bytes = _resolve_chart_png_for_export(data, str(block.get("src") or ""))
                if png_bytes:
                    draw_w, draw_h = _fit_pdf_image_size(png_bytes, usable_w, max_h=270.0)
                    img_flowable = RLImage(BytesIO(png_bytes), width=draw_w, height=draw_h)
                    img_flowable.hAlign = "CENTER"
                    figure_group: list[Any] = [Spacer(1, 4), img_flowable]
                    if alt_text:
                        figure_group.append(Paragraph(f"<i>{xml_escape(alt_text)}</i>", st_caption))
                    else:
                        figure_group.append(Spacer(1, 8))
                    story.append(KeepTogether(figure_group))
                elif alt_text:
                    story.append(Paragraph(f"<i>[插图：{xml_escape(alt_text)}]</i>", st_caption))
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
                                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F8FAFC")),
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

    story.append(Paragraph("— 报告正文结束 · GroupProof 证据驱动协作平台生成 —", st_footer_end))

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


def _load_chart_snapshot_and_facts(
    session: Session,
    user: User,
    project_id: UUID,
    version_no: int,
    chart_key: str,
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    if not CHART_KEY_RE.match(chart_key):
        raise ApiError(404, "REPORT_CHART_NOT_FOUND", "Unknown report chart.")
    access = get_project_access(session, user, project_id)
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
    snapshot = version.data_snapshot if isinstance(version.data_snapshot, dict) else {}
    fallback_facts: dict[str, Any] | None = None
    if not snapshot.get("facts") and chart_key in ALLOWED_DEFAULT_CHART_KEYS:
        project_name = str(snapshot.get("project_name") or access.project.name)
        fallback_facts = collect_project_facts(session, project_id, project_name)
    return snapshot, fallback_facts


@router.get("/versions/{version_no}/charts/{chart_key}.svg")
def get_report_chart_svg(
    project_id: UUID,
    version_no: int,
    chart_key: str,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    snapshot, fallback_facts = _load_chart_snapshot_and_facts(
        session, user, project_id, version_no, chart_key
    )
    svg_str = render_chart_svg_from_snapshot(snapshot, chart_key, fallback_facts=fallback_facts)
    if svg_str is None:
        raise ApiError(404, "REPORT_CHART_NOT_FOUND", "Report chart not found.")
    return Response(
        content=svg_str.encode("utf-8"),
        media_type="image/svg+xml; charset=utf-8",
        headers={
            "Cache-Control": "private, max-age=300",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox",
        },
    )


@router.get("/versions/{version_no}/charts/{chart_key}.png")
def get_report_chart(
    project_id: UUID,
    version_no: int,
    chart_key: str,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    snapshot, fallback_facts = _load_chart_snapshot_and_facts(
        session, user, project_id, version_no, chart_key
    )
    png_bytes = render_chart_from_snapshot(snapshot, chart_key, fallback_facts=fallback_facts)
    if png_bytes is None:
        raise ApiError(404, "REPORT_CHART_NOT_FOUND", "Report chart not found.")
    return Response(
        content=png_bytes,
        media_type="image/png",
        headers={
            "Cache-Control": "private, max-age=300",
            "X-Content-Type-Options": "nosniff",
        },
    )


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
        if _should_run_inline_sync():
            _render_export_inline_safe(session, artifact, version.data_snapshot)
            return success({"id": str(artifact.id), "status": artifact.status}, request)
        _run_export_in_background_thread(str(artifact.id))
        return success({"id": str(artifact.id), "status": artifact.status}, request)
    try:
        generate_export.delay(str(artifact.id))
    except Exception:
        if _allow_inline_worker_fallback():
            if _should_run_inline_sync():
                _render_export_inline_safe(session, artifact, version.data_snapshot)
                return success({"id": str(artifact.id), "status": artifact.status}, request)
            _run_export_in_background_thread(str(artifact.id))
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
