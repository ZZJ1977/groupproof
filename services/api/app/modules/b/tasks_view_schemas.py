"""B-7 response shapes: one task query shared by the tree, board and list (pages 11–13)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel

from app.modules.b.courses_schemas import PersonDTO
from app.modules.b.planning_schemas import IssueDTO, OptionDTO

View = Literal["tree", "board", "list"]


class TransitionDTO(BaseModel):
    """A status change the caller may ask C for; B itself never changes status."""

    to: str
    kind: Literal["api", "page"]
    method: str | None = None
    path: str | None = None
    href: str | None = None
    expected_version: int


class TaskLinksDTO(BaseModel):
    detail: str
    submit: str
    evidence: str
    verification: str


class TaskRowDTO(BaseModel):
    id: UUID
    code: str | None
    title: str
    module: OptionDTO
    parent_task_id: UUID | None
    assignees: list[PersonDTO]
    priority: str
    weight: int
    status: str
    progress_percent: int
    milestone_ids: list[UUID]
    dependency_ids: list[UUID]
    dependencies_done: bool
    content_version: int
    lock_version: int
    updated_at: datetime | None
    links: TaskLinksDTO
    transitions: list[TransitionDTO]
    blocked_reason: str | None
    matched: bool


class ColumnDTO(BaseModel):
    status: str
    label: str
    count: int


class TasksPageDTO(BaseModel):
    view: View
    items: list[TaskRowDTO]
    total: int
    page: int
    page_size: int
    lock_version: int
    plan_status: Literal["none", "draft", "frozen"]
    integrity_issues: list[IssueDTO]
    columns: list[ColumnDTO]
    modules: list[OptionDTO]
    members: list[PersonDTO]
    milestones: list[OptionDTO]
