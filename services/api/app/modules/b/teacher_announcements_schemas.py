"""Request and response schemas for teacher course announcements and student read receipts."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

AnnouncementPriority = Literal["normal", "important", "urgent"]
AnnouncementStatus = Literal["draft", "published"]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AnnouncementDTO(BaseModel):
    id: UUID
    course_id: UUID
    course_name: str
    title: str
    content: str
    priority: AnnouncementPriority
    is_pinned: bool
    status: AnnouncementStatus
    published_by: UUID
    publisher_name: str | None = None
    published_at: datetime | None = None
    created_at: datetime
    updated_at: datetime
    read_count: int = 0
    total_students: int = 0
    unread_count: int = 0


class AnnouncementListDTO(BaseModel):
    course_id: UUID
    can_post: bool
    total_students: int
    items: list[AnnouncementDTO]


class AnnouncementReaderDTO(BaseModel):
    user_id: UUID
    name: str
    student_number: str | None = None
    read_at: datetime | None = None


class AnnouncementReadsDTO(BaseModel):
    announcement_id: UUID
    title: str
    total_students: int
    read_count: int
    unread_count: int
    read_users: list[AnnouncementReaderDTO]
    unread_users: list[AnnouncementReaderDTO]


class UnreadAnnouncementsDTO(BaseModel):
    total: int
    items: list[AnnouncementDTO]


class CreateAnnouncementRequest(Strict):
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=10000)
    priority: AnnouncementPriority = "normal"
    is_pinned: bool = False
    status: AnnouncementStatus = "published"


class UpdateAnnouncementRequest(Strict):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    content: str | None = Field(default=None, min_length=1, max_length=10000)
    priority: AnnouncementPriority | None = None
    is_pinned: bool | None = None
    status: AnnouncementStatus | None = None


class RemindAnnouncementResultDTO(BaseModel):
    announcement_id: UUID
    notified_count: int


class MarkReadResultDTO(BaseModel):
    announcement_id: UUID
    read: bool
    read_at: datetime


class DeleteAnnouncementResultDTO(BaseModel):
    deleted: bool
    id: UUID
