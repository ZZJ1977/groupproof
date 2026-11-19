"""Request and response schemas for per-class project monitoring (Screen 61)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.modules.b.milestones_schemas import MilestoneDTO


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ProjectOverviewCardDTO(BaseModel):
    group_id: UUID
    group_name: str
    member_count: int
    leader_name: str | None = None
    has_project: bool
    project_id: UUID | None = None
    project_name: str | None = None
    project_href: str | None = None
    plaza_href: str
    progress_percent: int | None = None
    completed_tasks: int = 0
    total_tasks: int = 0
    milestones_completed: int = 0
    milestones_total: int = 0
    overdue_milestones: int = 0
    risk_level: Literal["high", "medium", "low"] | None = None
    last_activity_at: datetime | None = None


class TeacherProjectsListDTO(BaseModel):
    course_id: UUID
    can_remind: bool
    counts: dict[str, int]
    items: list[ProjectOverviewCardDTO]


class TeacherProjectDetailDTO(BaseModel):
    card: ProjectOverviewCardDTO
    members: list[str]
    milestones: list[MilestoneDTO]
    recent_events: list[str]


class ProjectRemindRequest(Strict):
    message: str | None = Field(default=None, max_length=500)


class ProjectRemindResultDTO(BaseModel):
    group_id: UUID
    notified_count: int
