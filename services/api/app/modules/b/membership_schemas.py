"""B-8 member removal / leaving with task handover (B2-04, B2-06, B2-07)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

from app.modules.b.courses_schemas import PersonDTO, Strict


class Handover(Strict):
    task_id: UUID
    to_user_id: UUID


class StartMembershipChange(Strict):
    change_type: Literal["remove", "leave"]
    # Required for "remove"; "leave" is always about the caller.
    member_id: UUID | None = None
    reason: str = Field(default="", max_length=2000)
    handovers: list[Handover] = Field(default_factory=list, max_length=500)


class EditMembershipChange(Strict):
    reason: str = Field(default="", max_length=2000)
    handovers: list[Handover] = Field(default_factory=list, max_length=500)
    expected_version: int = Field(ge=0, strict=True)


class DecideMembershipChange(Strict):
    decision: Literal["approve", "reject", "needs_info"]
    comment: str | None = Field(default=None, max_length=2000)
    expected_version: int = Field(ge=0, strict=True)


class OpenTaskDTO(BaseModel):
    id: UUID
    project_id: UUID
    code: str | None
    title: str
    status: str
    href: str


class OpenTasksDTO(BaseModel):
    member: PersonDTO
    tasks: list[OpenTaskDTO]
    candidates: list[PersonDTO]
    # True: the change applies at once; False: it waits for the teacher.
    applies_immediately: bool
    is_leader: bool


class HandoverDTO(BaseModel):
    task_id: UUID
    code: str | None
    title: str
    status: str
    from_user: PersonDTO | None
    to_user: PersonDTO | None
    applied_at: datetime | None


class MembershipChangeDTO(BaseModel):
    id: UUID
    course_id: UUID
    group_id: UUID
    group_name: str
    project_id: UUID | None
    change_type: str
    member: PersonDTO | None
    requested_by: PersonDTO | None
    status: str
    reason: str
    teacher_comment: str | None
    decided_by: PersonDTO | None
    decided_at: datetime | None
    applied_at: datetime | None
    created_at: datetime
    lock_version: int
    handovers: list[HandoverDTO]
    can_edit: bool
