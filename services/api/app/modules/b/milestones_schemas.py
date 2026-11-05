"""B-8 milestone shapes (pages 18–19, B7-01 ~ B7-04)."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, Field

from app.modules.b.courses_schemas import PersonDTO, Strict


class AddDeliverable(Strict):
    title: str = Field(min_length=1, max_length=200)


class CheckDeliverable(Strict):
    done: bool
    file_id: UUID | None = None
    expected_version: int = Field(ge=0)


class CompleteMilestone(Strict):
    expected_version: int = Field(ge=0)


class Reschedule(Strict):
    deadline: AwareDatetime
    reason: str = Field(default="", max_length=2000)
    expected_version: int = Field(ge=0)


class FileRefDTO(BaseModel):
    id: UUID
    name: str
    href: str


class DeliverableEventDTO(BaseModel):
    action: str
    actor: PersonDTO | None
    at: datetime
    file: FileRefDTO | None


class DeliverableDTO(BaseModel):
    id: UUID
    title: str
    done: bool
    done_by: PersonDTO | None
    done_at: datetime | None
    file: FileRefDTO | None
    lock_version: int
    history: list[DeliverableEventDTO]


class DateChangeDTO(BaseModel):
    old_deadline: datetime | None
    new_deadline: datetime
    reason: str
    changed_by: PersonDTO | None
    changed_at: datetime


class MilestoneTaskDTO(BaseModel):
    id: UUID
    code: str | None
    title: str
    status: str
    progress_percent: int
    weight: int
    assignees: list[PersonDTO]
    href: str


class MilestoneDTO(BaseModel):
    id: UUID
    title: str
    description: str | None
    deadline: datetime | None
    status: str
    overdue: bool
    progress_percent: int | None
    task_count: int
    completed_task_count: int
    deliverables_done: int
    deliverables_total: int
    # D's risk assessment; null until D provides one (never invented here).
    risk: dict | None
    lock_version: int
    href: str


class MilestoneDetailDTO(MilestoneDTO):
    tasks: list[MilestoneTaskDTO]
    deliverables: list[DeliverableDTO]
    date_changes: list[DateChangeDTO]
    can_lead: bool
    files: list[FileRefDTO]


class MilestoneListDTO(BaseModel):
    items: list[MilestoneDTO]
    can_lead: bool
