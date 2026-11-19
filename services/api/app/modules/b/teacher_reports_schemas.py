"""Request and response schemas for teacher class data reports center (Screen 45)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict

ProgressTone = Literal["green", "yellow", "red", "gray"]
ExportFormat = Literal["csv", "markdown", "json"]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ReportsOverviewDTO(BaseModel):
    course_id: UUID
    course_name: str
    student_count: int
    group_count: int
    project_count: int
    ungrouped_count: int
    overall_progress: int | None
    high_risk_groups: int
    medium_risk_groups: int
    overdue_milestones: int
    can_export: bool


class GroupProgressReportDTO(BaseModel):
    group_id: UUID
    group_name: str
    has_project: bool
    project_id: UUID | None = None
    project_name: str | None = None
    progress_percent: int | None
    completed_tasks: int
    total_tasks: int
    overdue_milestones: int
    milestones_completed: int
    milestones_total: int
    tone: ProgressTone


class ReportsProgressDTO(BaseModel):
    course_id: UUID
    items: list[GroupProgressReportDTO]


class MilestoneCellDTO(BaseModel):
    milestone_id: UUID
    title: str
    status: str
    overdue: bool
    progress_percent: int | None
    deadline: datetime | None = None
    completed_task_count: int
    task_count: int


class GroupMilestoneMatrixRowDTO(BaseModel):
    group_id: UUID
    group_name: str
    project_id: UUID | None = None
    project_name: str | None = None
    milestones: list[MilestoneCellDTO]


class ReportsMilestonesDTO(BaseModel):
    course_id: UUID
    rows: list[GroupMilestoneMatrixRowDTO]


class RiskEntryDTO(BaseModel):
    id: UUID
    title: str
    level: str
    status: str
    due_at: datetime | None = None


class GroupRiskAlertDTO(BaseModel):
    group_id: UUID
    group_name: str
    project_id: UUID | None = None
    project_name: str | None = None
    risk_level: Literal["high", "medium"]
    overdue_milestones: int
    progress_percent: int | None
    open_risk_count: int
    reasons: list[str]
    risks: list[RiskEntryDTO]


class ReportsRisksDTO(BaseModel):
    course_id: UUID
    items: list[GroupRiskAlertDTO]


class StudentActivityRankDTO(BaseModel):
    user_id: UUID
    name: str
    student_number: str | None = None
    group_name: str | None = None
    github_events: int
    progress_events: int
    completed_tasks: int
    total_score: int
    low_activity: bool


class ReportsActivityDTO(BaseModel):
    course_id: UUID
    feishu_message_count: int
    total_github_events: int
    total_progress_events: int
    items: list[StudentActivityRankDTO]


class ContributionMemberDTO(BaseModel):
    user_id: UUID
    name: str
    student_number: str | None = None
    share: float
    task_credit: float
    collaboration_credit: float
    acceptance_rate: float
    status: str
    note: str | None = None


class ProjectContributionDTO(BaseModel):
    project_id: UUID
    project_name: str
    group_id: UUID | None = None
    group_name: str | None = None
    snapshot_id: UUID | None = None
    version_no: int | None = None
    status: str | None = None
    frozen_at: datetime | None = None
    items: list[ContributionMemberDTO]


class ReportsContributionDTO(BaseModel):
    course_id: UUID
    projects: list[ProjectContributionDTO]


class ExportReportRequest(Strict):
    format: ExportFormat = "csv"


class ReportExportDTO(BaseModel):
    format: ExportFormat
    filename: str
    mime_type: str
    content: str
    download_href: str
