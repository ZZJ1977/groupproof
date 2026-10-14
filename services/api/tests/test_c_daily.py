"""C1 relational and HTTP tests; SQLite is not a PostgreSQL migration substitute."""

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
import test_c_discussions as discussion_tests
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import delete, event, select

from app.api.auth import get_current_user
from app.api.errors import ApiError, install_exception_handlers
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
from app.db.session import get_session
from app.main import request_context
from app.modules.c.daily_router import router
from app.modules.c.daily_schemas import DailyActivityFilters, DailyActivityPageDTO, DailyHomeDTO
from app.modules.c.daily_service import get_home_summary, list_personal_activity
from app.modules.c.discussion_models import Discussion, DiscussionReply
from app.modules.c.inbox_ports import ActionItemPage, NotificationPage, get_inbox_port
from app.modules.c.inbox_schemas import ActionItemRecord, InboxTarget, NotificationRecord
from app.modules.c.models import Evidence, EvidenceDecision, TaskNote, TaskNoteVersion
from app.modules.c.task_execution import SqlExecutionRepository, TaskExecutionService

db = discussion_tests.db
scope = discussion_tests.scope
WHEN = datetime(2026, 3, 2, 12, 0, tzinfo=UTC)


@pytest.fixture()
def daily(db, scope):
    actor = scope.users["author"]
    db.add(CourseMember(id=uuid4(), course_id=scope.course.id, user_id=actor.id))
    db.add(TaskAssignee(task_id=scope.task.id, user_id=actor.id, role="responsible"))
    discussion = Discussion(
        id=uuid4(),
        project_id=scope.project.id,
        author_id=actor.id,
        title="Own discussion",
        body="Private body must not enter the feed.",
        created_at=WHEN,
        updated_at=WHEN + timedelta(days=10),
    )
    evidence = Evidence(
        id=uuid4(),
        project_id=scope.project.id,
        task_id=scope.task.id,
        author_id=actor.id,
        title="Evidence title",
        description="Private description",
        source_type="manual",
        status="candidate",
        created_at=WHEN,
    )
    note = TaskNote(id=uuid4(), project_id=scope.project.id, task_id=scope.task.id)
    db.add_all([discussion, evidence, note])
    db.flush()
    records = [
        ProgressEvent(
            id=uuid4(),
            project_id=scope.project.id,
            task_id=scope.task.id,
            actor_id=actor.id,
            from_status="in_progress",
            to_status="in_progress",
            progress_before=0,
            progress_after=30,
            created_at=WHEN,
        ),
        TaskNoteVersion(
            id=uuid4(),
            note_id=note.id,
            edited_by=actor.id,
            version_no=1,
            title="Private version title",
            body="Private note",
            content_hash="a" * 64,
            created_at=WHEN,
        ),
        EvidenceDecision(
            id=uuid4(),
            evidence_id=evidence.id,
            actor_id=actor.id,
            decision="submitted",
            resulting_status="candidate",
            reason="private",
            created_at=WHEN,
        ),
        DiscussionReply(
            id=uuid4(),
            discussion_id=discussion.id,
            author_id=actor.id,
            body="Private reply",
            created_at=WHEN,
        ),
    ]
    db.add_all(records)
    db.flush()
    scope.actor = actor
    scope.discussion = discussion
    scope.evidence = evidence
    scope.note = note
    scope.records = records
    return scope


@pytest.fixture()
def client(db, daily):
    application = FastAPI()
    application.middleware("http")(request_context)
    install_exception_handlers(application)
    application.include_router(router, prefix="/api/v1")
    application.dependency_overrides[get_session] = lambda: db
    application.dependency_overrides[get_current_user] = lambda: daily.actor
    with TestClient(application) as result:
        yield result


def activity(db, daily, **filters):
    return list_personal_activity(db, daily.actor, DailyActivityFilters(**filters))


class HomeInboxFixture:
    """One-row pages with larger provider totals; no production adapter is implied."""

    def __init__(self, daily):
        self.daily = daily
        self.unread = 3
        self.pending = 5
        self.calls = []
        self.failure = {}
        self.wrong_recipient = None

    def _check(self, source, recipient_id, filters):
        self.calls.append((source, recipient_id, filters))
        if source in self.failure:
            raise ApiError(self.failure[source], "TEST_PROVIDER_ERROR", "Provider failure")

    def notifications(self, session, *, recipient_id, filters):
        self._check("notifications", recipient_id, filters)
        record = NotificationRecord(
            id=uuid4(),
            recipient_id=recipient_id,
            category="project",
            title="Notice",
            description="",
            created_at=WHEN,
            read_at=None,
            lock_version=0,
            target=None,
        )
        page = NotificationPage(
            recipient_id,
            (record,) if self.unread else (),
            self.unread,
            self.unread,
            self.unread,
            uuid4(),
            0,
        )
        return replace(page, recipient_id=self.wrong_recipient or recipient_id)

    def action_items(self, session, *, recipient_id, filters):
        self._check("action_items", recipient_id, filters)
        record = ActionItemRecord(
            id=uuid4(),
            recipient_id=recipient_id,
            category="task",
            title="Action",
            description="",
            status="pending",
            priority="medium",
            created_at=WHEN,
            due_at=None,
            target=InboxTarget(
                kind="task", id=self.daily.task.id, project_id=self.daily.project.id
            ),
        )
        return ActionItemPage(recipient_id, (record,) if self.pending else (), self.pending)


@pytest.fixture()
def home_inbox(client, daily):
    port = HomeInboxFixture(daily)
    client.app.dependency_overrides[get_inbox_port] = lambda: port
    return port


def test_home_reuses_recipient_scoped_inbox_totals_and_refreshes(client, daily, home_inbox):
    data = client.get("/api/v1/home/summary").json()["data"]
    assert (data["unread_notifications"], data["pending_action_items"]) == (3, 5)
    assert data["unavailable_sources"] == ["github", "feishu"]
    assert all(
        recipient == daily.actor.id and filters.page_size == 1 and filters.category == "all"
        for _, recipient, filters in home_inbox.calls
    )
    assert home_inbox.calls[1][2].status == "pending"
    home_inbox.unread = 0
    home_inbox.pending = 0
    response = client.get("/api/v1/home/summary")
    assert response.headers["Cache-Control"] == "private, no-store"
    assert response.json()["data"]["unread_notifications"] == 0
    assert response.json()["data"]["pending_action_items"] == 0


@pytest.mark.parametrize(
    "source,field,other",
    [
        ("notifications", "unread_notifications", "pending_action_items"),
        ("action_items", "pending_action_items", "unread_notifications"),
    ],
)
def test_home_degrades_only_unavailable_source_without_inventing_zero(
    client, home_inbox, source, field, other
):
    home_inbox.failure[source] = 503
    response = client.get("/api/v1/home/summary")
    assert response.status_code == 200
    data = response.json()["data"]
    assert data[field] is None and data[other] > 0
    assert data["project_count"] == 1
    assert data["unavailable_sources"] == [source, "github", "feishu"]


@pytest.mark.parametrize("source", ["notifications", "action_items"])
@pytest.mark.parametrize("status", [401, 403])
def test_home_does_not_swallow_provider_permission_revocation(client, home_inbox, source, status):
    home_inbox.failure[source] = status
    response = client.get("/api/v1/home/summary")
    assert response.status_code == status
    assert "data" not in response.json()


def test_home_rejects_cross_recipient_count_and_keeps_other_source(client, home_inbox):
    home_inbox.wrong_recipient = uuid4()
    data = client.get("/api/v1/home/summary").json()["data"]
    assert data["unread_notifications"] is None
    assert data["pending_action_items"] == 5
    assert "notifications" in data["unavailable_sources"]


def test_home_inactive_actor_does_not_query_inbox(client, daily, db, home_inbox):
    daily.actor.status = "disabled"
    db.flush()
    assert client.get("/api/v1/home/summary").status_code == 403
    assert home_inbox.calls == []


def test_home_counts_only_current_assignments_and_canonical_status(client, daily, db):
    summary = client.get("/api/v1/home/summary")
    assert summary.status_code == 200, summary.text
    assert summary.headers["Cache-Control"] == "private, no-store"
    data = summary.json()["data"]
    assert data["course_count"] == data["project_count"] == data["my_task_count"] == 1
    assert data["my_completed_tasks"] == 0
    assert data["task_counts"]["in_progress"] == 1
    assert data["unread_notifications"] is data["pending_action_items"] is None
    assert data["unavailable_sources"] == ["notifications", "action_items", "github", "feishu"]
    daily.task.progress_percent = 100
    db.flush()
    assert get_home_summary(db, daily.actor)["my_completed_tasks"] == 0
    daily.task.status = "completed"
    db.flush()
    changed = get_home_summary(db, daily.actor)
    assert changed["my_completed_tasks"] == 1 and changed["task_counts"]["in_progress"] == 0
    assignment = db.get(TaskAssignee, (daily.task.id, daily.actor.id))
    assignment.unassigned_at = WHEN
    db.flush()
    assert get_home_summary(db, daily.actor)["my_task_count"] == 0


def test_progress_updates_refresh_home_and_personal_history(db, daily):
    before = get_home_summary(db, daily.actor)
    result = TaskExecutionService(SqlExecutionRepository(db)).update_progress(
        daily.task.id, daily.actor, daily.task.lock_version, 75, "Implemented current task"
    )
    after = get_home_summary(db, daily.actor)
    assert before["projects"][0]["progress"] == 0
    assert after["projects"][0]["progress"] == result.project_progress == 75
    assert after["my_completed_tasks"] == 0
    assert activity(db, daily)["total"] == 6


def test_project_progress_uses_tree_weights_once_and_not_raw_parent_value(db, daily):
    daily.task.progress_percent = 0
    daily.task.weight = 1
    child = Task(
        id=uuid4(),
        project_id=daily.project.id,
        module_id=daily.task.module_id,
        parent_task_id=daily.task.id,
        title="Child",
        weight=1,
        progress_percent=100,
    )
    root = Task(
        id=uuid4(),
        project_id=daily.project.id,
        module_id=daily.task.module_id,
        title="Second root",
        weight=3,
        progress_percent=0,
    )
    db.add_all([child, root])
    db.flush()
    data = get_home_summary(db, daily.actor)
    assert data["projects"][0]["progress"] == 25
    assert data["projects"][0]["progress_status"] == "available"
    assert data["my_task_count"] == 1


def test_invalid_task_tree_is_not_fabricated_zero_and_other_counts_still_available(db, daily):
    daily.task.parent_task_id = daily.other_task.id
    db.flush()
    project = get_home_summary(db, daily.actor)["projects"][0]
    assert project["progress"] is None and project["progress_status"] == "invalid_task_tree"


def test_feed_exact_event_scope_and_minimal_fields(client, daily):
    response = client.get("/api/v1/me/activity")
    assert response.status_code == 200, response.text
    assert response.headers["Cache-Control"] == "private, no-store"
    data = response.json()["data"]
    assert data["total"] == 5
    assert {item["event_type"] for item in data["items"]} == {
        "task_progress",
        "task_note_saved",
        "evidence_submitted",
        "discussion_created",
        "discussion_replied",
    }
    assert all(item["occurred_at"] == "2026-03-02T12:00:00Z" for item in data["items"])
    assert all(
        set(item)
        == {
            "id",
            "category",
            "event_type",
            "project_id",
            "project_name",
            "object_type",
            "object_id",
            "title",
            "occurred_at",
            "href",
        }
        for item in data["items"]
    )
    assert "Private" not in response.text
    discussion = next(item for item in data["items"] if item["event_type"] == "discussion_created")
    assert discussion["href"] == (
        f"/projects/{daily.project.id}/discussions?discussion={daily.discussion.id}"
    )
    evidence = next(item for item in data["items"] if item["event_type"] == "evidence_submitted")
    assert evidence["href"] == f"/projects/{daily.project.id}/evidence?evidence={daily.evidence.id}"
    note = next(item for item in data["items"] if item["event_type"] == "task_note_saved")
    note_id = daily.records[1].id
    assert (
        note["href"] == f"/projects/{daily.project.id}/tasks/{daily.task.id}"
        f"?tab=history&note={note_id}#note-{note_id}"
    )
    progress = next(item for item in data["items"] if item["event_type"] == "task_progress")
    progress_id = daily.records[0].id
    assert (
        progress["href"] == f"/projects/{daily.project.id}/tasks/{daily.task.id}"
        f"?tab=history&progress={progress_id}#progress-{progress_id}"
    )


def test_feed_never_relabels_other_peoples_changes_as_actor_activity(db, daily):
    other = daily.users["member"]
    db.add_all(
        [
            DiscussionReply(
                id=uuid4(),
                discussion_id=daily.discussion.id,
                author_id=other.id,
                body="Someone else",
                created_at=WHEN + timedelta(days=1),
            ),
            EvidenceDecision(
                id=uuid4(),
                evidence_id=daily.evidence.id,
                actor_id=other.id,
                decision="adopted",
                resulting_status="formal",
                reason="Elsewhere",
                created_at=WHEN + timedelta(days=1),
            ),
            TaskNoteVersion(
                id=uuid4(),
                note_id=daily.note.id,
                edited_by=other.id,
                version_no=2,
                title="Somebody else's note",
                body="Hidden",
                content_hash="b" * 64,
            ),
            ProgressEvent(
                id=uuid4(),
                project_id=daily.project.id,
                task_id=daily.task.id,
                actor_id=other.id,
                reason="Someone else",
                created_at=WHEN,
            ),
        ]
    )
    db.flush()
    assert activity(db, daily)["total"] == 5
    daily.actor = other
    assert activity(db, daily)["total"] == 4


def test_author_only_access_is_insufficient_after_leaving_project(db, daily, client):
    member = db.scalar(
        select(ProjectMember).where(
            ProjectMember.project_id == daily.project.id, ProjectMember.user_id == daily.actor.id
        )
    )
    member.left_at = WHEN
    db.flush()
    data = client.get("/api/v1/me/activity").json()["data"]
    assert data["items"] == [] and data["total"] == 0
    summary = get_home_summary(db, daily.actor)
    assert summary["project_count"] == summary["my_task_count"] == 0
    assert summary["course_count"] == 1  # Still enrolled, but no content access to former project.


@pytest.mark.parametrize(
    "actor_name,projects,courses",
    [
        ("teacher", 2, 1),
        ("ta", 2, 1),
        ("admin", 0, 0),
        ("other_teacher", 0, 0),
        ("outsider", 1, 0),
    ],
)
def test_project_access_follows_real_relationships_without_admin_bypass(
    db, daily, actor_name, projects, courses
):
    daily.actor = daily.users[actor_name]
    data = get_home_summary(db, daily.actor)
    assert data["project_count"] == projects and data["course_count"] == courses
    assert data["my_task_count"] == 0
    assert activity(db, daily)["items"] == []


def test_former_course_staff_cannot_see_authored_content(db, daily):
    daily.actor = daily.users["ta"]
    daily.discussion.author_id = daily.actor.id
    db.flush()
    assert activity(db, daily)["total"] == 1
    db.get(CourseStaff, (daily.course.id, daily.actor.id)).left_at = WHEN
    db.flush()
    assert activity(db, daily)["total"] == 0
    assert get_home_summary(db, daily.actor)["course_count"] == 0


@pytest.mark.parametrize("status", ["disabled", "pending"])
def test_inactive_actor_denied_before_returning_data(client, daily, db, status):
    daily.actor.status = status
    db.flush()
    for path in ["/api/v1/home/summary", "/api/v1/me/activity"]:
        response = client.get(path)
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "ACCOUNT_INACTIVE"
        assert response.headers["Cache-Control"] == "private, no-store"


def test_unknown_actor_rejected(db, daily):
    ghost = User(id=uuid4(), status="active", global_role="student")
    with pytest.raises(ApiError) as error:
        get_home_summary(db, ghost)
    assert error.value.status_code == 401


@pytest.mark.parametrize("lifecycle", ["finalized", "archived"])
def test_archived_ended_context_remains_readable_and_no_email_verification_needed(
    db, daily, lifecycle
):
    daily.project.lifecycle = lifecycle
    daily.course.status = "ended"
    daily.actor.email_binding.verified_at = None
    db.flush()
    assert get_home_summary(db, daily.actor)["projects"][0]["lifecycle"] == lifecycle
    assert get_home_summary(db, daily.actor)["courses"][0]["status"] == "ended"
    assert activity(db, daily)["total"] == 5


def test_category_project_and_inclusive_utc_date_filters_combine(db, daily):
    filters = dict(
        category="development",
        project_id=daily.project.id,
        date_from="2026-03-02",
        date_to="2026-03-02",
    )
    assert activity(db, daily, **filters)["total"] == 2
    assert activity(db, daily, category="evidence")["total"] == 1
    assert activity(db, daily, category="discussion")["total"] == 2
    assert activity(db, daily, date_from="2026-03-03")["total"] == 0
    assert activity(db, daily, date_to="2026-03-01")["total"] == 0
    assert activity(db, daily, project_id=daily.other_project.id)["total"] == 0
    assert activity(db, daily, project_id=uuid4())["total"] == 0
    assert activity(db, daily, date_to="9999-12-31")["total"] == 5


def test_date_boundaries_include_last_microsecond_and_exclude_next_day(db, daily):
    daily.records[0].created_at = datetime(2026, 3, 2, 23, 59, 59, 999999, tzinfo=UTC)
    daily.records[1].created_at = datetime(2026, 3, 3, 0, 0, tzinfo=UTC)
    db.flush()
    assert activity(db, daily, category="development", date_to="2026-03-02")["total"] == 1
    assert activity(db, daily, category="development", date_from="2026-03-03")["total"] == 1


def test_stable_pagination_ties_use_type_then_uuid(db, daily):
    for _ in range(15):
        db.add(
            DiscussionReply(
                id=uuid4(),
                discussion_id=daily.discussion.id,
                author_id=daily.actor.id,
                body="Another own reply",
                created_at=WHEN,
            )
        )
    db.flush()
    full = activity(db, daily, page_size=50)
    pages = [activity(db, daily, page=page, page_size=3) for page in range(1, 8)]
    ids = [item["id"] for page in pages for item in page["items"]]
    assert ids == [item["id"] for item in full["items"]]
    assert len(set(ids)) == 20
    assert all(page["total"] == 20 for page in pages)
    assert activity(db, daily, page=100)["items"] == []
    assert activity(db, daily, page=2, page_size=3) == pages[1]


@pytest.mark.parametrize(
    "params",
    [
        {"page": 0},
        {"page": 1000001},
        {"page_size": 0},
        {"page_size": 51},
        {"category": "github"},
        {"project_id": "not-a-uuid"},
        {"actor_id": "someone-else"},
        {"date_from": "2026-03-04", "date_to": "2026-03-01"},
        {"date_from": "invalid"},
        {"date_to": "2026-03-01T03:00:00Z"},
    ],
)
def test_http_rejects_invalid_or_actor_override_filters(client, params):
    response = client.get("/api/v1/me/activity", params=params)
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"


def test_deleted_discussion_and_its_replies_disappear(db, daily):
    db.execute(delete(DiscussionReply).where(DiscussionReply.discussion_id == daily.discussion.id))
    db.delete(daily.discussion)
    db.flush()
    assert activity(db, daily)["total"] == 3
    assert activity(db, daily, category="discussion")["items"] == []


def test_inconsistent_cross_project_history_is_not_project_content_backdoor(db, daily):
    daily.records[0].task_id = daily.other_task.id
    daily.note.task_id = daily.other_task.id
    daily.evidence.task_id = daily.other_task.id
    db.flush()
    assert activity(db, daily)["total"] == 2


def test_inconsistent_group_course_is_excluded_like_canonical_permission_helper(db, daily):
    other_course = Course(
        id=uuid4(),
        owner_id=daily.users["other_teacher"].id,
        code=str(uuid4()),
        name="Elsewhere",
        college="T",
        semester="T",
    )
    db.add(other_course)
    db.flush()
    group = ProjectGroup(id=uuid4(), course_id=other_course.id, name="Other course group")
    db.add(group)
    db.flush()
    daily.project.group_id = group.id
    db.flush()
    assert activity(db, daily)["total"] == 0
    assert get_home_summary(db, daily.actor)["project_count"] == 0


def test_course_membership_pending_or_left_is_not_counted(db, daily):
    member = db.scalar(select(CourseMember).where(CourseMember.user_id == daily.actor.id))
    for status in ["pending", "left"]:
        member.status = status
        db.flush()
        assert get_home_summary(db, daily.actor)["course_count"] == 0
    member.status = "active"
    member.left_at = WHEN
    db.flush()
    assert get_home_summary(db, daily.actor)["courses"] == []


def test_home_previews_cap_only_items_not_totals_and_query_count_is_bounded(db, daily):
    for index in range(12):
        course = Course(
            id=uuid4(),
            owner_id=daily.users["teacher"].id,
            code=str(uuid4()),
            name=f"C{index}",
            college="T",
            semester="T",
        )
        db.add(course)
        db.flush()
        project = Project(id=uuid4(), course_id=course.id, name=f"P{index}")
        db.add(project)
        db.flush()
        db.add_all(
            [
                ProjectMember(id=uuid4(), project_id=project.id, user_id=daily.actor.id),
                CourseMember(id=uuid4(), course_id=course.id, user_id=daily.actor.id),
            ]
        )
    db.flush()
    statements = []

    def track(_, __, statement, ___, ____, _____):
        statements.append(statement)

    event.listen(db.bind, "before_cursor_execute", track)
    try:
        data = get_home_summary(db, daily.actor)
        home_count = len(statements)
        statements.clear()
        feed = activity(db, daily)
    finally:
        event.remove(db.bind, "before_cursor_execute", track)
    assert home_count == 7
    assert len(statements) == 3
    assert feed["total"] == 5
    assert data["project_count"] == data["course_count"] == 13
    assert len(data["projects"]) == len(data["courses"]) == 10
    expected = list(
        db.scalars(
            select(Project)
            .where(
                Project.id.in_(
                    select(ProjectMember.project_id).where(
                        ProjectMember.user_id == daily.actor.id,
                        ProjectMember.left_at.is_(None),
                    )
                )
            )
            .order_by(Project.updated_at.desc(), Project.id)
            .limit(10)
        )
    )
    assert [item["id"] for item in data["projects"]] == [item.id for item in expected]
    assert any(
        item["progress"] is None and item["progress_status"] == "no_weighted_tasks"
        for item in data["projects"]
    )
    DailyHomeDTO.model_validate(data)
    DailyActivityPageDTO.model_validate(feed)


def test_http_uses_canonical_auth_and_has_no_production_demo_bypass(client, daily, monkeypatch):
    client.app.dependency_overrides.pop(get_current_user)
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("ENABLE_DEMO_AUTH", "true")
    for path in ["/api/v1/home/summary", "/api/v1/me/activity"]:
        response = client.get(path, headers={"X-Demo-User-Id": str(daily.actor.id)})
        assert response.status_code == 401
