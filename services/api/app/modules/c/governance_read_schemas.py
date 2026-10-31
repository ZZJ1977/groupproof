from datetime import date
from decimal import Decimal
from typing import Literal, Self
from uuid import UUID

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    field_validator,
    model_validator,
)


class ReadContract(BaseModel):
    model_config = ConfigDict(extra="forbid")


AuditActorRole = Literal["student", "leader", "teacher", "ta", "admin", "system"]
AuditTargetType = Literal["user", "course", "project", "task", "evidence", "system"]


class AuditFilters(ReadContract):
    page: int = Field(default=1, ge=1, le=1_000_000)
    page_size: int = Field(default=10, ge=1, le=100)
    actor_id: UUID | None = None
    actor_role: AuditActorRole | None = None
    target_type: AuditTargetType | None = None
    target_id: UUID | None = None
    action: str | None = Field(default=None, min_length=1, max_length=100)
    result: Literal["success", "failure"] | None = None
    since: AwareDatetime | None = None
    until: AwareDatetime | None = None

    @model_validator(mode="after")
    def ordered_dates(self) -> Self:
        if self.since and self.until and self.since > self.until:
            raise ValueError("since must not follow until")
        return self


class AuditRecord(ReadContract):
    id: UUID
    actor_id: UUID
    actor_role: AuditActorRole
    action: str = Field(min_length=1, max_length=100)
    occurred_at: AwareDatetime
    target_type: AuditTargetType
    target_id: UUID | None
    result: Literal["success", "failure"]
    reason: str = Field(min_length=1, max_length=2000)
    before: dict[str, JsonValue]
    after: dict[str, JsonValue]

    @field_validator("before", "after")
    @classmethod
    def safe_metadata_only(cls, value):
        # A must project metadata, not arbitrary source rows or protected content.
        allowed = {
            "status",
            "role",
            "global_role",
            "college",
            "semester",
            "owner_id",
            "project_id",
            "lock_version",
            "is_important",
            "source_type",
            "version_no",
            "email_verified",
            "expires_at",
            "resource_type",
            "resource_id",
            "operation",
        }
        if set(value) - allowed or any(isinstance(item, dict | list) for item in value.values()):
            raise ValueError("Audit changes must contain only approved scalar metadata fields")
        return value


class AuditPageDTO(ReadContract):
    items: list[AuditRecord]
    total: int = Field(ge=0)
    page: int = Field(ge=1)
    page_size: int = Field(ge=1, le=100)


class UsageFilters(ReadContract):
    days: Literal[7, 30, 90] = 7
    user_id: UUID | None = None
    feature: str | None = Field(default=None, min_length=1, max_length=100)
    model: str | None = Field(default=None, min_length=1, max_length=160)

    @field_validator("days", mode="before")
    @classmethod
    def query_days(cls, value):
        # HTTP query parameters arrive as strings; keep the public literal enum.
        return int(value) if isinstance(value, str) and value in {"7", "30", "90"} else value


class UsageSample(ReadContract):
    id: UUID
    user_id: UUID
    occurred_at: AwareDatetime
    feature: str = Field(min_length=1, max_length=100)
    model: str = Field(min_length=1, max_length=160)
    success: bool = Field(strict=True)
    input_tokens: int = Field(ge=0, strict=True)
    output_tokens: int = Field(ge=0, strict=True)
    cost: Decimal = Field(ge=0, max_digits=24, decimal_places=12, allow_inf_nan=False)
    currency: Literal["USD", "CNY"]


class UsageTotalsDTO(ReadContract):
    requests: int
    succeeded: int
    failed: int
    input_tokens: int
    output_tokens: int
    cost_by_currency: dict[str, str]


class UsageDayDTO(UsageTotalsDTO):
    date: date


class UsageBreakdownDTO(UsageTotalsDTO):
    key: str


class UsageSummaryDTO(UsageTotalsDTO):
    days: Literal[7, 30, 90]
    since: AwareDatetime
    until: AwareDatetime
    source_snapshot_id: str
    daily: list[UsageDayDTO]
    by_feature: list[UsageBreakdownDTO]
    by_model: list[UsageBreakdownDTO]
    aggregation_scope: str
