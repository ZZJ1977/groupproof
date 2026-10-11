from datetime import datetime
from typing import Literal, Self
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, JsonValue, model_validator

from app.modules.c.evidence_schemas import Command


class CreateCourse(Command):
    code: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
    name: str = Field(min_length=1, max_length=200)
    college: str = Field(min_length=1, max_length=160)
    semester: str = Field(min_length=1, max_length=64)
    owner_id: UUID
    reason: str = Field(min_length=1, max_length=2000)
    project_deadline: AwareDatetime
    formation_deadline: AwareDatetime | None = None
    grouping_mode: Literal["free", "approval"] = "free"
    min_group_size: int = Field(default=1, ge=1, le=32767)
    max_group_size: int = Field(default=8, ge=1, le=32767)

    @model_validator(mode="after")
    def consistent_settings(self) -> Self:
        if self.min_group_size > self.max_group_size:
            raise ValueError("Minimum group size exceeds maximum")
        if self.formation_deadline and self.formation_deadline > self.project_deadline:
            raise ValueError("Formation deadline must not follow the project deadline")
        return self


class TransitionCourse(Command):
    action: Literal["publish", "end"]
    reason: str = Field(min_length=1, max_length=2000)
    expected_version: int = Field(ge=0)


class AccessScope(Command):
    project_id: UUID
    resource_type: Literal["project", "task", "evidence"]
    resource_id: UUID
    operation: Literal["read"] = "read"

    @model_validator(mode="after")
    def project_matches(self) -> Self:
        if self.resource_type == "project" and self.resource_id != self.project_id:
            raise ValueError("Project scope must identify its own project")
        return self


class CreateAccessRequest(Command):
    scope: AccessScope
    reason: str = Field(min_length=1, max_length=2000)
    expires_at: AwareDatetime


class DecideAccessRequest(Command):
    decision: Literal["approved", "rejected"]
    reason: str = Field(min_length=1, max_length=2000)
    expected_version: int = Field(ge=0)
    expires_at: AwareDatetime | None = None

    @model_validator(mode="after")
    def approval_expiry(self) -> Self:
        if (self.decision == "approved") != (self.expires_at is not None):
            raise ValueError("Only approval requires an expiry time")
        return self


class CourseFilters(BaseModel):
    model_config = ConfigDict(extra="forbid")
    page: int = Field(default=1, ge=1, le=1_000_000)
    page_size: int = Field(default=10, ge=1, le=100)
    q: str | None = Field(default=None, max_length=200)
    semester: str | None = Field(default=None, max_length=64)
    status: Literal["draft", "active", "ended"] | None = None


class AccessFilters(BaseModel):
    model_config = ConfigDict(extra="forbid")
    page: int = Field(default=1, ge=1, le=1_000_000)
    page_size: int = Field(default=10, ge=1, le=100)
    status: Literal["pending", "approved", "rejected"] | None = None


class GovernanceHistoryDTO(BaseModel):
    id: UUID
    actor_id: UUID
    version_no: int
    action: str
    reason: str
    before: dict[str, JsonValue]
    after: dict[str, JsonValue]
    created_at: datetime


class CourseDTO(BaseModel):
    id: UUID
    code: str
    name: str
    college: str
    semester: str
    owner_id: UUID
    status: Literal["draft", "active", "ended"]
    project_deadline: datetime | None
    formation_deadline: datetime | None
    grouping_mode: Literal["free", "approval"]
    min_group_size: int
    max_group_size: int
    lock_version: int


class CourseDetailDTO(CourseDTO):
    invite_code: str | None
    invite_revoked_at: datetime | None
    history: list[GovernanceHistoryDTO]


class CoursePageDTO(BaseModel):
    items: list[CourseDTO]
    total: int
    page: int
    page_size: int


class AccessRequestDTO(BaseModel):
    id: UUID
    applicant_id: UUID
    scope: AccessScope
    reason: str
    requested_expires_at: datetime
    status: Literal["pending", "approved", "rejected"]
    approved_expires_at: datetime | None
    approval_expired: bool
    authorization_receipt: dict[str, JsonValue] | None
    authorization_state: Literal["not_activated", "receipt_recorded_current_access_not_checked"]
    lock_version: int
    created_at: datetime


class AccessRequestDetailDTO(AccessRequestDTO):
    history: list[GovernanceHistoryDTO]


class AccessRequestPageDTO(BaseModel):
    items: list[AccessRequestDTO]
    total: int
    page: int
    page_size: int
