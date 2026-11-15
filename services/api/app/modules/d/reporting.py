"""D4 report versions built from a single frozen database read."""

from datetime import UTC, datetime, timedelta
from hashlib import sha256
from io import BytesIO
from secrets import token_urlsafe
from uuid import UUID

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
from app.modules.c.models import Evidence
from app.modules.c.permissions import get_project_access
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

router = APIRouter(prefix="/api/v1/projects/{project_id}/reports", tags=["d-reports"])


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
        select(Milestone).where(Milestone.project_id == project_id).order_by(Milestone.id)
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
    contribution = session.scalar(
        select(ContributionSnapshot)
        .where(
            ContributionSnapshot.project_id == project_id, ContributionSnapshot.status == "frozen"
        )
        .order_by(ContributionSnapshot.version_no.desc())
        .limit(1)
    )
    shares = (
        session.scalars(
            select(ContributionItem)
            .where(ContributionItem.snapshot_id == contribution.id)
            .order_by(ContributionItem.user_id)
        ).all()
        if contribution
        else []
    )
    completed = sum(task.status == "completed" for task in tasks)
    sections = {
        "overview": (
            f"{project_name}: {len(members)} members; {len(tasks)} tasks; {completed} completed."
        ),
        "tasks": "\n".join(
            f"{task.title}: {task.status} ({task.progress_percent}%)" for task in tasks
        )
        or "No tasks.",
        "milestones": "\n".join(
            f"{item.title}: {item.status} ({item.progress_percent}%)" for item in milestones
        )
        or "No milestones.",
        "evidence": f"{len(evidence)} formal evidence records.",
        "contribution": "\n".join(f"{item.user_id}: {item.share}%" for item in shares)
        or "No frozen contribution snapshot.",
        "risks": f"{len(risks)} active risks.\n"
        + "\n".join(f"{risk.title}: {risk.level}" for risk in risks),
    }
    if appendix:
        sections["appendix"] = "\n".join(item.title for item in evidence) or "No formal evidence."
    return {
        "project_name": project_name,
        "counts": {
            "members": len(members),
            "tasks": len(tasks),
            "completed_tasks": completed,
            "evidence": len(evidence),
            "risks": risk_counts(risks)["total"],
            "contribution_members": len(shares),
        },
        "sections": sections,
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
        if report.status in {"generating", "submitted", "finalized"}:
            raise ApiError(409, "REPORT_READ_ONLY", "Report is awaiting review or finalized.")
        previous = versions(session, report.id)
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
        contribution = session.scalar(
            select(ContributionSnapshot)
            .where(
                ContributionSnapshot.project_id == project_id,
                ContributionSnapshot.status == "frozen",
            )
            .order_by(ContributionSnapshot.version_no.desc())
            .limit(1)
        )
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
        report.status = "generating"
        report.includes_appendix = payload.includes_appendix
        report.lock_version += 1
        session.commit()
        try:
            from app.modules.d.report_tasks import generate_preview

            generate_preview.delay(str(version.id), payload.includes_appendix)
        except Exception:
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


def render_document(data: dict, file_format: str) -> tuple[bytes, str]:
    title = data["project_name"] + " project report"
    if file_format == "docx":
        document = Document()
        document.add_heading(title, 0)
        for heading, body in data["sections"].items():
            document.add_heading(heading.title(), level=1)
            document.add_paragraph(body)
        stream = BytesIO()
        document.save(stream)
        return (
            stream.getvalue(),
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )
    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    stream = BytesIO()
    pdf = canvas.Canvas(stream, pagesize=A4)
    pdf.setFont("STSong-Light", 16)
    pdf.drawString(40, 800, title[:40])
    y = 770
    for heading, body in data["sections"].items():
        for line in [heading.title(), *body.splitlines()]:
            while line:
                width = 0
                split_at = 0
                for character in line:
                    next_width = width + pdfmetrics.stringWidth(character, "STSong-Light", 12)
                    if next_width > A4[0] - 80:
                        break
                    width = next_width
                    split_at += 1
                chunk, line = line[:split_at], line[split_at:]
                if y < 50:
                    pdf.showPage()
                    y = 800
                pdf.setFont("STSong-Light", 12)
                pdf.drawString(40, y, chunk)
                y -= 19
    pdf.save()
    return stream.getvalue(), "application/pdf"


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
    try:
        from app.modules.d.report_tasks import generate_export

        generate_export.delay(str(artifact.id))
    except Exception:
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
    mime = (
        "application/pdf"
        if artifact.file_format == "pdf"
        else ("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    )
    return Response(
        content=artifact.content,
        media_type=mime,
        headers={
            "Content-Disposition": (
                f'attachment; filename="report-{artifact.id}.{artifact.file_format}"'
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
