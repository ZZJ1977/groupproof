"""HTTP endpoints for teacher class data reports center (Screen 45)."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, Response

from app.modules.b import teacher_reports_service as service
from app.modules.b.common import (
    ERROR_RESPONSES,
    CurrentUser,
    Database,
    IdempotencyKey,
    envelope,
    private_response,
    run_command,
)
from app.modules.b.teacher_reports_schemas import ExportFormat, ExportReportRequest

router = APIRouter(
    tags=["b-teacher-reports"],
    dependencies=[Depends(private_response)],
    responses=ERROR_RESPONSES,
)


@router.get("/teacher/classes/{course_id}/reports/overview")
def overview(course_id: UUID, request: Request, session: Database, user: CurrentUser):
    return envelope(service.get_overview(session, user, course_id), request)


@router.get("/teacher/classes/{course_id}/reports/progress")
def progress(course_id: UUID, request: Request, session: Database, user: CurrentUser):
    return envelope(service.get_progress(session, user, course_id), request)


@router.get("/teacher/classes/{course_id}/reports/milestones")
def milestones(course_id: UUID, request: Request, session: Database, user: CurrentUser):
    return envelope(service.get_milestones(session, user, course_id), request)


@router.get("/teacher/classes/{course_id}/reports/risks")
def risks(course_id: UUID, request: Request, session: Database, user: CurrentUser):
    return envelope(service.get_risks(session, user, course_id), request)


@router.get("/teacher/classes/{course_id}/reports/activity")
def activity(course_id: UUID, request: Request, session: Database, user: CurrentUser):
    return envelope(service.get_activity(session, user, course_id), request)


@router.get("/teacher/classes/{course_id}/reports/contribution")
def contribution(course_id: UUID, request: Request, session: Database, user: CurrentUser):
    return envelope(service.get_contribution(session, user, course_id), request)


@router.post("/teacher/classes/{course_id}/reports/export")
def export_report(
    course_id: UUID,
    command: ExportReportRequest,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return run_command(
        session,
        request,
        actor=user,
        operation=f"teacher.reports.export:{course_id}:{command.format}",
        idempotency_key=key,
        payload=command.model_dump(mode="json"),
        execute=lambda: service.export_report(session, user, course_id, command.format, request),
    )


@router.get("/teacher/classes/{course_id}/reports/export/download")
def download_export(
    course_id: UUID,
    session: Database,
    user: CurrentUser,
    format: ExportFormat = Query(default="csv"),
):
    filename, mime_type, payload = service.download_report_bytes(session, user, course_id, format)
    return Response(
        content=payload,
        media_type=mime_type,
        headers={"Content-Disposition": service.export_content_disposition(filename)},
    )
