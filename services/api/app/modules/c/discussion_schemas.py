from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from app.modules.c.evidence_schemas import Command


class MentionCommand(Command):
    mention_user_ids: list[UUID] = Field(default_factory=list, max_length=50)

    @field_validator("mention_user_ids")
    @classmethod
    def unique_mentions(cls, values: list[UUID]) -> list[UUID]:
        if len(values) != len(set(values)):
            raise ValueError("A user cannot be mentioned twice in one message")
        return values


class CreateDiscussion(MentionCommand):
    expected_version: int = Field(default=0, ge=0, le=0, strict=True)
    title: str = Field(min_length=1, max_length=240)
    body: str = Field(min_length=1, max_length=30000)
    task_id: UUID | None = None
    requirement_id: UUID | None = None
    module_id: UUID | None = None
    milestone_id: UUID | None = None


class ReplyDiscussion(MentionCommand):
    expected_version: int = Field(ge=0, strict=True)
    body: str = Field(min_length=1, max_length=30000)


class MarkDiscussionImportant(Command):
    expected_version: int = Field(ge=0, strict=True)
    is_important: bool = Field(strict=True)
    reason: str = Field(min_length=1, max_length=4000)


class DiscussionDTO(BaseModel):
    id: UUID
    project_id: UUID
    author_id: UUID
    task_id: UUID | None
    requirement_id: UUID | None
    module_id: UUID | None
    milestone_id: UUID | None
    title: str
    body: str
    is_important: bool
    status: str
    lock_version: int
    mention_user_ids: list[UUID]
    reply_count: int
    created_at: datetime
    updated_at: datetime
    last_activity_at: datetime
    evidence_source_id: UUID | None
    source_snapshot_id: UUID | None


class DiscussionReplyDTO(BaseModel):
    id: UUID
    discussion_id: UUID
    author_id: UUID
    body: str
    mention_user_ids: list[UUID]
    created_at: datetime
    updated_at: datetime


class DiscussionPageDTO(BaseModel):
    items: list[DiscussionDTO]
    page: int
    page_size: int
    total: int


class DiscussionRepliesPageDTO(BaseModel):
    items: list[DiscussionReplyDTO]
    page: int
    page_size: int
    total: int
    discussion_lock_version: int


class DiscussionReplyResultDTO(BaseModel):
    discussion: DiscussionDTO
    reply: DiscussionReplyDTO
