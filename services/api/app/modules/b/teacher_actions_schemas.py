"""Request and response schemas for teacher approval & action center (Screen 44)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

TeacherActionType = Literal[
    "join_request",
    "post_deadline_invite",
    "member_leave",
    "member_remove",
    "rule_change_review",
    "milestone_overdue",
    "risk_alert",
    "appeal",
    "notification",
]

ActionPriority = Literal["urgent", "normal", "low"]
ActionStatus = Literal["pending", "handled", "expired", "auto_resolved"]


class ActionDefDTO(BaseModel):
    key: str
    label: str
    requires_reason: bool = False
    confirm_text: str | None = None
    style: Literal["primary", "danger", "secondary"] = "secondary"


class TeacherActionItemDTO(BaseModel):
    id: str
    source_id: str
    type: TeacherActionType
    priority: ActionPriority
    status: ActionStatus
    title: str
    description: str
    course_id: UUID
    group_id: UUID | None = None
    project_id: UUID | None = None
    subject_user_id: UUID | None = None
    href: str
    available_actions: list[ActionDefDTO] = Field(default_factory=list)
    created_at: datetime
    handled_at: datetime | None = None
    handled_by: str | None = None
    decision: str | None = None
    decision_reason: str | None = None


class TeacherActionPageDTO(BaseModel):
    items: list[TeacherActionItemDTO]
    total: int
    pending_count: int
    urgent_count: int
    counts_by_type: dict[str, int]


class HandleAction(BaseModel):
    action_key: str = Field(min_length=1, max_length=64)
    reason: str | None = Field(default=None, max_length=500)


class BatchAction(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=100)
    action_key: str = Field(min_length=1, max_length=64)
    reason: str | None = Field(default=None, max_length=500)


class BatchActionErrorDTO(BaseModel):
    id: str
    code: str
    message: str


class BatchActionResultDTO(BaseModel):
    handled: int
    failed: int
    errors: list[BatchActionErrorDTO]


class RemindAction(BaseModel):
    message: str | None = Field(default=None, max_length=500)


class RemindResultDTO(BaseModel):
    notified_count: int
