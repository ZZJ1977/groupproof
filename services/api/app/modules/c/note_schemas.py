from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field

from app.modules.c.evidence_schemas import Command


class SaveTaskNote(Command):
    expected_version: int = Field(ge=0, strict=True)
    title: str = Field(min_length=1, max_length=240)
    body: str = Field(min_length=1, max_length=100000)


class TaskNoteVersionDTO(BaseModel):
    id: UUID
    version_no: int
    title: str
    body: str
    edited_by: UUID
    content_hash: str
    created_at: datetime


class TaskNoteDTO(BaseModel):
    id: UUID
    project_id: UUID
    task_id: UUID
    lock_version: int
    current_version_no: int
    versions: list[TaskNoteVersionDTO]
