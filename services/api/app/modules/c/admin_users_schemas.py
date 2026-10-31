"""Read-only administrator directory contracts; never expose identity credentials."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

AdminUserRole = Literal["student", "teacher", "ta", "admin"]
AdminUserStatus = Literal["active", "disabled", "pending"]


class AdminUserFilters(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    page: int = Field(default=1, ge=1, le=1_000_000)
    page_size: int = Field(default=10, ge=10, le=10)
    q: str | None = Field(default=None, max_length=320)
    name: str | None = Field(default=None, max_length=120)
    email: str | None = Field(default=None, max_length=320)
    student_id: str | None = Field(default=None, max_length=80)
    role: AdminUserRole | None = None
    status: AdminUserStatus | None = None
    college: str | None = Field(default=None, max_length=160)

    @field_validator("q", "name", "email", "student_id", "college")
    @classmethod
    def empty_filter_is_absent(cls, value: str | None) -> str | None:
        return value or None


class AdminUserDTO(BaseModel):
    """申报字段可空：注册流程中的账号可能尚未完成资料（完整性由注册规则判断）。"""

    id: UUID
    name: str | None
    username: str | None
    email: str | None
    student_id: str | None
    college: str | None
    global_role: AdminUserRole
    status: AdminUserStatus
    email_verified: bool


class AdminUserDetailDTO(AdminUserDTO):
    created_at: datetime
    updated_at: datetime
    lock_version: int


class AdminUserPageDTO(BaseModel):
    items: list[AdminUserDTO]
    page: int
    page_size: Literal[10] = 10
    total: int
