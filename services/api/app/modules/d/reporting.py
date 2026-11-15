"""D4 report versions built from a single frozen database read."""

from datetime import UTC, datetime
from io import BytesIO
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
    ReportDownload,
    ReportSnapshot,
    Risk,
)

router = APIRouter(prefix="/api/v1/projects/{project_id}/reports", tags=["d-reports"])


class RefreshInput(BaseModel):
    includes_appendix: bool = False


class EditSection(BaseModel):
    section: str
    body: str = Field(min_length=1, max_length=20000)
    expected_version: int


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
            f"{project_name}: {len(members)} members; "
            f"{len(tasks)} tasks; {completed} completed."
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
            "risks": len(risks),
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
    return success(
        {
            "status": report.status if report else "draft",
            "versions": [serialize(item) for item in report_versions],
            "downloads": [
                {
                    "version": next(
                        item.version_no for item in report_versions if item.id == row.snapshot_id
                    ),
                    "user_id": str(row.user_id),
                    "format": row.file_format,
                    "created_at": row.created_at.isoformat() if row.created_at else None,
                }
                for row in downloads
            ],
        },
        request,
    )


@router.post("/refresh", status_code=201)
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
        if report.status == "finalized":
            raise ApiError(409, "REPORT_FINALIZED", "The report is finalized.")
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
            status="generated",
            baseline_version_id=baseline.id if baseline else None,
            plan_version_id=plan.id if plan else None,
            contribution_snapshot_id=contribution.id if contribution else None,
            data_snapshot=snapshot_data(
                session, project_id, access.project.name, payload.includes_appendix
            ),
        )
        session.add(version)
        report.status = "generated"
        report.includes_appendix = payload.includes_appendix
        report.lock_version += 1
        session.commit()
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
        if report is None or report.status == "finalized":
            raise ApiError(409, "REPORT_NOT_EDITABLE", "Generate a draft report first.")
        latest = versions(session, report.id)[0]
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


@router.post("/finalize")
def finalize_report(
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
        if report.status == "finalized":
            raise ApiError(409, "REPORT_FINALIZED", "The report has already been submitted.")
        latest = versions(session, report.id)[0]
        latest.status = "finalized"
        latest.finalized_at = datetime.now(UTC)
        report.status = "finalized"
        report.lock_version += 1
        session.commit()
        return success(serialize(latest), request)
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


@router.get("/versions/{version_no}/download")
def download_report(
    project_id: UUID,
    version_no: int,
    file_format: str,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    get_project_access(session, user, project_id)
    if file_format not in {"pdf", "docx"}:
        raise ApiError(422, "REPORT_FORMAT_INVALID", "Choose pdf or docx.")
    report = session.scalar(select(Report).where(Report.project_id == project_id))
    version = (
        session.scalar(
            select(ReportSnapshot).where(
                ReportSnapshot.report_id == report.id, ReportSnapshot.version_no == version_no
            )
        )
        if report
        else None
    )
    if version is None:
        raise ApiError(404, "REPORT_VERSION_NOT_FOUND", "Report version not found.")
    content, mime = render_document(version.data_snapshot, file_format)
    session.add(ReportDownload(snapshot_id=version.id, user_id=user.id, file_format=file_format))
    session.commit()
    return Response(
        content=content,
        media_type=mime,
        headers={
            "Content-Disposition": f'attachment; filename="report-v{version_no}.{file_format}"'
        },
    )
