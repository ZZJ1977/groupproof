"""B-2: create/join groups (B2-01/02), invitations (B2-03), leader change (B2-05).

Concurrency: joining locks the group row (last seat) and the joiner's course
membership row (one group per course per student) before checking, so two
requests cannot both pass the checks.

Inbox targets: C's inbox has no "group" target kind yet, so student-facing
notifications point at the course (``kind=course``); teacher approvals use
``member_change`` (page 48), like course joins.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import (
    Course,
    CourseMember,
    GroupMember,
    Project,
    ProjectGroup,
    ProjectMember,
    User,
)
from app.modules.a import permissions
from app.modules.a.audit import record_audit
from app.modules.a.inbox import close_action_items_by_source, create_action_item, notify
from app.modules.a.models import ActionItem
from app.modules.b.common import now, require_reason, require_version
from app.modules.b.courses_schemas import PersonDTO
from app.modules.b.courses_service import teacher_ids
from app.modules.b.groups_schemas import (
    CandidateDTO,
    ConfirmLeaderChange,
    CreateGroup,
    DecideInvitation,
    GroupDetailDTO,
    GroupMemberDTO,
    GroupPageDTO,
    GroupSummaryDTO,
    InvitationDTO,
    Invite,
    LeaderChangeDTO,
    RespondInvitation,
    StartLeaderChange,
)
from app.modules.b.models import (
    BGroupInvitation,
    BLeaderChangeConfirmation,
    BLeaderChangeRequest,
)

OPEN_INVITATION = ("pending", "awaiting_teacher")


def invitation_source_key(invitation_id: UUID) -> str:
    return f"b:group-invite:{invitation_id}"


def leader_change_source_key(request_id: UUID) -> str:
    return f"b:leader-change:{request_id}"


# ---------------------------------------------------------------- reads


def _person(session: Session, user_id: UUID | None) -> PersonDTO | None:
    if user_id is None:
        return None
    user = session.get(User, user_id)
    return PersonDTO(id=user.id, name=user.name) if user else None


def _course(session: Session, course_id: UUID) -> Course:
    course = session.get(Course, course_id)
    if course is None:
        raise ApiError(404, "COURSE_NOT_FOUND", "课程不存在或你不是该课程成员。")
    return course


def _group(session: Session, group_id: UUID, *, lock: bool = False) -> ProjectGroup:
    query = select(ProjectGroup).where(ProjectGroup.id == group_id)
    if lock:
        query = query.with_for_update()
    group = session.scalar(query.execution_options(populate_existing=True))
    if group is None:
        raise ApiError(404, "GROUP_NOT_FOUND", "小组不存在。")
    return group


def _members(session: Session, group_id: UUID) -> list[GroupMember]:
    return list(
        session.scalars(
            select(GroupMember)
            .where(GroupMember.group_id == group_id, GroupMember.left_at.is_(None))
            .order_by(GroupMember.joined_at, GroupMember.user_id)
            .execution_options(populate_existing=True)
        )
    )


def _member_count(session: Session, group_id: UUID) -> int:
    return (
        session.scalar(
            select(func.count())
            .select_from(GroupMember)
            .where(GroupMember.group_id == group_id, GroupMember.left_at.is_(None))
        )
        or 0
    )


def _group_of(session: Session, user_id: UUID, course_id: UUID) -> ProjectGroup | None:
    return session.scalar(
        select(ProjectGroup)
        .join(GroupMember, GroupMember.group_id == ProjectGroup.id)
        .where(
            ProjectGroup.course_id == course_id,
            GroupMember.user_id == user_id,
            GroupMember.left_at.is_(None),
        )
        .execution_options(populate_existing=True)
    )


def formation_open(course: Course, group: ProjectGroup | None = None) -> bool:
    if course.status != "active" or (group is not None and group.roster_frozen):
        return False
    return course.formation_deadline is None or now() <= course.formation_deadline


def _require_course_reader(session: Session, user: User, course_id: UUID) -> Course:
    course = _course(session, course_id)
    if not (
        permissions.is_course_member(session, user, course_id)
        or permissions.is_course_staff(session, user, course_id)
    ):
        raise ApiError(404, "COURSE_NOT_FOUND", "课程不存在或你不是该课程成员。")
    return course


def _require_course_student(session: Session, user: User, course_id: UUID, *, lock=False):
    """The caller's current course membership row (locked when joining)."""
    query = select(CourseMember).where(
        CourseMember.course_id == course_id,
        CourseMember.user_id == user.id,
        CourseMember.left_at.is_(None),
        CourseMember.status == "active",
        CourseMember.role == "student",
    )
    if lock:
        query = query.with_for_update()
    row = session.scalar(query.execution_options(populate_existing=True))
    if row is None or user.global_role != "student":
        raise ApiError(403, "COURSE_MEMBER_REQUIRED", "只有本课程的学生可以执行此操作。")
    return row


def _summary(session: Session, user: User, group: ProjectGroup, course: Course) -> dict:
    count = _member_count(session, group.id)
    mine = (
        session.scalar(
            select(GroupMember.user_id).where(
                GroupMember.group_id == group.id,
                GroupMember.user_id == user.id,
                GroupMember.left_at.is_(None),
            )
        )
        is not None
    )
    return {
        "id": group.id,
        "course_id": group.course_id,
        "name": group.name,
        "direction": group.direction,
        "leader": _person(session, group.leader_id),
        "member_count": count,
        "max_group_size": course.max_group_size,
        "is_mine": mine,
        "full": count >= course.max_group_size,
        "lock_version": group.lock_version,
    }


def list_groups(session: Session, user: User, course_id: UUID) -> GroupPageDTO:
    course = _require_course_reader(session, user, course_id)
    groups = session.scalars(
        select(ProjectGroup)
        .where(ProjectGroup.course_id == course_id)
        .order_by(ProjectGroup.created_at, ProjectGroup.id)
    ).all()
    mine = _group_of(session, user.id, course_id)
    return GroupPageDTO(
        items=[GroupSummaryDTO(**_summary(session, user, g, course)) for g in groups],
        my_group_id=mine.id if mine else None,
        formation_open=formation_open(course),
        formation_deadline=course.formation_deadline,
    )


def _invitation_dto(session: Session, row: BGroupInvitation) -> InvitationDTO:
    group = session.get(ProjectGroup, row.group_id)
    return InvitationDTO(
        id=row.id,
        group_id=row.group_id,
        group_name=group.name if group else "",
        course_id=row.course_id,
        inviter=_person(session, row.inviter_id),
        invitee=_person(session, row.invitee_id),
        status=row.status,
        created_at=row.created_at,
        decided_at=row.decided_at,
        decision_reason=row.decision_reason,
        lock_version=row.lock_version,
    )


def _leader_change_dto(session: Session, row: BLeaderChangeRequest) -> LeaderChangeDTO:
    confirmations = {
        str(c.user_id): c.decision
        for c in session.scalars(
            select(BLeaderChangeConfirmation).where(BLeaderChangeConfirmation.request_id == row.id)
        )
    }
    waiting = [
        _person(session, UUID(uid))
        for uid in row.required_user_ids
        if uid not in confirmations and row.status == "pending"
    ]
    return LeaderChangeDTO(
        id=row.id,
        group_id=row.group_id,
        requested_by=_person(session, row.requested_by),
        previous_leader=_person(session, row.previous_leader_id),
        candidate=_person(session, row.candidate_id),
        reason=row.reason,
        status=row.status,
        created_at=row.created_at,
        completed_at=row.completed_at,
        confirmations=confirmations,  # type: ignore[arg-type]
        waiting_for=[p for p in waiting if p],
    )


def group_detail(session: Session, user: User, group_id: UUID) -> GroupDetailDTO:
    group = _group(session, group_id)
    course = _require_course_reader(session, user, group.course_id)
    members = _members(session, group.id)
    is_member = any(m.user_id == user.id for m in members)
    staff = permissions.is_course_staff(session, user, course.id)
    invitations = []
    leader_change = None
    if is_member or staff:
        invitations = [
            _invitation_dto(session, row)
            for row in session.scalars(
                select(BGroupInvitation)
                .where(
                    BGroupInvitation.group_id == group.id,
                    BGroupInvitation.status.in_(OPEN_INVITATION),
                )
                .order_by(BGroupInvitation.created_at)
            )
        ]
        pending = session.scalar(
            select(BLeaderChangeRequest)
            .where(BLeaderChangeRequest.group_id == group.id)
            .order_by(BLeaderChangeRequest.created_at.desc())
            .limit(1)
        )
        leader_change = _leader_change_dto(session, pending) if pending else None
    project_id = session.scalar(select(Project.id).where(Project.group_id == group.id))
    users = {
        u.id: u
        for u in session.scalars(select(User).where(User.id.in_([m.user_id for m in members])))
    }
    return GroupDetailDTO(
        **_summary(session, user, group, course),
        members=[
            GroupMemberDTO(
                id=m.user_id,
                name=users[m.user_id].name,
                role="leader" if m.user_id == group.leader_id else "member",
                joined_at=m.joined_at,
            )
            for m in members
        ],
        invitations=invitations,
        leader_change=leader_change,
        formation_open=formation_open(course, group),
        project_id=project_id,
    )


def ungrouped_students(session: Session, user: User, course_id: UUID, q: str | None):
    _require_course_reader(session, user, course_id)
    grouped = (
        select(GroupMember.user_id)
        .join(ProjectGroup, ProjectGroup.id == GroupMember.group_id)
        .where(ProjectGroup.course_id == course_id, GroupMember.left_at.is_(None))
    )
    query = (
        select(User)
        .join(CourseMember, CourseMember.user_id == User.id)
        .where(
            CourseMember.course_id == course_id,
            CourseMember.left_at.is_(None),
            CourseMember.role == "student",
            User.status == "active",
            User.id.not_in(grouped),
            User.id != user.id,
        )
    )
    if q and q.strip():
        like = f"%{q.strip()}%"
        query = query.where(
            User.name.ilike(like) | User.student_id.ilike(like) | User.email.ilike(like)
        )
    return [
        CandidateDTO(id=u.id, name=u.name, student_number=u.student_id)
        for u in session.scalars(query.order_by(User.name, User.id).limit(20))
    ]


# ---------------------------------------------------------------- B2-01 / B2-02


def _require_not_in_group(session: Session, user_id: UUID, course_id: UUID) -> None:
    if _group_of(session, user_id, course_id) is not None:
        raise ApiError(409, "ALREADY_IN_GROUP", "你已经在本课程的一个小组里了。")


def create_group(session: Session, user: User, course_id: UUID, command: CreateGroup, request=None):
    course = _require_course_reader(session, user, course_id)
    _require_course_student(session, user, course_id, lock=True)
    _require_not_in_group(session, user.id, course_id)
    if not formation_open(course):
        raise ApiError(409, "FORMATION_CLOSED", "组队已截止，不能再创建小组。")
    name = command.name.strip()
    if not name:
        raise ApiError(422, "GROUP_NAME_REQUIRED", "请填写小组名称。", details={"field": "name"})
    if session.scalar(
        select(ProjectGroup.id).where(
            ProjectGroup.course_id == course_id, ProjectGroup.name == name
        )
    ):
        raise ApiError(409, "GROUP_NAME_TAKEN", "本课程已有同名小组。", details={"field": "name"})
    group = ProjectGroup(
        course_id=course_id,
        leader_id=user.id,
        name=name,
        direction=(command.direction or "").strip() or None,
    )
    session.add(group)
    session.flush()
    session.add(GroupMember(group_id=group.id, user_id=user.id, role="leader"))
    session.flush()
    record_audit(
        session,
        actor=user,
        action="group.created",
        target=("group", group.id),
        course_id=course_id,
        after={"name": name, "leader_id": user.id},
        request=request,
    )
    return group_detail(session, user, group.id)


def _add_member(
    session: Session, group: ProjectGroup, course: Course, user_id: UUID, *, check_deadline: bool
) -> None:
    """Join checks in the documented order, then insert. Caller holds both locks."""
    if _group_of(session, user_id, course.id) is not None:
        raise ApiError(409, "ALREADY_IN_GROUP", "已经在本课程的一个小组里了。")
    if _member_count(session, group.id) >= course.max_group_size:
        raise ApiError(
            409,
            "GROUP_FULL",
            "小组人数已满。",
            details={"max_group_size": course.max_group_size},
        )
    if check_deadline and not formation_open(course, group):
        raise ApiError(
            409,
            "FORMATION_CLOSED",
            "组队已截止或名单已冻结，不能再加入。",
            details={
                "formation_deadline": course.formation_deadline.isoformat()
                if course.formation_deadline
                else None
            },
        )
    session.add(GroupMember(group_id=group.id, user_id=user_id, role="member"))
    project = session.scalar(select(Project).where(Project.group_id == group.id))
    if project is not None:
        session.add(ProjectMember(project_id=project.id, user_id=user_id, role="member"))
    session.flush()


def join_group(session: Session, user: User, group_id: UUID, request=None):
    group = _group(session, group_id)
    course = _require_course_reader(session, user, group.course_id)
    # Lock order everywhere: course membership row, then group row.
    _require_course_student(session, user, course.id, lock=True)
    group = _group(session, group_id, lock=True)
    _add_member(session, group, course, user.id, check_deadline=True)
    record_audit(
        session,
        actor=user,
        action="group.member.joined",
        target=("group", group.id),
        course_id=course.id,
        after={"user_id": user.id},
        request=request,
    )
    return group_detail(session, user, group.id)


# ---------------------------------------------------------------- B2-03


def _current_member(session: Session, group_id: UUID, user_id: UUID) -> GroupMember | None:
    return session.scalar(
        select(GroupMember).where(
            GroupMember.group_id == group_id,
            GroupMember.user_id == user_id,
            GroupMember.left_at.is_(None),
        )
    )


def invite(session: Session, user: User, group_id: UUID, command: Invite, request=None):
    group = _group(session, group_id)
    course = _course(session, group.course_id)
    if _current_member(session, group.id, user.id) is None:
        raise ApiError(403, "GROUP_MEMBER_REQUIRED", "只有本组成员可以邀请同学。")
    if command.invitee_id == user.id:
        raise ApiError(422, "INVITEE_INVALID", "不能邀请自己。")
    invitee = session.get(User, command.invitee_id)
    if invitee is None or not permissions.is_course_member(session, invitee, course.id):
        raise ApiError(422, "INVITEE_NOT_IN_COURSE", "只能邀请本课程的同学。")
    if course.status != "active":
        raise ApiError(409, "COURSE_CLOSED", "课程已经结束。")
    if _group_of(session, invitee.id, course.id) is not None:
        raise ApiError(409, "INVITEE_IN_GROUP", "这位同学已经加入了小组。")
    if _member_count(session, group.id) >= course.max_group_size:
        raise ApiError(409, "GROUP_FULL", "小组人数已满。")
    if session.scalar(
        select(BGroupInvitation.id).where(
            BGroupInvitation.group_id == group.id,
            BGroupInvitation.invitee_id == invitee.id,
            BGroupInvitation.status.in_(OPEN_INVITATION),
        )
    ):
        raise ApiError(409, "INVITATION_PENDING", "已经邀请过这位同学，正在等待处理。")
    open_now = formation_open(course, group)
    row = BGroupInvitation(
        group_id=group.id,
        course_id=course.id,
        inviter_id=user.id,
        invitee_id=invitee.id,
        status="pending" if open_now else "awaiting_teacher",
    )
    session.add(row)
    session.flush()
    if open_now:
        notify(
            session,
            recipient=invitee.id,
            category="course",
            title=f"{user.name or '同学'} 邀请你加入小组「{group.name}」",
            description=f"课程《{course.name}》。请到课程的小组页面接受或拒绝。",
            target={"kind": "course", "id": course.id, "course_id": course.id},
            dedupe_key=f"b:group-invite:{row.id}",
        )
    else:
        for teacher_id in teacher_ids(session, course):
            create_action_item(
                session,
                recipient=teacher_id,
                category="member",
                title=f"组队已截止：「{group.name}」申请加入 {invitee.name or '同学'}",
                description=f"邀请人：{user.name or ''}",
                target={"kind": "member_change", "id": row.id, "course_id": course.id},
                source_key=invitation_source_key(row.id),
            )
    record_audit(
        session,
        actor=user,
        action="group.invitation.created",
        target=("group_invitation", row.id),
        course_id=course.id,
        after={"invitee_id": invitee.id, "status": row.status},
        request=request,
    )
    return _invitation_dto(session, row)


def my_invitations(session: Session, user: User):
    rows = session.scalars(
        select(BGroupInvitation)
        .where(BGroupInvitation.invitee_id == user.id, BGroupInvitation.status.in_(OPEN_INVITATION))
        .order_by(BGroupInvitation.created_at.desc())
    ).all()
    return [_invitation_dto(session, row) for row in rows]


def _lock_invitation(session: Session, invitation_id: UUID) -> BGroupInvitation:
    row = session.scalar(
        select(BGroupInvitation)
        .where(BGroupInvitation.id == invitation_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None:
        raise ApiError(404, "INVITATION_NOT_FOUND", "邀请不存在。")
    return row


def respond_invitation(
    session: Session, user: User, invitation_id: UUID, command: RespondInvitation, request=None
):
    row = session.get(BGroupInvitation, invitation_id)
    if row is None or row.invitee_id != user.id:
        raise ApiError(404, "INVITATION_NOT_FOUND", "邀请不存在。")
    course = _course(session, row.course_id)
    _require_course_student(session, user, course.id, lock=True)
    group = _group(session, row.group_id, lock=True)
    row = _lock_invitation(session, invitation_id)
    require_version(row.lock_version, command.expected_version)
    if row.status != "pending":
        raise ApiError(409, "INVITATION_CLOSED", "这条邀请已经处理过或在等待老师审批。")
    if command.accept:
        _add_member(session, group, course, user.id, check_deadline=True)
    row.status = "accepted" if command.accept else "declined"
    row.decided_by = user.id
    row.decided_at = now()
    row.lock_version += 1
    session.flush()
    verb = "接受" if command.accept else "拒绝"
    notify(
        session,
        recipient=row.inviter_id,
        category="course",
        title=f"{user.name or '同学'}{verb}了加入「{group.name}」的邀请",
        target={"kind": "course", "id": course.id, "course_id": course.id},
        dedupe_key=f"b:group-invite-response:{row.id}",
    )
    record_audit(
        session,
        actor=user,
        action=f"group.invitation.{row.status}",
        target=("group_invitation", row.id),
        course_id=course.id,
        after={"status": row.status},
        request=request,
    )
    return _invitation_dto(session, row)


def decide_invitation(
    session: Session, user: User, invitation_id: UUID, command: DecideInvitation, request=None
):
    row = session.get(BGroupInvitation, invitation_id)
    if row is None:
        raise ApiError(404, "INVITATION_NOT_FOUND", "邀请不存在。")
    permissions.require_course_teacher(session, user, row.course_id)
    course = _course(session, row.course_id)
    invitee = session.get(User, row.invitee_id)
    if command.decision == "approve":
        _require_course_student(session, invitee, course.id, lock=True)
    group = _group(session, row.group_id, lock=True)
    row = _lock_invitation(session, invitation_id)
    require_version(row.lock_version, command.expected_version)
    if row.status != "awaiting_teacher":
        raise ApiError(409, "INVITATION_CLOSED", "这条邀请不需要老师审批或已处理。")
    reason = command.reason.strip() if command.reason else None
    if command.decision == "reject":
        reason = require_reason(command.reason)
    else:
        if course.status != "active":
            raise ApiError(409, "COURSE_CLOSED", "课程已经结束。")
        _add_member(session, group, course, invitee.id, check_deadline=False)
    row.status = "approved" if command.decision == "approve" else "rejected"
    row.decided_by = user.id
    row.decided_at = now()
    row.decision_reason = reason
    row.lock_version += 1
    session.flush()
    close_action_items_by_source(
        session,
        invitation_source_key(row.id),
        status="completed" if command.decision == "approve" else "rejected",
        actor=user,
    )
    approved = command.decision == "approve"
    for recipient in {row.invitee_id, row.inviter_id}:
        notify(
            session,
            recipient=recipient,
            category="course",
            title=(
                f"老师已批准 {invitee.name or '同学'} 加入「{group.name}」"
                if approved
                else f"老师未批准 {invitee.name or '同学'} 加入「{group.name}」"
            ),
            description="" if approved else f"原因：{reason}",
            target={"kind": "course", "id": course.id, "course_id": course.id},
            dedupe_key=f"b:group-invite-decision:{row.id}",
        )
    record_audit(
        session,
        actor=user,
        action=f"group.invitation.{row.status}",
        target=("group_invitation", row.id),
        course_id=course.id,
        after={"status": row.status, "invitee_id": row.invitee_id},
        reason=reason,
        request=request,
    )
    return _invitation_dto(session, row)


def course_invitations_awaiting_teacher(session: Session, user: User, course_id: UUID):
    _course(session, course_id)
    permissions.require_course_staff(session, user, course_id)
    rows = session.scalars(
        select(BGroupInvitation)
        .where(
            BGroupInvitation.course_id == course_id, BGroupInvitation.status == "awaiting_teacher"
        )
        .order_by(BGroupInvitation.created_at)
    ).all()
    return [_invitation_dto(session, row) for row in rows]


# ---------------------------------------------------------------- B2-05


def start_leader_change(
    session: Session, user: User, group_id: UUID, command: StartLeaderChange, request=None
):
    group = _group(session, group_id, lock=True)
    course = _course(session, group.course_id)
    if _current_member(session, group.id, user.id) is None:
        raise ApiError(403, "GROUP_MEMBER_REQUIRED", "只有本组成员可以发起更换组长。")
    if course.status != "active":
        raise ApiError(409, "COURSE_CLOSED", "课程已经结束。")
    reason = require_reason(command.reason)
    if _current_member(session, group.id, command.candidate_id) is None:
        raise ApiError(
            422, "CANDIDATE_NOT_MEMBER", "候选人必须是本组成员。", details={"field": "candidate_id"}
        )
    if command.candidate_id == group.leader_id:
        raise ApiError(
            422, "CANDIDATE_IS_LEADER", "候选人已经是组长。", details={"field": "candidate_id"}
        )
    if session.scalar(
        select(BLeaderChangeRequest.id).where(
            BLeaderChangeRequest.group_id == group.id, BLeaderChangeRequest.status == "pending"
        )
    ):
        raise ApiError(409, "LEADER_CHANGE_PENDING", "本组已有一个正在确认的组长变更。")
    required = [str(m.user_id) for m in _members(session, group.id) if m.user_id != user.id]
    row = BLeaderChangeRequest(
        group_id=group.id,
        requested_by=user.id,
        previous_leader_id=group.leader_id,
        candidate_id=command.candidate_id,
        reason=reason,
        required_user_ids=required,
    )
    session.add(row)
    session.flush()
    candidate = session.get(User, command.candidate_id)
    for uid in required:
        create_action_item(
            session,
            recipient=UUID(uid),
            category="course",
            title=f"请确认：「{group.name}」组长改为 {candidate.name or '组员'}",
            description=f"发起人：{user.name or ''}。原因：{reason}",
            target={"kind": "course", "id": course.id, "course_id": course.id},
            source_key=leader_change_source_key(row.id),
        )
    record_audit(
        session,
        actor=user,
        action="group.leader_change.requested",
        target=("leader_change_request", row.id),
        course_id=course.id,
        after={"candidate_id": command.candidate_id, "required": required},
        reason=reason,
        request=request,
    )
    return _leader_change_dto(session, row)


def _set_leader(session: Session, group: ProjectGroup, new_leader: UUID) -> None:
    group.leader_id = new_leader
    group.lock_version += 1
    for m in _members(session, group.id):
        m.role = "leader" if m.user_id == new_leader else "member"
    project = session.scalar(select(Project).where(Project.group_id == group.id))
    if project is not None:
        for pm in session.scalars(
            select(ProjectMember).where(
                ProjectMember.project_id == project.id, ProjectMember.left_at.is_(None)
            )
        ):
            pm.role = "leader" if pm.user_id == new_leader else "member"
    session.flush()


def confirm_leader_change(
    session: Session, user: User, request_id: UUID, command: ConfirmLeaderChange, request=None
):
    row = session.get(BLeaderChangeRequest, request_id)
    if row is None:
        raise ApiError(404, "LEADER_CHANGE_NOT_FOUND", "组长变更申请不存在。")
    group = _group(session, row.group_id, lock=True)
    row = session.scalar(
        select(BLeaderChangeRequest)
        .where(BLeaderChangeRequest.id == request_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if str(user.id) not in row.required_user_ids:
        raise ApiError(403, "NOT_A_CONFIRMER", "你不需要确认这条组长变更。")
    if session.scalar(
        select(BLeaderChangeConfirmation.id).where(
            BLeaderChangeConfirmation.request_id == row.id,
            BLeaderChangeConfirmation.user_id == user.id,
        )
    ):
        raise ApiError(409, "ALREADY_CONFIRMED", "你已经确认过了。")
    if row.status != "pending":
        raise ApiError(409, "LEADER_CHANGE_CLOSED", "这条组长变更已经结束。")
    if _current_member(session, group.id, user.id) is None:
        raise ApiError(403, "GROUP_MEMBER_REQUIRED", "你已不在本组。")
    session.add(
        BLeaderChangeConfirmation(request_id=row.id, user_id=user.id, decision=command.decision)
    )
    session.flush()
    course = _course(session, group.course_id)
    target = {"kind": "course", "id": course.id, "course_id": course.id}
    if command.decision == "reject":
        row.status = "rejected"
        row.completed_at = now()
        row.lock_version += 1
        close_action_items_by_source(
            session, leader_change_source_key(row.id), status="rejected", actor=user
        )
        notify(
            session,
            recipient=row.requested_by,
            category="course",
            title=f"「{group.name}」组长变更未通过：{user.name or '组员'} 拒绝了",
            target=target,
            dedupe_key=f"b:leader-change-result:{row.id}",
        )
    else:
        # Close only this confirmer's item; others still owe a confirmation.
        item = session.scalar(
            select(ActionItem).where(
                ActionItem.recipient_id == user.id,
                ActionItem.source_key == leader_change_source_key(row.id),
            )
        )
        if item is not None and item.status == "pending":
            item.status = "completed"
            item.closed_at = now()
            item.closed_by = user.id
        confirmed = {
            str(uid)
            for uid in session.scalars(
                select(BLeaderChangeConfirmation.user_id).where(
                    BLeaderChangeConfirmation.request_id == row.id,
                    BLeaderChangeConfirmation.decision == "confirm",
                )
            )
        }
        if set(row.required_user_ids) <= confirmed:
            if _current_member(session, group.id, row.candidate_id) is None:
                raise ApiError(409, "CANDIDATE_NOT_MEMBER", "候选人已不在本组，变更无法完成。")
            _set_leader(session, group, row.candidate_id)
            row.status = "approved"
            row.completed_at = now()
            row.lock_version += 1
            candidate = session.get(User, row.candidate_id)
            for m in _members(session, group.id):
                notify(
                    session,
                    recipient=m.user_id,
                    category="course",
                    title=f"「{group.name}」的组长已更换为 {candidate.name or '组员'}",
                    target=target,
                    dedupe_key=f"b:leader-change-result:{row.id}",
                )
            record_audit(
                session,
                actor=user,
                action="group.leader.changed",
                target=("group", group.id),
                course_id=course.id,
                before={"leader_id": row.previous_leader_id},
                after={"leader_id": row.candidate_id},
                reason=row.reason,
                request=request,
            )
    session.flush()
    record_audit(
        session,
        actor=user,
        action=f"group.leader_change.{command.decision}",
        target=("leader_change_request", row.id),
        course_id=course.id,
        after={"status": row.status},
        request=request,
    )
    return _leader_change_dto(session, row)
