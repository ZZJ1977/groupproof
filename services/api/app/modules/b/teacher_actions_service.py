"""Teacher approval and action center aggregation service."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import (
    Course,
    CourseMember,
    GroupMember,
    Milestone,
    Project,
    ProjectGroup,
    ProjectMember,
    User,
)
from app.modules.a import permissions
from app.modules.a.audit import record_audit
from app.modules.a.inbox import (
    close_action_item,
    close_action_items_by_source,
    create_action_item,
    notify,
)
from app.modules.a.models import ActionItem
from app.modules.b import courses_service, groups_service, membership_service
from app.modules.b.common import now, require_reason
from app.modules.b.courses_service import join_source_key
from app.modules.b.groups_service import invitation_source_key
from app.modules.b.membership_schemas import DecideMembershipChange
from app.modules.b.membership_service import source_key as member_change_source_key
from app.modules.b.milestones_service import milestone_briefs
from app.modules.b.models import (
    BCourseJoinRequest,
    BGroupInvitation,
    BMembershipChangeRequest,
    BTaskHandover,
)
from app.modules.b.teacher_actions_schemas import (
    ActionDefDTO,
    BatchAction,
    BatchActionErrorDTO,
    BatchActionResultDTO,
    HandleAction,
    RemindAction,
    RemindResultDTO,
    TeacherActionItemDTO,
    TeacherActionPageDTO,
)
from app.modules.b.teacher_permissions import has_staff_permission, require_staff_permission


def _load_course(session: Session, course_id: UUID) -> Course:
    course = session.get(Course, course_id)
    if course is None:
        raise ApiError(404, "COURSE_NOT_FOUND", "班级不存在。")
    return course


def _as_utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _user_names(session: Session, ids: set[UUID]) -> dict[UUID, str]:
    if not ids:
        return {}
    return {
        u.id: (u.name or u.email or "用户")
        for u in session.scalars(select(User).where(User.id.in_(ids))).all()
    }


def _collect_actions(session: Session, user: User, course_id: UUID) -> list[TeacherActionItemDTO]:
    course = _load_course(session, course_id)
    can_approve_joins = has_staff_permission(session, user, course_id, "approve_joins")
    can_manage_groups = has_staff_permission(session, user, course_id, "manage_groups")
    can_approve_changes = has_staff_permission(session, user, course_id, "approve_changes")

    joins = list(
        session.scalars(
            select(BCourseJoinRequest).where(BCourseJoinRequest.course_id == course_id)
        ).all()
    )
    invites = list(
        session.scalars(
            select(BGroupInvitation).where(
                BGroupInvitation.course_id == course_id,
                BGroupInvitation.status.in_(["awaiting_teacher", "approved", "rejected"]),
            )
        ).all()
    )
    member_changes = list(
        session.scalars(
            select(BMembershipChangeRequest).where(BMembershipChangeRequest.course_id == course_id)
        ).all()
    )
    projects = list(
        session.scalars(
            select(Project).where(Project.course_id == course_id, Project.archived_at.is_(None))
        ).all()
    )
    project_ids = [p.id for p in projects]
    groups_by_id = {
        g.id: g
        for g in session.scalars(
            select(ProjectGroup).where(ProjectGroup.course_id == course_id)
        ).all()
    }

    handover_counts: dict[UUID, int] = {}
    if member_changes:
        mc_ids = [m.id for m in member_changes]
        for req_id, cnt in session.execute(
            select(BTaskHandover.request_id, func.count(BTaskHandover.id))
            .where(BTaskHandover.request_id.in_(mc_ids))
            .group_by(BTaskHandover.request_id)
        ).all():
            handover_counts[req_id] = int(cnt)

    person_ids: set[UUID] = set()
    for row in joins:
        person_ids.add(row.user_id)
        if row.decided_by:
            person_ids.add(row.decided_by)
    for row in invites:
        person_ids.update({row.invitee_id, row.inviter_id})
        if row.decided_by:
            person_ids.add(row.decided_by)
    for row in member_changes:
        person_ids.update({row.member_id, row.requested_by})
        if row.decided_by:
            person_ids.add(row.decided_by)
    names = _user_names(session, person_ids)

    ts = now()
    items: list[TeacherActionItemDTO] = []

    for row in joins:
        is_pending = row.status == "pending"
        urgent = is_pending and (_as_utc(ts) - _as_utc(row.created_at)) >= timedelta(days=2)
        actions = (
            [
                ActionDefDTO(key="approve", label="批准", style="primary"),
                ActionDefDTO(
                    key="reject",
                    label="拒绝",
                    requires_reason=True,
                    confirm_text="请填写拒绝该学生入班的原因。",
                    style="danger",
                ),
            ]
            if is_pending and can_approve_joins and course.status == "active"
            else []
        )
        items.append(
            TeacherActionItemDTO(
                id=f"join:{row.id}",
                source_id=str(row.id),
                type="join_request",
                priority="urgent" if urgent else "normal",
                status="pending" if is_pending else "handled",
                title=f"{names.get(row.user_id, '学生')} 申请加入班级",
                description=row.message.strip() if row.message else "来源：邀请码审批加入",
                course_id=course_id,
                subject_user_id=row.user_id,
                href=f"/teacher/courses/{course_id}",
                available_actions=actions,
                created_at=row.created_at,
                handled_at=row.decided_at,
                handled_by=names.get(row.decided_by) if row.decided_by else None,
                decision=None if is_pending else row.status,
                decision_reason=row.decision_reason,
            )
        )

    for row in invites:
        is_pending = row.status == "awaiting_teacher"
        grp = groups_by_id.get(row.group_id)
        actions = (
            [
                ActionDefDTO(key="approve", label="批准", style="primary"),
                ActionDefDTO(
                    key="reject",
                    label="拒绝",
                    requires_reason=True,
                    confirm_text="请填写拒绝该逾期组队邀请的原因。",
                    style="danger",
                ),
            ]
            if is_pending and can_manage_groups and course.status == "active"
            else []
        )
        items.append(
            TeacherActionItemDTO(
                id=f"invite:{row.id}",
                source_id=str(row.id),
                type="post_deadline_invite",
                priority="normal",
                status="pending" if is_pending else "handled",
                title=(
                    f"「{grp.name if grp else '小组'}」逾期邀请 "
                    f"{names.get(row.invitee_id, '学生')} 入组"
                ),
                description=f"发起人：{names.get(row.inviter_id, '组员')}（组队截止后需教师审批）",
                course_id=course_id,
                group_id=row.group_id,
                subject_user_id=row.invitee_id,
                href=f"/teacher/courses/{course_id}/groups/{row.group_id}",
                available_actions=actions,
                created_at=row.created_at,
                handled_at=row.decided_at,
                handled_by=names.get(row.decided_by) if row.decided_by else None,
                decision=None if is_pending else row.status,
                decision_reason=row.decision_reason,
            )
        )

    for row in member_changes:
        is_pending = row.status in {"pending", "needs_info"}
        grp = groups_by_id.get(row.group_id)
        hc = handover_counts.get(row.id, 0)
        kind_label = "退组" if row.change_type == "leave" else "移出成员"
        actions = (
            [
                ActionDefDTO(key="approve", label="批准", style="primary"),
                ActionDefDTO(
                    key="reject",
                    label="拒绝",
                    requires_reason=True,
                    confirm_text="请填写拒绝本次成员变动的原因。",
                    style="danger",
                ),
            ]
            if row.status == "pending" and can_approve_changes and course.status == "active"
            else []
        )
        items.append(
            TeacherActionItemDTO(
                id=f"member_change:{row.id}",
                source_id=str(row.id),
                type="member_leave" if row.change_type == "leave" else "member_remove",
                priority="urgent" if is_pending else "normal",
                status="pending" if is_pending else "handled",
                title=(
                    f"{grp.name if grp else '小组'} · "
                    f"{names.get(row.member_id, '成员')} {kind_label}申请"
                ),
                description=f"原因：{row.reason} · 任务交接：{hc} 个任务",
                course_id=course_id,
                group_id=row.group_id,
                project_id=row.project_id,
                subject_user_id=row.member_id,
                href=f"/teacher/courses/{course_id}/member-changes?request={row.id}",
                available_actions=actions,
                created_at=row.created_at,
                handled_at=row.decided_at,
                handled_by=names.get(row.decided_by) if row.decided_by else None,
                decision=None if is_pending else row.status,
                decision_reason=row.teacher_comment,
            )
        )

    milestone_acks = {
        ai.source_key: ai
        for ai in session.scalars(
            select(ActionItem).where(
                ActionItem.recipient_id == user.id,
                ActionItem.source_key.like("b:milestone-ack:%"),
            )
        ).all()
        if ai.source_key
    }

    for proj in projects:
        briefs = milestone_briefs(session, proj.id)
        grp = groups_by_id.get(proj.group_id) if proj.group_id else None
        for m in briefs:
            if not m.overdue or m.deadline is None:
                continue
            ack_key = f"b:milestone-ack:{m.id}"
            ack_row = milestone_acks.get(ack_key)
            handled = ack_row is not None and ack_row.status != "pending"
            overdue_days = max(1, (_as_utc(ts) - _as_utc(m.deadline)).days)
            pct = m.progress_percent if m.progress_percent is not None else 0
            open_tasks = max(0, m.task_count - m.completed_task_count)
            actions = (
                [
                    ActionDefDTO(key="remind", label="发送催办通知", style="primary"),
                    ActionDefDTO(key="mark_read", label="标记已处理", style="secondary"),
                ]
                if not handled
                else []
            )
            items.append(
                TeacherActionItemDTO(
                    id=f"milestone:{m.id}",
                    source_id=str(m.id),
                    type="milestone_overdue",
                    priority="urgent",
                    status="handled" if handled else "pending",
                    title=(
                        f"{grp.name if grp else proj.name} 里程碑「{m.title}」"
                        f"已逾期 {overdue_days} 天"
                    ),
                    description=f"进度：{pct}%，{open_tasks} 个任务未完成",
                    course_id=course_id,
                    group_id=proj.group_id,
                    project_id=proj.id,
                    href=m.href,
                    available_actions=actions,
                    created_at=m.deadline,
                    handled_at=ack_row.closed_at if handled and ack_row else None,
                    decision="acknowledged" if handled else None,
                )
            )

    # Surface remaining inbox action items assigned to user for this course/projects
    inbox_rows = session.scalars(select(ActionItem).where(ActionItem.recipient_id == user.id)).all()
    pid_strs = {str(pid) for pid in project_ids}
    cid_str = str(course_id)
    for ai in inbox_rows:
        sk = ai.source_key or ""
        if sk.startswith(
            ("b:course-join:", "b:group-invite:", "b:membership:", "b:milestone-ack:")
        ):
            continue
        tgt = ai.target_json or {}
        if tgt.get("course_id") != cid_str and tgt.get("project_id") not in pid_strs:
            continue
        mapped_type = (
            "appeal"
            if ai.category == "appeal"
            else "rule_change_review"
            if ai.category == "rule"
            else "notification"
        )
        is_pending = ai.status == "pending"
        prio = "urgent" if ai.priority == "high" else ("low" if ai.priority == "low" else "normal")
        items.append(
            TeacherActionItemDTO(
                id=f"inbox:{ai.id}",
                source_id=str(ai.id),
                type=mapped_type,
                priority=prio,  # type: ignore[arg-type]
                status="pending" if is_pending else "handled",
                title=ai.title,
                description=ai.description,
                course_id=course_id,
                project_id=UUID(tgt["project_id"]) if tgt.get("project_id") else None,
                href=(
                    (
                        f"/teacher/courses/{course_id}/appeals?appeal={tgt['id']}"
                        if tgt.get("id")
                        else f"/teacher/courses/{course_id}/appeals"
                    )
                    if ai.category == "appeal"
                    else f"/teacher/courses/{course_id}/rules"
                ),
                available_actions=(
                    [ActionDefDTO(key="mark_read", label="标记已处理", style="secondary")]
                    if is_pending
                    else []
                ),
                created_at=ai.created_at,
                handled_at=ai.closed_at,
                decision=None if is_pending else ai.status,
            )
        )

    items.sort(
        key=lambda it: (0 if it.status == "pending" else 1, -_as_utc(it.created_at).timestamp())
    )
    return items


def list_actions(
    session: Session,
    user: User,
    course_id: UUID,
    *,
    action_types: list[str] | None = None,
    status_filter: str = "all",
    priority: str | None = None,
    days: int | None = None,
    page: int = 1,
    page_size: int = 20,
) -> TeacherActionPageDTO:
    permissions.require_course_staff(session, user, course_id)
    all_items = _collect_actions(session, user, course_id)
    pending_count = sum(1 for i in all_items if i.status == "pending")
    urgent_count = sum(1 for i in all_items if i.status == "pending" and i.priority == "urgent")
    counts_by_type: dict[str, int] = {}
    for item in all_items:
        counts_by_type[item.type] = counts_by_type.get(item.type, 0) + (
            1 if item.status == "pending" else 0
        )

    filtered = all_items
    if action_types:
        allowed = set(action_types)
        filtered = [i for i in filtered if i.type in allowed]
    if status_filter != "all":
        filtered = [i for i in filtered if i.status == status_filter]
    if priority and priority != "all":
        filtered = [i for i in filtered if i.priority == priority]
    if days is not None and days > 0:
        cutoff = _as_utc(now()) - timedelta(days=days)
        filtered = [i for i in filtered if _as_utc(i.created_at) >= cutoff]

    start = max(0, (page - 1) * page_size)
    end = start + page_size
    return TeacherActionPageDTO(
        items=filtered[start:end],
        total=len(filtered),
        pending_count=pending_count,
        urgent_count=urgent_count,
        counts_by_type=counts_by_type,
    )


def _parse_action_id(action_id: str) -> tuple[str, UUID]:
    if ":" not in action_id:
        raise ApiError(404, "ACTION_NOT_FOUND", "未找到对应待办事项。")
    kind, raw = action_id.split(":", 1)
    try:
        return kind, UUID(raw)
    except ValueError as exc:
        raise ApiError(404, "ACTION_NOT_FOUND", "无效的待办事项编号。") from exc


def _handle_join(
    session: Session, user: User, course: Course, req_id: UUID, command: HandleAction, request
) -> None:
    require_staff_permission(session, user, course.id, "approve_joins")
    row = session.scalar(
        select(BCourseJoinRequest)
        .where(BCourseJoinRequest.id == req_id, BCourseJoinRequest.course_id == course.id)
        .with_for_update()
    )
    if row is None:
        raise ApiError(404, "JOIN_REQUEST_NOT_FOUND", "入班申请不存在。")
    if row.status != "pending":
        raise ApiError(409, "JOIN_REQUEST_DECIDED", "该入班申请已被处理。")

    action = command.action_key
    if action not in {"approve", "reject"}:
        raise ApiError(422, "INVALID_ACTION", "不支持该操作。")

    reason = command.reason.strip() if command.reason else None
    if action == "reject":
        reason = require_reason(command.reason)
    elif course.status != "active":
        raise ApiError(409, "COURSE_CLOSED", "课程已结束，不能批准新学生入班。")

    row.status = "approved" if action == "approve" else "rejected"
    row.decided_by = user.id
    row.decided_at = now()
    row.decision_reason = reason
    row.lock_version += 1

    if (
        action == "approve"
        and courses_service._current_membership(session, row.user_id, course.id) is None
    ):
        session.add(CourseMember(course_id=course.id, user_id=row.user_id, role="student"))
    session.flush()

    close_action_items_by_source(
        session,
        join_source_key(row.id),
        status="completed" if action == "approve" else "rejected",
        actor=user,
    )
    notify(
        session,
        recipient=row.user_id,
        category="course",
        title=(
            f"你已加入《{course.name}》"
            if action == "approve"
            else f"加入《{course.name}》的申请未通过"
        ),
        description="" if action == "approve" else f"原因：{reason}",
        target={"kind": "course", "id": course.id, "course_id": course.id},
        dedupe_key=f"b:course-join-decision:{row.id}",
    )
    record_audit(
        session,
        actor=user,
        action=f"teacher.action.join_{row.status}",
        target=("course_join_request", row.id),
        course_id=course.id,
        reason=reason,
        request=request,
    )


def _handle_invite(
    session: Session, user: User, course: Course, inv_id: UUID, command: HandleAction, request
) -> None:
    require_staff_permission(session, user, course.id, "manage_groups")
    row = session.scalar(
        select(BGroupInvitation)
        .where(BGroupInvitation.id == inv_id, BGroupInvitation.course_id == course.id)
        .with_for_update()
    )
    if row is None:
        raise ApiError(404, "INVITATION_NOT_FOUND", "组队邀请不存在。")
    if row.status != "awaiting_teacher":
        raise ApiError(409, "INVITATION_CLOSED", "该邀请已被处理或无需教师审批。")

    action = command.action_key
    if action not in {"approve", "reject"}:
        raise ApiError(422, "INVALID_ACTION", "不支持该操作。")

    reason = command.reason.strip() if command.reason else None
    group = groups_service._group(session, row.group_id, lock=True)
    if action == "reject":
        reason = require_reason(command.reason)
    else:
        if course.status != "active":
            raise ApiError(409, "COURSE_CLOSED", "课程已结束。")
        groups_service._add_member(session, group, course, row.invitee_id, check_deadline=False)

    row.status = "approved" if action == "approve" else "rejected"
    row.decided_by = user.id
    row.decided_at = now()
    row.decision_reason = reason
    row.lock_version += 1
    session.flush()

    close_action_items_by_source(
        session,
        invitation_source_key(row.id),
        status="completed" if action == "approve" else "rejected",
        actor=user,
    )
    invitee = session.get(User, row.invitee_id)
    for recipient in {row.invitee_id, row.inviter_id}:
        notify(
            session,
            recipient=recipient,
            category="course",
            title=(
                f"已批准 {invitee.name if invitee else '同学'} 加入「{group.name}」"
                if action == "approve"
                else f"未批准 {invitee.name if invitee else '同学'} 加入「{group.name}」"
            ),
            description="" if action == "approve" else f"原因：{reason}",
            target={"kind": "course", "id": course.id, "course_id": course.id},
            dedupe_key=f"b:group-invite-decision:{row.id}",
        )
    record_audit(
        session,
        actor=user,
        action=f"teacher.action.invite_{row.status}",
        target=("group_invitation", row.id),
        course_id=course.id,
        reason=reason,
        request=request,
    )


def _handle_member_change(
    session: Session, user: User, course: Course, req_id: UUID, command: HandleAction, request
) -> None:
    require_staff_permission(session, user, course.id, "approve_changes")
    row = membership_service._lock_row(session, req_id)
    if row.course_id != course.id:
        raise ApiError(404, "MEMBERSHIP_CHANGE_NOT_FOUND", "成员变动申请不存在。")
    if row.status != "pending":
        raise ApiError(409, "MEMBERSHIP_CHANGE_CLOSED", "该成员变动申请不在待审批状态。")
    if command.action_key not in {"approve", "reject"}:
        raise ApiError(422, "INVALID_ACTION", "不支持该操作。")
    comment = command.reason.strip() if command.reason else None
    if command.action_key == "reject":
        comment = require_reason(command.reason)

    if permissions.is_course_teacher(session, user, course.id):
        membership_service.decide(
            session,
            user,
            req_id,
            DecideMembershipChange(
                decision=command.action_key,  # type: ignore[arg-type]
                comment=comment,
                expected_version=row.lock_version,
            ),
            request=request,
        )
        return

    # Authorized TA with approve_changes
    membership_service._projects(session, row.group_id, lock=True)
    group = membership_service._group(session, row.group_id, lock=True)
    row.teacher_comment = comment
    row.decided_by = user.id
    row.decided_at = now()
    if command.action_key == "approve":
        membership_service._apply(session, user, row, group)
    else:
        row.status = "rejected"
        row.lock_version += 1
        session.flush()
    close_action_items_by_source(
        session,
        member_change_source_key(row),
        status="rejected" if command.action_key == "reject" else "completed",
        actor=user,
    )
    record_audit(
        session,
        actor=user,
        action=f"teacher.action.member_change_{row.status}",
        target=("membership_change", row.id),
        course_id=course.id,
        reason=comment,
        request=request,
    )


def _acknowledge_milestone(
    session: Session, user: User, course: Course, milestone_id: UUID
) -> None:
    milestone = session.get(Milestone, milestone_id)
    if milestone is None:
        raise ApiError(404, "MILESTONE_NOT_FOUND", "里程碑不存在。")
    proj = session.get(Project, milestone.project_id)
    if proj is None or proj.course_id != course.id:
        raise ApiError(404, "MILESTONE_NOT_FOUND", "里程碑不属于本班级。")
    item = create_action_item(
        session,
        recipient=user.id,
        category="course",
        title=f"里程碑「{milestone.title}」逾期已处理",
        target={"kind": "course", "id": course.id, "course_id": course.id},
        source_key=f"b:milestone-ack:{milestone.id}",
    )
    close_action_item(session, item.id, status="completed", actor=user)


def handle_action(
    session: Session,
    user: User,
    course_id: UUID,
    action_id: str,
    command: HandleAction,
    request=None,
) -> TeacherActionItemDTO:
    course = _load_course(session, course_id)
    permissions.require_course_staff(session, user, course_id)
    kind, raw_id = _parse_action_id(action_id)

    if kind == "join":
        _handle_join(session, user, course, raw_id, command, request)
    elif kind == "invite":
        _handle_invite(session, user, course, raw_id, command, request)
    elif kind == "member_change":
        _handle_member_change(session, user, course, raw_id, command, request)
    elif kind == "milestone":
        if command.action_key == "remind":
            remind_action(
                session, user, course_id, action_id, RemindAction(message=command.reason), request
            )
        else:
            _acknowledge_milestone(session, user, course, raw_id)
    elif kind == "inbox":
        row = session.get(ActionItem, raw_id)
        if row is None or row.recipient_id != user.id:
            raise ApiError(404, "ACTION_ITEM_NOT_FOUND", "待办事项不存在。")
        close_action_item(session, row.id, status="completed", actor=user)
    else:
        raise ApiError(404, "ACTION_NOT_FOUND", "未知待办类型。")

    updated = next(
        (i for i in _collect_actions(session, user, course_id) if i.id == action_id), None
    )
    if updated is None:
        raise ApiError(404, "ACTION_NOT_FOUND", "操作项不存在。")
    return updated


def batch_actions(
    session: Session, user: User, course_id: UUID, command: BatchAction, request=None
) -> BatchActionResultDTO:
    permissions.require_course_staff(session, user, course_id)
    handled = 0
    errors: list[BatchActionErrorDTO] = []
    for aid in command.ids:
        try:
            handle_action(
                session,
                user,
                course_id,
                aid,
                HandleAction(action_key=command.action_key, reason=command.reason),
                request=request,
            )
            handled += 1
        except ApiError as exc:
            errors.append(BatchActionErrorDTO(id=aid, code=exc.code, message=exc.message))
    return BatchActionResultDTO(handled=handled, failed=len(errors), errors=errors)


def remind_action(
    session: Session,
    user: User,
    course_id: UUID,
    action_id: str,
    command: RemindAction,
    request=None,
) -> RemindResultDTO:
    course = _load_course(session, course_id)
    permissions.require_course_staff(session, user, course_id)
    kind, raw_id = _parse_action_id(action_id)
    custom = (command.message or "").strip()

    recipients: set[UUID] = set()
    title = f"「{course.name}」教师催办提醒"
    desc = custom or "请及时关注待处理里程碑或申请事项进度。"
    target: dict = {"kind": "course", "id": course_id, "course_id": course_id}

    if kind == "milestone":
        milestone = session.get(Milestone, raw_id)
        if milestone is None:
            raise ApiError(404, "MILESTONE_NOT_FOUND", "里程碑不存在。")
        proj = session.get(Project, milestone.project_id)
        if proj is None or proj.course_id != course_id:
            raise ApiError(404, "MILESTONE_NOT_FOUND", "里程碑不属于本班级。")
        member_ids = session.scalars(
            select(ProjectMember.user_id).where(
                ProjectMember.project_id == proj.id, ProjectMember.left_at.is_(None)
            )
        ).all()
        recipients.update(member_ids)
        if proj.group_id:
            grp_members = session.scalars(
                select(GroupMember.user_id).where(
                    GroupMember.group_id == proj.group_id, GroupMember.left_at.is_(None)
                )
            ).all()
            recipients.update(grp_members)
        title = f"[紧急催办] 里程碑「{milestone.title}」已逾期"
        desc = custom or f"所属项目「{proj.name}」里程碑已逾期，请组长与成员尽快推进完成。"
        target = {"kind": "project", "id": proj.id, "project_id": proj.id}
    elif kind == "member_change":
        row = session.get(BMembershipChangeRequest, raw_id)
        if row is None or row.course_id != course_id:
            raise ApiError(404, "MEMBERSHIP_CHANGE_NOT_FOUND", "申请不存在。")
        recipients.update(
            session.scalars(
                select(GroupMember.user_id).where(
                    GroupMember.group_id == row.group_id, GroupMember.left_at.is_(None)
                )
            ).all()
        )
        title = "[催办] 请补充成员变动任务交接信息"
    elif kind == "join":
        row = session.get(BCourseJoinRequest, raw_id)
        if row is None or row.course_id != course_id:
            raise ApiError(404, "JOIN_REQUEST_NOT_FOUND", "申请不存在。")
        recipients.add(row.user_id)
    elif kind == "invite":
        row = session.get(BGroupInvitation, raw_id)
        if row is None or row.course_id != course_id:
            raise ApiError(404, "INVITATION_NOT_FOUND", "邀请不存在。")
        recipients.update({row.invitee_id, row.inviter_id})
    else:
        raise ApiError(422, "REMIND_UNSUPPORTED", "该操作项不支持发送催办通知。")

    for rid in recipients:
        notify(
            session,
            recipient=rid,
            category="project" if "project_id" in target else "course",
            title=title,
            description=desc,
            target=target,
        )
    record_audit(
        session,
        actor=user,
        action="teacher.action.reminded",
        target=("course", course_id),
        course_id=course_id,
        after={"action_id": action_id, "notified": len(recipients)},
        request=request,
    )
    return RemindResultDTO(notified_count=len(recipients))
