from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, JsonValue, field_validator, model_validator

from app.modules.c.evidence_schemas import Command

ActivityStatus = Literal["candidate", "adopted", "ignored"]


class ActivityCommand(Command):
    expected_version: int = Field(ge=0)
    reason: str = Field(min_length=1, max_length=2000)


class AssociateActivity(ActivityCommand):
    task_id: UUID | None


class DecideActivity(ActivityCommand):
    action: Literal["adopt", "ignore", "restore"]
    task_id: UUID | None = None
    criterion_ids: list[UUID] = Field(default_factory=list, max_length=100)

    @field_validator("criterion_ids")
    @classmethod
    def unique_criteria(cls, values: list[UUID]) -> list[UUID]:
        if len(set(values)) != len(values):
            raise ValueError("Duplicate criterion IDs are not allowed")
        return values

    @model_validator(mode="after")
    def adoption_fields(self):
        if self.action == "adopt":
            if self.task_id is None or not self.criterion_ids:
                raise ValueError("Adoption requires a task and its acceptance criteria")
        elif self.task_id is not None or self.criterion_ids:
            raise ValueError("Only adoption accepts task and criterion fields")
        return self


class ActivityStateDTO(BaseModel):
    record_id: UUID | None
    project_id: UUID
    source_type: Literal["github", "feishu"]
    source_id: UUID
    status: ActivityStatus
    task_id: UUID | None
    evidence_id: UUID | None
    lock_version: int


class ActivityDTO(ActivityStateDTO):
    title: str
    summary: str
    author_id: UUID | None
    author_name: str
    occurred_at: datetime
    kind: str
    group_id: str | None
    source_identity: str
    source_revision: str
    source_url: str | None
    availability: Literal["available", "deleted"]
    source_changed: bool
    suggested_task_ids: list[UUID]


class ActivityDecisionDTO(BaseModel):
    id: UUID
    actor_id: UUID
    version_no: int
    action: Literal["associate", "adopt", "ignore", "restore"]
    reason: str
    before: dict[str, JsonValue]
    after: dict[str, JsonValue]
    source_revision: str
    source_hash: str
    source_snapshot: dict[str, JsonValue]
    created_at: datetime


class ActivityHistoryDTO(ActivityStateDTO):
    decisions: list[ActivityDecisionDTO]


class ActivityPageDTO(BaseModel):
    items: list[ActivityDTO]
    total: int
    page: int
    page_size: int
