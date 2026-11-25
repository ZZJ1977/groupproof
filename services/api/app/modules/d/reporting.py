"""D4 report versions built from a single frozen database read."""

import logging
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeoutError
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from io import BytesIO
from secrets import token_urlsafe
from urllib.parse import quote
from uuid import UUID

from celery.app.task import Task as CeleryTask
from docx import Document
from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.api.errors import ApiError
from app.api.responses import success
from app.db.models import BaselineVersion, Milestone, PlanVersion, ProjectMember, Task, User
from app.db.session import get_session
from app.modules.a.ai import AIUsageContext, RiskExplanationInput, explain_risk
from app.modules.a.ai.schemas import RiskRecord, TaskProgressBrief
from app.modules.c.models import Evidence
from app.modules.c.permissions import get_project_access
from app.modules.d.contribution import current_frozen_snapshot
from app.modules.d.models import (
    ContributionItem,
    ContributionSnapshot,
    Report,
    ReportArtifact,
    ReportDownload,
    ReportDownloadLink,
    ReportReview,
    ReportSnapshot,
    Risk,
)
from app.modules.d.risk_read import risk_counts

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/projects/{project_id}/reports", tags=["d-reports"])

STALE_GENERATING_SECONDS = 120
RISK_ADVICE_TIMEOUT_SECONDS = 6.0
_WORKER_INSPECT_TTL_SECONDS = 15.0
_worker_inspect_cache: dict[str, tuple[float, bool]] = {}
_XML_ILLEGAL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")
_PDF_FONT_REGISTERED = False


class RefreshInput(BaseModel):
    includes_appendix: bool = False


class EditSection(BaseModel):
    section: str
    body: str = Field(min_length=1, max_length=20000)
    expected_version: int


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


def snapshot_data(session: Session, project_id: UUID, project_name: str, appendix: bool) -> dict:
    tasks = session.scalars(
        select(Task).where(Task.project_id == project_id).order_by(Task.id)
    ).all()
    milestones = session.scalars(
        select(Milestone)
        .where(Milestone.project_id == project_id)
        .order_by(Milestone.deadline.asc().nulls_last(), Milestone.title, Milestone.id)
    ).all()
    members = session.scalars(
        select(ProjectMember).where(
            ProjectMember.project_id == project_id, ProjectMember.left_at.is_(None)
        )
    ).all()
    risks = session.scalars(
        select(Risk).where(Risk.project_id == project_id, Risk.status != "closed")
    ).all()
    evidence = session.scalars(
        select(Evidence).where(
            Evidence.project_id == project_id,
            Evidence.status == "formal",
            Evidence.source_changed.is_(False),
        )
    ).all()
    contribution = current_frozen_snapshot(session, project_id)
    draft_contribution = (
        None
        if contribution is not None
        else session.scalar(
            select(ContributionSnapshot)
            .where(ContributionSnapshot.project_id == project_id)
            .order_by(ContributionSnapshot.version_no.desc())
            .limit(1)
        )
    )
    display_snapshot = contribution or draft_contribution
    shares = (
        session.scalars(
            select(ContributionItem)
            .where(ContributionItem.snapshot_id == display_snapshot.id)
            .order_by(ContributionItem.share.desc(), ContributionItem.user_id)
        ).all()
        if display_snapshot
        else []
    )
    frozen_shares = shares if contribution is not None else []
    share_user_ids = {item.user_id for item in shares}
    share_names = (
        {
            u.id: (u.name or u.email or str(u.id))
            for u in session.scalars(select(User).where(User.id.in_(share_user_ids)))
        }
        if share_user_ids
        else {}
    )
    completed = sum(task.status == "completed" for task in tasks)
    if contribution is not None:
        contribution_text = (
            "\n".join(
                f"{share_names.get(item.user_id, item.user_id)}: {float(item.share):.1f}%"
                for item in frozen_shares
            )
            or "已冻结贡献快照暂无成员记录。"
        )
    elif draft_contribution is not None and shares:
        draft_lines = "\n".join(
            f"{share_names.get(item.user_id, item.user_id)}: {float(item.share):.1f}%"
            for item in shares
        )
        contribution_text = (
            f"尚未冻结正式贡献快照（以下为最新草稿 v{draft_contribution.version_no} 参考，"
            "正式提交前请在贡献页冻结快照）：\n"
            f"{draft_lines}"
        )
    else:
        contribution_text = "尚未冻结正式贡献快照。"
    sections = {
        "overview": (
            f"{project_name}：共 {len(members)} 名活跃成员，"
            f"{len(tasks)} 项任务（已完成 {completed} 项），"
            f"{len(evidence)} 条有效正式证据，{len(risks)} 项活跃风险。"
        ),
        "tasks": "\n".join(
            f"{task.title}: {task.status} ({task.progress_percent}%)" for task in tasks
        )
        or "暂无任务记录。",
        "milestones": "\n".join(
            f"{item.title}: {item.status} ({item.progress_percent}%)" for item in milestones
        )
        or "暂无里程碑记录。",
        "evidence": f"共 {len(evidence)} 条有效正式证据。",
        "contribution": contribution_text,
        "risks": (
            f"当前活跃风险 {len(risks)} 项。"
            + ("\n" + "\n".join(f"{risk.title}: {risk.level}" for risk in risks) if risks else "")
        ),
    }
    if appendix:
        sections["appendix"] = "\n".join(item.title for item in evidence) or "暂无正式证据。"
    return {
        "project_name": project_name,
        "contribution_snapshot_id": str(contribution.id) if contribution else None,
        "counts": {
            "members": len(members),
            "tasks": len(tasks),
            "completed_tasks": completed,
            "evidence": len(evidence),
            "risks": risk_counts(risks)["total"],
            "contribution_members": sum(1 for item in frozen_shares if item.share > 0),
        },
        "sections": sections,
        "evidence_records": [
            {"id": str(item.id), "task_id": str(item.task_id), "title": item.title}
            for item in evidence
        ],
    }


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
        if payload.section not in latest.data_snapshot["sections"]:
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


SECTION_LABELS: dict[str, str] = {
    "overview": "1. 项目概览 (Overview)",
    "tasks": "2. 任务进展 (Tasks)",
    "milestones": "3. 里程碑执行 (Milestones)",
    "evidence": "4. 正式证据统计 (Evidence)",
    "contribution": "5. 成员贡献快照 (Contribution)",
    "risks": "6. 风险记录 (Risks)",
    "risk_explanation": "7. 风险分析与建议 (AI Risk Advice)",
    "appendix": "附录：正式证据清单 (Formal Evidence Appendix)",
}


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


def _bounded_risk_explanation(
    session: Session, project_id: UUID, actor_id: UUID, data: dict
) -> str:
    active_risks = session.scalars(
        select(Risk)
        .where(Risk.project_id == project_id, Risk.status != "closed")
        .order_by(Risk.created_at.desc())
        .limit(100)
    ).all()
    if not active_risks:
        return _deterministic_risk_explanation(data, [])
    tasks = session.scalars(select(Task).where(Task.project_id == project_id).limit(500)).all()
    payload = RiskExplanationInput(
        project_id=project_id,
        tasks=[
            TaskProgressBrief(
                id=task.id,
                title=task.title,
                status=task.status,
                progress_percent=task.progress_percent,
            )
            for task in tasks
        ],
        risks=[
            RiskRecord(kind=risk.title, description=risk.description, severity=risk.level)
            for risk in active_risks
        ],
    )
    usage = AIUsageContext(user_id=actor_id, project_id=project_id)
    executor = ThreadPoolExecutor(max_workers=1)
    future = executor.submit(explain_risk, payload, usage=usage)
    try:
        result = future.result(timeout=RISK_ADVICE_TIMEOUT_SECONDS)
        advice = result.model_dump(mode="json")
        return (
            advice["summary"]
            + "\n"
            + advice["explanation"]
            + "\n"
            + "\n".join(advice["suggestions"])
            + "\nAI advice requires human review."
        )
    except (FuturesTimeoutError, Exception):
        logger.warning(
            "Falling back to deterministic risk summary for project %s",
            project_id,
            exc_info=True,
        )
        return _deterministic_risk_explanation(data, active_risks)
    finally:
        executor.shutdown(wait=False, cancel_futures=True)


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

    data = snapshot_data(session, project.id, project.name, appendix)
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
    risk_section = _bounded_risk_explanation(session, project.id, actor_id, data)
    if risk_section:
        data = {
            **data,
            "sections": {
                **data["sections"],
                "risk_explanation": risk_section,
            },
        }
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


def _wrap_pdf_line(text: str, font_name: str, font_size: int, max_width: float) -> list[str]:
    if not text:
        return [""]
    chunks: list[str] = []
    remaining = text
    while remaining:
        width = 0.0
        split_at = 0
        for character in remaining:
            next_width = width + pdfmetrics.stringWidth(character, font_name, font_size)
            if next_width > max_width and split_at > 0:
                break
            width = next_width
            split_at += 1
        chunks.append(remaining[:split_at])
        remaining = remaining[split_at:]
    return chunks


def render_document(data: dict, file_format: str) -> tuple[bytes, str]:
    project_name = _sanitize_text(data.get("project_name") or "GroupProof")
    title = f"{project_name} 项目报告 (Project Report)"
    counts = data.get("counts") if isinstance(data.get("counts"), dict) else None
    sections = data.get("sections") if isinstance(data.get("sections"), dict) else {}
    evidence_records = (
        data.get("evidence_records") if isinstance(data.get("evidence_records"), list) else []
    )

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
        for heading, body in sections.items():
            label = SECTION_LABELS.get(heading, heading.replace("_", " ").title())
            lines.append(f"## {label}")
            lines.append("")
            lines.append(_sanitize_text(body))
            lines.append("")
        if "appendix" in sections and evidence_records:
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
            headers = ["成员数", "任务总数", "已完成任务", "正式证据", "活跃风险"]
            values = [
                str(counts.get("members", 0)),
                str(counts.get("tasks", 0)),
                str(counts.get("completed_tasks", 0)),
                str(counts.get("evidence", 0)),
                str(counts.get("risks", 0)),
            ]
            for idx, text_val in enumerate(headers):
                summary_table.cell(0, idx).text = text_val
                summary_table.cell(1, idx).text = values[idx]
        for heading, body in sections.items():
            label = SECTION_LABELS.get(heading, heading.replace("_", " ").title())
            document.add_heading(_sanitize_text(label), level=1)
            lines = _sanitize_text(body).splitlines() or [""]
            for line in lines:
                document.add_paragraph(line)
        if "appendix" in sections and evidence_records:
            document.add_heading("正式证据明细表", level=2)
            ev_table = document.add_table(rows=len(evidence_records) + 1, cols=2)
            ev_table.cell(0, 0).text = "证据标题"
            ev_table.cell(0, 1).text = "关联任务 ID"
            for row_idx, item in enumerate(evidence_records, start=1):
                ev_table.cell(row_idx, 0).text = _sanitize_text(item.get("title", ""))
                ev_table.cell(row_idx, 1).text = _sanitize_text(item.get("task_id", ""))
        stream = BytesIO()
        document.save(stream)
        return (
            stream.getvalue(),
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )

    _ensure_pdf_font()
    stream = BytesIO()
    pdf = canvas.Canvas(stream, pagesize=A4)
    page_width, page_height = A4
    margin_x = 42.0
    usable_width = page_width - margin_x * 2
    page_no = 1
    y = page_height - 52.0

    def draw_footer(num: int) -> None:
        pdf.setFont("STSong-Light", 9)
        pdf.drawRightString(page_width - margin_x, 26, f"GroupProof · 第 {num} 页")

    def ensure_space(needed: float) -> None:
        nonlocal y, page_no
        if y < 52.0 + needed:
            draw_footer(page_no)
            pdf.showPage()
            page_no += 1
            y = page_height - 52.0

    for chunk in _wrap_pdf_line(title, "STSong-Light", 16, usable_width):
        ensure_space(24)
        pdf.setFont("STSong-Light", 16)
        pdf.drawString(margin_x, y, chunk)
        y -= 24

    if counts:
        summary_line = (
            f"成员：{counts.get('members', 0)} 人  |  "
            f"任务：{counts.get('completed_tasks', 0)}/{counts.get('tasks', 0)} 已完成  |  "
            f"正式证据：{counts.get('evidence', 0)} 条  |  "
            f"活跃风险：{counts.get('risks', 0)} 项"
        )
        for chunk in _wrap_pdf_line(summary_line, "STSong-Light", 10, usable_width):
            ensure_space(16)
            pdf.setFont("STSong-Light", 10)
            pdf.drawString(margin_x, y, chunk)
            y -= 16
        y -= 6

    for heading, body in sections.items():
        y -= 6
        label = _sanitize_text(SECTION_LABELS.get(heading, heading.replace("_", " ").title()))
        for chunk in _wrap_pdf_line(label, "STSong-Light", 13, usable_width):
            ensure_space(20)
            pdf.setFont("STSong-Light", 13)
            pdf.drawString(margin_x, y, chunk)
            y -= 20
        for raw_line in _sanitize_text(body).splitlines() or [""]:
            if not raw_line.strip():
                y -= 8
                continue
            for chunk in _wrap_pdf_line(raw_line, "STSong-Light", 11, usable_width):
                ensure_space(17)
                pdf.setFont("STSong-Light", 11)
                pdf.drawString(margin_x, y, chunk)
                y -= 17

    draw_footer(page_no)
    pdf.save()
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
