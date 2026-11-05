"""B-3 request and response shapes (pages 35, 07, 08 steps 1–2)."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from app.modules.b.courses_schemas import PersonDTO, Strict

MAX_TEXT_MATERIAL = 200_000


class MilestoneTemplateItem(Strict):
    title: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    deadline: datetime | None = None


class SetProjectTemplate(Strict):
    milestones: list[MilestoneTemplateItem] = Field(max_length=20)
    expected_version: int = Field(ge=0, strict=True)


class ProjectTemplateDTO(BaseModel):
    course_id: UUID
    milestones: list[MilestoneTemplateItem]
    lock_version: int


class SaveDraft(Strict):
    payload: dict[str, Any]
    step: int = Field(ge=0, le=10)
    expected_version: int = Field(ge=0, strict=True)

    @field_validator("payload")
    @classmethod
    def small_payload(cls, value: dict[str, Any]) -> dict[str, Any]:
        if len(str(value)) > 20_000:
            raise ValueError("draft is too large")
        return value


class DraftDTO(BaseModel):
    group_id: UUID
    payload: dict[str, Any]
    step: int
    lock_version: int
    updated_at: datetime | None
    project_id: UUID | None


class CreateProject(Strict):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    project_type: str | None = Field(default=None, max_length=80)


class CreatedProjectDTO(BaseModel):
    project_id: UUID
    href: str


class ProjectStatsDTO(BaseModel):
    task_count: int
    completed_count: int
    progress: int | None
    progress_status: Literal["available", "no_weighted_tasks", "invalid_task_tree"]
    member_count: int
    milestone_count: int


class MilestoneBriefDTO(BaseModel):
    id: UUID
    title: str
    deadline: datetime | None
    status: str


class OverviewDTO(BaseModel):
    id: UUID
    name: str
    description: str | None
    course_id: UUID | None
    group_id: UUID | None
    setup_status: str
    setup_step: int
    lifecycle: str
    entry: Literal["setup", "baseline", "readonly"]
    can_edit: bool
    is_leader: bool
    final_deadline: datetime | None
    stats: ProjectStatsDTO
    next_milestone: MilestoneBriefDTO | None
    members: list[PersonDTO]
    lock_version: int


class SaveBasic(Strict):
    name: str = Field(min_length=1, max_length=200)
    project_type: str | None = Field(default=None, max_length=80)
    description: str | None = Field(default=None, max_length=5000)
    start_date: date
    end_date: date
    expected_version: int = Field(ge=0, strict=True)


class AddMaterial(Strict):
    kind: Literal["text", "file"]
    title: str | None = Field(default=None, max_length=255)
    text: str | None = Field(default=None, max_length=MAX_TEXT_MATERIAL)
    receipt_id: UUID | None = None


class MaterialDTO(BaseModel):
    id: UUID
    kind: Literal["text", "file"]
    title: str
    extract_status: Literal["ready", "pending", "failed", "unavailable"]
    extract_reason: str | None
    text_length: int
    text: str | None = None
    created_by: PersonDTO | None
    created_at: datetime


class SetupDTO(BaseModel):
    project_id: UUID
    name: str
    project_type: str | None
    description: str | None
    start_date: date | None
    end_date: date | None
    course_deadline: date | None
    setup_status: str
    setup_step: int
    can_edit: bool
    materials: list[MaterialDTO]
    lock_version: int
