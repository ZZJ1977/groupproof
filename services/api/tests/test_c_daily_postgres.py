"""C1 PostgreSQL queries against an isolated schema, never a SQLite stand-in.

Root schedules execution with C_TEST_DATABASE_URL. The reused fixture only drops
its own UUID-named schema; these tests do not claim Alembic migration coverage.
"""

from datetime import UTC, datetime, timedelta, timezone
from uuid import UUID, uuid4

import pytest
import test_c_evidence_postgres as postgres_tests
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.db.models import CourseMember, ProgressEvent, Project, ProjectMember, Task, TaskAssignee
from app.modules.c.daily_schemas import DailyActivityFilters, DailyActivityPageDTO, DailyHomeDTO
from app.modules.c.daily_service import get_home_summary, list_personal_activity
from app.modules.c.discussion_models import Discussion, DiscussionReply
from app.modules.c.models import Evidence, EvidenceDecision, TaskNote, TaskNoteVersion
from app.modules.c.task_execution import SqlExecutionRepository, TaskExecutionService

pg_scope = postgres_tests.pg_scope
INSTANT = datetime(2026, 3, 2, 23, 59, 59, 999999, tzinfo=UTC)


def ensure_assignment(session, scope):
    """Reuse canonical fixture relations when present; never insert duplicate PKs."""
    actor_id = scope.users["author"].id
    assigned = session.get(TaskAssignee, (scope.task.id, actor_id))
    if assigned is None:
        session.add(TaskAssignee(task_id=scope.task.id, user_id=actor_id, role="responsible"))
    else:
        assigned.role, assigned.unassigned_at = "responsible", None
    member = session.scalar(
        select(CourseMember).where(
            CourseMember.course_id == scope.course.id, CourseMember.user_id == actor_id
        )
    )
    if member is None:
        session.add(CourseMember(id=uuid4(), course_id=scope.course.id, user_id=actor_id))
    else:
        member.status, member.left_at = "active", None


@pytest.fixture()
def daily_pg(pg_scope):
    engine, scope = pg_scope
    actor_id = scope.users["author"].id
    # Store a +08:00 representation and verify PG compares the underlying instant.
    local_time = INSTANT.astimezone(timezone(timedelta(hours=8)))
    with Session(engine) as session:
        ensure_assignment(session, scope)
        discussion = Discussion(
            id=uuid4(),
            project_id=scope.project.id,
            author_id=actor_id,
            title="PG discussion",
            body="Only the title belongs in the feed",
            created_at=local_time,
            updated_at=local_time + timedelta(days=2),
        )
        evidence = Evidence(
            id=uuid4(),
            project_id=scope.project.id,
            task_id=scope.task.id,
            author_id=actor_id,
            title="PG evidence",
            description="Source details",
            source_type="manual",
            status="candidate",
            created_at=local_time,
        )
        note = TaskNote(id=uuid4(), project_id=scope.project.id, task_id=scope.task.id)
        session.add_all([discussion, evidence, note])
        session.flush()
        session.add_all(
            [
                ProgressEvent(
                    id=uuid4(),
                    project_id=scope.project.id,
                    task_id=scope.task.id,
                    actor_id=actor_id,
                    progress_before=0,
                    progress_after=20,
                    created_at=local_time,
                ),
                TaskNoteVersion(
                    id=uuid4(),
                    note_id=note.id,
                    version_no=1,
                    edited_by=actor_id,
                    title="PG note",
                    body="Version content",
                    content_hash="a" * 64,
                    created_at=local_time,
                ),
                EvidenceDecision(
                    id=uuid4(),
                    evidence_id=evidence.id,
                    actor_id=actor_id,
                    decision="submitted",
                    resulting_status="candidate",
                    reason="A real actor event",
                    created_at=local_time,
                ),
                DiscussionReply(
                    id=uuid4(),
                    discussion_id=discussion.id,
                    author_id=actor_id,
                    body="Own reply",
                    created_at=local_time,
                ),
                # Same project and timestamp must not make another actor's event visible.
                DiscussionReply(
                    id=uuid4(),
                    discussion_id=discussion.id,
                    author_id=scope.users["member"].id,
                    body="Other actor reply",
                    created_at=local_time,
                ),
            ]
        )
        session.commit()
    return engine, scope


def test_pg_union_uuid_aware_timestamps_and_stable_pagination(daily_pg):
    engine, scope = daily_pg
    actor = scope.users["author"]
    with Session(engine) as session:
        filters = dict(date_from="2026-03-02", date_to="2026-03-02")
        full = list_personal_activity(session, actor, DailyActivityFilters(**filters, page_size=50))
        pages = [
            list_personal_activity(
                session, actor, DailyActivityFilters(**filters, page=page, page_size=2)
            )
            for page in range(1, 4)
        ]
        assert full["total"] == 5
        assert [len(page["items"]) for page in pages] == [2, 2, 1]
        assert [item["id"] for page in pages for item in page["items"]] == [
            item["id"] for item in full["items"]
        ]
        assert {item["event_type"] for item in full["items"]} == {
            "task_progress",
            "task_note_saved",
            "evidence_submitted",
            "discussion_created",
            "discussion_replied",
        }
        ordering = []
        for item in full["items"]:
            assert isinstance(item["project_id"], UUID)
            assert isinstance(item["object_id"], UUID)
            assert item["occurred_at"].utcoffset() is not None
            assert item["occurred_at"] == INSTANT
            assert item["href"].startswith(f"/projects/{scope.project.id}/")
            event_type, event_id = item["id"].split(":", 1)
            ordering.append((event_type, UUID(event_id)))
        assert ordering == sorted(ordering)
        DailyActivityPageDTO.model_validate(full)
        # +08:00 storage text is March 3, while UTC calendar filtering remains March 2.
        next_day = list_personal_activity(
            session, actor, DailyActivityFilters(date_from="2026-03-03", date_to="2026-03-03")
        )
        assert next_day["total"] == 0
        development = list_personal_activity(
            session,
            actor,
            DailyActivityFilters(**filters, project_id=scope.project.id, category="development"),
        )
        assert development["total"] == 2
        inaccessible = list_personal_activity(
            session, actor, DailyActivityFilters(**filters, project_id=scope.other_project.id)
        )
        assert inaccessible["total"] == 0


def test_pg_current_membership_revocation_hides_existing_history_and_counts(daily_pg):
    engine, scope = daily_pg
    actor = scope.users["author"]
    with Session(engine) as reader:
        assert list_personal_activity(reader, actor, DailyActivityFilters())["total"] == 5
        assert get_home_summary(reader, actor)["project_count"] == 1
        # A separate committed writer exercises fresh SQL relationship checks,
        # rather than mutating an object already in the reader's identity map.
        with Session(engine) as writer:
            writer.execute(
                update(ProjectMember)
                .where(
                    ProjectMember.project_id == scope.project.id,
                    ProjectMember.user_id == actor.id,
                )
                .values(left_at=datetime.now(UTC))
            )
            writer.commit()
        activity = list_personal_activity(reader, actor, DailyActivityFilters())
        home = get_home_summary(reader, actor)
        assert activity["items"] == [] and activity["total"] == 0
        assert home["project_count"] == home["my_task_count"] == home["my_completed_tasks"] == 0
        assert home["projects"] == []
        assert home["course_count"] == 1  # Course membership is an independent real relation.


def test_pg_home_tree_weighting_counts_roots_once_and_empty_progress_is_null(pg_scope):
    engine, scope = pg_scope
    actor = scope.users["author"]
    empty_id = uuid4()
    with Session(engine) as session:
        ensure_assignment(session, scope)
        parent = session.get(Task, scope.task.id)
        parent.progress_percent, parent.weight = 0, 1
        session.add_all(
            [
                Task(
                    id=uuid4(),
                    project_id=scope.project.id,
                    module_id=parent.module_id,
                    parent_task_id=parent.id,
                    title="Completed child",
                    progress_percent=100,
                    weight=1,
                ),
                Task(
                    id=uuid4(),
                    project_id=scope.project.id,
                    module_id=parent.module_id,
                    title="Incomplete root",
                    progress_percent=0,
                    weight=3,
                ),
                Project(id=empty_id, course_id=scope.course.id, name="No tasks yet"),
            ]
        )
        session.flush()
        session.add(ProjectMember(id=uuid4(), project_id=empty_id, user_id=actor.id))
        session.commit()
    with Session(engine) as session:
        home = get_home_summary(session, actor)
        projects = {item["id"]: item for item in home["projects"]}
        assert projects[scope.project.id]["progress"] == 25
        assert projects[scope.project.id]["progress_status"] == "available"
        assert projects[empty_id]["progress"] is None
        assert projects[empty_id]["progress_status"] == "no_weighted_tasks"
        assert home["project_count"] == 2 and home["my_task_count"] == 1
        assert home["unread_notifications"] is home["pending_action_items"] is None
        DailyHomeDTO.model_validate(home)


def test_pg_task_update_refreshes_existing_read_session_statistics_and_feed(daily_pg):
    engine, scope = daily_pg
    actor = scope.users["author"]
    with Session(engine) as reader:
        # Retain the loaded ORM task so this also catches stale identity-map projections.
        retained_task = reader.get(Task, scope.task.id)
        before = get_home_summary(reader, actor)
        before_total = list_personal_activity(reader, actor, DailyActivityFilters())["total"]
        assert before["projects"][0]["progress"] == 0
        with Session(engine) as writer:
            changed = TaskExecutionService(SqlExecutionRepository(writer)).update_progress(
                scope.task.id, actor, retained_task.lock_version, 100, "Finished implementation"
            )
        after = get_home_summary(reader, actor)
        assert changed.project_progress == after["projects"][0]["progress"] == 100
        assert retained_task.progress_percent == 100
        assert after["my_completed_tasks"] == 0  # A 100% progress update is not acceptance.
        assert after["task_counts"]["in_progress"] == 1
        assert list_personal_activity(reader, actor, DailyActivityFilters())["total"] == (
            before_total + 1
        )
        # Exercise the summary against a separately persisted canonical completed state;
        # this direct fixture write does not claim a D verification integration.
        with Session(engine) as writer:
            writer.execute(update(Task).where(Task.id == scope.task.id).values(status="completed"))
            writer.commit()
        completed = get_home_summary(reader, actor)
        assert completed["my_completed_tasks"] == 1
        assert completed["task_counts"]["in_progress"] == 0
