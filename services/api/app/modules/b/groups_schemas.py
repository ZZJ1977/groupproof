"""B-2 request and response shapes (pages 33, 34, 36)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

from app.modules.b.courses_schemas import PersonDTO, Strict


class CreateGroup(Strict):
    name: str = Field(min_length=1, max_length=160)
    direction: str | None = Field(default=None, max_length=200)


class Invite(Strict):
    invitee_id: UUID


class RespondInvitation(Strict):
    accept: bool
    expected_version: int = Field(ge=0, strict=True)


class DecideInvitation(Strict):
    decision: Literal["approve", "reject"]
    reason: str | None = Field(default=None, max_length=1000)
    expected_version: int = Field(ge=0, strict=True)


class StartLeaderChange(Strict):
    candidate_id: UUID
    reason: str = Field(max_length=1000)


class ConfirmLeaderChange(Strict):
    decision: Literal["confirm", "reject"]


class GroupMemberDTO(PersonDTO):
    role: Literal["leader", "member"]
    joined_at: datetime


class GroupSummaryDTO(BaseModel):
    id: UUID
    course_id: UUID
    name: str
    direction: str | None
    leader: PersonDTO | None
    member_count: int
    max_group_size: int
    is_mine: bool
    full: bool
    lock_version: int


class GroupPageDTO(BaseModel):
    items: list[GroupSummaryDTO]
    my_group_id: UUID | None
    formation_open: bool
    formation_deadline: datetime | None


class InvitationDTO(BaseModel):
    id: UUID
    group_id: UUID
    group_name: str
    course_id: UUID
    inviter: PersonDTO | None
    invitee: PersonDTO | None
    status: str
    created_at: datetime
    decided_at: datetime | None
    decision_reason: str | None
    lock_version: int


class LeaderChangeDTO(BaseModel):
    id: UUID
    group_id: UUID
    requested_by: PersonDTO | None
    previous_leader: PersonDTO | None
    candidate: PersonDTO | None
    reason: str
    status: str
    created_at: datetime
    completed_at: datetime | None
    confirmations: dict[str, Literal["confirm", "reject"]]
    waiting_for: list[PersonDTO]


class GroupDetailDTO(GroupSummaryDTO):
    members: list[GroupMemberDTO]
    invitations: list[InvitationDTO]
    leader_change: LeaderChangeDTO | None
    formation_open: bool
    project_id: UUID | None


class CandidateDTO(PersonDTO):
    student_number: str | None
