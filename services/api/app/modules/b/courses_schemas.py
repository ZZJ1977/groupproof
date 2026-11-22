"""B-1 request and response shapes (pages 31–32, teacher join approvals)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class InviteCode(Strict):
    invite_code: str = Field(min_length=1, max_length=128)


class JoinCourse(InviteCode):
    message: str | None = Field(default=None, max_length=500)


class DecideJoin(Strict):
    decision: Literal["approve", "reject"]
    reason: str | None = Field(default=None, max_length=1000)
    expected_version: int = Field(ge=0, strict=True)


class SetJoinPolicy(Strict):
    mode: Literal["direct", "approval"]
    expected_version: int = Field(ge=0, strict=True)


class MyCourseFilters(Strict):
    tab: Literal["all", "active", "ended"] = "all"
    q: str | None = Field(default=None, max_length=100)
    page: int = Field(default=1, ge=1, le=100_000)
    page_size: int = Field(default=20, ge=1, le=50)


class JoinRequestFilters(Strict):
    status: Literal["all", "pending", "approved", "rejected", "cancelled"] = "pending"
    page: int = Field(default=1, ge=1, le=100_000)
    page_size: int = Field(default=20, ge=1, le=50)


class PersonDTO(BaseModel):
    id: UUID
    name: str | None


class RefDTO(BaseModel):
    id: UUID
    name: str


class MyCourseDTO(BaseModel):
    id: UUID
    code: str
    name: str
    semester: str
    college: str
    status: str
    role: str
    joined_at: datetime
    teacher: PersonDTO | None
    formation_deadline: datetime | None
    project_deadline: datetime | None
    group: RefDTO | None
    project: RefDTO | None
    pending_count: int


class PendingJoinDTO(BaseModel):
    request_id: UUID
    course_id: UUID
    course_name: str
    created_at: datetime


class MyCoursePageDTO(BaseModel):
    items: list[MyCourseDTO]
    total: int
    page: int
    page_size: int
    counts: dict[str, int]
    pending_joins: list[PendingJoinDTO]


class CoursePreviewDTO(BaseModel):
    course_id: UUID
    code: str
    name: str
    semester: str
    college: str
    teacher: PersonDTO | None
    grouping_mode: str
    min_group_size: int
    max_group_size: int
    formation_deadline: datetime | None
    project_deadline: datetime | None
    join_mode: Literal["direct", "approval"]
    already_member: bool
    pending_request_id: UUID | None


class JoinResultDTO(BaseModel):
    status: Literal["joined", "pending"]
    course_id: UUID
    request_id: UUID | None = None


class JoinRequestDTO(BaseModel):
    id: UUID
    course_id: UUID
    student: PersonDTO
    student_email: str | None
    student_number: str | None
    status: str
    message: str | None
    created_at: datetime
    decided_by: UUID | None
    decided_at: datetime | None
    decision_reason: str | None
    lock_version: int


class JoinRequestPageDTO(BaseModel):
    items: list[JoinRequestDTO]
    total: int
    page: int
    page_size: int


class JoinPolicyDTO(BaseModel):
    course_id: UUID
    mode: Literal["direct", "approval"]
    lock_version: int
