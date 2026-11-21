"""B-7 pages 11–13: one read model for the task tree, board and list.

* Read only. Status changes stay with C (C2-01): each row lists the transitions
  the caller may ask C for, computed with C's rules (assignee, dependencies,
  frozen plan, verified email), and why a card cannot move otherwise.
* The tree reports broken data (cycles, parents outside the project, links to
  other projects) without fixing it, and never fails because of it.
"""

from __future__ import annotations

import re
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import FunctionalModule, Milestone, Requirement, Task, User
from app.modules.a import permissions
from app.modules.b.courses_schemas import PersonDTO
from app.modules.b.plan_validation import validate_plan
from app.modules.b.planning_schemas import OptionDTO
from app.modules.b.planning_service import (
    Facts,
    _facts,
    _issue_dto,
    _latest_plan,
    _members,
    _people,
    _plan_task,
    task_code,
)
from app.modules.b.tasks_view_schemas import (
    ColumnDTO,
    TaskLinksDTO,
    TaskRowDTO,
    TasksPageDTO,
    TransitionDTO,
)
from app.modules.c.permissions import task_in_frozen_plan
from app.modules.c.school_email import has_verified_school_email
from app.modules.c.task_execution import progress_projection

STATUSES = {
    "not_started": "未开始",
    "in_progress": "进行中",
    "pending_submission": "待提交",
    "pending_verification": "待验收",
    "completed": "已完成",
}
PRIORITY_RANK = {"high": 0, "medium": 1, "low": 2}
SORTS = {"code", "title", "priority", "weight", "progress", "status", "updated"}
DIAGNOSTICS = {
    "unknown_parent",
    "parent_cycle",
    "dependency_cycle",
    "unknown_dependency",
    "unknown_module",
    "unknown_requirement",
}
CODE = re.compile(r"^t-?0*(\d+)$", re.IGNORECASE)


def _invalid(field: str) -> ApiError:
    return ApiError(422, "INVALID_FILTER", "筛选条件不正确。", details={"field": field})


def _uuid(value: str | None, field: str) -> UUID | None:
    if not value:
        return None
    try:
        return UUID(value)
    except ValueError as exc:
        raise _invalid(field) from exc


def integrity_issues(session: Session, project_id: UUID, facts: Facts):
    """B6-01 diagnostics: same rules as the plan, limited to broken links."""
    scope = {
        "modules": session.scalars(
            select(FunctionalModule.id).where(FunctionalModule.project_id == project_id)
        ).all(),
        "requirements": session.scalars(
            select(Requirement.id).where(Requirement.project_id == project_id)
        ).all(),
        "milestones": session.scalars(
            select(Milestone.id).where(Milestone.project_id == project_id)
        ).all(),
        "members": [],
    }
    issues = validate_plan([_plan_task(facts, t) for t in facts.tasks], **scope)
    return [i for i in issues if i.code in DIAGNOSTICS]


def _progress(tasks: list[Task]) -> dict[UUID, int]:
    try:
        values, _ = progress_projection(tasks)
        return values
    except ApiError:  # broken tree: show each task's own figure instead of failing
        return {t.id: t.progress_percent for t in tasks}


def list_tasks(
    session: Session,
    user: User,
    project_id: UUID,
    *,
    view: str = "tree",
    q: str = "",
    status: str = "",
    assignee: str = "",
    module: str = "",
    milestone: str = "",
    sort: str = "",
    page: int = 1,
    page_size: int = 20,
) -> TasksPageDTO:
    relation = permissions.require_project_read(session, user, project_id)
    if view not in {"tree", "board", "list"}:
        raise _invalid("view")
    if status and status not in STATUSES:
        raise _invalid("status")
    sort = sort or "code"
    if sort.lstrip("-") not in SORTS:
        raise _invalid("sort")
    if page < 1 or not 1 <= page_size <= 100:
        raise _invalid("page")
    module_id, milestone_id = _uuid(module, "module"), _uuid(milestone, "milestone")
    if assignee in {"", "none"}:
        assignee_id = None
    elif assignee == "me":
        assignee_id = user.id
    else:
        assignee_id = _uuid(assignee, "assignee")
    q = q.strip()
    if len(q) > 100:
        raise _invalid("q")

    project = relation.project
    facts = _facts(session, project_id)
    by_id = {t.id: t for t in facts.tasks}
    progress = _progress(facts.tasks)
    plan = _latest_plan(session, project_id)
    plan_frozen = plan is not None and plan.status == "frozen"
    code_match = CODE.match(q)

    def matches(task: Task) -> bool:
        assigned = facts.assignees.get(task.id, [])
        if status and task.status != status:
            return False
        if module_id and task.module_id != module_id:
            return False
        if milestone_id and milestone_id not in facts.milestones.get(task.id, []):
            return False
        if assignee == "none" and assigned:
            return False
        if assignee_id and assignee_id not in assigned:
            return False
        if q:
            meta = facts.meta.get(task.id)
            if code_match and meta and meta.seq == int(code_match.group(1)):
                return True
            text = f"{task.title}\n{task.description or ''}\n{task_code(meta.seq) if meta else ''}"
            return q.casefold() in text.casefold()
        return True

    matched = [t for t in facts.tasks if matches(t)]
    total = len(matched)
    if view == "tree":
        keep = {t.id for t in matched}
        for task in matched:  # keep ancestors so the hierarchy still reads
            seen, cursor = {task.id}, task.parent_task_id
            while cursor in by_id and cursor not in seen:
                keep.add(cursor)
                seen.add(cursor)
                cursor = by_id[cursor].parent_task_id
        rows = [t for t in facts.tasks if t.id in keep]
        page, page_size = 1, max(total, 1)
    else:
        descending = sort.startswith("-")
        key = sort.lstrip("-")

        def sort_key(task: Task):
            meta = facts.meta.get(task.id)
            return {
                "code": (meta.seq if meta else 10**9,),
                "title": (task.title.casefold(),),
                "priority": (PRIORITY_RANK.get(task.priority, 9),),
                "weight": (int(task.weight),),
                "progress": (progress.get(task.id, 0),),
                "status": (list(STATUSES).index(task.status),),
                "updated": (task.updated_at.timestamp() if task.updated_at else 0,),
            }[key] + (str(task.id),)

        rows = sorted(matched, key=sort_key, reverse=descending)
        if view == "list":
            rows = rows[(page - 1) * page_size : page * page_size]
        else:
            page, page_size = 1, max(total, 1)

    matched_ids = {t.id for t in matched}
    verified = relation.member and has_verified_school_email(session, user)
    project_open = (
        project.lifecycle == "active"
        and project.setup_status == "frozen"
        and (relation.course is None or relation.course.status == "active")
    )
    people = _people(session, {u for ids in facts.assignees.values() for u in ids})
    modules = session.scalars(
        select(FunctionalModule)
        .where(FunctionalModule.project_id == project_id)
        .order_by(FunctionalModule.sort_order, FunctionalModule.created_at)
    ).all()
    module_names = {m.id: m.name for m in modules}
    children = {t.parent_task_id for t in facts.tasks if t.parent_task_id}

    def row(task: Task) -> TaskRowDTO:
        meta = facts.meta.get(task.id)
        code = task_code(meta.seq) if meta else None
        assigned = facts.assignees.get(task.id, [])
        deps = facts.dependencies.get(task.id, [])
        open_deps = [d for d in deps if d not in by_id or by_id[d].status != "completed"]
        base = f"/projects/{project_id}/tasks/{task.id}"
        transitions: list[TransitionDTO] = []
        if not relation.member:
            blocked = "只有本组成员可以推进任务"
        elif not project_open:
            blocked = "项目当前不能推进任务"
        elif not plan_frozen:
            blocked = "任务计划还没冻结"
        elif not task_in_frozen_plan(plan, task.id):
            blocked = "任务不在已冻结的计划里"
        elif not verified:
            blocked = "请先验证学校邮箱"
        elif task.status == "not_started":
            if user.id not in assigned:
                blocked = "只有负责人可以开始这个任务"
            elif open_deps:
                names = "、".join(
                    (task_code(facts.meta[d].seq) if d in facts.meta else "前置任务")
                    for d in open_deps
                )
                blocked = f"前置任务未完成：{names}"
            else:
                blocked = None
                transitions.append(
                    TransitionDTO(
                        to="in_progress",
                        kind="api",
                        method="POST",
                        path=f"/api/v1/tasks/{task.id}/start",
                        expected_version=task.lock_version,
                    )
                )
        elif task.status == "in_progress":
            if user.id not in assigned and not relation.leader:
                blocked = "只有负责人或组长可以提交"
            elif task.id in children:
                blocked = "有子任务的任务按子任务汇总进度"
            else:
                blocked = None
                transitions.append(
                    TransitionDTO(
                        to="pending_submission",
                        kind="page",
                        href=f"{base}/submit",
                        expected_version=task.lock_version,
                    )
                )
        else:
            blocked = "这个状态由提交和验收流程改变"
        return TaskRowDTO(
            id=task.id,
            code=code,
            title=task.title,
            module=OptionDTO(
                id=task.module_id, name=module_names.get(task.module_id, "其他项目的模块")
            ),
            parent_task_id=task.parent_task_id,
            assignees=[people.get(u) or PersonDTO(id=u, name=None) for u in assigned],
            priority=task.priority,
            weight=int(task.weight),
            status=task.status,
            progress_percent=progress.get(task.id, task.progress_percent),
            milestone_ids=facts.milestones.get(task.id, []),
            dependency_ids=deps,
            dependencies_done=not open_deps,
            content_version=meta.content_version if meta else 0,
            lock_version=task.lock_version,
            updated_at=task.updated_at,
            links=TaskLinksDTO(
                detail=base,
                submit=f"{base}/submit",
                evidence=f"/projects/{project_id}/evidence?task={task.id}",
                verification=f"{base}/verification",
            ),
            transitions=transitions,
            blocked_reason=blocked,
            matched=task.id in matched_ids,
        )

    counts = {key: 0 for key in STATUSES}
    for task in matched:
        counts[task.status] = counts.get(task.status, 0) + 1
    members = _members(session, project_id)
    member_people = _people(session, set(members))
    milestones = session.scalars(
        select(Milestone)
        .where(Milestone.project_id == project_id)
        .order_by(Milestone.sort_order, Milestone.deadline)
    ).all()
    return TasksPageDTO(
        view=view,  # type: ignore[arg-type]
        items=[row(t) for t in rows],
        total=total,
        page=page,
        page_size=page_size,
        lock_version=plan.lock_version if plan else 0,
        plan_status="none" if plan is None else ("frozen" if plan_frozen else "draft"),
        integrity_issues=[_issue_dto(i) for i in integrity_issues(session, project_id, facts)]
        if view == "tree"
        else [],
        columns=[ColumnDTO(status=k, label=v, count=counts[k]) for k, v in STATUSES.items()],
        modules=[OptionDTO(id=m.id, name=m.name) for m in modules],
        members=[member_people.get(m) or PersonDTO(id=m, name=None) for m in members],
        milestones=[OptionDTO(id=m.id, name=m.title) for m in milestones],
    )
