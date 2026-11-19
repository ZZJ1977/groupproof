"""Teacher course announcements service: publishing, pinning, read stats, reminders."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import Course, CourseMember, CourseStaff, User
from app.modules.a import permissions
from app.modules.a.audit import record_audit
from app.modules.a.inbox import notify
from app.modules.b.common import now
from app.modules.b.models import BAnnouncementRead, BCourseAnnouncement
from app.modules.b.teacher_announcements_schemas import (
    AnnouncementDTO,
    AnnouncementListDTO,
    AnnouncementReaderDTO,
    AnnouncementReadsDTO,
    CreateAnnouncementRequest,
    DeleteAnnouncementResultDTO,
    MarkReadResultDTO,
    RemindAnnouncementResultDTO,
    UnreadAnnouncementsDTO,
    UpdateAnnouncementRequest,
)
from app.modules.b.teacher_permissions import effective_permissions, require_staff_permission


def _load_course(session: Session, course_id: UUID) -> Course:
    course = session.get(Course, course_id)
    if course is None:
        raise ApiError(404, "COURSE_NOT_FOUND", "班级不存在。")
    return course


def _require_active_course(session: Session, course_id: UUID) -> Course:
    course = _load_course(session, course_id)
    if course.status != "active":
        raise ApiError(409, "COURSE_NOT_ACTIVE", "课程已结课或未激活，当前为只读状态。")
    return course


def _active_course_students(session: Session, course_id: UUID) -> list[User]:
    return list(
        session.scalars(
            select(User)
            .join(CourseMember, CourseMember.user_id == User.id)
            .where(
                CourseMember.course_id == course_id,
                CourseMember.role == "student",
                CourseMember.status == "active",
                CourseMember.left_at.is_(None),
            )
            .order_by(User.student_id.asc(), User.name.asc())
        ).all()
    )


def _user_names(session: Session, user_ids: set[UUID]) -> dict[UUID, str]:
    if not user_ids:
        return {}
    rows = session.execute(select(User.id, User.name).where(User.id.in_(user_ids))).all()
    return {uid: (name or "") for uid, name in rows}


def _notify_published(
    session: Session, course: Course, ann: BCourseAnnouncement, student_ids: list[UUID]
) -> None:
    prefix = "[紧急公告] " if ann.priority == "urgent" else "[课程公告] "
    note_title = f"{prefix}{ann.title}"[:290]
    desc = f"「{course.name}」：{ann.content[:180]}"
    for uid in student_ids:
        notify(
            session,
            recipient=uid,
            category="course",
            title=note_title,
            description=desc,
            target={"kind": "course", "id": course.id, "course_id": course.id},
            dedupe_key=f"course_ann:{ann.id}:{uid}",
        )


def _to_dto(
    ann: BCourseAnnouncement,
    *,
    course_name: str,
    names: dict[UUID, str],
    read_count: int,
    total_students: int,
) -> AnnouncementDTO:
    return AnnouncementDTO(
        id=ann.id,
        course_id=ann.course_id,
        course_name=course_name,
        title=ann.title,
        content=ann.content,
        priority=ann.priority,  # type: ignore[arg-type]
        is_pinned=ann.is_pinned,
        status=ann.status,  # type: ignore[arg-type]
        published_by=ann.published_by,
        publisher_name=names.get(ann.published_by),
        published_at=ann.published_at,
        created_at=ann.created_at,
        updated_at=ann.updated_at,
        read_count=read_count,
        total_students=total_students,
        unread_count=max(0, total_students - read_count),
    )


def list_teacher_announcements(
    session: Session, user: User, course_id: UUID
) -> AnnouncementListDTO:
    _role, _is_owner, perms = effective_permissions(session, user, course_id)
    course = _load_course(session, course_id)
    students = _active_course_students(session, course_id)
    student_ids = {s.id for s in students}
    total_students = len(student_ids)

    rows = session.scalars(
        select(BCourseAnnouncement)
        .where(BCourseAnnouncement.course_id == course_id)
        .order_by(
            BCourseAnnouncement.is_pinned.desc(),
            func.coalesce(BCourseAnnouncement.published_at, BCourseAnnouncement.created_at).desc(),
        )
    ).all()

    ann_ids = [r.id for r in rows]
    read_counts: dict[UUID, int] = {}
    if ann_ids and student_ids:
        reads = session.execute(
            select(BAnnouncementRead.announcement_id, BAnnouncementRead.user_id).where(
                BAnnouncementRead.announcement_id.in_(ann_ids)
            )
        ).all()
        for aid, uid in reads:
            if uid in student_ids:
                read_counts[aid] = read_counts.get(aid, 0) + 1

    names = _user_names(session, {r.published_by for r in rows})
    return AnnouncementListDTO(
        course_id=course_id,
        can_post=bool(perms.get("post_announcements", False)),
        total_students=total_students,
        items=[
            _to_dto(
                r,
                course_name=course.name,
                names=names,
                read_count=read_counts.get(r.id, 0),
                total_students=total_students,
            )
            for r in rows
        ],
    )


def create_announcement(
    session: Session,
    user: User,
    course_id: UUID,
    command: CreateAnnouncementRequest,
    request=None,
) -> AnnouncementDTO:
    require_staff_permission(session, user, course_id, "post_announcements")
    course = _require_active_course(session, course_id)
    title = command.title.strip()
    content = command.content.strip()
    if not title or not content:
        raise ApiError(422, "INVALID_ANNOUNCEMENT", "公告标题和正文不能为空。")

    ts = now()
    ann = BCourseAnnouncement(
        course_id=course_id,
        title=title,
        content=content,
        priority=command.priority,
        is_pinned=command.is_pinned,
        status=command.status,
        published_by=user.id,
        published_at=ts if command.status == "published" else None,
    )
    session.add(ann)
    session.flush()

    students = _active_course_students(session, course_id)
    if ann.status == "published":
        _notify_published(session, course, ann, [s.id for s in students])

    record_audit(
        session,
        actor=user,
        action="course.announcement.created",
        target=("course_announcement", ann.id),
        course_id=course_id,
        after={"title": ann.title, "priority": ann.priority, "status": ann.status},
        request=request,
    )
    names = _user_names(session, {ann.published_by})
    return _to_dto(
        ann,
        course_name=course.name,
        names=names,
        read_count=0,
        total_students=len(students),
    )


def update_announcement(
    session: Session,
    user: User,
    course_id: UUID,
    announcement_id: UUID,
    command: UpdateAnnouncementRequest,
    request=None,
) -> AnnouncementDTO:
    require_staff_permission(session, user, course_id, "post_announcements")
    course = _require_active_course(session, course_id)
    ann = session.get(BCourseAnnouncement, announcement_id)
    if ann is None or ann.course_id != course_id:
        raise ApiError(404, "ANNOUNCEMENT_NOT_FOUND", "公告不存在。")

    prev_status = ann.status
    if command.title is not None:
        cleaned = command.title.strip()
        if not cleaned:
            raise ApiError(422, "INVALID_ANNOUNCEMENT", "公告标题不能为空。")
        ann.title = cleaned
    if command.content is not None:
        cleaned_content = command.content.strip()
        if not cleaned_content:
            raise ApiError(422, "INVALID_ANNOUNCEMENT", "公告正文不能为空。")
        ann.content = cleaned_content
    if command.priority is not None:
        ann.priority = command.priority
    if command.is_pinned is not None:
        ann.is_pinned = command.is_pinned
    if command.status is not None:
        ann.status = command.status
        if command.status == "published" and ann.published_at is None:
            ann.published_at = now()
    session.flush()

    students = _active_course_students(session, course_id)
    student_ids = {s.id for s in students}
    if prev_status != "published" and ann.status == "published":
        _notify_published(session, course, ann, list(student_ids))

    read_uids = set(
        session.scalars(
            select(BAnnouncementRead.user_id).where(BAnnouncementRead.announcement_id == ann.id)
        ).all()
    )
    read_count = len(read_uids & student_ids)

    record_audit(
        session,
        actor=user,
        action="course.announcement.updated",
        target=("course_announcement", ann.id),
        course_id=course_id,
        after={"is_pinned": ann.is_pinned, "status": ann.status, "priority": ann.priority},
        request=request,
    )
    names = _user_names(session, {ann.published_by})
    return _to_dto(
        ann,
        course_name=course.name,
        names=names,
        read_count=read_count,
        total_students=len(student_ids),
    )


def delete_announcement(
    session: Session, user: User, course_id: UUID, announcement_id: UUID, request=None
) -> DeleteAnnouncementResultDTO:
    require_staff_permission(session, user, course_id, "post_announcements")
    _require_active_course(session, course_id)
    ann = session.get(BCourseAnnouncement, announcement_id)
    if ann is None or ann.course_id != course_id:
        raise ApiError(404, "ANNOUNCEMENT_NOT_FOUND", "公告不存在。")
    title = ann.title
    session.delete(ann)
    session.flush()
    record_audit(
        session,
        actor=user,
        action="course.announcement.deleted",
        target=("course_announcement", announcement_id),
        course_id=course_id,
        before={"title": title},
        request=request,
    )
    return DeleteAnnouncementResultDTO(deleted=True, id=announcement_id)


def get_announcement_reads(
    session: Session, user: User, course_id: UUID, announcement_id: UUID
) -> AnnouncementReadsDTO:
    effective_permissions(session, user, course_id)
    ann = session.get(BCourseAnnouncement, announcement_id)
    if ann is None or ann.course_id != course_id:
        raise ApiError(404, "ANNOUNCEMENT_NOT_FOUND", "公告不存在。")

    students = _active_course_students(session, course_id)
    read_rows = session.scalars(
        select(BAnnouncementRead).where(BAnnouncementRead.announcement_id == announcement_id)
    ).all()
    read_map = {r.user_id: r.read_at for r in read_rows}

    read_users: list[AnnouncementReaderDTO] = []
    unread_users: list[AnnouncementReaderDTO] = []
    for stu in students:
        entry = AnnouncementReaderDTO(
            user_id=stu.id,
            name=stu.name or "",
            student_number=stu.student_id,
            read_at=read_map.get(stu.id),
        )
        if stu.id in read_map:
            read_users.append(entry)
        else:
            unread_users.append(entry)

    return AnnouncementReadsDTO(
        announcement_id=ann.id,
        title=ann.title,
        total_students=len(students),
        read_count=len(read_users),
        unread_count=len(unread_users),
        read_users=read_users,
        unread_users=unread_users,
    )


def remind_unread_students(
    session: Session, user: User, course_id: UUID, announcement_id: UUID, request=None
) -> RemindAnnouncementResultDTO:
    require_staff_permission(session, user, course_id, "post_announcements")
    course = _require_active_course(session, course_id)
    ann = session.get(BCourseAnnouncement, announcement_id)
    if ann is None or ann.course_id != course_id:
        raise ApiError(404, "ANNOUNCEMENT_NOT_FOUND", "公告不存在。")
    if ann.status != "published":
        raise ApiError(409, "ANNOUNCEMENT_NOT_PUBLISHED", "仅已发布公告可发送催读通知。")

    students = _active_course_students(session, course_id)
    read_uids = set(
        session.scalars(
            select(BAnnouncementRead.user_id).where(BAnnouncementRead.announcement_id == ann.id)
        ).all()
    )
    unread_ids = [s.id for s in students if s.id not in read_uids]
    for uid in unread_ids:
        notify(
            session,
            recipient=uid,
            category="course",
            title=f"[公告催读] {ann.title}"[:290],
            description=f"「{course.name}」教师提醒您尽快查阅课程公告。",
            target={"kind": "course", "id": course.id, "course_id": course.id},
        )
    record_audit(
        session,
        actor=user,
        action="course.announcement.reminded",
        target=("course_announcement", ann.id),
        course_id=course_id,
        after={"notified_count": len(unread_ids)},
        request=request,
    )
    return RemindAnnouncementResultDTO(announcement_id=ann.id, notified_count=len(unread_ids))


def list_student_unread_announcements(session: Session, user: User) -> UnreadAnnouncementsDTO:
    permissions.require_active(user)
    member_courses = list(
        session.execute(
            select(Course.id, Course.name)
            .join(CourseMember, CourseMember.course_id == Course.id)
            .where(
                CourseMember.user_id == user.id,
                CourseMember.status == "active",
                CourseMember.left_at.is_(None),
                Course.status == "active",
            )
        ).all()
    )
    if not member_courses:
        return UnreadAnnouncementsDTO(total=0, items=[])

    course_names = {cid: cname for cid, cname in member_courses}
    read_ann_ids = set(
        session.scalars(
            select(BAnnouncementRead.announcement_id).where(BAnnouncementRead.user_id == user.id)
        ).all()
    )

    priority_rank = case(
        (BCourseAnnouncement.priority == "urgent", 0),
        (BCourseAnnouncement.priority == "important", 1),
        else_=2,
    )
    rows = session.scalars(
        select(BCourseAnnouncement)
        .where(
            BCourseAnnouncement.course_id.in_(course_names.keys()),
            BCourseAnnouncement.status == "published",
        )
        .order_by(
            BCourseAnnouncement.is_pinned.desc(),
            priority_rank.asc(),
            func.coalesce(BCourseAnnouncement.published_at, BCourseAnnouncement.created_at).desc(),
        )
    ).all()

    unread_rows = [r for r in rows if r.id not in read_ann_ids]
    names = _user_names(session, {r.published_by for r in unread_rows})
    return UnreadAnnouncementsDTO(
        total=len(unread_rows),
        items=[
            _to_dto(
                r,
                course_name=course_names.get(r.course_id, ""),
                names=names,
                read_count=0,
                total_students=0,
            )
            for r in unread_rows
        ],
    )


def mark_announcement_read(
    session: Session, user: User, course_id: UUID, announcement_id: UUID
) -> MarkReadResultDTO:
    permissions.require_active(user)
    ann = session.get(BCourseAnnouncement, announcement_id)
    if ann is None or ann.course_id != course_id or ann.status != "published":
        raise ApiError(404, "ANNOUNCEMENT_NOT_FOUND", "公告不存在或尚未发布。")

    is_member = session.scalar(
        select(CourseMember.user_id).where(
            CourseMember.course_id == course_id,
            CourseMember.user_id == user.id,
            CourseMember.left_at.is_(None),
        )
    )
    is_staff = session.scalar(
        select(CourseStaff.user_id).where(
            CourseStaff.course_id == course_id,
            CourseStaff.user_id == user.id,
            CourseStaff.left_at.is_(None),
        )
    )
    course = _load_course(session, course_id)
    if is_member is None and is_staff is None and course.owner_id != user.id:
        raise ApiError(403, "COURSE_MEMBER_REQUIRED", "只有本班成员可以标记公告已读。")

    existing = session.scalar(
        select(BAnnouncementRead).where(
            BAnnouncementRead.announcement_id == announcement_id,
            BAnnouncementRead.user_id == user.id,
        )
    )
    if existing is None:
        existing = BAnnouncementRead(announcement_id=announcement_id, user_id=user.id)
        session.add(existing)
        session.flush()
    return MarkReadResultDTO(announcement_id=announcement_id, read=True, read_at=existing.read_at)
