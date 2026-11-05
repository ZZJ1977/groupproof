"""B-4 request and response shapes (page 08 steps 3–5)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

from app.modules.b.courses_schemas import PersonDTO, Strict

Priority = Literal["high", "medium", "low"]
Origin = Literal["ai", "manual"]


class AnalysisRunDTO(BaseModel):
    id: UUID
    status: Literal["processing", "succeeded", "failed", "unavailable"]
    error_code: str | None
    error_message: str | None
    summary: dict | None
    is_placeholder: bool
    created_at: datetime
    finished_at: datetime | None


class SourceDTO(BaseModel):
    material_id: UUID | None
    material_title: str | None
    segment_id: str | None
    quote: str | None


class ModuleDTO(BaseModel):
    id: UUID
    name: str
    description: str | None
    owner: PersonDTO | None
    origin: Origin
    requirement_count: int
    lock_version: int


class RequirementDTO(BaseModel):
    id: UUID
    module_id: UUID
    title: str
    description: str | None
    priority: Priority
    status: str
    origin: Origin
    edited_by_human: bool
    excluded: bool
    sources: list[SourceDTO]
    lock_version: int


class ResolutionDTO(BaseModel):
    decision: Literal["keep_left", "keep_right", "merge"]
    reason: str
    resolved_by: PersonDTO | None
    created_at: datetime


class ConflictDTO(BaseModel):
    id: UUID
    left: RequirementDTO
    right: RequirementDTO
    description: str | None
    status: Literal["open", "resolved", "ignored"]
    resolution: ResolutionDTO | None


class RequirementsBoardDTO(BaseModel):
    project_id: UUID
    setup_status: str
    setup_step: int
    editable: bool
    latest_run: AnalysisRunDTO | None
    modules: list[ModuleDTO]
    requirements: list[RequirementDTO]
    conflicts: list[ConflictDTO]
    open_conflicts: int


class CreateModule(Strict):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    owner_id: UUID | None = None


class UpdateModule(Strict):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    owner_id: UUID | None = None
    expected_version: int = Field(ge=0, strict=True)


class CreateRequirement(Strict):
    module_id: UUID
    title: str = Field(min_length=1, max_length=240)
    description: str | None = Field(default=None, max_length=5000)
    priority: Priority = "medium"


class UpdateRequirement(Strict):
    module_id: UUID
    title: str = Field(min_length=1, max_length=240)
    description: str | None = Field(default=None, max_length=5000)
    priority: Priority
    expected_version: int = Field(ge=0, strict=True)


class ResolveConflict(Strict):
    decision: Literal["keep_left", "keep_right", "merge"]
    reason: str | None = Field(default=None, max_length=2000)
    merged_title: str | None = Field(default=None, max_length=240)
    merged_description: str | None = Field(default=None, max_length=5000)


class AdvanceSetup(Strict):
    from_step: Literal[2, 3, 4]


class SaveScope(Strict):
    in_scope: str = Field(max_length=5000)
    out_of_scope: str = Field(default="", max_length=5000)
    expected_version: int = Field(ge=0, strict=True)


class CheckItem(Strict):
    checked: bool


class ChecklistItemDTO(BaseModel):
    key: str
    label: str
    kind: Literal["rule", "manual"]
    passed: bool
    detail: str | None = None
    checked_by: PersonDTO | None = None


class ChecklistDTO(BaseModel):
    project_id: UUID
    items: list[ChecklistItemDTO]
    ready: bool
    in_scope: str
    out_of_scope: str
    scope_version: int


class ConfirmBaseline(Strict):
    decision: Literal["confirm", "reject"]
    comment: str | None = Field(default=None, max_length=2000)


class ForceFreeze(Strict):
    reason: str | None = Field(default=None, max_length=2000)


class ConfirmationDTO(BaseModel):
    user: PersonDTO
    status: Literal["pending", "confirmed", "rejected"]
    comment: str | None
    confirmed_at: datetime | None


class BaselineDTO(BaseModel):
    id: UUID
    version_no: int
    status: Literal["draft", "confirmed", "frozen", "archived"]
    created_by: PersonDTO | None
    created_at: datetime
    frozen_at: datetime | None
    confirmations: list[ConfirmationDTO]
    waiting_for: list[PersonDTO]
    snapshot: dict
    lock_version: int
