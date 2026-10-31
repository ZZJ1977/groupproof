"""C2 execution contracts; planning fields and arbitrary status patches are excluded."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.modules.c.note_schemas import SaveTaskNote, TaskNoteDTO

TaskStatus = Literal[
    "not_started", "in_progress", "pending_submission", "pending_verification", "completed"
]


class StartTaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_version: int = Field(ge=0, strict=True)


class UpdateProgressRequest(StartTaskRequest):
    progress: int = Field(ge=0, le=100, strict=True)
    reason: str = Field(min_length=1, max_length=2000)

    @field_validator("reason")
    @classmethod
    def non_blank_reason(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("A progress change reason is required.")
        return value


class TaskDependencyView(BaseModel):
    task_id: UUID
    status: TaskStatus | None
    satisfied: bool


class TaskExecutionView(BaseModel):
    task_id: UUID
    project_id: UUID
    status: TaskStatus
    progress: int
    version: int
    started_at: datetime | None
    completed_at: datetime | None
    responsible_ids: list[UUID]
    dependencies: list[TaskDependencyView]
    project_progress: int | None
    module_progress: dict[str, int | None]
    can_start: bool
    can_update_progress: bool
    read_only: bool


class PrepareSubmissionRequest(StartTaskRequest):
    # Absence preserves the current draft. D checks whether required work is missing.
    note: SaveTaskNote | None = None


class PrepareSubmissionView(BaseModel):
    execution: TaskExecutionView
    note: TaskNoteDTO | None
