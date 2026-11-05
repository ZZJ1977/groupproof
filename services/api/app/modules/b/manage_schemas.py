"""B-5 page 09 shapes: requirement list, detail, versions, impact and trace."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel

from app.modules.b.courses_schemas import PersonDTO
from app.modules.b.requirements_schemas import Origin, RequirementDTO


class ModuleBriefDTO(BaseModel):
    id: UUID
    name: str


class RequirementListItemDTO(BaseModel):
    id: UUID
    code: str | None
    title: str
    module: ModuleBriefDTO
    origin: Origin
    status: str
    priority: str
    excluded: bool
    version_no: int
    task_count: int
    updated_at: datetime


class RequirementPageDTO(BaseModel):
    items: list[RequirementListItemDTO]
    total: int
    page: int
    page_size: int
    modules: list[ModuleBriefDTO]


class RequirementDetailDTO(BaseModel):
    requirement: RequirementDTO
    module: ModuleBriefDTO
    version_no: int
    baseline_frozen: bool
    can_edit: bool
    reason_required: bool


class CriterionImpactDTO(BaseModel):
    id: UUID
    key: str
    text: str
    needs_recheck: bool


class TaskImpactDTO(BaseModel):
    id: UUID
    title: str
    status: str
    href: str
    criteria: list[CriterionImpactDTO]


class ImpactDTO(BaseModel):
    requirement_id: UUID
    tasks: list[TaskImpactDTO]
    criteria_count: int


class VersionDTO(BaseModel):
    version_no: int
    snapshot: dict
    reason: str | None
    after_freeze: bool
    created_by: PersonDTO | None
    created_at: datetime


class FieldChangeDTO(BaseModel):
    field: str
    label: str
    before: str | None
    after: str | None


class VersionsDTO(BaseModel):
    requirement_id: UUID
    versions: list[VersionDTO]
    compare: dict | None = None


class TraceEvidenceDTO(BaseModel):
    id: UUID
    title: str
    status: str
    href: str


class TraceCriterionDTO(BaseModel):
    id: UUID
    key: str
    text: str
    needs_recheck: bool
    evidence: list[TraceEvidenceDTO]


class TraceVerificationDTO(BaseModel):
    status: Literal["available", "unavailable"]
    state: str | None
    href: str


class TraceTaskDTO(BaseModel):
    id: UUID
    title: str
    status: str
    href: str
    criteria: list[TraceCriterionDTO]
    verification: TraceVerificationDTO


class TraceDTO(BaseModel):
    requirement: RequirementDTO
    module: ModuleBriefDTO
    module_href: str
    tasks: list[TraceTaskDTO]
    evidence_status: Literal["available", "unavailable"]
    evidence_reason: str | None
    verification_status: Literal["available", "unavailable"]


class RecheckDTO(BaseModel):
    criterion_id: UUID
    task_id: UUID
    requirement_id: UUID
    requirement_version_no: int
    reason: str | None
    flagged_at: datetime
    verification_notified: bool
