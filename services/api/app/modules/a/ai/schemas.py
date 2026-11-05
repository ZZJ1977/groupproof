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
