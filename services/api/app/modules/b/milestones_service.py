"""B-8 pages 18–19: milestones, deliverables, stage completion, rescheduling.

* Progress is computed on every read from the linked tasks with C's weighted
  roll-up (``progress_projection``), so it follows task changes immediately.
* Completion asks D whether every linked task is verified (``VerificationPort``);
  when D is unavailable the request fails with ``VERIFICATION_UNAVAILABLE``:
  "unknown" is never treated as "verified".
* ``risk`` is read from D's ``risks`` table (open and mitigating risks recorded
  on the milestone or on one of its linked tasks). B only reads it; when the
  table is not there yet the field is ``null`` and the page says "no data".
"""

from __future__ import annotations

from datetime import UTC
from uuid import UUID, uuid4

from sqlalchemy import Uuid, bindparam, func, select, text
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import Course, Milestone, Task, TaskMilestone, User
from app.modules.a import permissions
from app.modules.a.audit import record_audit
from app.modules.a.inbox import notify
from app.modules.b.common import now, require_reason, require_version
from app.modules.b.courses_schemas import PersonDTO
from app.modules.b.courses_service import teacher_ids
from app.modules.b.milestones_schemas import (
    AddDeliverable,
    CheckDeliverable,
    CompleteMilestone,
    DateChangeDTO,
    DeliverableDTO,
    DeliverableEventDTO,
    FileRefDTO,
    MilestoneDetailDTO,
    MilestoneDTO,
    MilestoneListDTO,
    MilestoneRiskDTO,
    MilestoneRiskItemDTO,
    MilestoneTaskDTO,
    Reschedule,
    RiskTaskDTO,
)
from app.modules.b.models import (
    BMilestoneDateChange,
    BMilestoneDeliverable,
    BMilestoneDeliverableEvent,
)
from app.modules.b.planning_service import (
    Facts,
    _facts,
    _lock_project,
    _members,
    _people,
    task_code,
)
from app.modules.b.ports import VerificationPort
from app.modules.c.files_models import LogicalFile
from app.modules.c.task_execution import progress_projection, weighted_progress


def _target(project_id: UUID) -> dict:
    return {"kind": "project", "id": project_id, "project_id": project_id}


def _milestones(session: Session, project_id: UUID) -> list[Milestone]:
    return list(
        session.scalars(
            select(Milestone)
            .where(Milestone.project_id == project_id)
            .order_by(Milestone.sort_order, Milestone.deadline, Milestone.id)
            .execution_options(populate_existing=True)
        )
    )


def _milestone(session: Session, project_id: UUID, milestone_id: UUID, *, lock=False) -> Milestone:
    statement = select(Milestone).where(
        Milestone.id == milestone_id, Milestone.project_id == project_id
    )
    if lock:
        statement = statement.with_for_update()
    row = session.scalar(statement.execution_options(populate_existing=True))
    if row is None:
        raise ApiError(404, "MILESTONE_NOT_FOUND", "里程碑不存在。")
    return row


def _values(tasks: list[Task]) -> dict[UUID, int]:
    try:
        values, _ = progress_projection(tasks)
        return values
    except ApiError:
        return {t.id: t.progress_percent for t in tasks}


def _linked(session: Session, milestone_ids: list[UUID]) -> dict[UUID, list[UUID]]:
    result: dict[UUID, list[UUID]] = {}
    if not milestone_ids:
        return result
    for row in session.scalars(
        select(TaskMilestone).where(TaskMilestone.milestone_id.in_(milestone_ids))
    ):
        result.setdefault(row.milestone_id, []).append(row.task_id)
    return result


def _deliverable_counts(session: Session, milestone_ids: list[UUID]) -> dict[UUID, tuple[int, int]]:
    if not milestone_ids:
        return {}
    rows = session.execute(
        select(
            BMilestoneDeliverable.milestone_id,
            func.count(),
            func.count().filter(BMilestoneDeliverable.done.is_(True)),
        )
        .where(BMilestoneDeliverable.milestone_id.in_(milestone_ids))
        .group_by(BMilestoneDeliverable.milestone_id)
    ).all()
    return {mid: (done, total) for mid, total, done in rows}


_LEVELS = {"high": 3, "medium": 2, "low": 1}
_RISKS = text(
    """
    SELECT id, task_id, milestone_id, owner_id, title, level, status, due_at
    FROM risks
    WHERE project_id = :project_id
      AND status IN ('open', 'mitigating')
      AND (milestone_id IN :milestone_ids OR task_id IN :task_ids)
    """
).bindparams(
    bindparam("project_id", type_=Uuid),
    bindparam("milestone_ids", type_=Uuid, expanding=True),
    bindparam("task_ids", type_=Uuid, expanding=True),
)


def _risks(
    session: Session,
    project_id: UUID,
    linked: dict[UUID, list[UUID]],
    milestone_ids: list[UUID],
    codes: dict[UUID, RiskTaskDTO],
) -> dict[UUID, MilestoneRiskDTO] | None:
    """D's open risks per milestone, or None when D's table does not exist yet.

    A risk counts for a milestone when it is recorded on the milestone itself or
    on one of the milestone's linked tasks; closed risks are left out.
    """
    if session.scalar(text("SELECT to_regclass('risks') IS NOT NULL")) is not True:
        return None
    result = {mid: MilestoneRiskDTO(level=None, open_count=0, items=[]) for mid in milestone_ids}
    if not milestone_ids:
        return result
    task_ids = sorted({t for mid in milestone_ids for t in linked.get(mid, [])})
    rows = session.execute(
        _RISKS,
        {"project_id": project_id, "milestone_ids": milestone_ids, "task_ids": task_ids},
    ).all()
    people = _people(session, {r.owner_id for r in rows if r.owner_id})
    by_task: dict[UUID, set[UUID]] = {}
    for mid in milestone_ids:
        for t in linked.get(mid, []):
            by_task.setdefault(t, set()).add(mid)
    for r in rows:
        targets = set(by_task.get(r.task_id, set()))
        if r.milestone_id in result:
            targets.add(r.milestone_id)
        item = MilestoneRiskItemDTO(
            id=r.id,
            title=r.title,
            level=r.level,
            status=r.status,
            due_at=r.due_at,
            owner=people.get(r.owner_id),
            task=codes.get(r.task_id) if r.task_id else None,
        )
        for mid in targets:
            result[mid].items.append(item)
    for summary in result.values():
        summary.items.sort(
            key=lambda i: (-_LEVELS.get(i.level, 0), i.due_at is None, i.due_at, i.title)
        )
        summary.open_count = len(summary.items)
        summary.level = summary.items[0].level if summary.items else None
    return result


def _risk_tasks(facts: Facts, by_id: dict[UUID, Task]) -> dict[UUID, RiskTaskDTO]:
    return {
        t: RiskTaskDTO(
            id=t,
            code=task_code(facts.meta[t].seq) if t in facts.meta else None,
            title=task.title,
        )
        for t, task in by_id.items()
    }


def _brief(
    m: Milestone,
    task_ids: list[UUID],
    by_id: dict[UUID, Task],
    values: dict[UUID, int],
    counts: tuple[int, int],
    risks: dict[UUID, MilestoneRiskDTO] | None,
) -> MilestoneDTO:
    tasks = [by_id[t] for t in task_ids if t in by_id]
    # Count each linked task once: a linked child already inside a linked parent
    # would otherwise be weighted twice.
    linked = {t.id for t in tasks}
    top = [t for t in tasks if not _has_linked_ancestor(t, linked, by_id)]
    progress = weighted_progress(top, values) if top else None
    deadline = m.deadline
    overdue = bool(
        deadline
        and m.status != "completed"
        and (deadline if deadline.tzinfo else deadline.replace(tzinfo=UTC)) < now()
    )
    return MilestoneDTO(
        id=m.id,
        title=m.title,
        description=m.description,
        deadline=m.deadline,
        status=m.status,
        overdue=overdue,
        progress_percent=100 if m.status == "completed" else progress,
        task_count=len(tasks),
        completed_task_count=sum(1 for t in tasks if t.status == "completed"),
        deliverables_done=counts[0],
        deliverables_total=counts[1],
        risk=risks.get(m.id) if risks is not None else None,
        lock_version=m.lock_version,
        href=f"/projects/{m.project_id}/milestones/{m.id}",
    )


def _has_linked_ancestor(task: Task, linked: set[UUID], by_id: dict[UUID, Task]) -> bool:
    seen, cursor = {task.id}, task.parent_task_id
    while cursor in by_id and cursor not in seen:
        if cursor in linked:
            return True
        seen.add(cursor)
        cursor = by_id[cursor].parent_task_id
    return False


def list_milestones(session: Session, user: User, project_id: UUID) -> MilestoneListDTO:
    relation = permissions.require_project_read(session, user, project_id)
    rows = _milestones(session, project_id)
    facts = _facts(session, project_id)
    by_id = {t.id: t for t in facts.tasks}
    values = _values(facts.tasks)
    ids = [m.id for m in rows]
    linked, counts = _linked(session, ids), _deliverable_counts(session, ids)
    risks = _risks(session, project_id, linked, ids, _risk_tasks(facts, by_id))
    return MilestoneListDTO(
        items=[
            _brief(m, linked.get(m.id, []), by_id, values, counts.get(m.id, (0, 0)), risks)
            for m in rows
        ],
        can_lead=relation.leader and not relation.read_only,
    )


def _file_ref(project_id: UUID, file: LogicalFile | None) -> FileRefDTO | None:
    if file is None:
        return None
    return FileRefDTO(
        id=file.id, name=file.name, href=f"/projects/{project_id}/files?file={file.id}"
    )


def milestone_detail(
    session: Session, user: User, project_id: UUID, milestone_id: UUID
) -> MilestoneDetailDTO:
    relation = permissions.require_project_read(session, user, project_id)
    m = _milestone(session, project_id, milestone_id)
    facts = _facts(session, project_id)
    by_id = {t.id: t for t in facts.tasks}
    values = _values(facts.tasks)
    linked = _linked(session, [m.id])
    task_ids = linked.get(m.id, [])
    risks = _risks(session, project_id, linked, [m.id], _risk_tasks(facts, by_id))
    brief = _brief(
        m, task_ids, by_id, values, _deliverable_counts(session, [m.id]).get(m.id, (0, 0)), risks
    )
    deliverables = list(
        session.scalars(
            select(BMilestoneDeliverable)
            .where(BMilestoneDeliverable.milestone_id == m.id)
            .order_by(BMilestoneDeliverable.sort_order, BMilestoneDeliverable.created_at)
            .execution_options(populate_existing=True)
        )
    )
    events = (
        list(
            session.scalars(
                select(BMilestoneDeliverableEvent)
                .where(BMilestoneDeliverableEvent.deliverable_id.in_([d.id for d in deliverables]))
                .order_by(BMilestoneDeliverableEvent.at.desc())
            )
        )
        if deliverables
        else []
    )
    changes = list(
        session.scalars(
            select(BMilestoneDateChange)
            .where(BMilestoneDateChange.milestone_id == m.id)
            .order_by(BMilestoneDateChange.changed_at.desc())
        )
    )
    files = {
        f.id: f
        for f in session.scalars(select(LogicalFile).where(LogicalFile.project_id == project_id))
    }
    people_ids = {d.done_by for d in deliverables if d.done_by} | {e.actor_id for e in events}
    people_ids |= {c.changed_by for c in changes}
    people_ids |= {u for t in task_ids for u in facts.assignees.get(t, [])}
    people = _people(session, people_ids)
    return MilestoneDetailDTO(
        **brief.model_dump(),
        tasks=[
            MilestoneTaskDTO(
                id=t,
                code=task_code(facts.meta[t].seq) if t in facts.meta else None,
                title=by_id[t].title,
                status=by_id[t].status,
                progress_percent=values.get(t, by_id[t].progress_percent),
                weight=int(by_id[t].weight),
                assignees=[
                    people.get(u) or PersonDTO(id=u, name=None) for u in facts.assignees.get(t, [])
                ],
                href=f"/projects/{project_id}/tasks/{t}",
            )
            for t in task_ids
            if t in by_id
        ],
        deliverables=[
            DeliverableDTO(
                id=d.id,
                title=d.title,
                done=d.done,
                done_by=people.get(d.done_by) if d.done_by else None,
                done_at=d.done_at,
                file=_file_ref(project_id, files.get(d.file_id)) if d.file_id else None,
                lock_version=d.lock_version,
                history=[
                    DeliverableEventDTO(
                        action=e.action,
                        actor=people.get(e.actor_id),
                        at=e.at,
                        file=_file_ref(project_id, files.get(e.file_id)) if e.file_id else None,
                    )
                    for e in events
                    if e.deliverable_id == d.id
                ],
            )
            for d in deliverables
        ],
        date_changes=[
            DateChangeDTO(
                old_deadline=c.old_deadline,
                new_deadline=c.new_deadline,
                reason=c.reason,
                changed_by=people.get(c.changed_by),
                changed_at=c.changed_at,
            )
            for c in changes
        ],
        can_lead=relation.leader and not relation.read_only,
        files=[_file_ref(project_id, f) for f in files.values()],  # type: ignore[misc]
    )


# ---------------------------------------------------------------- B7-02 deliverables


def _leader_write(session: Session, user: User, project_id: UUID, milestone_id: UUID):
    permissions.require_project_leader(session, user, project_id)
    project = _lock_project(session, project_id)
    m = _milestone(session, project_id, milestone_id, lock=True)
    return project, m


def _open(m: Milestone) -> None:
    if m.status == "completed":
        raise ApiError(409, "MILESTONE_COMPLETED", "这个阶段已经确认交付，不能再修改。")


def add_deliverable(
    session: Session,
    user: User,
    project_id: UUID,
    milestone_id: UUID,
    cmd: AddDeliverable,
    request=None,
):
    project, m = _leader_write(session, user, project_id, milestone_id)
    _open(m)
    title = cmd.title.strip()
    if not title:
        raise ApiError(422, "DELIVERABLE_TITLE_REQUIRED", "请填写交付物名称。")
    count = session.scalar(
        select(func.count())
        .select_from(BMilestoneDeliverable)
        .where(BMilestoneDeliverable.milestone_id == m.id)
    )
    row = BMilestoneDeliverable(
        id=uuid4(),
        milestone_id=m.id,
        project_id=project.id,
        title=title,
        sort_order=count or 0,
        created_by=user.id,
        created_at=now(),
        lock_version=0,
    )
    session.add(row)
    session.flush()
    record_audit(
        session,
        actor=user,
        action="project.milestone.deliverable_added",
        target=("milestone_deliverable", row.id),
        project_id=project.id,
        course_id=project.course_id,
        after={"milestone_id": str(m.id), "title": title},
        request=request,
    )
    return milestone_detail(session, user, project.id, m.id)


def check_deliverable(
    session: Session,
    user: User,
    project_id: UUID,
    milestone_id: UUID,
    deliverable_id: UUID,
    cmd: CheckDeliverable,
    request=None,
):
    project, m = _leader_write(session, user, project_id, milestone_id)
    _open(m)
    row = session.scalar(
        select(BMilestoneDeliverable)
        .where(
            BMilestoneDeliverable.id == deliverable_id, BMilestoneDeliverable.milestone_id == m.id
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None:
        raise ApiError(404, "DELIVERABLE_NOT_FOUND", "交付物不存在。")
    require_version(row.lock_version, cmd.expected_version)
    if cmd.file_id is not None:
        file = session.get(LogicalFile, cmd.file_id)
        if file is None or file.project_id != project.id:
            raise ApiError(422, "FILE_NOT_FOUND", "关联的文件不在本项目的资料里。")
    if row.done == cmd.done and (not cmd.done or row.file_id == cmd.file_id):
        return milestone_detail(session, user, project.id, m.id)
    moment = now()
    row.done = cmd.done
    row.done_by, row.done_at = (user.id, moment) if cmd.done else (None, None)
    row.file_id = cmd.file_id if cmd.done else row.file_id
    row.lock_version += 1
    session.add(
        BMilestoneDeliverableEvent(
            id=uuid4(),
            deliverable_id=row.id,
            action="checked" if cmd.done else "unchecked",
            file_id=cmd.file_id if cmd.done else None,
            actor_id=user.id,
            at=moment,
        )
    )
    session.flush()
    record_audit(
        session,
        actor=user,
        action="project.milestone.deliverable_checked"
        if cmd.done
        else "project.milestone.deliverable_unchecked",
        target=("milestone_deliverable", row.id),
        project_id=project.id,
        course_id=project.course_id,
        after={"done": cmd.done, "file_id": str(cmd.file_id) if cmd.file_id else None},
        request=request,
    )
    return milestone_detail(session, user, project.id, m.id)


# ---------------------------------------------------------------- B7-03 completion


def complete(
    session: Session,
    user: User,
    project_id: UUID,
    milestone_id: UUID,
    cmd: CompleteMilestone,
    verification: VerificationPort,
    request=None,
):
    project, m = _leader_write(session, user, project_id, milestone_id)
    _open(m)
    require_version(m.lock_version, cmd.expected_version)
    facts = _facts(session, project.id)
    by_id = {t.id: t for t in facts.tasks}
    task_ids = [t for t in _linked(session, [m.id]).get(m.id, []) if t in by_id]
    missing_deliverables = [
        {"id": str(d.id), "title": d.title}
        for d in session.scalars(
            select(BMilestoneDeliverable)
            .where(BMilestoneDeliverable.milestone_id == m.id)
            .order_by(BMilestoneDeliverable.sort_order, BMilestoneDeliverable.created_at)
        )
        if not d.done
    ]
    missing_tasks = []
    if task_ids:
        # Raises 503 VERIFICATION_UNAVAILABLE while D is not connected: no skipping.
        states = verification.task_verification_status(session, task_ids=task_ids)
        for tid in task_ids:
            state = states[tid].state if tid in states else None
            if state != "passed":
                meta = facts.meta.get(tid)
                missing_tasks.append(
                    {
                        "id": str(tid),
                        "code": task_code(meta.seq) if meta else None,
                        "title": by_id[tid].title,
                        "state": state or "unknown",
                    }
                )
    if missing_tasks or missing_deliverables:
        raise ApiError(
            409,
            "MILESTONE_NOT_READY",
            "还不能确认交付：有任务没通过验收或交付物没勾齐。",
            details={"tasks": missing_tasks, "deliverables": missing_deliverables},
        )
    m.status, m.progress_percent = "completed", 100
    m.lock_version += 1
    session.flush()
    course = session.get(Course, project.course_id) if project.course_id else None
    for teacher in teacher_ids(session, course) if course else []:
        notify(
            session,
            recipient=teacher,
            category="project",
            title=f"「{project.name}」完成了阶段「{m.title}」",
            description=f"{len(task_ids)} 个关联任务都已通过验收，交付物已齐全。",
            target=_target(project.id),
            dedupe_key=f"b:milestone-completed:{m.id}",
        )
    record_audit(
        session,
        actor=user,
        action="project.milestone.completed",
        target=("milestone", m.id),
        project_id=project.id,
        course_id=project.course_id,
        after={"tasks": len(task_ids)},
        request=request,
    )
    return milestone_detail(session, user, project.id, m.id)


# ---------------------------------------------------------------- B7-04 reschedule


def reschedule(
    session: Session,
    user: User,
    project_id: UUID,
    milestone_id: UUID,
    cmd: Reschedule,
    request=None,
):
    reason = require_reason(cmd.reason)
    project, m = _leader_write(session, user, project_id, milestone_id)
    _open(m)
    require_version(m.lock_version, cmd.expected_version)
    if project.final_deadline and cmd.deadline > project.final_deadline:
        raise ApiError(422, "DEADLINE_AFTER_PROJECT_END", "新的截止时间不能晚于项目截止时间。")
    if m.deadline is not None and m.deadline == cmd.deadline:
        raise ApiError(409, "DEADLINE_UNCHANGED", "新日期和原来的一样。")
    change = BMilestoneDateChange(
        id=uuid4(),
        milestone_id=m.id,
        project_id=project.id,
        old_deadline=m.deadline,
        new_deadline=cmd.deadline,
        reason=reason,
        changed_by=user.id,
        changed_at=now(),
    )
    session.add(change)
    old = m.deadline
    m.deadline = cmd.deadline
    m.lock_version += 1
    session.flush()
    course = session.get(Course, project.course_id) if project.course_id else None
    recipients = list(
        dict.fromkeys(
            [*(teacher_ids(session, course) if course else []), *_members(session, project.id)]
        )
    )
    when = cmd.deadline.astimezone(UTC).strftime("%Y-%m-%d")
    for recipient in recipients:
        notify(
            session,
            recipient=recipient,
            category="project",
            title=f"「{project.name}」的阶段「{m.title}」改期到 {when}",
            description=f"原因：{reason}"[:2000],
            target=_target(project.id),
            dedupe_key=f"b:milestone-rescheduled:{change.id}",
        )
    record_audit(
        session,
        actor=user,
        action="project.milestone.rescheduled",
        target=("milestone", m.id),
        project_id=project.id,
        course_id=project.course_id,
        before={"deadline": old.isoformat() if old else None},
        after={"deadline": cmd.deadline.isoformat()},
        reason=reason,
        request=request,
    )
    return milestone_detail(session, user, project.id, m.id)


__all__ = [
    "add_deliverable",
    "check_deliverable",
    "complete",
    "list_milestones",
    "milestone_detail",
    "reschedule",
]
