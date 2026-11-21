"""B5-01/B5-02 plan rules, ported from ``lib/commands/plan.ts`` ``validatePlan``.

Pure functions over plain data so the same rules run on every save (blocking
reference and cycle problems only) and on freeze (everything).
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from dataclasses import field as dc_field
from uuid import UUID


@dataclass(frozen=True)
class PlanTask:
    id: UUID
    code: str
    module_id: UUID
    parent_id: UUID | None
    weight: int
    criteria_count: int
    requirement_ids: tuple[UUID, ...] = ()
    assignee_ids: tuple[UUID, ...] = ()
    dependency_ids: tuple[UUID, ...] = ()
    milestone_ids: tuple[UUID, ...] = ()


@dataclass(frozen=True)
class Issue:
    code: str
    message: str
    task_id: UUID | None = None
    field: str | None = None
    # Every task on a cycle, in order, for cycle issues.
    task_ids: tuple[UUID, ...] = dc_field(default_factory=tuple)

    @property
    def key(self) -> tuple:
        return (self.code, self.task_id, self.field, frozenset(self.task_ids))


# Saving a task is refused only for these; the rest must be fixed before the freeze.
BLOCKING = frozenset(
    {
        "unknown_module",
        "unknown_requirement",
        "unknown_assignee",
        "unknown_milestone",
        "unknown_parent",
        "unknown_dependency",
        "self_parent",
        "self_dependency",
        "parent_cycle",
        "dependency_cycle",
    }
)


def _cycle_text(path: Sequence[UUID], codes: dict[UUID, str]) -> str:
    return " → ".join(codes.get(item, str(item)) for item in [*path, path[0]])


def validate_plan(
    tasks: Sequence[PlanTask],
    *,
    modules: Iterable[UUID],
    requirements: Iterable[UUID],
    milestones: Iterable[UUID],
    members: Iterable[UUID],
) -> list[Issue]:
    module_ids, requirement_ids = set(modules), set(requirements)
    milestone_ids, member_ids = set(milestones), set(members)
    by_id = {task.id: task for task in tasks}
    codes = {task.id: task.code for task in tasks}
    issues: list[Issue] = []

    if not tasks:
        issues.append(Issue("no_tasks", "计划里还没有任务。"))

    for task in tasks:
        name = task.code
        if task.module_id not in module_ids:
            issues.append(
                Issue("unknown_module", f"{name} 的模块不属于本项目。", task.id, "module_id")
            )
        for rid in task.requirement_ids:
            if rid not in requirement_ids:
                issues.append(
                    Issue(
                        "unknown_requirement",
                        f"{name} 关联的需求不属于本项目的基线。",
                        task.id,
                        "requirement_ids",
                    )
                )
        for uid in task.assignee_ids:
            if uid not in member_ids:
                issues.append(
                    Issue(
                        "unknown_assignee",
                        f"{name} 的负责人不是本组成员。",
                        task.id,
                        "assignee_ids",
                    )
                )
        for mid in task.milestone_ids:
            if mid not in milestone_ids:
                issues.append(
                    Issue(
                        "unknown_milestone",
                        f"{name} 的里程碑不属于本项目。",
                        task.id,
                        "milestone_ids",
                    )
                )
        if task.parent_id is not None:
            if task.parent_id == task.id:
                issues.append(
                    Issue("self_parent", f"{name} 不能是自己的父任务。", task.id, "parent_id")
                )
            elif task.parent_id not in by_id:
                issues.append(
                    Issue("unknown_parent", f"{name} 的父任务不在本项目中。", task.id, "parent_id")
                )
        for dep in task.dependency_ids:
            if dep == task.id:
                issues.append(
                    Issue("self_dependency", f"{name} 不能依赖自己。", task.id, "dependency_ids")
                )
            elif dep not in by_id:
                issues.append(
                    Issue(
                        "unknown_dependency",
                        f"{name} 的前置任务不在本项目中。",
                        task.id,
                        "dependency_ids",
                    )
                )
        if not task.assignee_ids:
            issues.append(
                Issue("missing_assignee", f"{name} 还没有负责人。", task.id, "assignee_ids")
            )
        if task.criteria_count == 0:
            issues.append(Issue("missing_criteria", f"{name} 没有验收标准。", task.id, "criteria"))

    issues.extend(_parent_cycles(by_id, codes))
    issues.extend(_dependency_cycles(tasks, by_id, codes))

    roots = [task for task in tasks if task.parent_id is None or task.parent_id not in by_id]
    total = sum(task.weight for task in roots)
    if roots and total != 100:
        issues.append(
            Issue("root_weight_total", f"顶层任务权重合计是 {total}，必须是 100。", field="weight")
        )
    for parent in tasks:
        children = [task for task in tasks if task.parent_id == parent.id and task.id != parent.id]
        child_total = sum(task.weight for task in children)
        if children and child_total != parent.weight:
            issues.append(
                Issue(
                    "child_weight_total",
                    f"{parent.code} 的子任务权重合计是 {child_total}，"
                    f"应等于它的权重 {parent.weight}。",
                    parent.id,
                    "weight",
                )
            )
    return issues


def _parent_cycles(by_id: dict[UUID, PlanTask], codes: dict[UUID, str]) -> list[Issue]:
    issues, reported = [], set()
    for start in by_id:
        path, cursor = [], start
        while cursor is not None and cursor in by_id and cursor not in path:
            path.append(cursor)
            parent = by_id[cursor].parent_id
            cursor = parent if parent != cursor else None
        if cursor is not None and cursor in path:
            cycle = tuple(path[path.index(cursor) :])
            if frozenset(cycle) not in reported:
                reported.add(frozenset(cycle))
                issues.append(
                    Issue(
                        "parent_cycle",
                        f"父子关系成环：{_cycle_text(cycle, codes)}",
                        cycle[0],
                        "parent_id",
                        cycle,
                    )
                )
    return issues


def _dependency_cycles(
    tasks: Sequence[PlanTask], by_id: dict[UUID, PlanTask], codes: dict[UUID, str]
) -> list[Issue]:
    issues: list[Issue] = []
    reported: set[frozenset] = set()
    done: set[UUID] = set()

    def walk(node: UUID, path: list[UUID]) -> None:
        if node in done:
            return
        if node in path:
            cycle = tuple(path[path.index(node) :])
            if frozenset(cycle) not in reported:
                reported.add(frozenset(cycle))
                issues.append(
                    Issue(
                        "dependency_cycle",
                        f"前置任务成环：{_cycle_text(cycle, codes)}",
                        cycle[0],
                        "dependency_ids",
                        cycle,
                    )
                )
            return
        path.append(node)
        for dep in by_id[node].dependency_ids:
            if dep in by_id and dep != node:
                walk(dep, path)
        path.pop()
        done.add(node)

    for task in tasks:
        walk(task.id, [])
    return issues


def new_blocking(before: Sequence[Issue], after: Sequence[Issue]) -> list[Issue]:
    """Blocking issues the change introduced; old bad data does not block every save."""
    old = {issue.key for issue in before}
    return [issue for issue in after if issue.code in BLOCKING and issue.key not in old]
