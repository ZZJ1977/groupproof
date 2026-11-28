"""B-6 request and response shapes (page 10, B5-01 ~ B5-05)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

from app.modules.b.courses_schemas import PersonDTO, Strict
from app.modules.b.requirements_schemas import Priority

PlanStatus = Literal["none", "draft", "frozen"]
ConfirmState = Literal["confirmed", "stale", "pending"]


class CriterionInput(Strict):
    id: UUID | None = None
    text: str = Field(min_length=1, max_length=2000)


class TaskInput(Strict):
    title: str = Field(min_length=1, max_length=240)
    description: str = Field(default="", max_length=5000)
    module_id: UUID
    parent_task_id: UUID | None = None
    requirement_ids: list[UUID] = Field(default_factory=list, max_length=50)
    assignee_ids: list[UUID] = Field(default_factory=list, max_length=10)
    dependency_ids: list[UUID] = Field(default_factory=list, max_length=50)
    milestone_ids: list[UUID] = Field(default_factory=list, max_length=20)
    priority: Priority = "medium"
    weight: int = Field(ge=1, le=100)
    criteria: list[CriterionInput] = Field(default_factory=list, max_length=30)


class UpdateTask(TaskInput):
    expected_version: int = Field(ge=0)


class DeleteTask(Strict):
    expected_version: int = Field(ge=0)


class ConfirmAssignment(Strict):
    # The task versions the member saw: {task_id: content_version}.
    task_versions: dict[UUID, int] = Field(max_length=500)


class FreezePlan(Strict):
    expected_version: int = Field(ge=0)


class UnlockPlan(Strict):
    expected_version: int = Field(ge=0)
    reason: str = Field(default="", max_length=2000)


class AdoptSuggestion(Strict):
    weight: int = Field(default=1, ge=1, le=100)


class CriterionDTO(BaseModel):
    id: UUID
    key: str
    text: str
    needs_recheck: bool


class TaskDTO(BaseModel):
    id: UUID
    code: str | None
    title: str
    description: str
    module_id: UUID
    parent_task_id: UUID | None
    requirement_ids: list[UUID]
    assignees: list[PersonDTO]
    dependency_ids: list[UUID]
    milestone_ids: list[UUID]
    priority: Priority
    weight: int
    criteria: list[CriterionDTO]
    status: str
    progress_percent: int
    content_version: int
    origin: Literal["manual", "ai", "ai_code"] = "manual"
    is_code_discovered: bool = False
    discovered_from: dict | None = None
    href: str


class IssueDTO(BaseModel):
    code: str
    message: str
    task_id: UUID | None
    field: str | None
    task_ids: list[UUID]


class MemberConfirmationDTO(BaseModel):
    user: PersonDTO
    state: ConfirmState
    confirmed_at: datetime | None
    task_count: int


class OptionDTO(BaseModel):
    id: UUID
    name: str
    code: str | None = None
    module_id: UUID | None = None


class PlanHistoryDTO(BaseModel):
    id: UUID
    version_no: int
    status: str
    frozen_at: datetime | None
    created_at: datetime


class PlanDTO(BaseModel):
    project_id: UUID
    id: UUID | None
    version_no: int
    status: PlanStatus
    lock_version: int
    baseline_required: bool
    baseline_frozen: bool
    baseline_version_no: int | None
    frozen_at: datetime | None
    tasks: list[TaskDTO]
    issues: list[IssueDTO]
    confirmations: list[MemberConfirmationDTO]
    my_task_versions: dict[UUID, int]
    my_state: ConfirmState | None
    can_edit: bool
    can_lead: bool
    root_weight_total: int
    modules: list[OptionDTO]
    requirements: list[OptionDTO]
    milestones: list[OptionDTO]
    members: list[PersonDTO]
    history: list[PlanHistoryDTO]


class TaskVersionDTO(BaseModel):
    version_no: int
    snapshot: dict
    created_by: PersonDTO | None
    created_at: datetime


class SuggestionDTO(BaseModel):
    id: UUID
    requirement_id: UUID
    requirement_code: str | None
    requirement_title: str
    title: str
    description: str
    acceptance_criteria: list[str]
    status: Literal["pending", "adopted", "dismissed"]
    is_placeholder: bool
    adopted_task_id: UUID | None
    created_at: datetime


class SuggestionBatchDTO(BaseModel):
    created: int
    duplicates: int
    uncovered_requirement_ids: list[UUID]
    is_placeholder: bool
    suggestions: list[SuggestionDTO]


# ------------------------------------------------ Code-Driven Incremental Task Discovery


CodeDiscoveryAction = Literal["merge_existing", "new_subtask", "new_top_level"]
CodeDiscoveryApprovalStatus = Literal["none", "pending_approval", "approved", "rejected"]


class UnmatchedCommitDTO(BaseModel):
    id: UUID
    sha: str
    title: str
    author_name: str
    author_user_id: UUID | None = None
    occurred_at: datetime | None = None
    effective_lines: int = 0
    files_count: int = 0


class DiscoverySourceCommitDTO(BaseModel):
    id: UUID
    sha: str
    title: str
    author_name: str
    effective_lines: int = 0


class DiscoveryApprovalDTO(BaseModel):
    user_id: UUID
    name: str
    role: str
    approved_at: datetime


class CodeDiscoveryItemDTO(BaseModel):
    id: UUID
    status: Literal["pending", "adopted", "dismissed"]
    approval_status: CodeDiscoveryApprovalStatus
    source_type: Literal["github_code"] = "github_code"
    action_type: CodeDiscoveryAction
    title: str
    description: str
    acceptance_criteria: list[str]
    suggested_module_id: UUID | None = None
    suggested_module_name: str | None = None
    suggested_parent_task_id: UUID | None = None
    suggested_parent_task_title: str | None = None
    target_task_id: UUID | None = None
    target_task_title: str | None = None
    suggested_assignee_ids: list[UUID]
    suggested_weight: int
    rationale: str
    confidence: float
    source_commits: list[DiscoverySourceCommitDTO]
    adopted_task_id: UUID | None = None
    proposed_by_id: UUID | None = None
    proposed_by_name: str | None = None
    approvals: list[DiscoveryApprovalDTO]
    required_approvals: int
    can_approve: bool
    provider: str
    is_placeholder: bool
    created_at: datetime


class CodeDiscoveryListDTO(BaseModel):
    unmatched_commits_count: int
    unmatched_commits: list[UnmatchedCommitDTO]
    pending_count: int
    pending_approval_count: int
    items: list[CodeDiscoveryItemDTO]


class CodeDiscoveryScanResultDTO(CodeDiscoveryListDTO):
    created_count: int


class ScanCodeDiscoveriesRequest(Strict):
    max_commits: int = Field(default=60, ge=1, le=120)


class AdoptCodeDiscoveryRequest(Strict):
    action_type: CodeDiscoveryAction | None = None
    title: str | None = Field(default=None, min_length=1, max_length=240)
    description: str | None = Field(default=None, max_length=5000)
    module_id: UUID | None = None
    parent_task_id: UUID | None = None
    target_task_id: UUID | None = None
    assignee_ids: list[UUID] | None = Field(default=None, max_length=10)
    weight: int | None = Field(default=None, ge=1, le=100)
    acceptance_criteria: list[str] | None = Field(default=None, max_length=30)
    reason: str | None = Field(default=None, max_length=2000)


class ApproveCodeDiscoveryRequest(Strict):
    reason: str | None = Field(default=None, max_length=2000)


class DismissCodeDiscoveryRequest(Strict):
    reason: str | None = Field(default=None, max_length=2000)


class CodeDiscoveryActionResultDTO(BaseModel):
    item: CodeDiscoveryItemDTO
    task_id: UUID | None = None
    adopted_immediately: bool
    attached_evidence_count: int = 0
    message: str


class CodeDiscoveryDismissResultDTO(BaseModel):
    item: CodeDiscoveryItemDTO
