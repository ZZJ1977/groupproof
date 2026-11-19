"""Schemas for teacher class creation, student roster, team plaza, and group progress."""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Self
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, Field, model_validator

from app.modules.b.milestones_schemas import MilestoneDTO

JoinMode = Literal["direct", "approval"]
ClassTab = Literal["active", "ended", "all"]
RosterFilter = Literal["all", "grouped", "ungrouped"]
ProgressState = Literal["no_project", "no_milestones", "tracking"]
RiskLevel = Literal["low", "medium", "high"]


class CreateClass(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    semester: str = Field(min_length=1, max_length=64)
    college: str = Field(min_length=1, max_length=160)
    code: str | None = Field(default=None, max_length=64, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
    project_deadline: AwareDatetime
    formation_deadline: AwareDatetime | None = None
    min_group_size: int = Field(default=1, ge=1, le=50)
    max_group_size: int = Field(default=6, ge=1, le=50)
    join_mode: JoinMode = "direct"

    @model_validator(mode="after")
    def validate_bounds(self) -> Self:
        if self.min_group_size > self.max_group_size:
            raise ValueError("min_group_size must not exceed max_group_size")
        if self.formation_deadline and self.formation_deadline > self.project_deadline:
            raise ValueError("formation_deadline must not follow project_deadline")
        return self


class RotateInvite(BaseModel):
    expected_version: int = Field(ge=0)


class RemoveStudent(BaseModel):
    reason: str = Field(min_length=1, max_length=500)


class TeacherCreateGroup(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    direction: str | None = Field(default=None, max_length=200)


class Assign(BaseModel):
    student_id: UUID
    to_group_id: UUID | None = None
    from_group_version: int | None = None
    to_group_version: int | None = None
    reason: str | None = Field(default=None, max_length=500)


class SetLeader(BaseModel):
    user_id: UUID
    expected_version: int = Field(ge=0)


class GroupRefDTO(BaseModel):
    id: UUID
    name: str


class ProjectRefDTO(BaseModel):
    id: UUID
    name: str
    href: str


class TeacherClassSummaryDTO(BaseModel):
    id: UUID
    code: str
    name: str
    semester: str
    college: str
    status: str
    student_count: int
    group_count: int
    ungrouped_count: int
    pending_join_count: int
    href: str


class TeacherClassPageDTO(BaseModel):
    items: list[TeacherClassSummaryDTO]
    counts: dict[str, int]


class ClassDetailDTO(TeacherClassSummaryDTO):
    invite_code: str | None
    join_url: str | None
    join_mode: JoinMode
    project_deadline: datetime | None
    formation_deadline: datetime | None
    min_group_size: int
    max_group_size: int
    lock_version: int
    can_manage: bool


class RosterStudentDTO(BaseModel):
    id: UUID
    name: str | None
    student_number: str | None
    email: str | None
    initial: str
    joined_at: datetime
    status: Literal["grouped", "ungrouped", "left"]
    group: GroupRefDTO | None
    is_leader: bool
    in_project_group: bool


class RosterDTO(BaseModel):
    items: list[RosterStudentDTO]
    counts: dict[str, int]
    pending_join_count: int


class MilestoneRefDTO(BaseModel):
    id: UUID
    title: str
    deadline: datetime | None
    href: str


class GroupProgressDTO(BaseModel):
    state: ProgressState
    milestones_total: int
    milestones_completed: int
    overall_percent: int | None
    next_milestone: MilestoneRefDTO | None
    overdue_count: int
    risk_level: RiskLevel | None


class PlazaMemberDTO(BaseModel):
    id: UUID
    name: str | None
    student_number: str | None
    initial: str
    is_leader: bool


class PlazaGroupDTO(BaseModel):
    id: UUID
    name: str
    direction: str | None
    leader_id: UUID | None
    members: list[PlazaMemberDTO]
    member_count: int
    max_group_size: int
    roster_frozen: bool
    has_project: bool
    project: ProjectRefDTO | None
    lock_version: int
    accepts_drop: bool
    locked_reason: str | None
    members_locked: bool
    progress: GroupProgressDTO
    href: str


class PlazaDTO(BaseModel):
    course_id: UUID
    groups: list[PlazaGroupDTO]
    ungrouped: list[PlazaMemberDTO]
    formation_deadline: datetime | None
    formation_open: bool
    can_manage: bool


class AssignResultDTO(BaseModel):
    student_id: UUID
    from_group: PlazaGroupDTO | None
    to_group: PlazaGroupDTO | None


class TeacherGroupMemberDTO(BaseModel):
    id: UUID
    name: str | None
    student_number: str | None
    email: str | None
    role: Literal["leader", "member"]
    joined_at: datetime
    open_task_count: int


class TeacherGroupDetailDTO(BaseModel):
    group: PlazaGroupDTO
    members: list[TeacherGroupMemberDTO]
    milestones: list[MilestoneDTO]
    member_changes_href: str


class ClassSettingsDTO(ClassDetailDTO):
    description: str | None = None
    archived_at: datetime | None = None
    can_delete: bool
    is_owner: bool


class UpdateSettings(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    semester: str | None = Field(default=None, min_length=1, max_length=64)
    college: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=2000)
    formation_deadline: AwareDatetime | None = None
    project_deadline: AwareDatetime | None = None
    min_group_size: int | None = Field(default=None, ge=1, le=50)
    max_group_size: int | None = Field(default=None, ge=1, le=50)
    join_mode: JoinMode | None = None
    expected_version: int = Field(ge=0)


class EndClass(BaseModel):
    reason: str = Field(min_length=1, max_length=500)
    expected_version: int = Field(ge=0)


class ArchiveClass(BaseModel):
    expected_version: int = Field(ge=0)


class ReopenClass(BaseModel):
    reason: str = Field(min_length=1, max_length=500)
    expected_version: int = Field(ge=0)


class DeleteClassResultDTO(BaseModel):
    deleted: bool = True
    course_id: UUID
