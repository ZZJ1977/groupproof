"""B-8 member removal (B2-04), leaving (B2-06) and teacher approval (B2-07).

Every unfinished task of the departing member must name a receiver who stays
in the group. Before the formation deadline the change applies at once;
afterwards it becomes a teacher action item on page 48.

Applying a change happens in one transaction: lock the group's projects (the
same order as C and B planning writes), then the group, re-check that the
member is still here, that the handover still covers every unfinished task
and that every receiver is still in the group; then end the memberships, move
``task_assignees``, stamp the handovers, close the action items and notify.
Any failure raises and ``run_command`` rolls the whole thing back.
"""

from __future__ import annotations

from uuid import UUID, uuid4

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import (
    Course,
    GroupMember,
    Project,
    ProjectGroup,
    ProjectMember,
    Task,
    TaskAssignee,
    User,
)
from app.modules.a import permissions
from app.modules.a.audit import record_audit
from app.modules.a.inbox import close_action_items_by_source, create_action_item, notify
from app.modules.b.common import now, require_reason, require_version
from app.modules.b.courses_schemas import PersonDTO
from app.modules.b.courses_service import teacher_ids
from app.modules.b.groups_service import formation_open
from app.modules.b.membership_schemas import (
    DecideMembershipChange,
    EditMembershipChange,
    Handover,
    HandoverDTO,
    MembershipChangeDTO,
    OpenTaskDTO,
    OpenTasksDTO,
    StartMembershipChange,
)
from app.modules.b.models import BMembershipChangeRequest, BTaskHandover, BTaskMeta
from app.modules.b.planning_service import _people, task_code

OPEN = ("pending", "needs_info")


def source_key(row: BMembershipChangeRequest) -> str:
    # Versioned: a resubmission after "needs_info" is a new action item.
    return f"b:membership-change:{row.id}:v{row.lock_version}"


def _course_target(course_id: UUID) -> dict:
    return {"kind": "course", "id": course_id, "course_id": course_id}


# ---------------------------------------------------------------- lookups


def _group(session: Session, group_id: UUID, *, lock: bool = False) -> ProjectGroup:
    statement = select(ProjectGroup).where(ProjectGroup.id == group_id)
    if lock:
        statement = statement.with_for_update()
    group = session.scalar(statement.execution_options(populate_existing=True))
    if group is None:
        raise ApiError(404, "GROUP_NOT_FOUND", "小组不存在。")
    return group


def _active(session: Session, group_id: UUID) -> list[UUID]:
    return list(
        session.scalars(
            select(GroupMember.user_id)
            .where(GroupMember.group_id == group_id, GroupMember.left_at.is_(None))
            .order_by(GroupMember.joined_at, GroupMember.user_id)
            .execution_options(populate_existing=True)
        )
    )


def _projects(session: Session, group_id: UUID, *, lock: bool = False) -> list[Project]:
    statement = select(Project).where(Project.group_id == group_id).order_by(Project.id)
    if lock:
        statement = statement.with_for_update()
    return list(session.scalars(statement.execution_options(populate_existing=True)))


def _open_tasks(session: Session, projects: list[Project], member_id: UUID) -> list[Task]:
    if not projects:
        return []
    return list(
        session.scalars(
            select(Task)
            .join(TaskAssignee, TaskAssignee.task_id == Task.id)
            .where(
                Task.project_id.in_([p.id for p in projects]),
                TaskAssignee.user_id == member_id,
                TaskAssignee.unassigned_at.is_(None),
                Task.status != "completed",
            )
            .order_by(Task.created_at, Task.id)
            .execution_options(populate_existing=True)
        )
    )


def _codes(session: Session, task_ids: list[UUID]) -> dict[UUID, str | None]:
    if not task_ids:
        return {}
    return {
        m.task_id: task_code(m.seq)
        for m in session.scalars(select(BTaskMeta).where(BTaskMeta.task_id.in_(task_ids)))
    }


def _require_reader(session: Session, user: User, group: ProjectGroup) -> None:
    if user.id in _active(session, group.id):
        return
    if permissions.is_course_staff(session, user, group.course_id):
        return
    raise ApiError(404, "GROUP_NOT_FOUND", "小组不存在。")


# ---------------------------------------------------------------- B2-04 open tasks


def open_tasks(session: Session, user: User, group_id: UUID, member_id: UUID) -> OpenTasksDTO:
    group = _group(session, group_id)
    is_leader = group.leader_id == user.id and user.id in _active(session, group.id)
    if member_id != user.id and not is_leader:
        _require_reader(session, user, group)
        if not permissions.is_course_staff(session, user, group.course_id):
            raise ApiError(403, "GROUP_LEADER_REQUIRED", "只有组长可以查看别人的待交接任务。")
    active = _active(session, group.id)
    if member_id not in active:
        raise ApiError(404, "MEMBER_NOT_FOUND", "这位同学不在本组。")
    tasks = _open_tasks(session, _projects(session, group.id), member_id)
    codes = _codes(session, [t.id for t in tasks])
    people = _people(session, set(active))
    course = session.get(Course, group.course_id)
    return OpenTasksDTO(
        member=people.get(member_id) or PersonDTO(id=member_id, name=None),
        tasks=[
            OpenTaskDTO(
                id=t.id,
                project_id=t.project_id,
                code=codes.get(t.id),
                title=t.title,
                status=t.status,
                href=f"/projects/{t.project_id}/tasks/{t.id}",
            )
            for t in tasks
        ],
        candidates=[people[u] for u in active if u != member_id and u in people],
        applies_immediately=formation_open(course, group),
        is_leader=is_leader,
    )


# ---------------------------------------------------------------- validation


def _check_handovers(
    session: Session,
    group: ProjectGroup,
    projects: list[Project],
    member_id: UUID,
    handovers: list[Handover] | list[BTaskHandover],
    *,
    applying: bool = False,
) -> dict[UUID, UUID]:
    open_ids = [t.id for t in _open_tasks(session, projects, member_id)]
    plan: dict[UUID, UUID] = {}
    for h in handovers:
        to_user = h.to_user_id
        if h.task_id in plan:
            raise ApiError(422, "HANDOVER_INVALID", "同一个任务只能指定一个接手人。")
        plan[h.task_id] = to_user
    if applying:
        # Tasks finished meanwhile no longer need a receiver.
        plan = {t: u for t, u in plan.items() if t in open_ids}
    missing = [t for t in open_ids if t not in plan]
    if missing:
        codes = _codes(session, missing)
        raise ApiError(
            409 if applying else 422,
            "HANDOVER_OUTDATED" if applying else "HANDOVER_REQUIRED",
            "有未完成任务还没有指定接手人。",
            details={
                "task_ids": [str(t) for t in missing],
                "codes": [codes.get(t) for t in missing],
            },
        )
    extra = [t for t in plan if t not in open_ids]
    if extra:
        raise ApiError(
            422,
            "HANDOVER_INVALID",
            "交接里有不属于这位同学的未完成任务。",
            details={"task_ids": [str(t) for t in extra]},
        )
    staying = set(_active(session, group.id)) - {member_id}
    project_ids = [p.id for p in projects]
    in_project = (
        set(
            session.scalars(
                select(ProjectMember.user_id).where(
                    ProjectMember.project_id.in_(project_ids), ProjectMember.left_at.is_(None)
                )
            )
        )
        if project_ids
        else set()
    )
    for task_id, to_user in plan.items():
        if to_user == member_id:
            raise ApiError(422, "HANDOVER_INVALID", "接手人不能是要离开的同学自己。")
        if to_user not in staying or (project_ids and to_user not in in_project):
            if applying:
                raise ApiError(
                    409,
                    "HANDOVER_TARGET_LEFT",
                    "有接手人已经不在本组，请重新指定后再提交。",
                    details={"task_id": str(task_id), "user_id": str(to_user)},
                )
            raise ApiError(
                422,
                "HANDOVER_INVALID",
                "接手人必须是本组的其他成员。",
                details={"task_id": str(task_id), "user_id": str(to_user)},
            )
    return plan


def _write_handovers(
    session: Session, row: BMembershipChangeRequest, plan: dict[UUID, UUID]
) -> None:
    session.execute(delete(BTaskHandover).where(BTaskHandover.request_id == row.id))
    for task_id, to_user in plan.items():
        session.add(
            BTaskHandover(
                id=uuid4(),
                request_id=row.id,
                task_id=task_id,
                from_user_id=row.member_id,
                to_user_id=to_user,
            )
        )
    session.flush()


# ---------------------------------------------------------------- apply


def _apply(session: Session, actor: User, row: BMembershipChangeRequest, group: ProjectGroup):
    projects = _projects(session, group.id)
    if row.member_id not in _active(session, group.id):
        raise ApiError(409, "MEMBER_ALREADY_LEFT", "这位同学已经不在本组。")
    handovers = list(
        session.scalars(select(BTaskHandover).where(BTaskHandover.request_id == row.id))
    )
    plan = _check_handovers(session, group, projects, row.member_id, handovers, applying=True)
    moment = now()
    for member in session.scalars(
        select(GroupMember).where(
            GroupMember.group_id == group.id,
            GroupMember.user_id == row.member_id,
            GroupMember.left_at.is_(None),
        )
    ):
        member.left_at = moment
    if projects:
        for member in session.scalars(
            select(ProjectMember).where(
                ProjectMember.project_id.in_([p.id for p in projects]),
                ProjectMember.user_id == row.member_id,
                ProjectMember.left_at.is_(None),
            )
        ):
            member.left_at = moment
    for handover in handovers:
        to_user = plan.get(handover.task_id)
        if to_user is None:
            continue
        old = session.get(TaskAssignee, (handover.task_id, row.member_id))
        if old is not None:
            old.unassigned_at = moment
        new = session.get(TaskAssignee, (handover.task_id, to_user))
        if new is None:
            session.add(
                TaskAssignee(
                    task_id=handover.task_id,
                    user_id=to_user,
                    role="responsible",
                    assigned_at=moment,
                )
            )
        elif new.unassigned_at is not None or new.role != "responsible":
            new.role, new.unassigned_at, new.assigned_at = "responsible", None, moment
        task = session.get(Task, handover.task_id)
        task.lock_version += 1
        handover.applied_at = moment
    row.status = "applied"
    row.applied_at = moment
    row.lock_version += 1
    session.flush()
    course = session.get(Course, row.course_id)
    member = session.get(User, row.member_id)
    title = (
        f"你已离开小组「{group.name}」"
        if row.change_type == "leave"
        else f"你已被移出小组「{group.name}」"
    )
    notify(
        session,
        recipient=row.member_id,
        category="course",
        title=title,
        description=f"课程《{course.name}》。原因：{row.reason}"[:2000],
        target=_course_target(course.id),
        dedupe_key=f"b:membership-applied:{row.id}",
    )
    receivers: dict[UUID, int] = {}
    for to_user in plan.values():
        receivers[to_user] = receivers.get(to_user, 0) + 1
    for to_user, count in receivers.items():
        notify(
            session,
            recipient=to_user,
            category="project",
            title=f"你接手了 {member.name or '同学'} 的 {count} 个任务",
            description=f"小组「{group.name}」",
            target={"kind": "project", "id": projects[0].id, "project_id": projects[0].id}
            if projects
            else _course_target(course.id),
            dedupe_key=f"b:membership-handover:{row.id}",
        )
    record_audit(
        session,
        actor=actor,
        action=f"group.member.{'left' if row.change_type == 'leave' else 'removed'}",
        target=("membership_change", row.id),
        course_id=row.course_id,
        project_id=row.project_id,
        after={
            "member_id": str(row.member_id),
            "handovers": {str(t): str(u) for t, u in plan.items()},
        },
        reason=row.reason,
    )


def _ask_teachers(session: Session, row: BMembershipChangeRequest, group: ProjectGroup) -> None:
    course = session.get(Course, row.course_id)
    member = session.get(User, row.member_id)
    verb = "申请退出" if row.change_type == "leave" else "申请移出"
    for teacher in teacher_ids(session, course):
        create_action_item(
            session,
            recipient=teacher,
            category="member",
            title=f"「{group.name}」{verb}：{member.name or '同学'}",
            description=f"原因：{row.reason}"[:2000],
            target={"kind": "member_change", "id": row.id, "course_id": course.id},
            source_key=source_key(row),
        )


# ---------------------------------------------------------------- B2-04 / B2-06 start


def start(
    session: Session, user: User, group_id: UUID, cmd: StartMembershipChange, request=None
) -> MembershipChangeDTO:
    projects = _projects(session, group_id, lock=True)
    group = _group(session, group_id, lock=True)
    active = _active(session, group.id)
    if user.id not in active:
        raise ApiError(403, "GROUP_MEMBER_REQUIRED", "只有本组成员可以操作。")
    if cmd.change_type == "remove":
        if group.leader_id != user.id:
            raise ApiError(403, "GROUP_LEADER_REQUIRED", "只有组长可以移出成员。")
        if cmd.member_id is None or cmd.member_id == user.id:
            raise ApiError(422, "MEMBER_INVALID", "请选择要移出的其他成员。")
        member_id = cmd.member_id
        if member_id not in active:
            raise ApiError(404, "MEMBER_NOT_FOUND", "这位同学不在本组。")
    else:
        if cmd.member_id not in (None, user.id):
            raise ApiError(422, "MEMBER_INVALID", "只能为自己申请退出。")
        if group.leader_id == user.id:
            raise ApiError(409, "LEADER_MUST_TRANSFER", "组长需要先把组长交给别人才能退出。")
        member_id = user.id
    reason = require_reason(cmd.reason)
    course = session.get(Course, group.course_id)
    if course.status != "active":
        raise ApiError(409, "COURSE_CLOSED", "课程已经结束。")
    plan = _check_handovers(session, group, projects, member_id, cmd.handovers)
    if session.scalar(
        select(BMembershipChangeRequest.id).where(
            BMembershipChangeRequest.group_id == group.id,
            BMembershipChangeRequest.member_id == member_id,
            BMembershipChangeRequest.status.in_(OPEN),
        )
    ):
        raise ApiError(409, "MEMBERSHIP_CHANGE_PENDING", "这位同学已经有一条待处理的申请。")
    row = BMembershipChangeRequest(
        id=uuid4(),
        course_id=course.id,
        group_id=group.id,
        project_id=projects[0].id if projects else None,
        change_type=cmd.change_type,
        member_id=member_id,
        requested_by=user.id,
        status="pending",
        reason=reason,
        created_at=now(),
        lock_version=0,
    )
    session.add(row)
    try:
        with session.begin_nested():
            session.flush()
    except IntegrityError as exc:
        raise ApiError(
            409, "MEMBERSHIP_CHANGE_PENDING", "这位同学已经有一条待处理的申请。"
        ) from exc
    _write_handovers(session, row, plan)
    record_audit(
        session,
        actor=user,
        action=f"group.membership_change.{cmd.change_type}_requested",
        target=("membership_change", row.id),
        course_id=course.id,
        project_id=row.project_id,
        after={"member_id": str(member_id), "tasks": len(plan)},
        reason=reason,
        request=request,
    )
    if formation_open(course, group):
        _apply(session, user, row, group)
    else:
        _ask_teachers(session, row, group)
    return _dto(session, user, row)


# ---------------------------------------------------------------- B2-07 edit / decide


def _lock_row(session: Session, request_id: UUID) -> BMembershipChangeRequest:
    row = session.scalar(
        select(BMembershipChangeRequest)
        .where(BMembershipChangeRequest.id == request_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None:
        raise ApiError(404, "MEMBERSHIP_CHANGE_NOT_FOUND", "申请不存在。")
    return row


def edit(
    session: Session, user: User, request_id: UUID, cmd: EditMembershipChange, request=None
) -> MembershipChangeDTO:
    probe = session.get(BMembershipChangeRequest, request_id)
    if probe is None or probe.requested_by != user.id:
        raise ApiError(404, "MEMBERSHIP_CHANGE_NOT_FOUND", "申请不存在。")
    projects = _projects(session, probe.group_id, lock=True)
    group = _group(session, probe.group_id, lock=True)
    row = _lock_row(session, request_id)
    require_version(row.lock_version, cmd.expected_version)
    if row.status != "needs_info":
        raise ApiError(409, "MEMBERSHIP_CHANGE_CLOSED", "只有老师要求补充的申请可以修改。")
    reason = require_reason(cmd.reason)
    if row.member_id not in _active(session, group.id):
        raise ApiError(409, "MEMBER_ALREADY_LEFT", "这位同学已经不在本组。")
    plan = _check_handovers(session, group, projects, row.member_id, cmd.handovers)
    row.reason = reason
    row.status = "pending"
    row.lock_version += 1
    session.flush()
    _write_handovers(session, row, plan)
    _ask_teachers(session, row, group)
    record_audit(
        session,
        actor=user,
        action="group.membership_change.resubmitted",
        target=("membership_change", row.id),
        course_id=row.course_id,
        project_id=row.project_id,
        after={"tasks": len(plan)},
        reason=reason,
        request=request,
    )
    return _dto(session, user, row)


def decide(
    session: Session, user: User, request_id: UUID, cmd: DecideMembershipChange, request=None
) -> MembershipChangeDTO:
    probe = session.get(BMembershipChangeRequest, request_id)
    if probe is None:
        raise ApiError(404, "MEMBERSHIP_CHANGE_NOT_FOUND", "申请不存在。")
    permissions.require_course_teacher(session, user, probe.course_id)
    _projects(session, probe.group_id, lock=True)
    group = _group(session, probe.group_id, lock=True)
    row = _lock_row(session, request_id)
    require_version(row.lock_version, cmd.expected_version)
    if row.status != "pending":
        raise ApiError(409, "MEMBERSHIP_CHANGE_CLOSED", "这条申请不在待审批状态。")
    comment = cmd.comment.strip() if cmd.comment else None
    if cmd.decision != "approve":
        comment = require_reason(cmd.comment, field="comment")
    key = source_key(row)
    row.teacher_comment = comment
    row.decided_by, row.decided_at = user.id, now()
    if cmd.decision == "approve":
        _apply(session, user, row, group)
    else:
        row.status = "rejected" if cmd.decision == "reject" else "needs_info"
        row.lock_version += 1
        session.flush()
    close_action_items_by_source(
        session, key, status="rejected" if cmd.decision == "reject" else "completed", actor=user
    )
    course = session.get(Course, row.course_id)
    member = session.get(User, row.member_id)
    word = {"approve": "已批准", "reject": "未批准", "needs_info": "需要补充"}[cmd.decision]
    verb = "退出" if row.change_type == "leave" else f"移出 {member.name or '同学'}"
    notify(
        session,
        recipient=row.requested_by,
        category="course",
        title=f"老师{word}「{group.name}」的{verb}申请",
        description=f"老师意见：{comment}"[:2000] if comment else "",
        target=_course_target(course.id),
        dedupe_key=f"b:membership-decision:{row.id}:v{row.lock_version}",
    )
    record_audit(
        session,
        actor=user,
        action=f"group.membership_change.{row.status}",
        target=("membership_change", row.id),
        course_id=row.course_id,
        project_id=row.project_id,
        after={"status": row.status},
        reason=comment,
        request=request,
    )
    return _dto(session, user, row)


# ---------------------------------------------------------------- reads


def _dto(session: Session, user: User, row: BMembershipChangeRequest) -> MembershipChangeDTO:
    group = session.get(ProjectGroup, row.group_id)
    handovers = list(
        session.scalars(
            select(BTaskHandover)
            .where(BTaskHandover.request_id == row.id)
            .execution_options(populate_existing=True)
        )
    )
    tasks = (
        {
            t.id: t
            for t in session.scalars(
                select(Task).where(Task.id.in_([h.task_id for h in handovers]))
            )
        }
        if handovers
        else {}
    )
    codes = _codes(session, list(tasks))
    ids = {row.member_id, row.requested_by} | {h.to_user_id for h in handovers}
    if row.decided_by:
        ids.add(row.decided_by)
    people = _people(session, ids)
    return MembershipChangeDTO(
        id=row.id,
        course_id=row.course_id,
        group_id=row.group_id,
        group_name=group.name if group else "",
        project_id=row.project_id,
        change_type=row.change_type,
        member=people.get(row.member_id),
        requested_by=people.get(row.requested_by),
        status=row.status,
        reason=row.reason,
        teacher_comment=row.teacher_comment,
        decided_by=people.get(row.decided_by) if row.decided_by else None,
        decided_at=row.decided_at,
        applied_at=row.applied_at,
        created_at=row.created_at,
        lock_version=row.lock_version,
        handovers=[
            HandoverDTO(
                task_id=h.task_id,
                code=codes.get(h.task_id),
                title=tasks[h.task_id].title if h.task_id in tasks else "",
                status=tasks[h.task_id].status if h.task_id in tasks else "",
                from_user=people.get(h.from_user_id),
                to_user=people.get(h.to_user_id),
                applied_at=h.applied_at,
            )
            for h in handovers
        ],
        can_edit=row.status == "needs_info" and row.requested_by == user.id,
    )


def group_changes(session: Session, user: User, group_id: UUID) -> list[MembershipChangeDTO]:
    group = _group(session, group_id)
    _require_reader(session, user, group)
    rows = session.scalars(
        select(BMembershipChangeRequest)
        .where(BMembershipChangeRequest.group_id == group.id)
        .order_by(BMembershipChangeRequest.created_at.desc())
    ).all()
    return [_dto(session, user, r) for r in rows]


def course_changes(
    session: Session, user: User, course_id: UUID, status: str | None
) -> list[MembershipChangeDTO]:
    permissions.require_course_staff(session, user, course_id)
    statement = select(BMembershipChangeRequest).where(
        BMembershipChangeRequest.course_id == course_id
    )
    if status:
        if status not in {"pending", "needs_info", "approved", "rejected", "applied"}:
            raise ApiError(422, "INVALID_FILTER", "筛选条件无效。")
        statement = statement.where(BMembershipChangeRequest.status == status)
    rows = session.scalars(statement.order_by(BMembershipChangeRequest.created_at)).all()
    return [_dto(session, user, r) for r in rows]
