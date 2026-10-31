"""C1 inbox contracts. A owns notification facts, delivery and read mutations."""

from typing import Literal, Self
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

from app.modules.c.evidence_schemas import Command


class InboxContract(BaseModel):
    model_config = ConfigDict(extra="forbid")


class InboxTarget(InboxContract):
    kind: Literal[
        "project",
        "task",
        "verification",
        "evidence",
        "discussion",
        "course",
        "member_change",
        "appeal",
        "baseline",
        "plan",
        "rule_change",
    ]
    id: UUID
    project_id: UUID | None = None
    course_id: UUID | None = None

    @model_validator(mode="after")
    def scoped_target(self) -> Self:
        if self.kind in {"course", "member_change", "appeal", "rule_change"}:
            if self.project_id is not None or self.course_id is None:
                raise ValueError("Course targets require only their course scope")
            if self.kind == "course" and self.id != self.course_id:
                raise ValueError("Course target must identify its own course")
        elif (
            self.course_id is not None
            or self.project_id is None
            or (self.kind in {"project", "baseline", "plan"} and self.id != self.project_id)
        ):
            raise ValueError("Project targets require their exact project")
        return self


class NotificationFilters(InboxContract):
    state: Literal["all", "unread", "read"] = "all"
    category: Literal["all", "course", "project", "system"] = "all"
    page: int = Field(default=1, ge=1, le=1_000_000)
    page_size: int = Field(default=10, ge=1, le=50)


class ActionItemFilters(InboxContract):
    status: Literal["all", "pending", "completed", "rejected"] = "pending"
    category: Literal[
        "all", "task", "verification", "evidence", "rule", "appeal", "member", "course"
    ] = "all"
    page: int = Field(default=1, ge=1, le=1_000_000)
    page_size: int = Field(default=10, ge=1, le=50)


class NotificationRecord(InboxContract):
    id: UUID
    recipient_id: UUID
    category: Literal["course", "project", "system"]
    title: str = Field(min_length=1, max_length=300)
    description: str = Field(max_length=2000)
    created_at: AwareDatetime
    read_at: AwareDatetime | None
    lock_version: int = Field(ge=0, strict=True)
    target: InboxTarget | None

    @model_validator(mode="after")
    def ordered_read(self) -> Self:
        if self.read_at and self.read_at < self.created_at:
            raise ValueError("Read time must not precede creation")
        return self


class ActionItemRecord(InboxContract):
    id: UUID
    recipient_id: UUID
    category: Literal["task", "verification", "evidence", "rule", "appeal", "member", "course"]
    title: str = Field(min_length=1, max_length=300)
    description: str = Field(max_length=2000)
    status: Literal["pending", "completed", "rejected"]
    priority: Literal["low", "medium", "high"]
    created_at: AwareDatetime
    due_at: AwareDatetime | None
    target: InboxTarget

    @model_validator(mode="after")
    def valid_action_destination(self) -> Self:
        allowed = {
            "task": {"task", "plan", "baseline"},
            "verification": {"verification"},
            "evidence": {"evidence", "task"},
            "rule": {"rule_change", "course", "baseline", "plan"},
            "appeal": {"appeal"},
            "member": {"member_change"},
            "course": {"course"},
        }
        if self.target.kind not in allowed[self.category]:
            raise ValueError("Action category does not match its processing destination")
        return self


class NotificationDTO(NotificationRecord):
    href: str | None


class ActionItemDTO(ActionItemRecord):
    href: str


class NotificationPageDTO(InboxContract):
    items: list[NotificationDTO]
    total: int = Field(ge=0)
    total_all: int = Field(ge=0)
    unread_total: int = Field(ge=0)
    page: int
    page_size: int
    snapshot_id: UUID
    inbox_version: int = Field(ge=0)


class ActionItemPageDTO(InboxContract):
    items: list[ActionItemDTO]
    total: int = Field(ge=0)
    page: int
    page_size: int


class MarkNotificationRead(Command):
    expected_version: int = Field(ge=0, strict=True)
    expected_inbox_version: int = Field(ge=0, strict=True)
    snapshot_id: UUID


class MarkAllNotificationsRead(Command):
    expected_inbox_version: int = Field(ge=0, strict=True)
    snapshot_id: UUID


class NotificationReadReceipt(InboxContract):
    recipient_id: UUID
    operation: Literal["single", "all"]
    notification_id: UUID | None
    idempotency_key: str = Field(min_length=1, max_length=128)
    snapshot_id: UUID
    expected_version: int | None = Field(ge=0, strict=True)
    expected_inbox_version: int = Field(ge=0, strict=True)
    resulting_version: int | None = Field(ge=0, strict=True)
    resulting_inbox_version: int = Field(ge=0, strict=True)
    total_all: int = Field(ge=0, strict=True)
    unread_before: int = Field(ge=0, strict=True)
    unread_after: int = Field(ge=0, strict=True)
    marked_count: int = Field(ge=0, strict=True)
    read_at: AwareDatetime
