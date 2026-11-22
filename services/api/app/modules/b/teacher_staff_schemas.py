"""Request and response schemas for teacher TA & staff permission management."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field


class StaffPermissionsDTO(BaseModel):
    approve_joins: bool = False
    manage_groups: bool = False
    manage_files: bool = False
    approve_changes: bool = False
    export_reports: bool = False
    post_announcements: bool = False


class StaffMemberDTO(BaseModel):
    user_id: UUID
    name: str
    email: str | None = None
    role: Literal["teacher", "ta"]
    permissions: StaffPermissionsDTO
    joined_at: datetime
    is_owner: bool


class StaffListDTO(BaseModel):
    items: list[StaffMemberDTO]
    total: int
    can_manage_staff: bool


class InviteStaff(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    role: Literal["ta", "teacher"] = "ta"


class UpdatePermissions(BaseModel):
    approve_joins: bool | None = None
    manage_groups: bool | None = None
    manage_files: bool | None = None
    approve_changes: bool | None = None
    export_reports: bool | None = None
    post_announcements: bool | None = None


class RemoveStaff(BaseModel):
    reason: str = Field(min_length=1, max_length=500)


class RemoveStaffResultDTO(BaseModel):
    removed: bool = True
    user_id: UUID


class MyPermissionsDTO(BaseModel):
    role: Literal["teacher", "ta"]
    is_owner: bool
    can_manage: bool
    permissions: StaffPermissionsDTO
