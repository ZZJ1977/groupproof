"""B-1: my courses (B1-01), invite preview (B1-02) and joining (B1-03).

Rules:
* A student sees only courses with a current ``course_members`` row; any other
  course ID is 404, whether it exists or not.
* The invite code is validated by C (``resolve_course_invite``), which also locks
  the course row so it cannot end between validation and B's commit.
* Direct mode writes ``course_members`` at once. Approval mode writes a pending
  ``b_course_join_requests`` row and an A4-03 action item for each course teacher;
  membership is written only when a teacher approves.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.auth.models import SchoolEmailBinding
from app.db.models import (
    Course,
    CourseMember,
    CourseStaff,
    GroupMember,
    Project,
    ProjectGroup,
    User,
)
from app.modules.a import permissions
from app.modules.a.audit import record_audit
from app.modules.a.inbox import close_action_items_by_source, create_action_item, notify
from app.modules.a.models import ActionItem
from app.modules.b.common import now, require_reason, require_version
from app.modules.b.courses_schemas import (
    CoursePreviewDTO,
    DecideJoin,
    JoinCourse,
    JoinPolicyDTO,
    JoinRequestDTO,
    JoinRequestFilters,
    JoinRequestPageDTO,
    JoinResultDTO,
    MyCourseDTO,
    MyCourseFilters,
    MyCoursePageDTO,
    PendingJoinDTO,
    PersonDTO,
    RefDTO,
    SetJoinPolicy,
)
from app.modules.b.models import BCourseJoinPolicy, BCourseJoinRequest
from app.modules.c.governance_course_service import resolve_course_invite
from app.modules.c.governance_models import CourseInvite


def invite_not_found() -> ApiError:
    return ApiError(404, "COURSE_INVITE_NOT_FOUND", "邀请码不存在或已失效，请向老师确认。")


def already_member() -> ApiError:
    return ApiError(409, "ALREADY_MEMBER", "你已经是这门课程的成员。")


def join_pending() -> ApiError:
    return ApiError(409, "JOIN_REQUEST_PENDING", "你的加入申请正在等待老师审批。")


def join_source_key(request_id: UUID) -> str:
    return f"b:course-join:{request_id}"


# ---------------------------------------------------------------- shared reads


def _current_membership(session: Session, user_id: UUID, course_id: UUID) -> CourseMember | None:
    return session.scalar(
        select(CourseMember)
        .where(
            CourseMember.course_id == course_id,
            CourseMember.user_id == user_id,
            CourseMember.left_at.is_(None),
        )
        .execution_options(populate_existing=True)
    )


def _pending_request(session: Session, user_id: UUID, course_id: UUID) -> BCourseJoinRequest | None:
    return session.scalar(
        select(BCourseJoinRequest).where(
            BCourseJoinRequest.course_id == course_id,
            BCourseJoinRequest.user_id == user_id,
            BCourseJoinRequest.status == "pending",
        )
    )


def join_mode(session: Session, course_id: UUID) -> str:
    policy = session.get(BCourseJoinPolicy, course_id)
    return policy.mode if policy else "direct"


def _teacher_ids(session: Session, course: Course) -> list[UUID]:
    staff = session.scalars(
        select(CourseStaff.user_id)
        .join(User, User.id == CourseStaff.user_id)
        .where(
            CourseStaff.course_id == course.id,
            CourseStaff.role == "teacher",
            CourseStaff.left_at.is_(None),
            User.status == "active",
        )
    ).all()
    return list(dict.fromkeys([course.owner_id, *staff]))


def _person(session: Session, user_id: UUID | None) -> PersonDTO | None:
    if user_id is None:
        return None
    user = session.get(User, user_id)
    return PersonDTO(id=user.id, name=user.name) if user else None


def _require_student(session: Session, user: User) -> None:
    if user.global_role != "student":
        raise ApiError(403, "STUDENT_ONLY", "只有学生账号可以通过邀请码加入课程。")
    verified = session.scalar(
        select(SchoolEmailBinding.verified_at).where(SchoolEmailBinding.user_id == user.id)
    )
    if verified is None:
        raise ApiError(
            403,
            "EMAIL_NOT_VERIFIED",
            "请先完成学校邮箱验证，再加入课程。",
            details={"action": "/account/verify-email"},
        )


def _closed_course_for(session: Session, code: str) -> Course | None:
    """C reports every unusable code as not found; B tells students when the
    code was real but its course has ended, so they know to ask the teacher."""
    invite = session.scalar(select(CourseInvite).where(CourseInvite.code == code))
    if invite is None:
        return None
    course = session.get(Course, invite.course_id)
    return course if course is not None and course.status == "ended" else None


def _resolve(session: Session, code: str) -> Course:
    code = code.strip()
    closed = _closed_course_for(session, code)
    if closed is not None:
        raise ApiError(
            409, "COURSE_CLOSED", "这门课程已经结束，不能再加入。", details={"course": closed.name}
        )
    try:
        course_id = resolve_course_invite(session, code)
    except ApiError as exc:
        if exc.code == "COURSE_INVITE_NOT_FOUND":
            raise invite_not_found() from exc
        raise
    return session.get(Course, course_id)


# ---------------------------------------------------------------- B1-01


def _course_dto(session: Session, user: User, member: CourseMember, course: Course, pending: int):
    group = session.scalar(
        select(ProjectGroup)
        .join(GroupMember, GroupMember.group_id == ProjectGroup.id)
        .where(
            ProjectGroup.course_id == course.id,
            GroupMember.user_id == user.id,
            GroupMember.left_at.is_(None),
        )
    )
    project = session.scalar(select(Project).where(Project.group_id == group.id)) if group else None
    return MyCourseDTO(
        id=course.id,
        code=course.code,
        name=course.name,
        semester=course.semester,
        college=course.college,
        status=course.status,
        role=member.role,
        joined_at=member.joined_at,
        teacher=_person(session, course.owner_id),
        formation_deadline=course.formation_deadline,
        project_deadline=course.project_deadline,
        group=RefDTO(id=group.id, name=group.name) if group else None,
        project=RefDTO(id=project.id, name=project.name) if project else None,
        pending_count=pending,
    )


def _pending_counts(session: Session, user: User) -> dict[str, int]:
    """Pending A4-03 items per course, attributing project targets to their course."""
    items = session.scalars(
        select(ActionItem.target_json).where(
            ActionItem.recipient_id == user.id, ActionItem.status == "pending"
        )
    ).all()
    project_ids = {t.get("project_id") for t in items if t and t.get("project_id")}
    project_course = (
        {
            str(pid): str(cid)
            for pid, cid in session.execute(
                select(Project.id, Project.course_id).where(
                    Project.id.in_([UUID(p) for p in project_ids])
                )
            )
        }
        if project_ids
        else {}
    )
    counts: dict[str, int] = {}
    for target in items:
        if not target:
            continue
        course_id = target.get("course_id") or project_course.get(str(target.get("project_id")))
        if course_id:
            counts[str(course_id)] = counts.get(str(course_id), 0) + 1
    return counts


def my_courses(session: Session, user: User, filters: MyCourseFilters) -> MyCoursePageDTO:
    base = (
        select(CourseMember, Course)
        .join(Course, Course.id == CourseMember.course_id)
        .where(CourseMember.user_id == user.id, CourseMember.left_at.is_(None))
    )
    counts = {"all": 0, "active": 0, "ended": 0}
    for status, total in session.execute(
        select(Course.status, func.count())
        .join(CourseMember, CourseMember.course_id == Course.id)
        .where(CourseMember.user_id == user.id, CourseMember.left_at.is_(None))
        .group_by(Course.status)
    ):
        counts["all"] += total
        if status in counts:
            counts[status] += total
    query = base
    if filters.tab != "all":
        query = query.where(Course.status == filters.tab)
    if filters.q and filters.q.strip():
        like = f"%{filters.q.strip()}%"
        query = query.where(or_(Course.name.ilike(like), Course.code.ilike(like)))
    total = session.scalar(select(func.count()).select_from(query.subquery())) or 0
    rows = session.execute(
        query.order_by(Course.status.asc(), CourseMember.joined_at.desc(), Course.id)
        .offset((filters.page - 1) * filters.page_size)
        .limit(filters.page_size)
    ).all()
    pending = _pending_counts(session, user)
    pending_joins = session.execute(
        select(BCourseJoinRequest, Course.name)
        .join(Course, Course.id == BCourseJoinRequest.course_id)
        .where(BCourseJoinRequest.user_id == user.id, BCourseJoinRequest.status == "pending")
        .order_by(BCourseJoinRequest.created_at.desc())
    ).all()
    return MyCoursePageDTO(
        items=[
            _course_dto(session, user, member, course, pending.get(str(course.id), 0))
            for member, course in rows
        ],
        total=total,
        page=filters.page,
        page_size=filters.page_size,
        counts=counts,
        pending_joins=[
            PendingJoinDTO(
                request_id=r.id, course_id=r.course_id, course_name=name, created_at=r.created_at
            )
            for r, name in pending_joins
        ],
    )


def my_course(session: Session, user: User, course_id: UUID) -> MyCourseDTO:
    member = _current_membership(session, user.id, course_id)
    if member is None:
        raise ApiError(404, "COURSE_NOT_FOUND", "课程不存在或你不是该课程成员。")
    course = session.get(Course, course_id)
    pending = _pending_counts(session, user).get(str(course_id), 0)
    return _course_dto(session, user, member, course, pending)


# ---------------------------------------------------------------- B1-02


def preview(session: Session, user: User, code: str) -> CoursePreviewDTO:
    _require_student(session, user)
    course = _resolve(session, code)
    pending = _pending_request(session, user.id, course.id)
    return CoursePreviewDTO(
        course_id=course.id,
        code=course.code,
        name=course.name,
        semester=course.semester,
        college=course.college,
        teacher=_person(session, course.owner_id),
        grouping_mode=course.grouping_mode,
        min_group_size=course.min_group_size,
        max_group_size=course.max_group_size,
        formation_deadline=course.formation_deadline,
        project_deadline=course.project_deadline,
        join_mode=join_mode(session, course.id),  # type: ignore[arg-type]
        already_member=_current_membership(session, user.id, course.id) is not None,
        pending_request_id=pending.id if pending else None,
    )


# ---------------------------------------------------------------- B1-03


def join(session: Session, user: User, command: JoinCourse, request=None) -> JoinResultDTO:
    _require_student(session, user)
    course = _resolve(session, command.invite_code)
    if _current_membership(session, user.id, course.id) is not None:
        raise already_member()
    if _pending_request(session, user.id, course.id) is not None:
        raise join_pending()

    if join_mode(session, course.id) == "direct":
        member = CourseMember(course_id=course.id, user_id=user.id, role="student")
        session.add(member)
        session.flush()
        record_audit(
            session,
            actor=user,
            action="course.member.joined",
            target=("course_member", member.id),
            course_id=course.id,
            after={"user_id": user.id, "mode": "direct"},
            request=request,
        )
        return JoinResultDTO(status="joined", course_id=course.id)

    row = BCourseJoinRequest(
        course_id=course.id, user_id=user.id, message=(command.message or "").strip() or None
    )
    session.add(row)
    session.flush()
    for teacher_id in _teacher_ids(session, course):
        create_action_item(
            session,
            recipient=teacher_id,
            category="member",
            title=f"{user.name or user.email} 申请加入《{course.name}》",
            description=row.message or "",
            target={"kind": "member_change", "id": row.id, "course_id": course.id},
            priority="medium",
            source_key=join_source_key(row.id),
        )
    record_audit(
        session,
        actor=user,
        action="course.join_request.created",
        target=("course_join_request", row.id),
        course_id=course.id,
        after={"user_id": user.id, "status": "pending"},
        request=request,
    )
    return JoinResultDTO(status="pending", course_id=course.id, request_id=row.id)


def join_conflict_error(session: Session, user: User, code: str) -> ApiError:
    """Which duplicate a concurrent join most likely hit (for the 409 message)."""
    invite = session.scalar(select(CourseInvite).where(CourseInvite.code == code.strip()))
    if invite and join_mode(session, invite.course_id) == "approval":
        return join_pending()
    return already_member()


# ---------------------------------------------------------------- teacher side


def _require_course(session: Session, course_id: UUID) -> Course:
    course = session.get(Course, course_id)
    if course is None:
        raise ApiError(404, "COURSE_NOT_FOUND", "课程不存在。")
    return course


def _request_dto(session: Session, row: BCourseJoinRequest) -> JoinRequestDTO:
    student = session.get(User, row.user_id)
    return JoinRequestDTO(
        id=row.id,
        course_id=row.course_id,
        student=PersonDTO(id=student.id, name=student.name),
        student_email=student.email,
        student_number=student.student_id,
        status=row.status,
        message=row.message,
        created_at=row.created_at,
        decided_by=row.decided_by,
        decided_at=row.decided_at,
        decision_reason=row.decision_reason,
        lock_version=row.lock_version,
    )


def list_join_requests(
    session: Session, user: User, course_id: UUID, filters: JoinRequestFilters
) -> JoinRequestPageDTO:
    _require_course(session, course_id)
    permissions.require_course_staff(session, user, course_id)
    query = select(BCourseJoinRequest).where(BCourseJoinRequest.course_id == course_id)
    if filters.status != "all":
        query = query.where(BCourseJoinRequest.status == filters.status)
    total = session.scalar(select(func.count()).select_from(query.subquery())) or 0
    rows = session.scalars(
        query.order_by(BCourseJoinRequest.created_at.asc(), BCourseJoinRequest.id)
        .offset((filters.page - 1) * filters.page_size)
        .limit(filters.page_size)
    ).all()
    return JoinRequestPageDTO(
        items=[_request_dto(session, row) for row in rows],
        total=total,
        page=filters.page,
        page_size=filters.page_size,
    )


def decide_join(
    session: Session, user: User, request_id: UUID, command: DecideJoin, request=None
) -> JoinRequestDTO:
    row = session.scalar(
        select(BCourseJoinRequest)
        .where(BCourseJoinRequest.id == request_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None:
        raise ApiError(404, "JOIN_REQUEST_NOT_FOUND", "加入申请不存在。")
    permissions.require_course_teacher(session, user, row.course_id)
    require_version(row.lock_version, command.expected_version)
    if row.status != "pending":
        raise ApiError(409, "JOIN_REQUEST_DECIDED", "这条申请已经处理过了。")
    course = session.get(Course, row.course_id)
    reason = command.reason.strip() if command.reason else None
    if command.decision == "reject":
        reason = require_reason(command.reason)
    elif course.status != "active":
        raise ApiError(409, "COURSE_CLOSED", "课程已经结束，不能再批准加入。")

    before = {"status": row.status}
    row.status = "approved" if command.decision == "approve" else "rejected"
    row.decided_by = user.id
    row.decided_at = now()
    row.decision_reason = reason
    row.lock_version += 1
    if (
        command.decision == "approve"
        and _current_membership(session, row.user_id, course.id) is None
    ):
        session.add(CourseMember(course_id=course.id, user_id=row.user_id, role="student"))
    session.flush()
    close_action_items_by_source(
        session,
        join_source_key(row.id),
        status="completed" if command.decision == "approve" else "rejected",
        actor=user,
    )
    approved = command.decision == "approve"
    notify(
        session,
        recipient=row.user_id,
        category="course",
        title=f"你已加入《{course.name}》" if approved else f"加入《{course.name}》的申请未通过",
        description="" if approved else f"原因：{reason}",
        target={"kind": "course", "id": course.id, "course_id": course.id},
        dedupe_key=f"b:course-join-decision:{row.id}",
    )
    record_audit(
        session,
        actor=user,
        action=f"course.join_request.{row.status}",
        target=("course_join_request", row.id),
        course_id=course.id,
        before=before,
        after={"status": row.status, "user_id": row.user_id},
        reason=reason,
        request=request,
    )
    return _request_dto(session, row)


def get_join_policy(session: Session, user: User, course_id: UUID) -> JoinPolicyDTO:
    _require_course(session, course_id)
    permissions.require_course_staff(session, user, course_id)
    policy = session.get(BCourseJoinPolicy, course_id)
    return JoinPolicyDTO(
        course_id=course_id,
        mode=policy.mode if policy else "direct",  # type: ignore[arg-type]
        lock_version=policy.lock_version if policy else 0,
    )


def set_join_policy(
    session: Session, user: User, course_id: UUID, command: SetJoinPolicy, request=None
) -> JoinPolicyDTO:
    course = _require_course(session, course_id)
    permissions.require_course_teacher(session, user, course_id)
    if course.status == "ended":
        raise ApiError(409, "COURSE_CLOSED", "课程已经结束，不能修改加入方式。")
    policy = session.scalar(
        select(BCourseJoinPolicy)
        .where(BCourseJoinPolicy.course_id == course_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    require_version(policy.lock_version if policy else 0, command.expected_version)
    before = policy.mode if policy else "direct"
    if policy is None:
        policy = BCourseJoinPolicy(course_id=course_id, mode=command.mode, lock_version=1)
        session.add(policy)
    else:
        policy.mode = command.mode
        policy.lock_version += 1
    policy.updated_by = user.id
    policy.updated_at = now()
    session.flush()
    record_audit(
        session,
        actor=user,
        action="course.join_policy.updated",
        target=("course", course_id),
        course_id=course_id,
        before={"mode": before},
        after={"mode": command.mode},
        request=request,
    )
    return JoinPolicyDTO(course_id=course_id, mode=policy.mode, lock_version=policy.lock_version)  # type: ignore[arg-type]
