"""D6 teacher review data, append-only comments, and grades tied to a frozen basis."""

from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.api.errors import ApiError
from app.api.responses import success
from app.db.models import Project, User
from app.db.session import get_session
from app.modules.a.access_grants import has_read_grant
from app.modules.c.permissions import get_project_access
from app.modules.d.contribution_week7 import archive_contribution
from app.modules.d.models import (
    ContributionAppeal,
    ContributionArchive,
    ContributionItem,
    CourseGrade,
    Report,
    ReportSnapshot,
    TeacherReportComment,
)

router = APIRouter(prefix="/api/v1/projects/{project_id}/teacher-report", tags=["d-teacher-report"])


class CommentInput(BaseModel):
    body: str = Field(min_length=1, max_length=4000)


class GradeInput(BaseModel):
    score: float = Field(ge=0, le=100)
    comment: str = Field(min_length=1, max_length=4000)


def require_staff(session: Session, user: User, project_id: UUID, teacher_only: bool = False):
    access = get_project_access(
        session, user, project_id, lock=teacher_only, allow_readonly=teacher_only
    )
    if not access.teacher and not (access.staff and not teacher_only):
        raise ApiError(403, "TEACHER_REPORT_DENIED", "Course staff access required.")
    if user.global_role == "ta" and not has_read_grant(session, user.id, project_id):
        raise ApiError(403, "GROUP_ACCESS_DENIED", "This group is outside your authorization.")
    if teacher_only and access.course is not None and access.course.status == "ended":
        raise ApiError(403, "COURSE_READ_ONLY", "The course has ended.")
    return access


def current_report(session: Session, project_id: UUID):
    report = session.scalar(select(Report).where(Report.project_id == project_id))
    snapshot = (
        session.scalar(
            select(ReportSnapshot)
            .where(ReportSnapshot.report_id == report.id)
            .order_by(ReportSnapshot.version_no.desc())
            .limit(1)
        )
        if report
        else None
    )
    return report, snapshot


@router.get("")
def teacher_report(
    project_id: UUID,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    require_staff(session, user, project_id)
    report, snapshot = current_report(session, project_id)
    comments = session.scalars(
        select(TeacherReportComment)
        .where(TeacherReportComment.project_id == project_id)
        .order_by(TeacherReportComment.created_at.desc())
    ).all()
    appeals = (
        session.scalars(
            select(ContributionAppeal)
            .where(
                ContributionAppeal.project_id == project_id,
                ContributionAppeal.snapshot_id == snapshot.contribution_snapshot_id,
            )
            .order_by(ContributionAppeal.created_at.desc())
        ).all()
        if snapshot and snapshot.contribution_snapshot_id
        else []
    )
    archive = (
        session.scalar(
            select(ContributionArchive).where(
                ContributionArchive.source_kind == "report",
                ContributionArchive.source_id == snapshot.id,
            )
        )
        if snapshot
        else None
    )
    grades = session.scalars(
        select(CourseGrade)
        .where(CourseGrade.project_id == project_id)
        .order_by(CourseGrade.created_at.desc())
    ).all()
    contribution = archive.data if archive else None
    if contribution is None and snapshot and snapshot.contribution_snapshot_id:
        items = session.scalars(
            select(ContributionItem).where(
                ContributionItem.snapshot_id == snapshot.contribution_snapshot_id
            )
        ).all()
        contribution = {
            "members": [{"user_id": str(item.user_id), "share": str(item.share)} for item in items]
        }
    return success(
        {
            "report_status": report.status if report else "missing",
            "snapshot": {
                "id": str(snapshot.id),
                "version": snapshot.version_no,
                "data": snapshot.data_snapshot,
            }
            if snapshot
            else None,
            "contribution": contribution,
            "evidence": snapshot.data_snapshot.get("evidence_records", []) if snapshot else [],
            "appeals": [
                {
                    "id": str(row.id),
                    "status": row.status,
                    "reason": row.reason,
                    "snapshot_id": str(row.snapshot_id),
                }
                for row in appeals
            ],
            "comments": [
                {
                    "id": str(row.id),
                    "body": row.body,
                    "actor_id": str(row.actor_id),
                    "created_at": row.created_at.isoformat(),
                }
                for row in comments
            ],
            "grades": [
                {
                    "id": str(row.id),
                    "score": float(row.score),
                    "comment": row.comment,
                    "contribution_archive_id": str(row.contribution_archive_id),
                    "created_at": row.created_at.isoformat(),
                }
                for row in grades
            ],
        },
        request,
    )


@router.post("/comments", status_code=201)
def comment_report(
    project_id: UUID,
    payload: CommentInput,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    require_staff(session, user, project_id, teacher_only=True)
    _, snapshot = current_report(session, project_id)
    if snapshot is None:
        raise ApiError(409, "REPORT_MISSING", "Generate a report before commenting.")
    row = TeacherReportComment(
        project_id=project_id, snapshot_id=snapshot.id, actor_id=user.id, body=payload.body.strip()
    )
    session.add(row)
    session.commit()
    return success({"id": str(row.id)}, request)


@router.post("/grades", status_code=201)
def grade_report(
    project_id: UUID,
    payload: GradeInput,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    require_staff(session, user, project_id, teacher_only=True)
    report, snapshot = current_report(session, project_id)
    if (
        report is None
        or report.status != "finalized"
        or snapshot is None
        or snapshot.status != "finalized"
    ):
        raise ApiError(409, "REPORT_NOT_FINAL", "Finalize the report before grading.")
    if not payload.comment.strip():
        raise ApiError(422, "GRADE_COMMENT_REQUIRED", "Grade comment is required.")
    if snapshot.contribution_snapshot_id is None:
        raise ApiError(409, "CONTRIBUTION_MISSING", "No contribution basis is available.")
    project = session.get(Project, project_id)
    grade_id = uuid4()
    archive = archive_contribution(
        session, project_id, "grade", grade_id, snapshot.contribution_snapshot_id
    )
    if archive is None:
        raise ApiError(409, "CONTRIBUTION_MISSING", "No contribution basis is available.")
    session.flush()
    grade = CourseGrade(
        id=grade_id,
        course_id=project.course_id,
        project_id=project_id,
        report_snapshot_id=snapshot.id,
        actor_id=user.id,
        score=payload.score,
        comment=payload.comment.strip(),
        contribution_archive_id=archive.id,
    )
    session.add(grade)
    session.commit()
    return success(
        {
            "id": str(grade.id),
            "score": float(grade.score),
            "contribution_archive_id": str(archive.id),
        },
        request,
    )
