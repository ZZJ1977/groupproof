"""A7 四个 AI 函数的输入输出字段（草案，开工前和 B、D 确认后再定稿）。

所有输出都带 ``provider``、``is_placeholder`` 和 ``needs_human_review=True``：
AI 的结果只是建议，页面必须让人确认后才生效。
"""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class AIModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AIResultMeta(AIModel):
    provider: str
    is_placeholder: bool
    needs_human_review: Literal[True] = True


# ------------------------------------------------ A7-03 从资料提取需求和模块（B 用，页面 08）


class DocumentSegment(AIModel):
    segment_id: str = Field(min_length=1, max_length=80)
    text: str = Field(min_length=1, max_length=8000)


class SourceDocument(AIModel):
    source_id: UUID
    title: str = Field(min_length=1, max_length=255)
    segments: list[DocumentSegment] = Field(min_length=1, max_length=500)


class RequirementExtractionInput(AIModel):
    project_id: UUID
    documents: list[SourceDocument] = Field(min_length=1, max_length=20)


class SourceCitation(AIModel):
    """每条结果都标明来自哪个文件的哪一段。"""

    source_id: UUID
    segment_id: str
    quote: str = Field(max_length=300)


class ExtractedModule(AIModel):
    name: str
    description: str


class ExtractedRequirement(AIModel):
    title: str
    description: str
    module: str | None
    sources: list[SourceCitation] = Field(min_length=1)


class RequirementConflict(AIModel):
    description: str
    sources: list[SourceCitation] = Field(min_length=2)


class RequirementExtractionResult(AIResultMeta):
    modules: list[ExtractedModule]
    requirements: list[ExtractedRequirement]
    conflicts: list[RequirementConflict]


# ------------------------------------------------ A7-04 根据需求建议任务（B 用，页面 10）


class RequirementBrief(AIModel):
    id: UUID
    title: str
    description: str = ""


class TaskBrief(AIModel):
    id: UUID
    title: str
    description: str = ""
    requirement_ids: list[UUID] = Field(default_factory=list)


class TaskSuggestionInput(AIModel):
    project_id: UUID
    requirements: list[RequirementBrief] = Field(min_length=1, max_length=300)
    tasks: list[TaskBrief] = Field(default_factory=list, max_length=500)


class SuggestedTask(AIModel):
    requirement_id: UUID
    title: str
    description: str
    acceptance_criteria: list[str] = Field(min_length=1)


class TaskSuggestionResult(AIResultMeta):
    uncovered_requirement_ids: list[UUID]
    suggestions: list[SuggestedTask]


# ------------------------------------------------ A7-05 证据和验收标准匹配（D 用，页面 17）


class CriterionBrief(AIModel):
    id: UUID
    text: str = Field(min_length=1, max_length=2000)


class EvidenceBrief(AIModel):
    id: UUID
    kind: str = Field(min_length=1, max_length=40)  # commit / pr / file / feishu / note ...
    text: str = Field(min_length=1, max_length=8000)


class EvidenceMatchInput(AIModel):
    project_id: UUID
    criterion: CriterionBrief
    evidence: list[EvidenceBrief] = Field(max_length=50)


class EvidenceMatchResult(AIResultMeta):
    criterion_id: UUID
    verdict: Literal["pass", "partial", "fail", "insufficient"]
    confidence: float = Field(ge=0, le=1)
    matched_evidence_ids: list[UUID]
    reasons: list[str]
    missing: list[str]


# ------------------------------------------------ A7-06 风险解释（D 用，风险和报告页）


class TaskProgressBrief(AIModel):
    id: UUID
    title: str
    status: str
    progress_percent: int = Field(ge=0, le=100)
    due_at: str | None = None  # ISO 8601
    overdue: bool = False


class RiskRecord(AIModel):
    kind: str
    description: str
    severity: Literal["low", "medium", "high"]


class RiskExplanationInput(AIModel):
    project_id: UUID
    tasks: list[TaskProgressBrief] = Field(max_length=500)
    risks: list[RiskRecord] = Field(max_length=100)


class RiskExplanationResult(AIResultMeta):
    level: Literal["low", "medium", "high"]
    summary: str
    explanation: str
    suggestions: list[str]


# ------------------------------------------------ A7-07 代码是否实现了需求（A5 用，读取绑定仓库）


class ImplRequirement(AIModel):
    id: UUID
    text: str = Field(min_length=1, max_length=2000)


class CodeFile(AIModel):
    path: str = Field(min_length=1, max_length=1000)
    text: str = Field(max_length=20000)


class ImplementationAnalysisInput(AIModel):
    project_id: UUID
    requirements: list[ImplRequirement] = Field(min_length=1, max_length=50)
    files: list[CodeFile] = Field(max_length=60)


class CodeEvidence(AIModel):
    path: str = Field(min_length=1, max_length=1000)
    quote: str = Field(min_length=1, max_length=300)  # 必须是该文件里真实存在的原文


class ImplementationFinding(AIModel):
    requirement_id: UUID
    status: Literal["implemented", "partial", "not_found", "unclear"]
    confidence: float = Field(ge=0, le=1)
    reasons: list[str]
    evidence: list[CodeEvidence]
    missing: list[str]


class ImplementationAnalysisResult(AIResultMeta):
    findings: list[ImplementationFinding]


# ------------------------------------------------ 通用活动摘要（首期由 GitHub commit 使用）


class ActivityFileChange(AIModel):
    path: str = Field(min_length=1, max_length=500)
    status: Literal["added", "modified", "deleted", "renamed", "unknown"] = "unknown"
    additions: int = Field(default=0, ge=0, le=1_000_000)
    deletions: int = Field(default=0, ge=0, le=1_000_000)
    patch: str | None = Field(default=None, max_length=6000)


class ActivitySummaryInput(AIModel):
    """平台无关的来源输入；不把项目业务名词硬编码进提示词。"""

    project_id: UUID
    platform: str = Field(min_length=1, max_length=40)
    record_kind: str = Field(min_length=1, max_length=40)
    source_revision: str = Field(min_length=1, max_length=255)
    actor_name: str = Field(min_length=1, max_length=240)
    actor_login: str | None = Field(default=None, max_length=120)
    occurred_at: str = Field(min_length=1, max_length=80)
    title: str = Field(min_length=1, max_length=240)
    body: str = Field(default="", max_length=30000)
    metadata: dict[str, str | int | float | bool | None] = Field(
        default_factory=dict, max_length=40
    )
    files: list[ActivityFileChange] = Field(default_factory=list, max_length=80)
    diff_truncated: bool = False


class ActivityEvidence(AIModel):
    source: Literal["title", "body", "metadata", "files"]
    quote: str = Field(min_length=1, max_length=300)


class ActivitySummaryResult(AIResultMeta):
    headline: str = Field(min_length=1, max_length=240)
    implementation: str = Field(min_length=1, max_length=600)
    impact: str | None = Field(default=None, max_length=600)
    verification: list[str] = Field(default_factory=list, max_length=8)
    risks: list[str] = Field(default_factory=list, max_length=8)
    evidence: list[ActivityEvidence] = Field(default_factory=list, max_length=8)
    confidence: float = Field(ge=0, le=1)
    insufficient_context: list[str] = Field(default_factory=list, max_length=8)


# ------------------------------------------------ A7-08 从项目资料一键生成需求、任务与里程碑


class BlueprintMemberBrief(AIModel):
    id: UUID
    name: str = Field(min_length=1, max_length=120)
    github_username: str | None = Field(default=None, max_length=60)


class BlueprintMaterialDoc(AIModel):
    material_id: UUID
    title: str = Field(min_length=1, max_length=255)
    text: str = Field(min_length=1, max_length=28000)


class ProjectBlueprintInput(AIModel):
    project_id: UUID
    project_name: str = Field(min_length=1, max_length=200)
    start_date: str | None = Field(default=None, max_length=32)
    end_date: str | None = Field(default=None, max_length=32)
    members: list[BlueprintMemberBrief] = Field(default_factory=list, max_length=20)
    documents: list[BlueprintMaterialDoc] = Field(min_length=1, max_length=20)


class BlueprintModule(AIModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)
    owner_id: UUID | None = None


class BlueprintRequirement(AIModel):
    title: str = Field(min_length=1, max_length=240)
    description: str = Field(default="", max_length=3000)
    module: str = Field(min_length=1, max_length=200)
    priority: Literal["high", "medium", "low"] = "medium"
    material_id: UUID | None = None
    quote: str = Field(default="", max_length=300)


class BlueprintMilestone(AIModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)
    deadline: str | None = Field(default=None, max_length=32)
    deliverables: list[str] = Field(default_factory=list, max_length=8)


class BlueprintTask(AIModel):
    title: str = Field(min_length=1, max_length=240)
    description: str = Field(default="", max_length=3000)
    module: str = Field(min_length=1, max_length=200)
    requirement_titles: list[str] = Field(default_factory=list, max_length=10)
    milestone_titles: list[str] = Field(default_factory=list, max_length=10)
    assignee_ids: list[UUID] = Field(default_factory=list, max_length=10)
    priority: Literal["high", "medium", "low"] = "medium"
    weight: int = Field(default=5, ge=1, le=100)
    acceptance_criteria: list[str] = Field(min_length=1, max_length=10)


class ProjectBlueprintResult(AIResultMeta):
    modules: list[BlueprintModule] = Field(min_length=1, max_length=20)
    requirements: list[BlueprintRequirement] = Field(min_length=1, max_length=80)
    milestones: list[BlueprintMilestone] = Field(default_factory=list, max_length=20)
    tasks: list[BlueprintTask] = Field(min_length=1, max_length=80)
    in_scope: str = Field(default="", max_length=2000)
    out_of_scope: str = Field(default="", max_length=2000)


# ------------------------------------------------ A7-09 飞书群聊协作进展与结论分析


class CollabTaskBrief(AIModel):
    code: str = Field(min_length=1, max_length=32)
    title: str = Field(min_length=1, max_length=240)
    status: str = Field(default="not_started", max_length=32)


class CollabMessageBrief(AIModel):
    id: UUID
    occurred_at: str = Field(min_length=1, max_length=80)
    sender_label: str = Field(min_length=1, max_length=80)
    msg_type: str = Field(default="text", max_length=40)
    text: str = Field(min_length=1, max_length=1200)


class FeishuCollaborationInput(AIModel):
    project_id: UUID
    project_name: str = Field(min_length=1, max_length=200)
    member_count: int = Field(default=1, ge=1, le=50)
    tasks: list[CollabTaskBrief] = Field(default_factory=list, max_length=80)
    messages: list[CollabMessageBrief] = Field(min_length=1, max_length=300)


class CollabInsightItem(AIModel):
    title: str = Field(min_length=1, max_length=120)
    category: Literal["division_confirm", "task_progress", "doc_review", "decision", "blocker"]
    status: Literal["completed", "in_progress", "needs_followup"]
    summary: str = Field(min_length=1, max_length=600)
    judgment_basis: str = Field(min_length=1, max_length=600)
    task_codes: list[str] = Field(default_factory=list, max_length=10)
    confirmed_count: int = Field(default=1, ge=0, le=50)
    message_ids: list[UUID] = Field(min_length=1, max_length=40)
    confidence: float = Field(default=0.8, ge=0, le=1)


class FeishuCollaborationResult(AIResultMeta):
    overview: str = Field(min_length=1, max_length=600)
    items: list[CollabInsightItem] = Field(default_factory=list, max_length=24)


# ------------------------------------------------ A7-10 从未归属代码提交发现增补任务（B 用）


class CodeDiscoveryCommitBrief(AIModel):
    id: UUID
    sha: str = Field(min_length=1, max_length=64)
    title: str = Field(min_length=1, max_length=240)
    summary: str = Field(default="", max_length=2000)
    author_name: str = Field(default="", max_length=120)
    author_user_id: UUID | None = None
    occurred_at: str | None = Field(default=None, max_length=80)
    effective_lines: int = Field(default=0, ge=0)
    files: list[str] = Field(default_factory=list, max_length=60)
    ai_headline: str = Field(default="", max_length=240)
    ai_implementation: str = Field(default="", max_length=600)


class CodeDiscoveryExistingTaskBrief(AIModel):
    id: UUID
    code: str | None = Field(default=None, max_length=32)
    title: str = Field(min_length=1, max_length=240)
    description: str = Field(default="", max_length=1000)
    module_id: UUID
    module_name: str = Field(default="", max_length=200)
    parent_task_id: UUID | None = None
    status: str = Field(default="not_started", max_length=32)
    weight: int = Field(default=1, ge=1, le=100)


class CodeDiscoveryModuleBrief(AIModel):
    id: UUID
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=600)


class CodeDiscoveryMemberBrief(AIModel):
    id: UUID
    name: str = Field(min_length=1, max_length=120)
    github_username: str | None = Field(default=None, max_length=60)


class CodeTaskDiscoveryInput(AIModel):
    project_id: UUID
    project_name: str = Field(min_length=1, max_length=200)
    modules: list[CodeDiscoveryModuleBrief] = Field(default_factory=list, max_length=40)
    existing_tasks: list[CodeDiscoveryExistingTaskBrief] = Field(
        default_factory=list, max_length=200
    )
    members: list[CodeDiscoveryMemberBrief] = Field(default_factory=list, max_length=30)
    unmatched_commits: list[CodeDiscoveryCommitBrief] = Field(min_length=1, max_length=120)


class DiscoveredCodeTask(AIModel):
    action_type: Literal["merge_existing", "new_subtask", "new_top_level"]
    title: str = Field(min_length=1, max_length=240)
    description: str = Field(default="", max_length=3000)
    acceptance_criteria: list[str] = Field(min_length=1, max_length=10)
    target_task_id: UUID | None = None
    suggested_parent_task_id: UUID | None = None
    suggested_module_id: UUID | None = None
    suggested_assignee_ids: list[UUID] = Field(default_factory=list, max_length=10)
    suggested_weight: int = Field(default=3, ge=1, le=6)
    source_commit_ids: list[UUID] = Field(min_length=1, max_length=40)
    rationale: str = Field(default="", max_length=1000)
    confidence: float = Field(default=0.75, ge=0.0, le=1.0)


class CodeTaskDiscoveryResult(AIResultMeta):
    suggestions: list[DiscoveredCodeTask] = Field(default_factory=list, max_length=12)
