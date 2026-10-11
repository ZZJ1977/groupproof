from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import (
    CourseStaff,
    FunctionalModule,
    Milestone,
    ProjectMember,
    Requirement,
    Task,
    User,
)
from app.modules.c.discussion_models import (
    Discussion,
    DiscussionMention,
    DiscussionReply,
    DiscussionReplyMention,
    DiscussionSourceSnapshot,
)
from app.modules.c.discussion_schemas import (
    CreateDiscussion,
    MarkDiscussionImportant,
    ReplyDiscussion,
)
from app.modules.c.integration_events import claim_request, content_hash, emit_event, finish_request
from app.modules.c.permissions import ProjectAccess, get_project_access
from app.modules.c.source_ports import VerifiedSource


def require_discussion_write(access: ProjectAccess) -> None:
    """Discussion supports planning before baseline/plan freeze; TA remains read-only."""
    if not (access.member or access.teacher):
        raise ApiError(403, "DISCUSSION_WRITE_DENIED", "A project member or teacher is required.")
    if access.project.lifecycle != "active":
        raise ApiError(403, "PROJECT_READ_ONLY", "This project is read-only.")
    if access.course is not None and access.course.status != "active":
        raise ApiError(403, "COURSE_READ_ONLY", "The course is not active.")


def discussion_in_project(session: Session, project_id: UUID, discussion_id: UUID) -> Discussion:
    row = session.scalar(
        select(Discussion)
        .where(
            Discussion.id == discussion_id,
            Discussion.project_id == project_id,
        )
        .execution_options(populate_existing=True)
    )
    if row is None:
        raise ApiError(404, "DISCUSSION_NOT_FOUND", "Discussion not found in this project.")
    return row


def validate_links(session: Session, project_id: UUID, values: dict, *, lock: bool = False) -> None:
    for key, model in [
        ("task_id", Task),
        ("requirement_id", Requirement),
        ("module_id", FunctionalModule),
        ("milestone_id", Milestone),
    ]:
        target_id = values.get(key)
        if target_id is not None:
            query = select(model).where(model.id == target_id, model.project_id == project_id)
            if lock:
                query = query.with_for_update(read=True)
            target = session.scalar(query)
            if target is None:
                raise ApiError(
                    422,
                    "DISCUSSION_LINK_MISMATCH",
                    "Every linked object must exist in this project.",
                    {"field": key},
                )


def permitted_notification_users(
    session: Session, access: ProjectAccess
) -> tuple[set[UUID], set[UUID]]:
    members = set(
        session.scalars(
            select(User.id)
            .join(ProjectMember, ProjectMember.user_id == User.id)
            .where(
                ProjectMember.project_id == access.project.id,
                ProjectMember.left_at.is_(None),
                User.status == "active",
                User.global_role == "student",
            )
        )
    )
    readers = set(members)
    if access.course is not None:
        readers.update(
            session.scalars(
                select(User.id)
                .join(CourseStaff, CourseStaff.user_id == User.id)
                .where(
                    CourseStaff.course_id == access.course.id,
                    CourseStaff.left_at.is_(None),
                    User.status == "active",
                    User.global_role.in_(["teacher", "ta"]),
                )
            )
        )
        owner = session.scalar(
            select(User.id).where(
                User.id == access.course.owner_id,
                User.status == "active",
                User.global_role == "teacher",
            )
        )
        if owner is not None:
            readers.add(owner)
    return members, readers


def validate_mentions(session: Session, access: ProjectAccess, ids: list[UUID]) -> set[UUID]:
    members, readers = permitted_notification_users(session, access)
    if len(ids) != len(set(ids)) or not set(ids).issubset(readers):
        raise ApiError(
            422,
            "DISCUSSION_MENTION_INVALID",
            "Mentioned users must currently have access to this project.",
        )
    return members


def notify(
    session: Session,
    row: Discussion,
    actor_id: UUID,
    recipients: set[UUID],
    mentions: set[UUID],
    *,
    reply_id: UUID | None = None,
) -> None:
    for recipient_id in sorted(recipients - {actor_id}, key=str):
        emit_event(
            session,
            project_id=row.project_id,
            aggregate_id=row.id,
            event_type="notification.requested",
            payload={
                "recipient_id": str(recipient_id),
                "actor_id": str(actor_id),
                "project_id": str(row.project_id),
                "target_type": "discussion",
                "target_id": str(row.id),
                "reply_id": str(reply_id) if reply_id else None,
                "notification_type": "discussion_mentioned"
                if recipient_id in mentions
                else ("discussion_replied" if reply_id else "discussion_created"),
                "title": row.title,
                "delivery_status": "pending",
            },
        )


def latest_snapshot(session: Session, discussion_id: UUID) -> DiscussionSourceSnapshot | None:
    return session.scalar(
        select(DiscussionSourceSnapshot)
        .where(
            DiscussionSourceSnapshot.discussion_id == discussion_id,
        )
        .order_by(DiscussionSourceSnapshot.version_no.desc())
        .limit(1)
    )


def reply_data(session: Session, row: DiscussionReply) -> dict:
    mentions = session.scalars(
        select(DiscussionReplyMention.user_id)
        .where(DiscussionReplyMention.reply_id == row.id)
        .order_by(DiscussionReplyMention.user_id)
    )
    return {
        "id": str(row.id),
        "discussion_id": str(row.discussion_id),
        "author_id": str(row.author_id),
        "body": row.body,
        "mention_user_ids": [str(value) for value in mentions],
        "created_at": row.created_at.isoformat(),
        "updated_at": row.updated_at.isoformat(),
    }


def discussion_data(session: Session, row: Discussion) -> dict:
    reply_count, latest_reply = session.execute(
        select(func.count(DiscussionReply.id), func.max(DiscussionReply.created_at)).where(
            DiscussionReply.discussion_id == row.id
        )
    ).one()
    mentions = session.scalars(
        select(DiscussionMention.user_id)
        .where(DiscussionMention.discussion_id == row.id)
        .order_by(DiscussionMention.user_id)
    )
    snapshot = latest_snapshot(session, row.id)
    # SQLite fixtures are naive; PG values are timezone-aware. Normalize only for
    # the comparison and keep the canonical stored timestamps in the response.
    last_activity = max(
        [row.updated_at] + ([latest_reply] if latest_reply else []),
        key=lambda value: value.replace(tzinfo=UTC) if value.tzinfo is None else value,
    )
    return {
        "id": str(row.id),
        "project_id": str(row.project_id),
        "author_id": str(row.author_id),
        "task_id": str(row.task_id) if row.task_id else None,
        "requirement_id": str(row.requirement_id) if row.requirement_id else None,
        "module_id": str(row.module_id) if row.module_id else None,
        "milestone_id": str(row.milestone_id) if row.milestone_id else None,
        "title": row.title,
        "body": row.body,
        "is_important": row.is_important,
        "status": row.status,
        "lock_version": row.lock_version,
        "mention_user_ids": [str(value) for value in mentions],
        "reply_count": reply_count,
        "created_at": row.created_at.isoformat(),
        "updated_at": row.updated_at.isoformat(),
        "last_activity_at": last_activity.isoformat(),
        "evidence_source_id": str(row.id) if row.is_important and row.status == "open" else None,
        "source_snapshot_id": str(snapshot.id) if snapshot else None,
    }


def capture_source(session: Session, row: Discussion, actor_id: UUID) -> DiscussionSourceSnapshot:
    previous = latest_snapshot(session, row.id)
    data = discussion_data(session, row)
    data.pop("source_snapshot_id")
    data.pop("evidence_source_id")
    data["replies"] = [
        reply_data(session, reply)
        for reply in session.scalars(
            select(DiscussionReply)
            .where(DiscussionReply.discussion_id == row.id)
            .order_by(DiscussionReply.created_at, DiscussionReply.id)
        )
    ]
    snapshot = DiscussionSourceSnapshot(
        discussion_id=row.id,
        captured_by=actor_id,
        version_no=previous.version_no + 1 if previous else 1,
        is_important=row.is_important,
        content_json=data,
        content_hash=content_hash(data),
    )
    session.add(snapshot)
    session.flush()
    return snapshot


def source_changed(
    session: Session,
    row: Discussion,
    user: User,
    reason: str,
    snapshot: DiscussionSourceSnapshot | None,
) -> None:
    # Root integration keeps already-adopted evidence invalidation in this same
    # local transaction. Outbox delivery to B/D remains a separate concern.
    from app.modules.c.discussion_evidence import invalidate_discussion_evidence

    if snapshot is not None:
        invalidate_discussion_evidence(session, user, row.project_id, row.id, reason)
    emit_event(
        session,
        project_id=row.project_id,
        aggregate_id=row.id,
        event_type="discussion.source_changed",
        payload={
            "discussion_id": str(row.id),
            "source_type": "discussion",
            "source_id": str(row.id),
            "actor_id": str(user.id),
            "source_revision": str(snapshot.id) if snapshot else None,
            "available_for_new_evidence": row.is_important and row.status == "open",
            "reason": reason,
            "delivery_status": "pending",
        },
    )


def create_discussion(
    session: Session,
    user: User,
    project_id: UUID,
    command: CreateDiscussion,
    key: str,
) -> dict:
    access = get_project_access(session, user, project_id, lock=True)
    require_discussion_write(access)
    record, replay = claim_request(
        session,
        actor_id=user.id,
        project_id=project_id,
        operation="discussion.create",
        key=key,
        payload=command.model_dump(mode="json"),
    )
    if replay is not None:
        return replay
    validate_links(session, project_id, command.model_dump(), lock=True)
    members = validate_mentions(session, access, command.mention_user_ids)
    row = Discussion(
        project_id=project_id,
        author_id=user.id,
        title=command.title,
        body=command.body,
        task_id=command.task_id,
        requirement_id=command.requirement_id,
        module_id=command.module_id,
        milestone_id=command.milestone_id,
        is_important=False,
        status="open",
        lock_version=0,
    )
    session.add(row)
    session.flush()
    session.add_all(
        DiscussionMention(discussion_id=row.id, user_id=value) for value in command.mention_user_ids
    )
    emit_event(
        session,
        project_id=project_id,
        aggregate_id=row.id,
        event_type="discussion.created",
        payload={
            "discussion_id": str(row.id),
            "actor_id": str(user.id),
            "mention_user_ids": [str(value) for value in command.mention_user_ids],
        },
    )
    mentions = set(command.mention_user_ids)
    notify(session, row, user.id, members | mentions, mentions)
    session.flush()
    return finish_request(session, record, discussion_data(session, row))


def require_open_version(row: Discussion, expected_version: int) -> None:
    if row.status != "open":
        raise ApiError(409, "DISCUSSION_CLOSED", "This discussion is closed.")
    if row.lock_version != expected_version:
        raise ApiError(
            409,
            "VERSION_CONFLICT",
            "Discussion metadata changed; reload and retry.",
            {
                "expected_version": expected_version,
                "current_version": row.lock_version,
            },
        )


def add_reply(
    session: Session,
    user: User,
    project_id: UUID,
    discussion_id: UUID,
    command: ReplyDiscussion,
    key: str,
) -> dict:
    access = get_project_access(session, user, project_id, lock=True)
    require_discussion_write(access)
    row = discussion_in_project(session, project_id, discussion_id)
    record, replay = claim_request(
        session,
        actor_id=user.id,
        project_id=project_id,
        operation=f"discussion.reply:{discussion_id}",
        key=key,
        payload=command.model_dump(mode="json"),
    )
    if replay is not None:
        return replay
    require_open_version(row, command.expected_version)
    validate_mentions(session, access, command.mention_user_ids)
    reply = DiscussionReply(discussion_id=row.id, author_id=user.id, body=command.body)
    session.add(reply)
    session.flush()
    session.add_all(
        DiscussionReplyMention(reply_id=reply.id, user_id=value)
        for value in command.mention_user_ids
    )
    emit_event(
        session,
        project_id=project_id,
        aggregate_id=row.id,
        event_type="discussion.reply_added",
        payload={
            "discussion_id": str(row.id),
            "reply_id": str(reply.id),
            "actor_id": str(user.id),
            "mention_user_ids": [str(value) for value in command.mention_user_ids],
        },
    )
    _, readers = permitted_notification_users(session, access)
    mentions = set(command.mention_user_ids)
    recipients = mentions | ({row.author_id} if row.author_id in readers else set())
    notify(session, row, user.id, recipients, mentions, reply_id=reply.id)
    session.flush()
    snapshot = (
        capture_source(session, row, user.id)
        if (row.is_important or latest_snapshot(session, row.id) is not None)
        else None
    )
    source_changed(session, row, user, "A reply was appended.", snapshot)
    return finish_request(
        session,
        record,
        {"discussion": discussion_data(session, row), "reply": reply_data(session, reply)},
    )


def mark_important(
    session: Session,
    user: User,
    project_id: UUID,
    discussion_id: UUID,
    command: MarkDiscussionImportant,
    key: str,
) -> dict:
    access = get_project_access(session, user, project_id, lock=True)
    require_discussion_write(access)
    row = discussion_in_project(session, project_id, discussion_id)
    if not (row.author_id == user.id or access.leader or access.teacher):
        raise ApiError(
            403, "DISCUSSION_IMPORTANCE_DENIED", "Author, project leader or teacher required."
        )
    record, replay = claim_request(
        session,
        actor_id=user.id,
        project_id=project_id,
        operation=f"discussion.important:{discussion_id}",
        key=key,
        payload=command.model_dump(mode="json"),
    )
    if replay is not None:
        return replay
    require_open_version(row, command.expected_version)
    if row.is_important == command.is_important:
        return finish_request(session, record, discussion_data(session, row))
    changed = session.execute(
        update(Discussion)
        .where(Discussion.id == row.id, Discussion.lock_version == command.expected_version)
        .values(
            is_important=command.is_important,
            lock_version=Discussion.lock_version + 1,
            updated_at=datetime.now(UTC),
        )
    )
    if changed.rowcount != 1:
        raise ApiError(409, "VERSION_CONFLICT", "Discussion changed; reload and retry.")
    session.refresh(row)
    snapshot = capture_source(session, row, user.id)
    emit_event(
        session,
        project_id=project_id,
        aggregate_id=row.id,
        event_type="discussion.importance_changed",
        payload={
            "discussion_id": str(row.id),
            "actor_id": str(user.id),
            "is_important": row.is_important,
            "reason": command.reason,
            "lock_version": row.lock_version,
            "source_revision": str(snapshot.id),
        },
    )
    source_changed(session, row, user, command.reason, snapshot)
    return finish_request(session, record, discussion_data(session, row))


def get_discussion(session: Session, user: User, project_id: UUID, discussion_id: UUID) -> dict:
    get_project_access(session, user, project_id)
    return discussion_data(session, discussion_in_project(session, project_id, discussion_id))


def list_discussions(
    session: Session,
    user: User,
    project_id: UUID,
    *,
    page: int = 1,
    page_size: int = 20,
    task_id: UUID | None = None,
    requirement_id: UUID | None = None,
    module_id: UUID | None = None,
    milestone_id: UUID | None = None,
    is_important: bool | None = None,
    q: str | None = None,
) -> dict:
    get_project_access(session, user, project_id)
    if page < 1 or not 1 <= page_size <= 100:
        raise ApiError(422, "INVALID_PAGINATION", "Invalid page or page_size.")
    links = dict(
        task_id=task_id,
        requirement_id=requirement_id,
        module_id=module_id,
        milestone_id=milestone_id,
    )
    validate_links(session, project_id, links)
    query = select(Discussion).where(Discussion.project_id == project_id)
    for name, value in links.items():
        if value is not None:
            query = query.where(getattr(Discussion, name) == value)
    if is_important is not None:
        query = query.where(Discussion.is_important == is_important)
    if q and q.strip():
        pattern = (
            "%" + q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        )
        query = query.where(
            or_(
                Discussion.title.ilike(pattern, escape="\\"),
                Discussion.body.ilike(pattern, escape="\\"),
            )
        )
    total = session.scalar(select(func.count()).select_from(query.subquery()))
    rows = session.scalars(
        query.order_by(Discussion.created_at.desc(), Discussion.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    return {
        "items": [discussion_data(session, row) for row in rows],
        "page": page,
        "page_size": page_size,
        "total": total,
    }


def list_replies(
    session: Session,
    user: User,
    project_id: UUID,
    discussion_id: UUID,
    *,
    page: int = 1,
    page_size: int = 50,
) -> dict:
    get_project_access(session, user, project_id)
    row = discussion_in_project(session, project_id, discussion_id)
    if page < 1 or not 1 <= page_size <= 100:
        raise ApiError(422, "INVALID_PAGINATION", "Invalid page or page_size.")
    query = select(DiscussionReply).where(DiscussionReply.discussion_id == row.id)
    total = session.scalar(select(func.count()).select_from(query.subquery()))
    replies = session.scalars(
        query.order_by(DiscussionReply.created_at, DiscussionReply.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    return {
        "items": [reply_data(session, reply) for reply in replies],
        "page": page,
        "page_size": page_size,
        "total": total,
        "discussion_lock_version": row.lock_version,
    }


def resolve_discussion_source(
    session: Session,
    user: User,
    project_id: UUID,
    discussion_id: UUID,
    *,
    require_important: bool = True,
) -> VerifiedSource:
    """Read-only internal resolver for the future SourcePort adapter.

    New evidence must use the default require_important=True. A source-change
    consumer may set False to capture revoked importance for existing evidence;
    this does not permit an unimportant discussion to become a new candidate.
    """
    get_project_access(session, user, project_id)
    row = discussion_in_project(session, project_id, discussion_id)
    if require_important and (not row.is_important or row.status != "open"):
        raise ApiError(
            409, "DISCUSSION_NOT_IMPORTANT", "Only important open discussions are evidence sources."
        )
    snapshot = latest_snapshot(session, row.id)
    if snapshot is None:
        raise ApiError(
            409, "DISCUSSION_SNAPSHOT_UNAVAILABLE", "This discussion has no captured source."
        )
    return VerifiedSource(
        project_id=project_id,
        source_type="discussion",
        identity=str(row.id),
        revision=str(snapshot.id),
        content=snapshot.content_json,
    )
