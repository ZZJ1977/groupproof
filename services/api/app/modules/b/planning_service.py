"""B-6 page 10: task plan draft, versions, AI suggestions, confirmation, freeze.

* Tasks live in C's ``tasks`` tables; the plan is ``plan_versions``. C starts a
  task only when the *latest* plan version is ``frozen`` and lists the task in
  ``snapshot_json["tasks"]`` (``c.permissions.require_task_plan``).
* Every plan write locks the ``projects`` row first, like C's execution writers,
  then the latest plan row.
* A save is refused only for problems it introduces (bad references, cycles);
  missing owners, missing criteria and weight totals are reported and block the
  freeze.
* A member's confirmation stores the content version of each task assigned to
  them; it is valid only while those versions are unchanged (checked on read).
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass, field
from uuid import UUID, uuid4

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import (
    AcceptanceCriterion,
    BaselineVersion,
    FunctionalModule,
    Milestone,
    PlanConfirmation,
    PlanVersion,
    Project,
    ProjectMember,
    Requirement,
    Task,
    TaskAssignee,
    TaskDependency,
    TaskMilestone,
    TaskRequirement,
    User,
)
from app.modules.a import permissions
from app.modules.a.ai import TaskSuggestionInput, suggest_tasks
from app.modules.a.ai.provider import AIProvider
from app.modules.a.ai.schemas import RequirementBrief, TaskBrief
from app.modules.a.audit import record_audit
from app.modules.a.inbox import notify
from app.modules.b.common import now, require_reason, require_version
from app.modules.b.courses_schemas import PersonDTO
from app.modules.b.models import (
    BCriterionInvalidation,
    BCriterionRecheck,
    BPlanConfirmationSnapshot,
    BProjectCounter,
    BRequirementCode,
    BRequirementMeta,
    BTaskMeta,
    BTaskSuggestion,
    BTaskVersion,
)
from app.modules.b.plan_validation import Issue, PlanTask, new_blocking, validate_plan
from app.modules.b.planning_schemas import (
    AdoptSuggestion,
    ConfirmAssignment,
    CriterionDTO,
    CriterionInput,
    DeleteTask,
    FreezePlan,
    IssueDTO,
    MemberConfirmationDTO,
    OptionDTO,
    PlanDTO,
    PlanHistoryDTO,
    SuggestionBatchDTO,
    SuggestionDTO,
    TaskDTO,
    TaskInput,
    TaskVersionDTO,
    UnlockPlan,
    UpdateTask,
)
from app.modules.b.ports import VerificationPort
from app.modules.b.requirement_history import code_of as requirement_code

DRAFT, FROZEN = "draft", "frozen"


def task_code(seq: int | None) -> str | None:
    return f"T-{seq:03d}" if seq else None


# ---------------------------------------------------------------- loading


@dataclass
class Facts:
    tasks: list[Task]
    meta: dict[UUID, BTaskMeta]
    requirements: dict[UUID, list[UUID]] = field(default_factory=dict)
    dependencies: dict[UUID, list[UUID]] = field(default_factory=dict)
    milestones: dict[UUID, list[UUID]] = field(default_factory=dict)
    assignees: dict[UUID, list[UUID]] = field(default_factory=dict)
    criteria: dict[UUID, list[AcceptanceCriterion]] = field(default_factory=dict)

    def code(self, task_id: UUID) -> str:
        meta = self.meta.get(task_id)
        return task_code(meta.seq if meta else None) or f"任务 {str(task_id)[:8]}"

    def content_version(self, task_id: UUID) -> int:
        meta = self.meta.get(task_id)
        return meta.content_version if meta else 0


def _fresh(session: Session, statement):
    return session.scalars(statement.execution_options(populate_existing=True)).all()


def _facts(session: Session, project_id: UUID) -> Facts:
    tasks = list(
        _fresh(
            session,
            select(Task).where(Task.project_id == project_id).order_by(Task.created_at, Task.id),
        )
    )
    ids = [t.id for t in tasks]
    facts = Facts(
        tasks=tasks,
        meta={
            m.task_id: m
            for m in _fresh(session, select(BTaskMeta).where(BTaskMeta.project_id == project_id))
        },
    )
    if not ids:
        return facts
    for row in _fresh(session, select(TaskRequirement).where(TaskRequirement.task_id.in_(ids))):
        facts.requirements.setdefault(row.task_id, []).append(row.requirement_id)
    for row in _fresh(session, select(TaskDependency).where(TaskDependency.task_id.in_(ids))):
        facts.dependencies.setdefault(row.task_id, []).append(row.depends_on_task_id)
    for row in _fresh(session, select(TaskMilestone).where(TaskMilestone.task_id.in_(ids))):
        facts.milestones.setdefault(row.task_id, []).append(row.milestone_id)
    for row in _fresh(
        session,
        select(TaskAssignee)
        .where(
            TaskAssignee.task_id.in_(ids),
            TaskAssignee.role == "responsible",
            TaskAssignee.unassigned_at.is_(None),
        )
        .order_by(TaskAssignee.assigned_at, TaskAssignee.user_id),
    ):
        facts.assignees.setdefault(row.task_id, []).append(row.user_id)
    for row in _fresh(
        session,
        select(AcceptanceCriterion)
        .where(AcceptanceCriterion.task_id.in_(ids))
        .order_by(AcceptanceCriterion.sort_order, AcceptanceCriterion.created_at),
    ):
        facts.criteria.setdefault(row.task_id, []).append(row)
    return facts


def _plan_task(facts: Facts, task: Task) -> PlanTask:
    return PlanTask(
        id=task.id,
        code=facts.code(task.id),
        module_id=task.module_id,
        parent_id=task.parent_task_id,
        weight=int(task.weight),
        criteria_count=len(facts.criteria.get(task.id, [])),
        requirement_ids=tuple(facts.requirements.get(task.id, [])),
        assignee_ids=tuple(facts.assignees.get(task.id, [])),
        dependency_ids=tuple(facts.dependencies.get(task.id, [])),
        milestone_ids=tuple(facts.milestones.get(task.id, [])),
    )


def _members(session: Session, project_id: UUID) -> list[UUID]:
    return list(
        session.scalars(
            select(ProjectMember.user_id)
            .where(ProjectMember.project_id == project_id, ProjectMember.left_at.is_(None))
            .order_by(ProjectMember.joined_at, ProjectMember.user_id)
        )
    )


def _included_requirements(session: Session, project_id: UUID) -> list[Requirement]:
    return list(
        _fresh(
            session,
            select(Requirement)
            .join(BRequirementMeta, BRequirementMeta.requirement_id == Requirement.id, isouter=True)
            .where(
                Requirement.project_id == project_id,
                func.coalesce(BRequirementMeta.excluded, False).is_(False),
            )
            .order_by(Requirement.created_at, Requirement.id),
        )
    )


def _scope(session: Session, project_id: UUID) -> dict:
    return {
        "modules": session.scalars(
            select(FunctionalModule.id).where(FunctionalModule.project_id == project_id)
        ).all(),
        "requirements": [r.id for r in _included_requirements(session, project_id)],
        "milestones": session.scalars(
            select(Milestone.id).where(Milestone.project_id == project_id)
        ).all(),
        "members": _members(session, project_id),
    }


def _issues(session: Session, project_id: UUID, facts: Facts) -> list[Issue]:
    return validate_plan([_plan_task(facts, t) for t in facts.tasks], **_scope(session, project_id))


def _issue_dto(issue: Issue) -> IssueDTO:
    return IssueDTO(
        code=issue.code,
        message=issue.message,
        task_id=issue.task_id,
        field=issue.field,
        task_ids=list(issue.task_ids),
    )


def _latest_plan(session: Session, project_id: UUID, *, lock: bool = False) -> PlanVersion | None:
    statement = (
        select(PlanVersion)
        .where(PlanVersion.project_id == project_id)
        .order_by(PlanVersion.version_no.desc())
        .limit(1)
    )
    if lock:
        statement = statement.with_for_update()
    return session.scalar(statement.execution_options(populate_existing=True))


def _lock_project(session: Session, project_id: UUID) -> Project:
    return session.scalar(
        select(Project)
        .where(Project.id == project_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )


def _require_baseline(project: Project) -> None:
    if project.setup_status != "frozen":
        raise ApiError(409, "BASELINE_NOT_FROZEN", "需求基线冻结后才能制定任务计划。")


def _frozen_baseline(session: Session, project_id: UUID) -> BaselineVersion | None:
    return session.scalar(
        select(BaselineVersion)
        .where(BaselineVersion.project_id == project_id, BaselineVersion.status == "frozen")
        .order_by(BaselineVersion.version_no.desc())
        .limit(1)
    )


def _new_draft(
    session: Session,
    project: Project,
    user: User,
    *,
    based_on: PlanVersion | None,
    reason: str | None = None,
) -> PlanVersion:
    baseline = _frozen_baseline(session, project.id)
    version_no = (
        session.scalar(
            select(func.max(PlanVersion.version_no)).where(PlanVersion.project_id == project.id)
        )
        or 0
    ) + 1
    snapshot: dict = {
        "tasks": [],
        "baseline_version_id": str(baseline.id) if baseline else None,
        "baseline_version_no": baseline.version_no if baseline else None,
    }
    if reason:
        snapshot["unlock_reason"] = reason
    plan = PlanVersion(
        id=uuid4(),
        project_id=project.id,
        version_no=version_no,
        based_on_version_id=based_on.id if based_on else None,
        created_by=user.id,
        status=DRAFT,
        snapshot_json=snapshot,
        lock_version=0,
    )
    session.add(plan)
    session.flush()
    return plan


def plan_frozen() -> ApiError:
    return ApiError(409, "PLAN_FROZEN", "任务计划已冻结，组长解锁后才能修改。")


def _writer(session: Session, user: User, project_id: UUID):
    """Member + writable project + frozen baseline + draft plan (project row locked first)."""
    relation = permissions.require_project_member(session, user, project_id)
    project = _lock_project(session, project_id)
    _require_baseline(project)
    plan = _latest_plan(session, project.id, lock=True)
    if plan is None:
        plan = _new_draft(session, project, user, based_on=None)
    if plan.status != DRAFT:
        raise plan_frozen()
    return relation, project, plan


# ---------------------------------------------------------------- snapshots + versions


def _task_snapshot(facts: Facts, task: Task) -> dict:
    return {
        "title": task.title,
        "description": task.description or "",
        "module_id": str(task.module_id),
        "parent_task_id": str(task.parent_task_id) if task.parent_task_id else None,
        "requirement_ids": sorted(str(i) for i in facts.requirements.get(task.id, [])),
        "assignee_ids": sorted(str(i) for i in facts.assignees.get(task.id, [])),
        "dependency_ids": sorted(str(i) for i in facts.dependencies.get(task.id, [])),
        "milestone_ids": sorted(str(i) for i in facts.milestones.get(task.id, [])),
        "priority": task.priority,
        "weight": int(task.weight),
        "criteria": [{"id": str(c.id), "text": c.text} for c in facts.criteria.get(task.id, [])],
    }


def _next_task_seq(session: Session, project_id: UUID) -> int:
    statement = (
        insert(BProjectCounter)
        .values(project_id=project_id, requirement_seq=0, task_seq=1)
        .on_conflict_do_update(
            index_elements=[BProjectCounter.project_id],
            set_={"task_seq": BProjectCounter.task_seq + 1},
        )
        .returning(BProjectCounter.task_seq)
    )
    return session.execute(statement).scalar_one()


def _add_version(
    session: Session, task: Task, plan: PlanVersion, version_no: int, snapshot: dict, actor: UUID
) -> None:
    session.add(
        BTaskVersion(
            id=uuid4(),
            task_id=task.id,
            project_id=task.project_id,
            plan_version_id=plan.id,
            version_no=version_no,
            snapshot=snapshot,
            created_by=actor,
            created_at=now(),
        )
    )


def _dedupe(values) -> list:
    return list(dict.fromkeys(values))


def _validation_failed(issues: list[Issue]) -> ApiError:
    return ApiError(
        422,
        "PLAN_VALIDATION_FAILED",
        issues[0].message,
        details={"issues": [_issue_dto(i).model_dump(mode="json") for i in issues]},
    )


def _check_proposal(
    session: Session, project_id: UUID, facts: Facts, task_id: UUID, code: str, cmd: TaskInput
) -> None:
    current = [_plan_task(facts, t) for t in facts.tasks]
    proposed = PlanTask(
        id=task_id,
        code=code,
        module_id=cmd.module_id,
        parent_id=cmd.parent_task_id,
        weight=cmd.weight,
        criteria_count=len(cmd.criteria),
        requirement_ids=tuple(_dedupe(cmd.requirement_ids)),
        assignee_ids=tuple(_dedupe(cmd.assignee_ids)),
        dependency_ids=tuple(_dedupe(cmd.dependency_ids)),
        milestone_ids=tuple(_dedupe(cmd.milestone_ids)),
    )
    after = [t for t in current if t.id != task_id] + [proposed]
    scope = _scope(session, project_id)
    blocking = new_blocking(validate_plan(current, **scope), validate_plan(after, **scope))
    if blocking:
        raise _validation_failed(blocking)
    own = {c.id for c in facts.criteria.get(task_id, [])}
    for item in cmd.criteria:
        if not item.text.strip():
            raise ApiError(422, "CRITERION_EMPTY", "验收标准不能为空。")
        if item.id is not None and item.id not in own:
            raise ApiError(
                422,
                "CRITERION_NOT_FOUND",
                "这条验收标准不属于这个任务。",
                details={"criterion_id": str(item.id)},
            )


def _write_relations(session: Session, task: Task, cmd: TaskInput) -> None:
    pairs = (
        (TaskRequirement, "requirement_id", cmd.requirement_ids),
        (TaskDependency, "depends_on_task_id", cmd.dependency_ids),
        (TaskMilestone, "milestone_id", cmd.milestone_ids),
    )
    for model, column, values in pairs:
        session.execute(delete(model).where(model.task_id == task.id))
        for value in _dedupe(values):
            session.add(model(task_id=task.id, **{column: value}))
    rows = {
        r.user_id: r
        for r in session.scalars(select(TaskAssignee).where(TaskAssignee.task_id == task.id))
    }
    wanted = _dedupe(cmd.assignee_ids)
    for user_id, row in rows.items():
        if user_id not in wanted and row.unassigned_at is None:
            row.unassigned_at = now()
    for user_id in wanted:
        row = rows.get(user_id)
        if row is None:
            session.add(
                TaskAssignee(
                    task_id=task.id, user_id=user_id, role="responsible", assigned_at=now()
                )
            )
        elif row.unassigned_at is not None or row.role != "responsible":
            row.role, row.unassigned_at, row.assigned_at = "responsible", None, now()


def _write_criteria(
    session: Session, task: Task, existing: list[AcceptanceCriterion], items: list[CriterionInput]
) -> list[UUID]:
    """Apply the criteria list; returns the ids of existing criteria whose text changed."""
    by_id = {c.id: c for c in existing}
    keep, changed = set(), []
    for index, item in enumerate(items):
        text = item.text.strip()
        if item.id is not None:
            row = by_id[item.id]
            keep.add(row.id)
            if row.text != text:
                row.text = text
                row.lock_version += 1
                changed.append(row.id)
            row.sort_order = index
        else:
            session.add(
                AcceptanceCriterion(
                    id=uuid4(),
                    task_id=task.id,
                    criterion_key=f"AC-{uuid4().hex[:8]}",
                    text=text,
                    sort_order=index,
                )
            )
    for row in existing:
        if row.id in keep:
            continue
        try:
            with session.begin_nested():
                session.delete(row)
                session.flush()
        except IntegrityError as exc:
            raise ApiError(
                409,
                "CRITERION_HAS_RECORDS",
                "这条验收标准已有证据或验收记录，不能删除，可以改写内容。",
                details={"criterion_id": str(row.id)},
            ) from exc
    return changed


def _tell_verification(
    session: Session,
    user: User,
    task: Task,
    code: str,
    changed: list[UUID],
    content_version: int,
    verification: VerificationPort,
) -> None:
    """B5-02: a started task may have verification results; ask D to void them."""
    if not changed:
        return
    for mark in session.scalars(
        select(BCriterionRecheck).where(
            BCriterionRecheck.criterion_id.in_(changed), BCriterionRecheck.cleared_at.is_(None)
        )
    ):
        mark.cleared_at = now()
    if task.started_at is None and task.status == "not_started":
        return
    reason = f"{code} 的验收标准已修改"
    outcome = verification.invalidate_criterion_results(
        session, task_id=task.id, criterion_ids=changed, reason=reason, actor_id=user.id
    )
    session.add(
        BCriterionInvalidation(
            id=uuid4(),
            project_id=task.project_id,
            task_id=task.id,
            criterion_ids=[str(i) for i in changed],
            task_content_version=content_version,
            reason=reason,
            accepted=outcome.accepted,
            requested_by=user.id,
            requested_at=now(),
        )
    )


def _save(
    session: Session,
    user: User,
    project: Project,
    plan: PlanVersion,
    task: Task | None,
    cmd: TaskInput,
    verification: VerificationPort,
    *,
    origin: str = "manual",
    suggestion_id: UUID | None = None,
    request=None,
) -> Task:
    facts = _facts(session, project.id)
    creating = task is None
    task_id = task.id if task else uuid4()
    meta = facts.meta.get(task_id)
    code = facts.code(task_id) if not creating else "新任务"
    _check_proposal(session, project.id, facts, task_id, code, cmd)
    before = None if creating else _task_snapshot(facts, task)
    old_version = facts.content_version(task_id)
    if creating:
        task = Task(id=task_id, project_id=project.id, created_by=user.id, module_id=cmd.module_id)
        session.add(task)
    task.module_id = cmd.module_id
    task.parent_task_id = cmd.parent_task_id
    task.title = cmd.title.strip()
    task.description = cmd.description.strip()
    task.priority = cmd.priority
    task.weight = cmd.weight
    session.flush()
    _write_relations(session, task, cmd)
    changed = _write_criteria(session, task, facts.criteria.get(task.id, []), cmd.criteria)
    session.flush()
    facts = _facts(session, project.id)
    after = _task_snapshot(facts, task)
    if not creating and after == before:
        return task
    if meta is None:
        meta = BTaskMeta(
            task_id=task.id,
            project_id=project.id,
            seq=_next_task_seq(session, project.id),
            content_version=0,
            origin=origin,
            suggestion_id=suggestion_id,
        )
        session.add(meta)
    has_history = session.scalar(
        select(func.count()).select_from(BTaskVersion).where(BTaskVersion.task_id == task.id)
    )
    if not creating and not has_history and old_version >= 1 and before is not None:
        _add_version(session, task, plan, old_version, before, user.id)  # back-fill
    meta.content_version = old_version + 1
    _add_version(session, task, plan, meta.content_version, after, user.id)
    if not creating:
        task.lock_version += 1
    plan.lock_version += 1
    session.flush()
    code = task_code(meta.seq) or code
    _tell_verification(session, user, task, code, changed, meta.content_version, verification)
    record_audit(
        session,
        actor=user,
        action="project.plan.task_created" if creating else "project.plan.task_updated",
        target=("task", task.id),
        project_id=project.id,
        course_id=project.course_id,
        before=before,
        after={"code": code, "content_version": meta.content_version, "origin": meta.origin},
        request=request,
    )
    session.flush()
    return task


def _task_in_project(session: Session, project_id: UUID, task_id: UUID, *, lock=False) -> Task:
    statement = select(Task).where(Task.id == task_id, Task.project_id == project_id)
    if lock:
        statement = statement.with_for_update()
    task = session.scalar(statement.execution_options(populate_existing=True))
    if task is None:
        raise ApiError(404, "TASK_NOT_FOUND", "任务不存在。")
    return task


def create_task(
    session: Session,
    user: User,
    project_id: UUID,
    cmd: TaskInput,
    verification: VerificationPort,
    request=None,
) -> TaskDTO:
    _, project, plan = _writer(session, user, project_id)
    task = _save(session, user, project, plan, None, cmd, verification, request=request)
    return _task_dto_for(session, project.id, task.id)


def update_task(
    session: Session,
    user: User,
    project_id: UUID,
    task_id: UUID,
    cmd: UpdateTask,
    verification: VerificationPort,
    request=None,
) -> TaskDTO:
    _, project, plan = _writer(session, user, project_id)
    task = _task_in_project(session, project.id, task_id, lock=True)
    meta = session.get(BTaskMeta, task.id, populate_existing=True)
    require_version(meta.content_version if meta else 0, cmd.expected_version)
    data = cmd.model_dump(exclude={"expected_version"})
    _save(session, user, project, plan, task, TaskInput(**data), verification, request=request)
    return _task_dto_for(session, project.id, task.id)


def delete_task(
    session: Session, user: User, project_id: UUID, task_id: UUID, cmd: DeleteTask, request=None
) -> dict:
    _, project, plan = _writer(session, user, project_id)
    task = _task_in_project(session, project.id, task_id, lock=True)
    meta = session.get(BTaskMeta, task.id, populate_existing=True)
    require_version(meta.content_version if meta else 0, cmd.expected_version)
    if task.started_at is not None or task.status != "not_started":
        raise ApiError(409, "TASK_STARTED", "已经开始执行的任务不能删除。")
    if session.scalar(select(func.count()).select_from(Task).where(Task.parent_task_id == task.id)):
        raise ApiError(409, "TASK_HAS_CHILDREN", "先删除或移走它的子任务。")
    dependents = session.scalar(
        select(func.count())
        .select_from(TaskDependency)
        .where(TaskDependency.depends_on_task_id == task.id)
    )
    if dependents:
        raise ApiError(409, "TASK_IS_DEPENDENCY", "还有任务把它设为前置任务，先去掉这些依赖。")
    code = task_code(meta.seq) if meta else None
    try:
        with session.begin_nested():
            session.delete(task)
            session.flush()
    except IntegrityError as exc:
        raise ApiError(409, "TASK_HAS_RECORDS", "这个任务已有执行或证据记录，不能删除。") from exc
    plan.lock_version += 1
    record_audit(
        session,
        actor=user,
        action="project.plan.task_deleted",
        target=("task", task_id),
        project_id=project.id,
        course_id=project.course_id,
        before={"code": code, "title": task.title},
        request=request,
    )
    session.flush()
    return {"id": task_id, "deleted": True}


def task_versions(
    session: Session, user: User, project_id: UUID, task_id: UUID
) -> list[TaskVersionDTO]:
    permissions.require_project_read(session, user, project_id)
    _task_in_project(session, project_id, task_id)
    rows = session.scalars(
        select(BTaskVersion)
        .where(BTaskVersion.task_id == task_id)
        .order_by(BTaskVersion.version_no.desc())
    ).all()
    people = _people(session, {r.created_by for r in rows if r.created_by})
    return [
        TaskVersionDTO(
            version_no=r.version_no,
            snapshot=r.snapshot,
            created_by=people.get(r.created_by),
            created_at=r.created_at,
        )
        for r in rows
    ]


# ---------------------------------------------------------------- B5-04 confirmation


def _my_versions(facts: Facts, user_id: UUID) -> dict[str, int]:
    return {
        str(task.id): facts.content_version(task.id)
        for task in facts.tasks
        if user_id in facts.assignees.get(task.id, [])
    }


def _confirmations(
    session: Session, plan: PlanVersion | None, facts: Facts, members: list[UUID]
) -> list[MemberConfirmationDTO]:
    rows, snaps = {}, {}
    if plan is not None:
        rows = {
            r.user_id: r
            for r in _fresh(
                session, select(PlanConfirmation).where(PlanConfirmation.plan_version_id == plan.id)
            )
        }
        snaps = {
            s.confirmation_id: s.task_versions
            for s in _fresh(
                session,
                select(BPlanConfirmationSnapshot).where(
                    BPlanConfirmationSnapshot.confirmation_id.in_([r.id for r in rows.values()])
                ),
            )
        }
    people = _people(session, set(members))
    result = []
    for user_id in members:
        mine = _my_versions(facts, user_id)
        row = rows.get(user_id)
        state = "pending"
        if row is not None and row.status == "confirmed":
            state = "confirmed" if snaps.get(row.id) == mine else "stale"
        result.append(
            MemberConfirmationDTO(
                user=people.get(user_id) or PersonDTO(id=user_id, name=None),
                state=state,  # type: ignore[arg-type]
                confirmed_at=row.confirmed_at if row is not None and state == "confirmed" else None,
                task_count=len(mine),
            )
        )
    return result


def confirm_mine(
    session: Session, user: User, project_id: UUID, cmd: ConfirmAssignment, request=None
) -> PlanDTO:
    _, project, plan = _writer(session, user, project_id)
    facts = _facts(session, project.id)
    current = _my_versions(facts, user.id)
    seen = {str(k): v for k, v in cmd.task_versions.items()}
    if seen != current:
        raise ApiError(
            409,
            "ASSIGNMENT_CHANGED",
            "分给你的任务刚刚有变化，请刷新后再确认。",
            details={"task_versions": current},
        )
    row = session.scalar(
        select(PlanConfirmation)
        .where(PlanConfirmation.plan_version_id == plan.id, PlanConfirmation.user_id == user.id)
        .with_for_update()
    )
    if row is None:
        row = PlanConfirmation(id=uuid4(), plan_version_id=plan.id, user_id=user.id)
        session.add(row)
    row.status, row.confirmed_at = "confirmed", now()
    session.flush()
    snap = session.get(BPlanConfirmationSnapshot, row.id)
    if snap is None:
        session.add(BPlanConfirmationSnapshot(confirmation_id=row.id, task_versions=current))
    else:
        snap.task_versions = current
    record_audit(
        session,
        actor=user,
        action="project.plan.assignment_confirmed",
        target=("plan_version", plan.id),
        project_id=project.id,
        course_id=project.course_id,
        after={"task_versions": current},
        request=request,
    )
    session.flush()
    return plan_view(session, user, project.id)


# ---------------------------------------------------------------- B5-05 freeze + unlock


def _target(project_id: UUID) -> dict:
    return {"kind": "plan", "id": project_id, "project_id": project_id}


def freeze(session: Session, user: User, project_id: UUID, cmd: FreezePlan, request=None):
    permissions.require_project_leader(session, user, project_id)
    project = _lock_project(session, project_id)
    _require_baseline(project)
    plan = _latest_plan(session, project.id, lock=True)
    if plan is None:
        raise ApiError(409, "PLAN_NOT_STARTED", "还没有任务计划草稿。")
    if plan.status != DRAFT:
        raise ApiError(409, "PLAN_FROZEN", "任务计划已经冻结。")
    require_version(plan.lock_version, cmd.expected_version)
    facts = _facts(session, project.id)
    issues = _issues(session, project.id, facts)
    members = _members(session, project.id)
    unconfirmed = [
        c.user for c in _confirmations(session, plan, facts, members) if c.state != "confirmed"
    ]
    if issues or unconfirmed:
        parts = []
        if issues:
            parts.append(f"{len(issues)} 个问题要先处理")
        if unconfirmed:
            parts.append(f"{len(unconfirmed)} 位组员还没确认分配")
        raise ApiError(
            409,
            "PLAN_NOT_READY",
            "还不能冻结：" + "，".join(parts) + "。",
            details={
                "issues": [_issue_dto(i).model_dump(mode="json") for i in issues],
                "unconfirmed": [p.model_dump(mode="json") for p in unconfirmed],
            },
        )
    moment = now()
    plan.snapshot_json = {
        **plan.snapshot_json,
        "tasks": [
            {
                "id": str(t.id),
                "code": facts.code(t.id),
                "content_version": facts.content_version(t.id),
                **_task_snapshot(facts, t),
            }
            for t in facts.tasks
        ],
        "frozen_by": str(user.id),
        "frozen_at": moment.isoformat(),
    }
    plan.status, plan.frozen_at, plan.confirmed_at = FROZEN, moment, moment
    plan.lock_version += 1
    session.flush()
    for member_id in members:
        notify(
            session,
            recipient=member_id,
            category="project",
            title=f"「{project.name}」的任务计划 v{plan.version_no} 已冻结",
            description="全部组员已确认分配，可以按计划开始任务了。",
            target=_target(project.id),
            dedupe_key=f"b:plan-frozen:{plan.id}",
        )
    record_audit(
        session,
        actor=user,
        action="project.plan.frozen",
        target=("plan_version", plan.id),
        project_id=project.id,
        course_id=project.course_id,
        after={"version_no": plan.version_no, "tasks": len(facts.tasks)},
        request=request,
    )
    session.flush()
    return plan_view(session, user, project.id)


def unlock(session: Session, user: User, project_id: UUID, cmd: UnlockPlan, request=None):
    permissions.require_project_leader(session, user, project_id)
    reason = require_reason(cmd.reason)
    project = _lock_project(session, project_id)  # same order as C: project row first
    plan = _latest_plan(session, project.id, lock=True)
    if plan is None or plan.status != FROZEN:
        raise ApiError(409, "PLAN_NOT_FROZEN", "计划还没有冻结，不需要解锁。")
    require_version(plan.lock_version, cmd.expected_version)
    plan.status = "archived"
    plan.lock_version += 1
    draft = _new_draft(session, project, user, based_on=plan, reason=reason)
    for member_id in _members(session, project.id):
        notify(
            session,
            recipient=member_id,
            category="project",
            title=f"「{project.name}」的任务计划已解锁",
            description=f"原因：{reason}。修改完成后请重新确认你的任务分配。"[:2000],
            target=_target(project.id),
            dedupe_key=f"b:plan-unlocked:{draft.id}",
        )
    record_audit(
        session,
        actor=user,
        action="project.plan.unlocked",
        target=("plan_version", plan.id),
        project_id=project.id,
        course_id=project.course_id,
        after={"draft_version_no": draft.version_no},
        reason=reason,
        request=request,
    )
    session.flush()
    return plan_view(session, user, project.id)


# ---------------------------------------------------------------- B5-03 AI suggestions


def fingerprint(requirement_id: UUID, title: str) -> str:
    normalised = re.sub(r"[\W_]+", "", unicodedata.normalize("NFKC", title).casefold())
    return hashlib.sha256(f"{requirement_id}|{normalised}".encode()).hexdigest()


def _requirement_codes(session: Session, ids) -> dict[UUID, str | None]:
    if not ids:
        return {}
    return {
        r.requirement_id: requirement_code(r.seq)
        for r in session.scalars(
            select(BRequirementCode).where(BRequirementCode.requirement_id.in_(list(ids)))
        )
    }


def _suggestion_dtos(session: Session, rows: list[BTaskSuggestion]) -> list[SuggestionDTO]:
    ids = {r.requirement_id for r in rows}
    codes = _requirement_codes(session, ids)
    titles = (
        {
            r.id: r.title
            for r in session.scalars(select(Requirement).where(Requirement.id.in_(list(ids))))
        }
        if ids
        else {}
    )
    return [
        SuggestionDTO(
            id=r.id,
            requirement_id=r.requirement_id,
            requirement_code=codes.get(r.requirement_id),
            requirement_title=titles.get(r.requirement_id, ""),
            title=r.title,
            description=r.description,
            acceptance_criteria=list(r.acceptance_criteria),
            status=r.status,  # type: ignore[arg-type]
            is_placeholder=r.is_placeholder,
            adopted_task_id=r.adopted_task_id,
            created_at=r.created_at,
        )
        for r in rows
    ]


def list_suggestions(
    session: Session, user: User, project_id: UUID, status: str = "pending"
) -> list[SuggestionDTO]:
    permissions.require_project_read(session, user, project_id)
    if status not in {"pending", "adopted", "dismissed", "all"}:
        raise ApiError(422, "INVALID_FILTER", "筛选条件不正确。", details={"field": "status"})
    statement = select(BTaskSuggestion).where(BTaskSuggestion.project_id == project_id)
    if status != "all":
        statement = statement.where(BTaskSuggestion.status == status)
    rows = list(_fresh(session, statement.order_by(BTaskSuggestion.created_at, BTaskSuggestion.id)))
    return _suggestion_dtos(session, rows)


def generate_suggestions(
    session: Session, user: User, project_id: UUID, provider: AIProvider | None, request=None
) -> SuggestionBatchDTO:
    # Read and ask the AI without holding the project lock; C writers keep going.
    permissions.require_project_member(session, user, project_id)
    project = session.get(Project, project_id, populate_existing=True)
    _require_baseline(project)
    latest = _latest_plan(session, project_id)
    if latest is not None and latest.status != DRAFT:
        raise plan_frozen()
    requirements = _included_requirements(session, project_id)
    if not requirements:
        raise ApiError(409, "NO_REQUIREMENTS", "基线里没有需求，无法生成任务建议。")
    facts = _facts(session, project_id)
    payload = TaskSuggestionInput(
        project_id=project_id,
        requirements=[
            RequirementBrief(id=r.id, title=r.title, description=r.description or "")
            for r in requirements[:300]
        ],
        tasks=[
            TaskBrief(
                id=t.id,
                title=t.title,
                description=t.description or "",
                requirement_ids=facts.requirements.get(t.id, []),
            )
            for t in facts.tasks[:500]
        ],
    )
    result = suggest_tasks(payload, provider=provider)
    _, project, plan = _writer(session, user, project_id)
    created = duplicates = 0
    for item in result.suggestions:
        criteria = [c.strip()[:2000] for c in item.acceptance_criteria if c.strip()][:30]
        title = item.title.strip()[:240]
        if not title or not criteria:
            continue
        inserted = session.execute(
            insert(BTaskSuggestion)
            .values(
                id=uuid4(),
                project_id=project.id,
                requirement_id=item.requirement_id,
                fingerprint=fingerprint(item.requirement_id, title),
                title=title,
                description=item.description.strip()[:5000],
                acceptance_criteria=criteria,
                provider=result.provider[:40],
                is_placeholder=result.is_placeholder,
                status="pending",
                created_by=user.id,
                created_at=now(),
            )
            .on_conflict_do_nothing(constraint="uq_b_task_suggestions_fingerprint")
            .returning(BTaskSuggestion.id)
        ).scalar()
        if inserted:
            created += 1
        else:
            duplicates += 1
    record_audit(
        session,
        actor=user,
        action="project.plan.suggestions_generated",
        target=("plan_version", plan.id),
        project_id=project.id,
        course_id=project.course_id,
        after={"created": created, "duplicates": duplicates, "provider": result.provider},
        request=request,
    )
    session.flush()
    return SuggestionBatchDTO(
        created=created,
        duplicates=duplicates,
        uncovered_requirement_ids=result.uncovered_requirement_ids,
        is_placeholder=result.is_placeholder,
        suggestions=list_suggestions(session, user, project.id),
    )


def _pending_suggestion(session: Session, project_id: UUID, suggestion_id: UUID):
    row = session.scalar(
        select(BTaskSuggestion)
        .where(BTaskSuggestion.id == suggestion_id, BTaskSuggestion.project_id == project_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None:
        raise ApiError(404, "SUGGESTION_NOT_FOUND", "建议不存在。")
    if row.status != "pending":
        raise ApiError(409, "SUGGESTION_HANDLED", "这条建议已经处理过了。")
    return row


def adopt_suggestion(
    session: Session,
    user: User,
    project_id: UUID,
    suggestion_id: UUID,
    cmd: AdoptSuggestion,
    verification: VerificationPort,
    request=None,
) -> TaskDTO:
    _, project, plan = _writer(session, user, project_id)
    row = _pending_suggestion(session, project.id, suggestion_id)
    requirement = session.get(Requirement, row.requirement_id)
    task_input = TaskInput(
        title=row.title,
        description=row.description,
        module_id=requirement.module_id,
        requirement_ids=[requirement.id],
        weight=cmd.weight,
        criteria=[CriterionInput(text=text) for text in row.acceptance_criteria],
    )
    task = _save(
        session,
        user,
        project,
        plan,
        None,
        task_input,
        verification,
        origin="ai",
        suggestion_id=row.id,
        request=request,
    )
    row.status, row.adopted_task_id = "adopted", task.id
    row.handled_by, row.handled_at = user.id, now()
    session.flush()
    return _task_dto_for(session, project.id, task.id)


def dismiss_suggestion(
    session: Session, user: User, project_id: UUID, suggestion_id: UUID, request=None
) -> SuggestionDTO:
    _, project, _plan = _writer(session, user, project_id)
    row = _pending_suggestion(session, project.id, suggestion_id)
    row.status, row.handled_by, row.handled_at = "dismissed", user.id, now()
    record_audit(
        session,
        actor=user,
        action="project.plan.suggestion_dismissed",
        target=("task_suggestion", row.id),
        project_id=project.id,
        course_id=project.course_id,
        request=request,
    )
    session.flush()
    return _suggestion_dtos(session, [row])[0]


# ---------------------------------------------------------------- read model


def _people(session: Session, ids: set[UUID]) -> dict[UUID, PersonDTO]:
    if not ids:
        return {}
    return {
        u.id: PersonDTO(id=u.id, name=u.name)
        for u in session.scalars(select(User).where(User.id.in_(list(ids))))
    }


def _task_dtos(session: Session, project_id: UUID, facts: Facts) -> list[TaskDTO]:
    people = _people(session, {u for ids in facts.assignees.values() for u in ids})
    criterion_ids = [c.id for rows in facts.criteria.values() for c in rows]
    flagged = (
        set(
            session.scalars(
                select(BCriterionRecheck.criterion_id).where(
                    BCriterionRecheck.criterion_id.in_(criterion_ids),
                    BCriterionRecheck.cleared_at.is_(None),
                )
            )
        )
        if criterion_ids
        else set()
    )
    result = []
    for task in facts.tasks:
        meta = facts.meta.get(task.id)
        result.append(
            TaskDTO(
                id=task.id,
                code=task_code(meta.seq) if meta else None,
                title=task.title,
                description=task.description or "",
                module_id=task.module_id,
                parent_task_id=task.parent_task_id,
                requirement_ids=facts.requirements.get(task.id, []),
                assignees=[
                    people.get(u) or PersonDTO(id=u, name=None)
                    for u in facts.assignees.get(task.id, [])
                ],
                dependency_ids=facts.dependencies.get(task.id, []),
                milestone_ids=facts.milestones.get(task.id, []),
                priority=task.priority,  # type: ignore[arg-type]
                weight=int(task.weight),
                criteria=[
                    CriterionDTO(
                        id=c.id, key=c.criterion_key, text=c.text, needs_recheck=c.id in flagged
                    )
                    for c in facts.criteria.get(task.id, [])
                ],
                status=task.status,
                progress_percent=task.progress_percent,
                content_version=meta.content_version if meta else 0,
                origin=meta.origin if meta else "manual",  # type: ignore[arg-type]
                href=f"/projects/{project_id}/tasks/{task.id}",
            )
        )
    return result


def _task_dto_for(session: Session, project_id: UUID, task_id: UUID) -> TaskDTO:
    facts = _facts(session, project_id)
    return next(t for t in _task_dtos(session, project_id, facts) if t.id == task_id)


def plan_view(session: Session, user: User, project_id: UUID) -> PlanDTO:
    relation = permissions.require_project_read(session, user, project_id)
    project = session.get(Project, project_id, populate_existing=True)
    plan = _latest_plan(session, project_id)
    facts = _facts(session, project_id)
    members = _members(session, project_id)
    baseline_frozen = project.setup_status == "frozen"
    issues = _issues(session, project_id, facts) if baseline_frozen else []
    confirmations = _confirmations(session, plan, facts, members)
    mine = next((c for c in confirmations if c.user.id == user.id), None)
    writable = relation.member and not relation.read_only and baseline_frozen
    modules = session.scalars(
        select(FunctionalModule)
        .where(FunctionalModule.project_id == project_id)
        .order_by(FunctionalModule.sort_order, FunctionalModule.created_at)
    ).all()
    requirements = _included_requirements(session, project_id)
    codes = _requirement_codes(session, {r.id for r in requirements})
    milestones = session.scalars(
        select(Milestone)
        .where(Milestone.project_id == project_id)
        .order_by(Milestone.sort_order, Milestone.deadline)
    ).all()
    history = session.scalars(
        select(PlanVersion)
        .where(PlanVersion.project_id == project_id)
        .order_by(PlanVersion.version_no.desc())
    ).all()
    people = _people(session, set(members))
    tasks = _task_dtos(session, project_id, facts)
    roots = [t for t in facts.tasks if t.parent_task_id is None]
    baseline_no = plan.snapshot_json.get("baseline_version_no") if plan else None
    if baseline_no is None and baseline_frozen:
        frozen = _frozen_baseline(session, project_id)
        baseline_no = frozen.version_no if frozen else None
    status = "none" if plan is None else (FROZEN if plan.status == FROZEN else DRAFT)
    return PlanDTO(
        project_id=project_id,
        id=plan.id if plan else None,
        version_no=plan.version_no if plan else 0,
        status=status,  # type: ignore[arg-type]
        lock_version=plan.lock_version if plan else 0,
        baseline_frozen=baseline_frozen,
        baseline_version_no=baseline_no,
        frozen_at=plan.frozen_at if plan else None,
        tasks=tasks,
        issues=[_issue_dto(i) for i in issues],
        confirmations=confirmations,
        my_task_versions={UUID(k): v for k, v in _my_versions(facts, user.id).items()},
        my_state=mine.state if mine else None,
        can_edit=writable and status != FROZEN,
        can_lead=writable and relation.leader,
        root_weight_total=sum(int(t.weight) for t in roots),
        modules=[OptionDTO(id=m.id, name=m.name) for m in modules],
        requirements=[
            OptionDTO(id=r.id, name=r.title, code=codes.get(r.id), module_id=r.module_id)
            for r in requirements
        ],
        milestones=[OptionDTO(id=m.id, name=m.title) for m in milestones],
        members=[people.get(m) or PersonDTO(id=m, name=None) for m in members],
        history=[
            PlanHistoryDTO(
                id=h.id,
                version_no=h.version_no,
                status=h.status,
                frozen_at=h.frozen_at,
                created_at=h.created_at,
            )
            for h in history
        ],
    )
