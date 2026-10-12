"""Read current access and real C history using bounded SQL queries, never outbox guesses.

The project predicate mirrors permissions.get_project_access in a set query. It
does not grant administrators project-content access or require writable projects.
"""

from datetime import UTC, datetime, time

from sqlalchemy import and_, false, func, literal, or_, select, union_all
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import (
    Course,
    CourseMember,
    CourseStaff,
    ProgressEvent,
    Project,
    ProjectGroup,
    ProjectMember,
    Task,
    TaskAssignee,
    User,
)
from app.modules.c.daily_schemas import DailyActivityFilters
from app.modules.c.discussion_models import Discussion, DiscussionReply
from app.modules.c.inbox_ports import InboxPort
from app.modules.c.inbox_schemas import ActionItemFilters, NotificationFilters
from app.modules.c.inbox_service import action_items, notifications
from app.modules.c.models import Evidence, EvidenceDecision, TaskNote, TaskNoteVersion
from app.modules.c.task_execution import progress_projection

HOME_SCOPE = (
    "Courses use active canonical student membership or current teaching-team ownership/staff. "
    "Projects include all currently readable member/teaching-team projects, including archived "
    "and finalized projects. My tasks are current responsible assignments in those projects. "
    "Completed means task.status=completed, not progress=100. Project progress uses the canonical "
    "tree-weighted progress projection, counting roots once; absent weights/tasks or invalid "
    "task trees return null with progress_status. "
    "Project/course previews show at most 10 ordered by updated_at descending, id ascending. "
    "Inbox counts use the same recipient-validated provider queries as the inbox pages. "
    "An unavailable provider returns null for that counter, never an invented zero. "
    "External activity integrations are unavailable here."
)
ACTIVITY_SCOPE = (
    "Only events performed by the current actor on objects still accessible now: canonical "
    "task progress events, saved task-note versions, evidence decisions (submitted/adopted/"
    "withdrawn/source_changed), discussion creation and replies. Discussion importance changes "
    "and external GitHub/Feishu activity are not included. Titles are current object titles; "
    "timestamps are event creation times. Date filters are inclusive UTC calendar dates. "
    "Order is occurred_at descending, event_type ascending, event UUID ascending."
)


def _active_actor(session: Session, user: User) -> User:
    # Read again even when called outside HTTP, so a revoked/stale actor cannot read.
    actor = session.scalar(
        select(User).where(User.id == user.id).execution_options(populate_existing=True)
    )
    if actor is None:
        raise ApiError(401, "UNAUTHENTICATED", "Authentication is required.")
    if actor.status != "active":
        raise ApiError(403, "ACCOUNT_INACTIVE", "The account is not active.")
    return actor


def _staff_course_predicate(actor: User):
    current_staff = (
        select(CourseStaff.course_id)
        .where(
            CourseStaff.course_id == Course.id,
            CourseStaff.user_id == actor.id,
            CourseStaff.left_at.is_(None),
        )
        .exists()
    )
    if actor.global_role == "teacher":
        return or_(Course.owner_id == actor.id, current_staff)
    if actor.global_role == "ta":
        return current_staff
    return false()


def _readable_projects(actor: User):
    member = (
        select(ProjectMember.id)
        .where(
            ProjectMember.project_id == Project.id,
            ProjectMember.user_id == actor.id,
            ProjectMember.left_at.is_(None),
        )
        .exists()
        if actor.global_role == "student"
        else false()
    )
    valid_group = (
        select(ProjectGroup.id)
        .where(ProjectGroup.id == Project.group_id, ProjectGroup.course_id == Project.course_id)
        .exists()
    )
    return (
        select(Project.id, Project.name, Project.lifecycle, Project.updated_at)
        .outerjoin(Course, Course.id == Project.course_id)
        .where(
            or_(Project.course_id.is_(None), Course.id.is_not(None)),
            or_(Project.group_id.is_(None), valid_group),
            or_(member, _staff_course_predicate(actor)),
        )
        .cte("daily_readable_projects")
    )


def _readable_courses(actor: User):
    member = (
        select(CourseMember.id)
        .where(
            CourseMember.course_id == Course.id,
            CourseMember.user_id == actor.id,
            CourseMember.role == "student",
            CourseMember.status == "active",
            CourseMember.left_at.is_(None),
        )
        .exists()
        if actor.global_role == "student"
        else false()
    )
    return (
        select(Course.id, Course.name, Course.status, Course.updated_at)
        .where(or_(member, _staff_course_predicate(actor)))
        .cte("daily_readable_courses")
    )


def _inbox_counts(session: Session, actor: User, port: InboxPort | None) -> dict:
    result = {"unread_notifications": None, "pending_action_items": None}
    unavailable = []
    sources = (
        (
            "notifications",
            "unread_notifications",
            notifications,
            NotificationFilters(page_size=1),
            "unread_total",
        ),
        (
            "action_items",
            "pending_action_items",
            action_items,
            ActionItemFilters(status="pending", page_size=1),
            "total",
        ),
    )
    for source, field, query, filters, count_field in sources:
        if port is None:
            unavailable.append(source)
            continue
        try:
            result[field] = query(session, actor, filters, port)[count_field]
        except ApiError as error:
            # Optional provider outages do not hide unrelated project/task facts.
            # Authentication/permission failures must still fail the whole response.
            if error.status_code != 503:
                raise
            unavailable.append(source)
    return {**result, "unavailable_sources": [*unavailable, "github", "feishu"]}


def get_home_summary(session: Session, user: User, *, inbox_port: InboxPort | None = None) -> dict:
    actor = _active_actor(session, user)
    projects = _readable_projects(actor)
    courses = _readable_courses(actor)
    counts = dict.fromkeys(
        ["not_started", "in_progress", "pending_submission", "pending_verification", "completed"],
        0,
    )
    assigned = (
        select(TaskAssignee.task_id)
        .where(
            TaskAssignee.task_id == Task.id,
            TaskAssignee.user_id == actor.id,
            TaskAssignee.role == "responsible",
            TaskAssignee.unassigned_at.is_(None),
        )
        .exists()
    )
    counts.update(
        dict(
            session.execute(
                select(Task.status, func.count())
                .join(projects, projects.c.id == Task.project_id)
                .where(assigned if actor.global_role == "student" else false())
                .group_by(Task.status)
            ).all()
        )
    )
    project_count = session.scalar(select(func.count()).select_from(projects)) or 0
    course_count = session.scalar(select(func.count()).select_from(courses)) or 0
    project_rows = (
        session.execute(
            select(projects).order_by(projects.c.updated_at.desc(), projects.c.id).limit(10)
        )
        .mappings()
        .all()
    )
    tasks_by_project = {row.id: [] for row in project_rows}
    # Load all preview tasks once so parent/child weighting matches C2 without N+1.
    for task in session.scalars(
        select(Task)
        .where(Task.project_id.in_(tasks_by_project))
        .execution_options(populate_existing=True)
    ):
        tasks_by_project[task.project_id].append(task)
    project_items = []
    for row in project_rows:
        try:
            _, progress = progress_projection(tasks_by_project[row.id])
            progress_status = "available" if progress is not None else "no_weighted_tasks"
        except ApiError as error:
            if error.code != "INVALID_TASK_TREE":
                raise
            progress, progress_status = None, "invalid_task_tree"
        project_items.append(
            {
                "id": row.id,
                "name": row.name,
                "lifecycle": row.lifecycle,
                "progress": progress,
                "progress_status": progress_status,
                "href": f"/projects/{row.id}",
            }
        )
    course_rows = session.execute(
        select(courses).order_by(courses.c.updated_at.desc(), courses.c.id).limit(10)
    ).mappings()
    return {
        "course_count": course_count,
        "project_count": project_count,
        "my_task_count": sum(counts.values()),
        "my_completed_tasks": counts["completed"],
        "task_counts": counts,
        "projects": project_items,
        "courses": [
            {
                "id": row.id,
                "name": row.name,
                "status": row.status,
                "href": f"/courses/{row.id}/rules",
            }
            for row in course_rows
        ],
        **_inbox_counts(session, actor, inbox_port),
        "scope": HOME_SCOPE,
    }


def _activity_events(actor: User):
    def columns(
        category,
        event_type,
        event_id,
        occurred_at,
        project_id,
        object_type,
        object_id,
        title,
        task_id,
    ):
        return (
            literal(category).label("category"),
            (literal(event_type) if isinstance(event_type, str) else event_type).label(
                "event_type"
            ),
            event_id.label("event_id"),
            occurred_at.label("occurred_at"),
            project_id.label("project_id"),
            literal(object_type).label("object_type"),
            object_id.label("object_id"),
            title.label("title"),
            task_id.label("task_id"),
        )

    progress = (
        select(
            *columns(
                "development",
                "task_progress",
                ProgressEvent.id,
                ProgressEvent.created_at,
                Task.project_id,
                "task",
                Task.id,
                Task.title,
                Task.id,
            )
        )
        .select_from(ProgressEvent)
        .join(
            Task,
            and_(Task.id == ProgressEvent.task_id, Task.project_id == ProgressEvent.project_id),
        )
        .where(ProgressEvent.actor_id == actor.id)
    )
    notes = (
        select(
            *columns(
                "development",
                "task_note_saved",
                TaskNoteVersion.id,
                TaskNoteVersion.created_at,
                Task.project_id,
                "task",
                Task.id,
                Task.title,
                Task.id,
            )
        )
        .select_from(TaskNoteVersion)
        .join(TaskNote, TaskNote.id == TaskNoteVersion.note_id)
        .join(Task, and_(Task.id == TaskNote.task_id, Task.project_id == TaskNote.project_id))
        .where(TaskNoteVersion.edited_by == actor.id)
    )
    decisions = (
        select(
            *columns(
                "evidence",
                literal("evidence_") + EvidenceDecision.decision,
                EvidenceDecision.id,
                EvidenceDecision.created_at,
                Evidence.project_id,
                "evidence",
                Evidence.id,
                Evidence.title,
                Task.id,
            )
        )
        .select_from(EvidenceDecision)
        .join(Evidence, Evidence.id == EvidenceDecision.evidence_id)
        .join(Task, and_(Task.id == Evidence.task_id, Task.project_id == Evidence.project_id))
        .where(EvidenceDecision.actor_id == actor.id)
    )
    discussion = select(
        *columns(
            "discussion",
            "discussion_created",
            Discussion.id,
            Discussion.created_at,
            Discussion.project_id,
            "discussion",
            Discussion.id,
            Discussion.title,
            literal(None),
        )
    ).where(Discussion.author_id == actor.id)
    replies = (
        select(
            *columns(
                "discussion",
                "discussion_replied",
                DiscussionReply.id,
                DiscussionReply.created_at,
                Discussion.project_id,
                "discussion",
                Discussion.id,
                Discussion.title,
                literal(None),
            )
        )
        .select_from(DiscussionReply)
        .join(Discussion, Discussion.id == DiscussionReply.discussion_id)
        .where(DiscussionReply.author_id == actor.id)
    )
    return union_all(progress, notes, decisions, discussion, replies).subquery("daily_events")


def list_personal_activity(session: Session, user: User, filters: DailyActivityFilters) -> dict:
    actor = _active_actor(session, user)
    projects = _readable_projects(actor)
    events = _activity_events(actor)
    statement = select(events, projects.c.name.label("project_name")).join(
        projects, projects.c.id == events.c.project_id
    )
    if filters.category != "all":
        statement = statement.where(events.c.category == filters.category)
    if filters.project_id is not None:
        statement = statement.where(events.c.project_id == filters.project_id)
    if filters.date_from is not None:
        statement = statement.where(
            events.c.occurred_at >= datetime.combine(filters.date_from, time.min, UTC)
        )
    if filters.date_to is not None:
        # Avoid date.max overflow while retaining inclusive date semantics.
        end = datetime.combine(filters.date_to, time.max, UTC)
        statement = statement.where(events.c.occurred_at <= end)
    total = session.scalar(select(func.count()).select_from(statement.subquery())) or 0
    rows = session.execute(
        statement.order_by(events.c.occurred_at.desc(), events.c.event_type, events.c.event_id)
        .offset((filters.page - 1) * filters.page_size)
        .limit(filters.page_size)
    ).mappings()
    items = []
    for row in rows:
        base = f"/projects/{row.project_id}"
        if row.object_type == "discussion":
            href = f"{base}/discussions?discussion={row.object_id}"
        elif row.object_type == "evidence":
            href = f"{base}/tasks/{row.task_id}?tab=evidence"
        else:
            href = f"{base}/tasks/{row.object_id}"
        items.append(
            {
                "id": f"{row.event_type}:{row.event_id}",
                "category": row.category,
                "event_type": row.event_type,
                "project_id": row.project_id,
                "project_name": row.project_name,
                "object_type": row.object_type,
                "object_id": row.object_id,
                "title": row.title,
                "occurred_at": row.occurred_at
                if row.occurred_at.tzinfo
                else row.occurred_at.replace(tzinfo=UTC),
                "href": href,
            }
        )
    return {
        "items": items,
        "page": filters.page,
        "page_size": filters.page_size,
        "total": total,
        "scope": ACTIVITY_SCOPE,
        "unavailable_sources": ["github", "feishu"],
    }
