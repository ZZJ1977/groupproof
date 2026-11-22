"""HTTP endpoints for cross-class teacher dashboard (Screen 58)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from app.modules.b import teacher_dashboard_service as service
from app.modules.b.common import (
    ERROR_RESPONSES,
    CurrentUser,
    Database,
    envelope,
    private_response,
)

router = APIRouter(
    tags=["b-teacher-dashboard"],
    dependencies=[Depends(private_response)],
    responses=ERROR_RESPONSES,
)


@router.get("/teacher/dashboard")
def dashboard(request: Request, session: Database, user: CurrentUser):
    return envelope(service.get_dashboard(session, user), request)


@router.get("/teacher/dashboard/actions")
def dashboard_actions(request: Request, session: Database, user: CurrentUser):
    return envelope(service.list_dashboard_actions(session, user), request)


@router.get("/teacher/dashboard/risks")
def dashboard_risks(request: Request, session: Database, user: CurrentUser):
    return envelope(service.list_dashboard_risks(session, user), request)


@router.get("/teacher/dashboard/activity")
def dashboard_activity(request: Request, session: Database, user: CurrentUser):
    return envelope(service.list_dashboard_activity(session, user), request)
