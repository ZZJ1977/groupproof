from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    HttpUrl,
    JsonValue,
    field_validator,
    model_validator,
)

EvidenceStatus = Literal["candidate", "pending_confirmation", "formal", "withdrawn", "void"]
EvidenceSourceType = Literal["manual", "task_note", "file", "screenshot", "github", "feishu"]


class EvidenceDTO(BaseModel):
    id: UUID
    project_id: UUID
    task_id: UUID
    author_id: UUID
    title: str
    description: str
    source_type: EvidenceSourceType
    source_url: str | None
    status: EvidenceStatus
    criterion_ids: list[UUID]
    source_changed: bool
    lock_version: int
    created_at: datetime
    updated_at: datetime
    effective: bool
    original_snapshot_id: UUID | None


class EvidenceSnapshotDTO(BaseModel):
    id: UUID
    version_no: int
    source_identity: str
    source_revision: str
    content_hash: str
    content: dict[str, JsonValue]
    created_at: datetime


class EvidenceDecisionDTO(BaseModel):
    id: UUID
    actor_id: UUID
    decision: Literal["submitted", "adopted", "withdrawn", "source_changed"]
    resulting_status: EvidenceStatus
    reason: str
    created_at: datetime


class EvidenceDetailDTO(EvidenceDTO):
    source_snapshots: list[EvidenceSnapshotDTO]
    decisions: list[EvidenceDecisionDTO]


class EvidencePageDTO(BaseModel):
    items: list[EvidenceDTO]
    total: int
    offset: int
    limit: int
    page: int
    page_size: int


class Command(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class CreateEvidence(Command):
    task_id: UUID
    title: str = Field(min_length=1, max_length=240)
    description: str = Field(min_length=1, max_length=30000)
    source_type: Literal["manual", "task_note", "file", "screenshot", "github", "feishu"]
    source_id: UUID | None = None
    source_url: HttpUrl | None = None
    criterion_ids: list[UUID] = Field(min_length=1, max_length=100)

    @field_validator("criterion_ids")
    @classmethod
    def unique_criteria(cls, value: list[UUID]) -> list[UUID]:
        if len(set(value)) != len(value):
            raise ValueError("criterion_ids must not contain duplicates")
        return value

    @model_validator(mode="after")
    def source_requirements(self) -> CreateEvidence:
        if self.source_type != "manual" and self.source_id is None:
            raise ValueError("This source type requires a verified source_id")
        if self.source_type == "manual" and self.source_id is not None:
            raise ValueError("Manual evidence does not accept a source_id")
        if self.source_type != "manual" and self.source_url is not None:
            raise ValueError("The source adapter supplies the verified URL")
        if self.source_url is not None and (self.source_url.username or self.source_url.password):
            raise ValueError("Source URLs cannot contain credentials")
        return self


class DecideEvidence(Command):
    expected_version: int = Field(ge=0, strict=True)
    reason: str = Field(min_length=1, max_length=4000)


class CheckEvidenceSource(DecideEvidence):
    source_id: UUID
