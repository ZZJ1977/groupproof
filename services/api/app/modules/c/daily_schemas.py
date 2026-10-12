"""C1 read contracts, with explicit limits on canonical activity coverage."""

from datetime import date, datetime
from typing import Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

DailyCategory = Literal["development", "evidence", "discussion"]
DailyEventType = Literal[
    "task_progress",
    "task_note_saved",
    "evidence_submitted",
    "evidence_adopted",
    "evidence_withdrawn",
    "evidence_source_changed",
    "discussion_created",
    "discussion_replied",
]


class DailyActivityFilters(BaseModel):
    model_config = ConfigDict(extra="forbid")

    category: Literal["all", "development", "evidence", "discussion"] = "all"
    project_id: UUID | None = None
    date_from: date | None = Field(default=None, description="Inclusive UTC calendar date.")
    date_to: date | None = Field(default=None, description="Inclusive UTC calendar date.")
    page: int = Field(default=1, ge=1, le=1_000_000)
    page_size: int = Field(default=10, ge=1, le=50)

    @model_validator(mode="after")
    def ordered_dates(self) -> Self:
        if self.date_from and self.date_to and self.date_from > self.date_to:
            raise ValueError("date_from must not be after date_to")
        return self


class DailyTaskCountsDTO(BaseModel):
    not_started: int
    in_progress: int
    pending_submission: int
    pending_verification: int
    completed: int


class DailyProjectDTO(BaseModel):
    id: UUID
    name: str
    lifecycle: Literal["active", "finalized", "archived"]
    progress: int | None = Field(
        description="Canonical tree-weighted progress; null if unavailable."
    )
    progress_status: Literal["available", "no_weighted_tasks", "invalid_task_tree"]
    href: str


class DailyCourseDTO(BaseModel):
    id: UUID
    name: str
    status: Literal["draft", "active", "ended"]
    href: str


class DailyHomeDTO(BaseModel):
    course_count: int
    project_count: int
    my_task_count: int
    my_completed_tasks: int
    task_counts: DailyTaskCountsDTO
    projects: list[DailyProjectDTO] = Field(description="At most 10; updated_at DESC, id ASC.")
    courses: list[DailyCourseDTO] = Field(description="At most 10; updated_at DESC, id ASC.")
    unread_notifications: int | None = Field(default=None, ge=0, strict=True)
    pending_action_items: int | None = Field(default=None, ge=0, strict=True)
    unavailable_sources: list[Literal["notifications", "action_items", "github", "feishu"]]
    scope: str


class DailyActivityDTO(BaseModel):
    id: str
    category: DailyCategory
    event_type: DailyEventType
    project_id: UUID
    project_name: str
    object_type: Literal["task", "evidence", "discussion"]
    object_id: UUID
    title: str
    occurred_at: datetime
    href: str


class DailyActivityPageDTO(BaseModel):
    items: list[DailyActivityDTO]
    page: int
    page_size: int
    total: int
    scope: str
    unavailable_sources: list[Literal["github", "feishu"]]
