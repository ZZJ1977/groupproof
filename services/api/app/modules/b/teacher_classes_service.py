"""Teacher class management, student roster, team plaza, and milestone-backed progress."""

from __future__ import annotations

import secrets
from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
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
from app.modules.a.inbox import notify
from app.modules.b import groups_service, membership_service
from app.modules.b.common import now, require_reason, require_version
from app.modules.b.courses_service import join_mode
from app.modules.b.milestones_schemas import MilestoneDTO
from app.modules.b.milestones_service import milestone_briefs
from app.modules.b.models import (
    BAnnouncementRead,
    BCourseAnnouncement,
    BCourseAppeal,
    BCourseAppealDecision,
    BCourseFileFolder,
    BCourseJoinPolicy,
    BCourseJoinRequest,
    BCourseMaterialItem,
    BCourseMaterialVersion,
    BCourseProjectTemplate,
    BCourseRuleVersion,
)
from app.modules.b.teacher_classes_schemas import (
    ArchiveClass,
    Assign,
    AssignResultDTO,
    ClassDetailDTO,
    ClassSettingsDTO,
    ClassTab,
    CreateClass,
    DeleteClassResultDTO,
    EndClass,
    GroupProgressDTO,
    GroupRefDTO,
    MilestoneRefDTO,
    PlazaDTO,
    PlazaGroupDTO,
    PlazaMemberDTO,
    ProjectRefDTO,
    RemoveStudent,
    ReopenClass,
    RiskLevel,
    RosterDTO,
    RosterFilter,
    RosterStudentDTO,
    RotateInvite,
    SetLeader,
    TeacherClassPageDTO,
    TeacherClassSummaryDTO,
    TeacherCreateGroup,
    TeacherGroupDetailDTO,
    TeacherGroupMemberDTO,
    UpdateSettings,
)
from app.modules.b.teacher_permissions import (
    has_staff_permission,
    require_course_owner,
    require_staff_permission,
)
from app.modules.c.governance_course_service import course_data, require_teacher, reserve_code
from app.modules.c.governance_models import (
    CourseCodeRegistry,
    CourseInvite,
    CourseLifecycleDecision,
)

CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def _initial(user: User) -> str:
    for text in (user.name, user.email):
        if text and text.strip():
            return text.strip()[0].upper()
    return "?"


def _course(session: Session, course_id: UUID, *, lock: bool = False) -> Course:
    query = select(Course).where(Course.id == course_id)
    if lock:
        query = query.with_for_update()
    course = session.scalar(query.execution_options(populate_existing=True))
    if course is None:
        raise ApiError(404, "COURSE_NOT_FOUND", "班级不存在。")
    return course


def _require_active_course(course: Course) -> None:
    if course.status != "active":
        raise ApiError(409, "COURSE_NOT_ACTIVE", "班级已结束或未生效，不能执行此操作。")


def _auto_course_code(session: Session) -> str:
    for _ in range(10):
        candidate = "CLS-" + "".join(secrets.choice(CODE_ALPHABET) for _ in range(6))
        key = candidate.lower()
        exists = session.scalar(
            select(Course.id).where(func.lower(func.trim(Course.code)) == key).limit(1)
        )
        claimed = session.get(CourseCodeRegistry, key)
        if exists is None and claimed is None:
            return candidate
    raise ApiError(409, "COURSE_CODE_CONFLICT", "自动生成课程编号冲突，请重试或手动填写。")


def _class_counts(
    session: Session, course_ids: list[UUID]
) -> tuple[dict[UUID, int], dict[UUID, int], dict[UUID, int], dict[UUID, int]]:
    if not course_ids:
        return {}, {}, {}, {}
    students = dict(
        session.execute(
            select(CourseMember.course_id, func.count())
            .join(User, User.id == CourseMember.user_id)
            .where(
                CourseMember.course_id.in_(course_ids),
                CourseMember.left_at.is_(None),
                CourseMember.role == "student",
                CourseMember.status == "active",
                User.status == "active",
            )
            .group_by(CourseMember.course_id)
        ).all()
    )
    groups = dict(
        session.execute(
            select(ProjectGroup.course_id, func.count())
            .where(ProjectGroup.course_id.in_(course_ids))
            .group_by(ProjectGroup.course_id)
        ).all()
    )
    grouped = dict(
        session.execute(
            select(ProjectGroup.course_id, func.count(func.distinct(GroupMember.user_id)))
            .join(GroupMember, GroupMember.group_id == ProjectGroup.id)
            .join(
                CourseMember,
                (CourseMember.course_id == ProjectGroup.course_id)
                & (CourseMember.user_id == GroupMember.user_id),
            )
            .join(User, User.id == GroupMember.user_id)
            .where(
                ProjectGroup.course_id.in_(course_ids),
                GroupMember.left_at.is_(None),
                CourseMember.left_at.is_(None),
                CourseMember.role == "student",
                CourseMember.status == "active",
                User.status == "active",
            )
            .group_by(ProjectGroup.course_id)
        ).all()
    )
    pending = dict(
        session.execute(
            select(BCourseJoinRequest.course_id, func.count())
            .where(
                BCourseJoinRequest.course_id.in_(course_ids),
                BCourseJoinRequest.status == "pending",
            )
            .group_by(BCourseJoinRequest.course_id)
        ).all()
    )
    return students, groups, grouped, pending


def _summary_dto(
    course: Course,
    student_count: int,
    group_count: int,
    grouped_count: int,
    pending_count: int,
) -> TeacherClassSummaryDTO:
    return TeacherClassSummaryDTO(
        id=course.id,
        code=course.code,
        name=course.name,
        semester=course.semester,
        college=course.college,
        status=course.status,
        student_count=student_count,
        group_count=group_count,
        ungrouped_count=max(0, student_count - grouped_count),
        pending_join_count=pending_count,
        href=f"/teacher/courses/{course.id}",
    )


def class_detail(session: Session, user: User, course: Course) -> ClassDetailDTO:
    students, groups, grouped, pending = _class_counts(session, [course.id])
    summary = _summary_dto(
        course,
        students.get(course.id, 0),
        groups.get(course.id, 0),
        grouped.get(course.id, 0),
        pending.get(course.id, 0),
    )
    invite = session.get(CourseInvite, course.id, populate_existing=True)
    active_code = invite.code if invite and invite.revoked_at is None else None
    mode = join_mode(session, course.id)
    return ClassDetailDTO(
        **summary.model_dump(),
        invite_code=active_code,
        join_url=f"/courses/join?code={active_code}" if active_code else None,
        join_mode="approval" if mode == "approval" else "direct",
        project_deadline=course.project_deadline,
        formation_deadline=course.formation_deadline,
        min_group_size=course.min_group_size,
        max_group_size=course.max_group_size,
        lock_version=course.lock_version,
        can_manage=permissions.is_course_teacher(session, user, course.id),
    )


def list_classes(
    session: Session, user: User, tab: ClassTab = "all", q: str | None = None
) -> TeacherClassPageDTO:
    permissions.require_active(user)
    if user.global_role not in {"teacher", "ta"}:
        raise ApiError(403, "FORBIDDEN", "只有教师或助教可以查看所教班级。")
    staff_courses = select(CourseStaff.course_id).where(
        CourseStaff.user_id == user.id, CourseStaff.left_at.is_(None)
    )
    scope = or_(Course.owner_id == user.id, Course.id.in_(staff_courses))
    counts = {"all": 0, "active": 0, "ended": 0}
    for status, total in session.execute(
        select(Course.status, func.count()).where(scope).group_by(Course.status)
    ):
        counts["all"] += total
        if status in counts:
            counts[status] += total
    query = select(Course).where(scope)
    if tab == "active":
        query = query.where(Course.status == "active", Course.archived_at.is_(None))
    elif tab != "all":
        query = query.where(Course.status == tab)
    if q and q.strip():
        like = f"%{q.strip()}%"
        query = query.where(or_(Course.name.ilike(like), Course.code.ilike(like)))
    rows = list(
        session.scalars(query.order_by(Course.status.asc(), Course.created_at.desc(), Course.id))
    )
    cids = [c.id for c in rows]
    students, groups, grouped, pending = _class_counts(session, cids)
    return TeacherClassPageDTO(
        items=[
            _summary_dto(
                c,
                students.get(c.id, 0),
                groups.get(c.id, 0),
                grouped.get(c.id, 0),
                pending.get(c.id, 0),
            )
            for c in rows
        ],
        counts=counts,
    )


def create_class(
    session: Session, user: User, command: CreateClass, request=None
) -> ClassDetailDTO:
    permissions.require_active(user)
    if user.global_role != "teacher":
        raise ApiError(403, "FORBIDDEN", "只有教师可以创建班级。")
    require_teacher(session, user.id)
    if command.project_deadline <= now():
        raise ApiError(
            422,
            "COURSE_DEADLINE_INVALID",
            "项目截止时间必须晚于当前时间。",
            details={"field": "project_deadline"},
        )
    code = (
        command.code.strip()
        if command.code and command.code.strip()
        else _auto_course_code(session)
    )
    duplicate = session.scalar(
        select(Course.id).where(func.lower(func.trim(Course.code)) == code.lower()).limit(1)
    )
    if duplicate is not None:
        raise ApiError(409, "COURSE_CODE_CONFLICT", "该课程编号已存在。", details={"field": "code"})
    course = Course(
        id=uuid4(),
        owner_id=user.id,
        code=code,
        name=command.name.strip(),
        college=command.college.strip(),
        semester=command.semester.strip(),
        status="active",
        project_deadline=command.project_deadline,
        formation_deadline=command.formation_deadline,
        grouping_mode="free",
        min_group_size=command.min_group_size,
        max_group_size=command.max_group_size,
        lock_version=0,
    )
    session.add(course)
    session.flush()
    session.add(CourseStaff(course_id=course.id, user_id=user.id, role="teacher"))
    reserve_code(session, course.code, course.id)
    # Teacher-created classes start directly in active status with an invite code,
    # so only the initial 'create' lifecycle decision is recorded.
    session.add(
        CourseLifecycleDecision(
            course_id=course.id,
            actor_id=user.id,
            version_no=0,
            action="create",
            reason="教师创建班级",
            before_json={},
            after_json=course_data(course),
        )
    )
    session.add(
        CourseInvite(
            course_id=course.id,
            code=secrets.token_urlsafe(24),
            created_by=user.id,
        )
    )
    session.add(
        BCourseJoinPolicy(
            course_id=course.id,
            mode=command.join_mode,
            lock_version=1,
            updated_by=user.id,
            updated_at=now(),
        )
    )
    record_audit(
        session,
        actor=user,
        action="class.created",
        target=("course", course.id),
        course_id=course.id,
        after={"code": course.code, "name": course.name, "join_mode": command.join_mode},
        request=request,
    )
    session.flush()
    return class_detail(session, user, course)


def get_class(session: Session, user: User, course_id: UUID) -> ClassDetailDTO:
    course = _course(session, course_id)
    permissions.require_course_staff(session, user, course_id)
    return class_detail(session, user, course)


def rotate_invite(
    session: Session, user: User, course_id: UUID, command: RotateInvite, request=None
) -> ClassDetailDTO:
    course = _course(session, course_id, lock=True)
    permissions.require_course_teacher(session, user, course_id)
    _require_active_course(course)
    require_version(course.lock_version, command.expected_version)
    invite = session.scalar(
        select(CourseInvite)
        .where(CourseInvite.course_id == course_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    new_code = secrets.token_urlsafe(24)
    if invite is None:
        session.add(CourseInvite(course_id=course_id, code=new_code, created_by=user.id))
    else:
        invite.code = new_code
        invite.revoked_at = None
        invite.created_by = user.id
        invite.created_at = now()
    course.lock_version += 1
    course.updated_at = now()
    session.flush()
    record_audit(
        session,
        actor=user,
        action="class.invite_rotated",
        target=("course", course_id),
        course_id=course_id,
        after={"lock_version": course.lock_version},
        request=request,
    )
    return class_detail(session, user, course)


def roster(
    session: Session,
    user: User,
    course_id: UUID,
    q: str | None = None,
    status: RosterFilter = "all",
) -> RosterDTO:
    _course(session, course_id)
    permissions.require_course_staff(session, user, course_id)
    student_rows = session.execute(
        select(CourseMember, User)
        .join(User, User.id == CourseMember.user_id)
        .where(
            CourseMember.course_id == course_id,
            CourseMember.left_at.is_(None),
            CourseMember.role == "student",
            CourseMember.status == "active",
            User.status == "active",
        )
    ).all()
    group_rows = session.execute(
        select(GroupMember, ProjectGroup)
        .join(ProjectGroup, ProjectGroup.id == GroupMember.group_id)
        .where(ProjectGroup.course_id == course_id, GroupMember.left_at.is_(None))
    ).all()
    group_Ids = [g.id for _, g in group_rows]
    project_group_ids: set[UUID] = set()
    if group_Ids:
        project_group_ids = set(
            session.scalars(
                select(Project.group_id).where(
                    Project.group_id.in_(group_Ids), Project.archived_at.is_(None)
                )
            ).all()
        )
    by_user: dict[UUID, tuple[GroupMember, ProjectGroup]] = {
        gm.user_id: (gm, g) for gm, g in group_rows
    }
    all_items: list[RosterStudentDTO] = []
    for cm, stu in student_rows:
        pair = by_user.get(stu.id)
        grp = pair[1] if pair else None
        is_leader = bool(grp and (grp.leader_id == stu.id or (pair and pair[0].role == "leader")))
        all_items.append(
            RosterStudentDTO(
                id=stu.id,
                name=stu.name,
                student_number=stu.student_id,
                email=stu.email,
                initial=_initial(stu),
                joined_at=cm.joined_at,
                status="grouped" if grp else "ungrouped",
                group=GroupRefDTO(id=grp.id, name=grp.name) if grp else None,
                is_leader=is_leader,
                in_project_group=bool(grp and grp.id in project_group_ids),
            )
        )
    counts = {
        "all": len(all_items),
        "grouped": sum(1 for item in all_items if item.status == "grouped"),
        "ungrouped": sum(1 for item in all_items if item.status == "ungrouped"),
    }
    filtered = all_items
    if status != "all":
        filtered = [item for item in filtered if item.status == status]
    if q and q.strip():
        needle = q.strip().lower()
        filtered = [
            item
            for item in filtered
            if needle in (item.name or "").lower()
            or needle in (item.student_number or "").lower()
            or needle in (item.email or "").lower()
        ]
    filtered.sort(
        key=lambda item: (
            0 if item.status == "ungrouped" else 1,
            (item.name or "").lower(),
            str(item.id),
        )
    )
    pending_count = (
        session.scalar(
            select(func.count())
            .select_from(BCourseJoinRequest)
            .where(
                BCourseJoinRequest.course_id == course_id,
                BCourseJoinRequest.status == "pending",
            )
        )
        or 0
    )
    return RosterDTO(items=filtered, counts=counts, pending_join_count=pending_count)


def remove_student(
    session: Session,
    user: User,
    course_id: UUID,
    student_id: UUID,
    command: RemoveStudent,
    request=None,
) -> RosterStudentDTO:
    course = _course(session, course_id, lock=True)
    permissions.require_course_teacher(session, user, course_id)
    _require_active_course(course)
    reason = require_reason(command.reason)
    member = session.scalar(
        select(CourseMember)
        .where(
            CourseMember.course_id == course_id,
            CourseMember.user_id == student_id,
            CourseMember.role == "student",
            CourseMember.left_at.is_(None),
            CourseMember.status == "active",
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if member is None:
        raise ApiError(404, "STUDENT_NOT_FOUND", "该学生不在本班级中。")
    if groups_service._group_of(session, student_id, course_id) is not None:
        raise ApiError(
            409,
            "STUDENT_IN_GROUP",
            "该学生仍在队伍中，请先在组队广场将其移出队伍。",
        )
    member.left_at = now()
    member.status = "left"
    member.lock_version += 1
    stu = session.get(User, student_id)
    notify(
        session,
        recipient=student_id,
        category="course",
        title=f"你已被移出班级《{course.name}》",
        description=f"原因：{reason}",
        target={"kind": "course", "id": course.id, "course_id": course.id},
        dedupe_key=f"b:class-student-removed:{course.id}:{student_id}:{member.lock_version}",
    )
    record_audit(
        session,
        actor=user,
        action="class.student_removed",
        target=("course_member", member.id),
        course_id=course.id,
        after={"student_id": student_id, "status": "left"},
        reason=reason,
        request=request,
    )
    session.flush()
    return RosterStudentDTO(
        id=student_id,
        name=stu.name if stu else None,
        student_number=stu.student_id if stu else None,
        email=stu.email if stu else None,
        initial=_initial(stu) if stu else "?",
        joined_at=member.joined_at,
        status="left",
        group=None,
        is_leader=False,
        in_project_group=False,
    )


def _group_progress(
    session: Session, project: Project | None
) -> tuple[GroupProgressDTO, list[MilestoneDTO]]:
    if project is None:
        return (
            GroupProgressDTO(
                state="no_project",
                milestones_total=0,
                milestones_completed=0,
                overall_percent=None,
                next_milestone=None,
                overdue_count=0,
                risk_level=None,
            ),
            [],
        )
    briefs = milestone_briefs(session, project.id)
    if not briefs:
        return (
            GroupProgressDTO(
                state="no_milestones",
                milestones_total=0,
                milestones_completed=0,
                overall_percent=None,
                next_milestone=None,
                overdue_count=0,
                risk_level=None,
            ),
            [],
        )
    total = len(briefs)
    completed = sum(1 for m in briefs if m.status == "completed")
    with_tasks = [
        m.progress_percent for m in briefs if m.task_count > 0 and m.progress_percent is not None
    ]
    overall = round(sum(with_tasks) / len(with_tasks)) if with_tasks else None
    incomplete = [m for m in briefs if m.status != "completed"]
    far_future = datetime.max.replace(tzinfo=UTC)
    incomplete.sort(
        key=lambda m: (
            0 if m.deadline is not None else 1,
            (m.deadline if m.deadline.tzinfo else m.deadline.replace(tzinfo=UTC))
            if m.deadline
            else far_future,
        )
    )
    nxt = incomplete[0] if incomplete else None
    next_ref = (
        MilestoneRefDTO(id=nxt.id, title=nxt.title, deadline=nxt.deadline, href=nxt.href)
        if nxt
        else None
    )
    overdue_count = sum(1 for m in briefs if m.overdue)
    rank: dict[str, int] = {"low": 1, "medium": 2, "high": 3}
    levels: list[RiskLevel] = [
        m.risk.level  # type: ignore[misc]
        for m in briefs
        if m.risk is not None and m.risk.level in rank
    ]
    highest: RiskLevel | None = max(levels, key=lambda lv: rank[lv]) if levels else None
    return (
        GroupProgressDTO(
            state="tracking",
            milestones_total=total,
            milestones_completed=completed,
            overall_percent=overall,
            next_milestone=next_ref,
            overdue_count=overdue_count,
            risk_level=highest,
        ),
        briefs,
    )


def _plaza_group_dto(
    session: Session,
    course: Course,
    group: ProjectGroup,
    *,
    project: Project | None = None,
    project_loaded: bool = False,
) -> tuple[PlazaGroupDTO, list[MilestoneDTO]]:
    if not project_loaded:
        project = session.scalar(
            select(Project).where(Project.group_id == group.id, Project.archived_at.is_(None))
        )
    member_rows = session.execute(
        select(GroupMember, User)
        .join(User, User.id == GroupMember.user_id)
        .where(GroupMember.group_id == group.id, GroupMember.left_at.is_(None))
        .order_by(GroupMember.joined_at, GroupMember.user_id)
        .execution_options(populate_existing=True)
    ).all()
    members: list[PlazaMemberDTO] = []
    for gm, u in member_rows:
        is_leader = group.leader_id == u.id or gm.role == "leader"
        members.append(
            PlazaMemberDTO(
                id=u.id,
                name=u.name,
                student_number=u.student_id,
                initial=_initial(u),
                is_leader=is_leader,
            )
        )
    members.sort(key=lambda m: (0 if m.is_leader else 1, (m.name or "").lower(), str(m.id)))
    count = len(members)
    has_project = project is not None
    full = count >= course.max_group_size
    accepts_drop = course.status == "active" and not group.roster_frozen and not full
    locked_reason: str | None = None
    if course.status != "active":
        locked_reason = "班级已结束"
    elif group.roster_frozen:
        locked_reason = "名单已冻结"
    elif full:
        locked_reason = "已满员"
    progress, briefs = _group_progress(session, project)
    dto = PlazaGroupDTO(
        id=group.id,
        name=group.name,
        direction=group.direction,
        leader_id=group.leader_id,
        members=members,
        member_count=count,
        max_group_size=course.max_group_size,
        roster_frozen=group.roster_frozen,
        has_project=has_project,
        project=(
            ProjectRefDTO(id=project.id, name=project.name, href=f"/projects/{project.id}")
            if project
            else None
        ),
        lock_version=group.lock_version,
        accepts_drop=accepts_drop,
        locked_reason=locked_reason,
        members_locked=has_project or group.roster_frozen,
        progress=progress,
        href=f"/teacher/courses/{course.id}/groups/{group.id}",
    )
    return dto, briefs


def plaza(session: Session, user: User, course_id: UUID) -> PlazaDTO:
    course = _course(session, course_id)
    permissions.require_course_staff(session, user, course_id)
    groups = list(
        session.scalars(
            select(ProjectGroup)
            .where(ProjectGroup.course_id == course_id)
            .order_by(ProjectGroup.created_at, ProjectGroup.id)
        )
    )
    gids = [g.id for g in groups]
    projects_by_group: dict[UUID, Project] = {}
    if gids:
        for p in session.scalars(
            select(Project).where(Project.group_id.in_(gids), Project.archived_at.is_(None))
        ):
            if p.group_id is not None:
                projects_by_group[p.group_id] = p
    group_dtos = [
        _plaza_group_dto(
            session,
            course,
            g,
            project=projects_by_group.get(g.id),
            project_loaded=True,
        )[0]
        for g in groups
    ]
    grouped_user_ids = (
        select(GroupMember.user_id)
        .join(ProjectGroup, ProjectGroup.id == GroupMember.group_id)
        .where(ProjectGroup.course_id == course_id, GroupMember.left_at.is_(None))
    )
    ungrouped_users = list(
        session.scalars(
            select(User)
            .join(CourseMember, CourseMember.user_id == User.id)
            .where(
                CourseMember.course_id == course_id,
                CourseMember.left_at.is_(None),
                CourseMember.role == "student",
                CourseMember.status == "active",
                User.status == "active",
                User.id.not_in(grouped_user_ids),
            )
            .order_by(User.name, User.id)
        )
    )
    return PlazaDTO(
        course_id=course_id,
        groups=group_dtos,
        ungrouped=[
            PlazaMemberDTO(
                id=u.id,
                name=u.name,
                student_number=u.student_id,
                initial=_initial(u),
                is_leader=False,
            )
            for u in ungrouped_users
        ],
        formation_deadline=course.formation_deadline,
        formation_open=groups_service.formation_open(course),
        can_manage=has_staff_permission(session, user, course_id, "manage_groups"),
    )


def create_group(
    session: Session, user: User, course_id: UUID, command: TeacherCreateGroup, request=None
) -> PlazaGroupDTO:
    course = _course(session, course_id, lock=True)
    require_staff_permission(session, user, course_id, "manage_groups")
    _require_active_course(course)
    name = command.name.strip()
    if not name:
        raise ApiError(422, "GROUP_NAME_REQUIRED", "请填写队伍名称。", details={"field": "name"})
    if session.scalar(
        select(ProjectGroup.id).where(
            ProjectGroup.course_id == course_id, ProjectGroup.name == name
        )
    ):
        raise ApiError(409, "GROUP_NAME_TAKEN", "本班级已有同名队伍。", details={"field": "name"})
    group = ProjectGroup(
        course_id=course_id,
        leader_id=None,
        name=name,
        direction=(command.direction or "").strip() or None,
    )
    session.add(group)
    session.flush()
    record_audit(
        session,
        actor=user,
        action="group.teacher_created",
        target=("group", group.id),
        course_id=course_id,
        after={"name": name},
        request=request,
    )
    return _plaza_group_dto(session, course, group, project=None, project_loaded=True)[0]


def assign(
    session: Session, user: User, course_id: UUID, command: Assign, request=None
) -> AssignResultDTO:
    course = _course(session, course_id, lock=True)
    require_staff_permission(session, user, course_id, "manage_groups")
    _require_active_course(course)
    member = session.scalar(
        select(CourseMember)
        .where(
            CourseMember.course_id == course_id,
            CourseMember.user_id == command.student_id,
            CourseMember.role == "student",
            CourseMember.left_at.is_(None),
            CourseMember.status == "active",
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if member is None:
        raise ApiError(404, "STUDENT_NOT_FOUND", "该学生不在本班级中。")
    src = groups_service._group_of(session, command.student_id, course_id)
    dst_id = command.to_group_id
    if (src is None and dst_id is None) or (src is not None and dst_id == src.id):
        dto = _plaza_group_dto(session, course, src)[0] if src else None
        return AssignResultDTO(student_id=command.student_id, from_group=dto, to_group=dto)
    locked: dict[UUID, ProjectGroup] = {}
    for gid in sorted({g for g in (src.id if src else None, dst_id) if g is not None}, key=str):
        g = groups_service._group(session, gid, lock=True)
        if g.course_id != course_id:
            raise ApiError(404, "GROUP_NOT_FOUND", "队伍不属于本班级。")
        locked[gid] = g
    src = locked[src.id] if src else None
    dst = locked[dst_id] if dst_id else None
    if src is not None:
        if command.from_group_version is None:
            raise ApiError(
                409,
                "VERSION_CONFLICT",
                "内容已被其他人修改，请刷新后再操作。",
                details={"current_version": src.lock_version},
            )
        require_version(src.lock_version, command.from_group_version)
    if dst is not None:
        if command.to_group_version is None:
            raise ApiError(
                409,
                "VERSION_CONFLICT",
                "内容已被其他人修改，请刷新后再操作。",
                details={"current_version": dst.lock_version},
            )
        require_version(dst.lock_version, command.to_group_version)
    if src is not None:
        if src.roster_frozen:
            raise ApiError(409, "ROSTER_FROZEN", "该队伍名单已冻结，不能移出或调整成员。")
        has_project = session.scalar(
            select(Project.id).where(Project.group_id == src.id, Project.archived_at.is_(None))
        )
        if has_project is not None:
            raise ApiError(
                409,
                "GROUP_HAS_PROJECT",
                "该队伍已立项，不能直接移出或换组。请通过成员变动流程处理。",
                details={
                    "group_id": str(src.id),
                    "member_changes_href": f"/teacher/courses/{course_id}/member-changes",
                },
            )
        gm = groups_service._current_member(session, src.id, command.student_id)
        if gm is not None:
            gm.left_at = now()
        if src.leader_id == command.student_id:
            src.leader_id = None
        src.lock_version += 1
        src.updated_at = now()
        session.flush()
    if dst is not None:
        if dst.roster_frozen:
            raise ApiError(409, "ROSTER_FROZEN", "目标队伍名单已冻结，不能分配新成员。")
        groups_service._add_member(session, dst, course, command.student_id, check_deadline=False)
        dst.lock_version += 1
        dst.updated_at = now()
        session.flush()
    student = session.get(User, command.student_id)
    reason = (command.reason or "").strip() or None
    record_audit(
        session,
        actor=user,
        action="group.teacher_assign",
        target=("course", course_id),
        course_id=course_id,
        after={
            "student_id": command.student_id,
            "from_group_id": src.id if src else None,
            "to_group_id": dst.id if dst else None,
        },
        reason=reason,
        request=request,
    )
    src_tag = str(src.id) if src else "none"
    dst_tag = str(dst.id) if dst else "none"
    ver_tag = dst.lock_version if dst else (src.lock_version if src else 0)
    dedupe_suffix = f"{command.student_id}:{src_tag}:{dst_tag}:{ver_tag}"
    notify(
        session,
        recipient=command.student_id,
        category="course",
        title=(
            f"老师已将你分配到「{dst.name}」"
            if dst is not None
            else f"老师已将你移出「{src.name if src else ''}」"
        ),
        description=f"原因：{reason}" if reason else "",
        target={"kind": "course", "id": course_id, "course_id": course_id},
        dedupe_key=f"b:teacher-assign:student:{dedupe_suffix}",
    )
    if dst is not None and dst.leader_id is not None and dst.leader_id != command.student_id:
        student_name = (student.name if student else None) or "同学"
        notify(
            session,
            recipient=dst.leader_id,
            category="course",
            title=f"老师将 {student_name} 分配进了你的小组「{dst.name}」",
            description="",
            target={"kind": "course", "id": course_id, "course_id": course_id},
            dedupe_key=f"b:teacher-assign:leader:{dedupe_suffix}",
        )
    session.flush()
    return AssignResultDTO(
        student_id=command.student_id,
        from_group=_plaza_group_dto(session, course, src)[0] if src else None,
        to_group=_plaza_group_dto(session, course, dst)[0] if dst else None,
    )


def set_leader(
    session: Session,
    user: User,
    course_id: UUID,
    group_id: UUID,
    command: SetLeader,
    request=None,
) -> PlazaGroupDTO:
    course = _course(session, course_id)
    require_staff_permission(session, user, course_id, "manage_groups")
    _require_active_course(course)
    group = groups_service._group(session, group_id, lock=True)
    if group.course_id != course_id:
        raise ApiError(404, "GROUP_NOT_FOUND", "队伍不存在。")
    require_version(group.lock_version, command.expected_version)
    if group.roster_frozen:
        raise ApiError(409, "ROSTER_FROZEN", "该队伍名单已冻结，不能更换队长。")
    if groups_service._current_member(session, group.id, command.user_id) is None:
        raise ApiError(
            422,
            "NOT_GROUP_MEMBER",
            "所选学生不是该队伍的当前成员。",
            details={"field": "user_id"},
        )
    old_leader = group.leader_id
    groups_service._set_leader(session, group, command.user_id)
    group.updated_at = now()
    session.flush()
    record_audit(
        session,
        actor=user,
        action="group.teacher_set_leader",
        target=("group", group.id),
        course_id=course_id,
        before={"leader_id": old_leader},
        after={"leader_id": command.user_id},
        request=request,
    )
    notify(
        session,
        recipient=command.user_id,
        category="course",
        title=f"老师已指定你为「{group.name}」队长",
        description="",
        target={"kind": "course", "id": course_id, "course_id": course_id},
        dedupe_key=f"b:teacher-leader:{group.id}:{group.lock_version}:new",
    )
    if old_leader is not None and old_leader != command.user_id:
        notify(
            session,
            recipient=old_leader,
            category="course",
            title=f"「{group.name}」队长已调整",
            description="",
            target={"kind": "course", "id": course_id, "course_id": course_id},
            dedupe_key=f"b:teacher-leader:{group.id}:{group.lock_version}:old",
        )
    session.flush()
    return _plaza_group_dto(session, course, group)[0]


def group_detail(
    session: Session, user: User, course_id: UUID, group_id: UUID
) -> TeacherGroupDetailDTO:
    course = _course(session, course_id)
    permissions.require_course_staff(session, user, course_id)
    group = groups_service._group(session, group_id)
    if group.course_id != course_id:
        raise ApiError(404, "GROUP_NOT_FOUND", "队伍不存在。")
    projects = membership_service._projects(session, group.id)
    active_project = next((p for p in projects if p.archived_at is None), None)
    plaza_dto, briefs = _plaza_group_dto(
        session, course, group, project=active_project, project_loaded=True
    )
    member_rows = session.execute(
        select(GroupMember, User)
        .join(User, User.id == GroupMember.user_id)
        .where(GroupMember.group_id == group.id, GroupMember.left_at.is_(None))
        .order_by(GroupMember.joined_at, GroupMember.user_id)
    ).all()
    members: list[TeacherGroupMemberDTO] = []
    for gm, u in member_rows:
        is_leader = group.leader_id == u.id or gm.role == "leader"
        open_tasks = membership_service._open_tasks(session, projects, u.id)
        members.append(
            TeacherGroupMemberDTO(
                id=u.id,
                name=u.name,
                student_number=u.student_id,
                email=u.email,
                role="leader" if is_leader else "member",
                joined_at=gm.joined_at,
                open_task_count=len(open_tasks),
            )
        )
    members.sort(key=lambda m: (0 if m.role == "leader" else 1, (m.name or "").lower(), str(m.id)))
    return TeacherGroupDetailDTO(
        group=plaza_dto,
        members=members,
        milestones=briefs,
        member_changes_href=f"/teacher/courses/{course_id}/member-changes",
    )


def _settings_dto(session: Session, user: User, course: Course) -> ClassSettingsDTO:
    detail = class_detail(session, user, course)
    return ClassSettingsDTO(
        **detail.model_dump(),
        description=course.description,
        archived_at=course.archived_at,
        can_delete=(
            course.status == "ended"
            and detail.student_count == 0
            and detail.group_count == 0
            and course.owner_id == user.id
            and user.global_role == "teacher"
        ),
        is_owner=course.owner_id == user.id and user.global_role == "teacher",
    )


def _next_lifecycle_version(session: Session, course_id: UUID) -> int:
    latest = session.scalar(
        select(func.max(CourseLifecycleDecision.version_no)).where(
            CourseLifecycleDecision.course_id == course_id
        )
    )
    return (latest if latest is not None else -1) + 1


def get_settings(session: Session, user: User, course_id: UUID) -> ClassSettingsDTO:
    course = _course(session, course_id)
    permissions.require_course_staff(session, user, course_id)
    return _settings_dto(session, user, course)


def update_settings(
    session: Session, user: User, course_id: UUID, command: UpdateSettings, request=None
) -> ClassSettingsDTO:
    course = _course(session, course_id, lock=True)
    permissions.require_course_teacher(session, user, course_id)
    _require_active_course(course)
    require_version(course.lock_version, command.expected_version)

    new_min = (
        command.min_group_size if command.min_group_size is not None else course.min_group_size
    )
    new_max = (
        command.max_group_size if command.max_group_size is not None else course.max_group_size
    )
    if new_min > new_max:
        raise ApiError(
            422,
            "INVALID_GROUP_SIZE",
            "最小人数不能超过最大人数。",
            details={"field": "min_group_size"},
        )
    new_form = (
        command.formation_deadline
        if command.formation_deadline is not None
        else course.formation_deadline
    )
    new_proj = (
        command.project_deadline
        if command.project_deadline is not None
        else course.project_deadline
    )
    if new_form is not None and new_proj is not None and new_form > new_proj:
        raise ApiError(
            422,
            "DEADLINE_ORDER_INVALID",
            "组队截止时间不能晚于项目结项截止时间。",
            details={"field": "formation_deadline"},
        )

    before = {
        "name": course.name,
        "semester": course.semester,
        "college": course.college,
        "join_mode": join_mode(session, course_id),
    }
    if command.name is not None:
        course.name = command.name.strip()
    if command.semester is not None:
        course.semester = command.semester.strip()
    if command.college is not None:
        course.college = command.college.strip()
    if command.description is not None:
        course.description = command.description.strip() or None
    course.min_group_size = new_min
    course.max_group_size = new_max
    course.formation_deadline = new_form
    course.project_deadline = new_proj
    ts = now()
    course.lock_version += 1
    course.updated_at = ts

    if command.join_mode is not None:
        policy = session.get(BCourseJoinPolicy, course_id)
        if policy is None:
            session.add(
                BCourseJoinPolicy(
                    course_id=course_id, mode=command.join_mode, updated_by=user.id, updated_at=ts
                )
            )
        else:
            policy.mode = command.join_mode
            policy.updated_by = user.id
            policy.updated_at = ts

    session.flush()
    record_audit(
        session,
        actor=user,
        action="class.settings_updated",
        target=("course", course_id),
        course_id=course_id,
        before=before,
        after={
            "name": course.name,
            "semester": course.semester,
            "college": course.college,
            "join_mode": join_mode(session, course_id),
            "lock_version": course.lock_version,
        },
        request=request,
    )
    return _settings_dto(session, user, course)


def end_class(
    session: Session, user: User, course_id: UUID, command: EndClass, request=None
) -> ClassSettingsDTO:
    course = _course(session, course_id, lock=True)
    permissions.require_course_teacher(session, user, course_id)
    reason = require_reason(command.reason)
    require_version(course.lock_version, command.expected_version)
    if course.status != "active":
        raise ApiError(409, "COURSE_NOT_ACTIVE", "只有进行中的班级可以结束课程。")

    ts = now()
    before = course_data(course)
    course.status = "ended"
    course.lock_version += 1
    course.updated_at = ts
    session.add(
        CourseLifecycleDecision(
            course_id=course_id,
            actor_id=user.id,
            version_no=_next_lifecycle_version(session, course_id),
            action="end",
            reason=reason,
            before_json=before,
            after_json=course_data(course),
            created_at=ts,
        )
    )
    session.flush()

    member_uids = session.scalars(
        select(CourseMember.user_id).where(
            CourseMember.course_id == course_id,
            CourseMember.status == "active",
            CourseMember.left_at.is_(None),
        )
    ).all()
    for uid in set(member_uids) - {user.id}:
        notify(
            session,
            recipient=uid,
            category="course",
            title=f"「{course.name}」已结课",
            description=f"教师已结束本课程（{reason}），现有记录保留为只读。",
            target={"kind": "course", "id": course_id, "course_id": course_id},
            dedupe_key=f"course_end:{course_id}:{course.lock_version}",
        )
    record_audit(
        session,
        actor=user,
        action="class.ended",
        target=("course", course_id),
        course_id=course_id,
        before={"status": "active"},
        after={"status": "ended"},
        reason=reason,
        request=request,
    )
    return _settings_dto(session, user, course)


def archive_class(
    session: Session, user: User, course_id: UUID, command: ArchiveClass, request=None
) -> ClassSettingsDTO:
    course = _course(session, course_id, lock=True)
    permissions.require_course_teacher(session, user, course_id)
    require_version(course.lock_version, command.expected_version)
    ts = now()
    if course.status == "active":
        before = course_data(course)
        course.status = "ended"
        session.add(
            CourseLifecycleDecision(
                course_id=course_id,
                actor_id=user.id,
                version_no=_next_lifecycle_version(session, course_id),
                action="end",
                reason="归档并结束课程",
                before_json=before,
                after_json=course_data(course),
                created_at=ts,
            )
        )
    course.archived_at = ts
    course.lock_version += 1
    course.updated_at = ts
    session.flush()
    record_audit(
        session,
        actor=user,
        action="class.archived",
        target=("course", course_id),
        course_id=course_id,
        after={"status": course.status, "archived_at": ts.isoformat()},
        request=request,
    )
    return _settings_dto(session, user, course)


def reopen_class(
    session: Session, user: User, course_id: UUID, command: ReopenClass, request=None
) -> ClassSettingsDTO:
    course = _course(session, course_id, lock=True)
    permissions.require_course_teacher(session, user, course_id)
    reason = require_reason(command.reason)
    require_version(course.lock_version, command.expected_version)
    if course.status != "ended":
        raise ApiError(409, "COURSE_NOT_ENDED", "只有已结束的班级可以重新开启。")

    ts = now()
    before = course_data(course)
    course.status = "active"
    course.archived_at = None
    course.lock_version += 1
    course.updated_at = ts
    session.add(
        CourseLifecycleDecision(
            course_id=course_id,
            actor_id=user.id,
            version_no=_next_lifecycle_version(session, course_id),
            action="publish",
            reason=f"重开课程：{reason}",
            before_json=before,
            after_json=course_data(course),
            created_at=ts,
        )
    )
    session.flush()
    record_audit(
        session,
        actor=user,
        action="class.reopened",
        target=("course", course_id),
        course_id=course_id,
        before={"status": "ended"},
        after={"status": "active"},
        reason=reason,
        request=request,
    )
    return _settings_dto(session, user, course)


def delete_class(
    session: Session, user: User, course_id: UUID, request=None
) -> DeleteClassResultDTO:
    course = require_course_owner(session, user, course_id)
    if course.status != "ended":
        raise ApiError(409, "COURSE_NOT_ENDED", "请先结束课程后再删除空班级。")

    active_students = session.scalar(
        select(func.count(CourseMember.id)).where(
            CourseMember.course_id == course_id,
            CourseMember.role == "student",
            CourseMember.left_at.is_(None),
            CourseMember.status == "active",
        )
    )
    group_count = session.scalar(
        select(func.count(ProjectGroup.id)).where(ProjectGroup.course_id == course_id)
    )
    if (active_students or 0) > 0 or (group_count or 0) > 0:
        raise ApiError(409, "COURSE_HAS_STUDENTS", "班级内仍有学生或队伍，无法删除。")

    course_code = course.code
    session.execute(delete(CourseInvite).where(CourseInvite.course_id == course_id))
    session.execute(delete(CourseCodeRegistry).where(CourseCodeRegistry.course_id == course_id))
    session.execute(
        delete(CourseLifecycleDecision).where(CourseLifecycleDecision.course_id == course_id)
    )
    session.execute(delete(BCourseJoinRequest).where(BCourseJoinRequest.course_id == course_id))
    session.execute(delete(BCourseJoinPolicy).where(BCourseJoinPolicy.course_id == course_id))
    session.execute(
        delete(BCourseProjectTemplate).where(BCourseProjectTemplate.course_id == course_id)
    )
    session.execute(
        delete(BCourseAppealDecision).where(
            BCourseAppealDecision.appeal_id.in_(
                select(BCourseAppeal.id).where(BCourseAppeal.course_id == course_id)
            )
        )
    )
    session.execute(delete(BCourseAppeal).where(BCourseAppeal.course_id == course_id))
    session.execute(
        delete(BAnnouncementRead).where(
            BAnnouncementRead.announcement_id.in_(
                select(BCourseAnnouncement.id).where(BCourseAnnouncement.course_id == course_id)
            )
        )
    )
    session.execute(delete(BCourseAnnouncement).where(BCourseAnnouncement.course_id == course_id))
    session.execute(
        delete(BCourseMaterialVersion).where(
            BCourseMaterialVersion.material_id.in_(
                select(BCourseMaterialItem.id).where(BCourseMaterialItem.course_id == course_id)
            )
        )
    )
    session.execute(delete(BCourseMaterialItem).where(BCourseMaterialItem.course_id == course_id))
    session.execute(delete(BCourseFileFolder).where(BCourseFileFolder.course_id == course_id))
    session.execute(delete(BCourseRuleVersion).where(BCourseRuleVersion.course_id == course_id))
    session.execute(delete(CourseMember).where(CourseMember.course_id == course_id))
    session.execute(delete(CourseStaff).where(CourseStaff.course_id == course_id))
    session.delete(course)
    session.flush()
    record_audit(
        session,
        actor=user,
        action="class.deleted",
        target=("course", course_id),
        before={"code": course_code},
        request=request,
    )
    return DeleteClassResultDTO(deleted=True, course_id=course_id)
