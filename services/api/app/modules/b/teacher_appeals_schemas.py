"""Request and response schemas for teacher course appeals and contribution adjustments."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

AppealType = Literal["contribution", "task", "score", "other"]
AppealStatus = Literal["pending", "need_supplement", "accepted", "rejected"]
AppealHandleAction = Literal["reject", "request_supplement", "accept"]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AppealSummaryDTO(BaseModel):
    id: UUID
    course_id: UUID
    project_id: UUID
    project_name: str
    group_name: str | None = None
    appellant_id: UUID
    appellant_name: str
    student_number: str | None = None
    appeal_type: AppealType
    title: str
    content: str
    supplement_text: str | None = None
    evidence: list[str]
    status: AppealStatus
    resolved_by: UUID | None = None
    resolver_name: str | None = None
    resolved_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class AppealListDTO(BaseModel):
    course_id: UUID
    can_handle: bool
    counts: dict[str, int]
    items: list[AppealSummaryDTO]


class AppealDecisionDTO(BaseModel):
    id: UUID
    actor_id: UUID
    actor_name: str
    action: str
    reason: str
    snapshot_id: UUID | None = None
    adjustments: list[dict] | None = None
    created_at: datetime


class AppealTaskRefDTO(BaseModel):
    id: UUID
    title: str
    status: str
    progress_percent: int


class AppealContributionMemberDTO(BaseModel):
    user_id: UUID
    name: str
    student_number: str | None = None
    share: float
    task_credit: float
    collaboration_credit: float
    acceptance_rate: float
    status: str
    note: str | None = None


class AppealSnapshotContextDTO(BaseModel):
    snapshot_id: UUID | None = None
    version_no: int | None = None
    status: str | None = None
    frozen_at: datetime | None = None
    items: list[AppealContributionMemberDTO]


class AppealDetailDTO(BaseModel):
    appeal: AppealSummaryDTO
    can_handle: bool
    decisions: list[AppealDecisionDTO]
    appellant_tasks: list[AppealTaskRefDTO]
    github_commit_count: int
    snapshot: AppealSnapshotContextDTO


class SubmitAppealRequest(Strict):
    project_id: UUID | None = None
    appeal_type: AppealType = "contribution"
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=10000)
    evidence: list[str] = Field(default_factory=list, max_length=20)


class SupplementAppealRequest(Strict):
    supplement_text: str = Field(min_length=1, max_length=10000)
    evidence: list[str] = Field(default_factory=list, max_length=20)


class ContributionAdjustmentItem(Strict):
    user_id: UUID
    share: float = Field(ge=0.0, le=100.0)
    task_credit: float | None = Field(default=None, ge=0.0)
    collaboration_credit: float | None = Field(default=None, ge=0.0)
    acceptance_rate: float | None = Field(default=None, ge=0.0, le=100.0)
    note: str | None = Field(default=None, max_length=500)


class HandleAppealRequest(Strict):
    action: AppealHandleAction
    reason: str = Field(min_length=1, max_length=2000)
    contribution_adjustments: list[ContributionAdjustmentItem] = Field(default_factory=list)
