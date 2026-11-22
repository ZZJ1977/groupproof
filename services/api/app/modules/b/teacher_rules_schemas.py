"""Request and response schemas for course rules versioning and milestone templates."""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Self
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, Field, model_validator


class RuleMilestoneItem(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)
    deadline: AwareDatetime | None = None
    deadline_offset_days: int | None = Field(default=None, ge=1, le=365)
    weight: int | None = Field(default=None, ge=0, le=100)


class ContributionWeights(BaseModel):
    task_weight: int = Field(default=50, ge=0, le=100)
    verification_weight: int = Field(default=30, ge=0, le=100)
    collaboration_weight: int = Field(default=20, ge=0, le=100)

    @model_validator(mode="after")
    def validate_sum(self) -> Self:
        if self.task_weight + self.verification_weight + self.collaboration_weight != 100:
            raise ValueError("contribution weights must sum to 100")
        return self


class CourseRulesDTO(BaseModel):
    grouping_mode: Literal["free", "approval"] = "free"
    min_group_size: int = Field(default=1, ge=1, le=50)
    max_group_size: int = Field(default=6, ge=1, le=50)
    formation_deadline: AwareDatetime | None = None
    post_deadline_policy: Literal["teacher_approval", "forbidden", "free"] = "teacher_approval"
    allow_cross_group_transfer: bool = True
    project_deadline: AwareDatetime | None = None
    milestone_template: list[RuleMilestoneItem] = Field(default_factory=list, max_length=20)
    require_baseline_review: bool = False
    require_plan_review: bool = False
    auto_contribution: bool = True
    contribution_weights: ContributionWeights = Field(default_factory=ContributionWeights)
    appeal_window_days: int = Field(default=7, ge=0, le=90)
    required_deliverables: list[str] = Field(default_factory=list, max_length=20)
    final_presentation: bool = False

    @model_validator(mode="after")
    def validate_bounds(self) -> Self:
        if self.min_group_size > self.max_group_size:
            raise ValueError("min_group_size must not exceed max_group_size")
        if (
            self.formation_deadline is not None
            and self.project_deadline is not None
            and self.formation_deadline > self.project_deadline
        ):
            raise ValueError("formation_deadline must not follow project_deadline")
        return self


class SaveRulesDraft(BaseModel):
    rules: CourseRulesDTO
    change_summary: str = Field(default="", max_length=500)


class PublishRules(BaseModel):
    change_summary: str = Field(min_length=1, max_length=500)
    rules: CourseRulesDTO | None = None


class RuleVersionBriefDTO(BaseModel):
    version_no: int
    status: Literal["draft", "published", "archived"]
    change_summary: str
    published_by: str | None = None
    published_at: datetime | None = None
    created_at: datetime


class RuleVersionDTO(RuleVersionBriefDTO):
    rules: CourseRulesDTO


class CourseRulesOverviewDTO(BaseModel):
    course_id: UUID
    course_status: str
    can_edit: bool
    current_published: RuleVersionDTO | None = None
    draft: RuleVersionDTO | None = None
    effective_rules: CourseRulesDTO
    versions: list[RuleVersionBriefDTO]


class MilestoneTemplateOverviewDTO(BaseModel):
    course_id: UUID
    items: list[RuleMilestoneItem]
    version_no: int | None = None
