"""Request and response schemas for cross-class teacher dashboard (Screen 58)."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel

from app.modules.b.teacher_actions_schemas import TeacherActionItemDTO
from app.modules.b.teacher_reports_schemas import GroupRiskAlertDTO


class DashboardClassDTO(BaseModel):
    course_id: UUID
    name: str
    semester: str
    status: str
    student_count: int
    group_count: int
    project_count: int
    overall_progress: int | None
    pending_actions: int
    risk_count: int
    href: str


class DashboardActivityDTO(BaseModel):
    id: str
    course_id: UUID
    course_name: str
    kind: str
    title: str
    actor_name: str | None = None
    occurred_at: datetime
    href: str


class TeacherDashboardDTO(BaseModel):
    total_pending_actions: int
    total_classes: int
    total_students: int
    total_groups: int
    total_projects: int
    high_risk_groups: int
    medium_risk_groups: int
    classes: list[DashboardClassDTO]
    recent_activity: list[DashboardActivityDTO]


class DashboardActionsDTO(BaseModel):
    total: int
    items: list[TeacherActionItemDTO]


class DashboardRisksDTO(BaseModel):
    total: int
    items: list[GroupRiskAlertDTO]


class DashboardActivityFeedDTO(BaseModel):
    total: int
    items: list[DashboardActivityDTO]
