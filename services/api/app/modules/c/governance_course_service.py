"""Canonical course lifecycle with C-owned history/code claims/invitations."""

import secrets
from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import Course, User
from app.modules.c.governance_common import claim, current_actor, event, finish, history_data, utc
from app.modules.c.governance_models import (
    CourseCodeRegistry,
    CourseInvite,
    CourseLifecycleDecision,
)
from app.modules.c.governance_schemas import CourseFilters, CreateCourse, TransitionCourse


def course_data(row: Course) -> dict:
    return {
        "id": str(row.id),
        "code": row.code,
        "name": row.name,
        "college": row.college,
        "semester": row.semester,
        "owner_id": str(row.owner_id),
        "status": row.status,
        "project_deadline": utc(row.project_deadline).isoformat() if row.project_deadline else None,
        "formation_deadline": utc(row.formation_deadline).isoformat()
        if row.formation_deadline
        else None,
        "grouping_mode": row.grouping_mode,
        "min_group_size": row.min_group_size,
        "max_group_size": row.max_group_size,
        "lock_version": row.lock_version,
    }


def course_detail(session, row):
    invite = session.get(CourseInvite, row.id, populate_existing=True)
    decisions = session.scalars(
        select(CourseLifecycleDecision)
        .where(
            CourseLifecycleDecision.course_id == row.id,
        )
        .order_by(CourseLifecycleDecision.version_no)
    )
    return {
        **course_data(row),
        "invite_code": invite.code if invite else None,
        "invite_revoked_at": utc(invite.revoked_at).isoformat()
        if invite and invite.revoked_at
        else None,
        "history": history_data(decisions),
    }


def list_courses(session: Session, user: User, filters: CourseFilters) -> dict:
    current_actor(session, user, admin=True)
    conditions = []
    if filters.q:
        conditions.append(
            or_(
                Course.code.icontains(filters.q, autoescape=True),
                Course.name.icontains(filters.q, autoescape=True),
            )
        )
    if filters.semester is not None:
        conditions.append(Course.semester == filters.semester)
    if filters.status is not None:
        conditions.append(Course.status == filters.status)
    total = session.scalar(select(func.count()).select_from(Course).where(*conditions))
    rows = session.scalars(
        select(Course)
        .where(*conditions)
        .order_by(Course.created_at.desc(), Course.id)
        .offset((filters.page - 1) * filters.page_size)
        .limit(filters.page_size)
    )
    return {
        "items": [course_data(row) for row in rows],
        "total": total,
        "page": filters.page,
        "page_size": filters.page_size,
    }


def course_row(session, course_id, *, lock=False):
    query = select(Course).where(Course.id == course_id).execution_options(populate_existing=True)
    row = session.scalar(query.with_for_update() if lock else query)
    if row is None:
        raise ApiError(404, "COURSE_NOT_FOUND", "The course does not exist.")
    return row


def get_course(session, user, course_id):
    current_actor(session, user, admin=True)
    return course_detail(session, course_row(session, course_id))


def require_teacher(session, teacher_id):
    teacher = session.scalar(
        select(User)
        .where(User.id == teacher_id)
        .with_for_update(read=True)
        .execution_options(populate_existing=True)
    )
    if (
        teacher is None
        or teacher.status != "active"
        or teacher.global_role != "teacher"
        or teacher.email_verified_at is None
    ):
        raise ApiError(
            422, "COURSE_OWNER_INELIGIBLE", "An active verified canonical teacher is required."
        )


def reserve_code(session, code, course_id):
    """C command uniqueness, not a replacement for B's historical semester key."""
    key = code.strip().lower()
    duplicate = session.scalar(
        select(Course.id)
        .where(func.lower(func.trim(Course.code)) == key, Course.id != course_id)
        .limit(1)
    )
    claim_row = session.get(CourseCodeRegistry, key)
    if duplicate is not None or (claim_row and claim_row.course_id != course_id):
        raise ApiError(
            409,
            "COURSE_CODE_CONFLICT",
            "This course code already exists; historical courses are unchanged.",
        )
    if claim_row is None:
        session.add(CourseCodeRegistry(code_key=key, course_id=course_id))
        session.flush()


def create_course(session, user, command: CreateCourse, key: str):
    actor = current_actor(session, user, admin=True, write=True)
    request, replay = claim(
        session, actor.id, "course.create", key, command.model_dump(mode="json")
    )
    if replay is not None:
        return course_detail(session, course_row(session, UUID(replay["id"]), lock=True))
    require_teacher(session, command.owner_id)
    row = Course(
        id=uuid4(), **command.model_dump(exclude={"reason"}), status="draft", lock_version=0
    )
    # Check before inserting to return a domain conflict for existing course codes.
    duplicate = session.scalar(
        select(Course.id).where(func.lower(func.trim(Course.code)) == command.code.lower()).limit(1)
    )
    if duplicate is not None:
        raise ApiError(409, "COURSE_CODE_CONFLICT", "This course code already exists.")
    session.add(row)
    session.flush()
    reserve_code(session, row.code, row.id)
    after = course_data(row)
    session.add(
        CourseLifecycleDecision(
            course_id=row.id,
            actor_id=actor.id,
            version_no=0,
            action="create",
            reason=command.reason,
            before_json={},
            after_json=after,
        )
    )
    event(
        session,
        row.id,
        "course.created",
        {"course_id": str(row.id), "actor_id": str(actor.id), "reason": command.reason},
    )
    session.flush()
    return finish(session, request, course_detail(session, row))


def transition_course(session, user, course_id, command: TransitionCourse, key: str):
    actor = current_actor(session, user, admin=True, write=True)
    row = course_row(session, course_id, lock=True)
    request, replay = claim(
        session, actor.id, f"course.transition:{course_id}", key, command.model_dump(mode="json")
    )
    if replay is not None:
        return course_detail(session, row)
    if row.lock_version != command.expected_version:
        raise ApiError(409, "VERSION_CONFLICT", "The course has changed.")
    source_status, target_status = (
        ("draft", "active") if command.action == "publish" else ("active", "ended")
    )
    if row.status != source_status:
        raise ApiError(
            409, "COURSE_STATE_CONFLICT", "Course transitions must be draft to active to ended."
        )
    before = course_data(row)
    if command.action == "publish":
        require_teacher(session, row.owner_id)
        reserve_code(session, row.code, row.id)
        if row.project_deadline is None or utc(row.project_deadline) <= datetime.now(UTC):
            raise ApiError(
                409,
                "COURSE_DEADLINE_INVALID",
                "A future project deadline is required for publication.",
            )
        if row.formation_deadline and utc(row.formation_deadline) > utc(row.project_deadline):
            raise ApiError(
                409, "COURSE_DEADLINE_INVALID", "Formation deadline follows project deadline."
            )
        if session.get(CourseInvite, row.id) is not None:
            raise ApiError(409, "COURSE_INVITE_CONFLICT", "A course invite already exists.")
        session.add(
            CourseInvite(course_id=row.id, code=secrets.token_urlsafe(24), created_by=actor.id)
        )
    else:
        invite = session.get(CourseInvite, row.id)
        if invite:
            invite.revoked_at = datetime.now(UTC)
    result = session.execute(
        update(Course)
        .where(Course.id == row.id, Course.lock_version == command.expected_version)
        .values(
            status=target_status, lock_version=Course.lock_version + 1, updated_at=datetime.now(UTC)
        )
    )
    if result.rowcount != 1:
        raise ApiError(409, "VERSION_CONFLICT", "The course has changed.")
    session.refresh(row)
    session.add(
        CourseLifecycleDecision(
            course_id=row.id,
            actor_id=actor.id,
            version_no=row.lock_version,
            action=command.action,
            reason=command.reason,
            before_json=before,
            after_json=course_data(row),
        )
    )
    event(
        session,
        row.id,
        f"course.{command.action}",
        {
            "course_id": str(row.id),
            "actor_id": str(actor.id),
            "reason": command.reason,
            "lock_version": row.lock_version,
        },
    )
    session.flush()
    return finish(session, request, course_detail(session, row))


def resolve_course_invite(session: Session, code: str) -> UUID:
    """Internal B consumption contract; validates a code, never creates membership.

    B must authenticate the joiner, enforce its rules, and keep this same Session
    open through its membership mutation. The shared course lock blocks ending
    the course between invitation validation and B's transaction commit.
    """
    if not isinstance(code, str) or not 20 <= len(code) <= 128 or code != code.strip():
        raise ApiError(404, "COURSE_INVITE_NOT_FOUND", "No active invitation matches.")
    invite = session.scalar(select(CourseInvite).where(CourseInvite.code == code))
    if invite is None or invite.revoked_at is not None:
        raise ApiError(404, "COURSE_INVITE_NOT_FOUND", "No active invitation matches.")
    course = session.scalar(
        select(Course)
        .where(Course.id == invite.course_id)
        .with_for_update(read=True)
        .execution_options(populate_existing=True)
    )
    if course is None or course.status != "active":
        raise ApiError(404, "COURSE_INVITE_NOT_FOUND", "No active invitation matches.")
    return course.id
