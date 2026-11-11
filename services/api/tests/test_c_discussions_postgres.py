"""Actual PostgreSQL races; use the shared UUID-schema fixture, never production data."""

import importlib
from uuid import UUID

import pytest
import test_c_discussions as discussion_tests
import test_c_evidence_postgres as postgres_tests
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import func, inspect, select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.modules.c.discussion_models import DiscussionReply, DiscussionSourceSnapshot
from app.modules.c.discussion_schemas import ReplyDiscussion
from app.modules.c.discussion_service import add_reply, list_replies
from app.modules.c.models import IntegrationOutbox
from app.modules.c.notification_delivery import get_notification_writer

pg_scope = postgres_tests.pg_scope
race = postgres_tests.race


@pytest.fixture()
def inbox_pg_scope():
    # Import A's models before the shared private-schema fixture creates its tables.
    if get_notification_writer() is None:
        pytest.skip("A4 notification provider is not installed")
    yield from pg_scope.__wrapped__()


def test_concurrent_replies_deliver_mentions_and_author_notifications_once(inbox_pg_scope):
    from app.modules.a.models import Notification

    engine, scope = inbox_pg_scope
    writer = get_notification_writer()
    with Session(engine) as session:
        thread = discussion_tests.create(session, scope)
        session.commit()
    thread_id = UUID(thread["id"])
    author_id, teacher_id = (scope.users[name].id for name in ("author", "teacher"))

    def reply(session, actor, body, mentions, key):
        return add_reply(
            session,
            scope.users[actor],
            scope.project.id,
            thread_id,
            ReplyDiscussion(
                expected_version=thread["lock_version"], body=body, mention_user_ids=mentions
            ),
            key,
            writer=writer,
        )["reply"]

    def mention(session):
        return reply(session, "member", "Review the draft.", [teacher_id], "mention")

    def respond(session):
        return reply(session, "leader", "I reviewed the tests.", [], "respond")

    # An interrupted transaction rolls back both operations before the client retries.
    with Session(engine) as session:
        mention(session)
        assert session.scalar(select(func.count()).select_from(Notification)) == 2
        session.rollback()
        assert session.scalar(select(func.count()).select_from(Notification)) == 0
        assert session.scalar(select(func.count()).select_from(DiscussionReply)) == 0

    sent = race(engine, [mention, respond])
    assert all(isinstance(row, dict) for row in sent), sent
    assert race(engine, [mention, respond]) == sent
    mention_id, response_id = (row["id"] for row in sent)
    with Session(engine) as session:
        replies = list_replies(session, scope.users["teacher"], scope.project.id, thread_id)
        assert {row["id"] for row in replies["items"]} == {mention_id, response_id}
        delivered = session.scalars(select(Notification)).all()
        assert len(delivered) == 3
        assert {(row.dedupe_key, row.recipient_id, row.description) for row in delivered} == {
            (f"c:discussion:{mention_id}:{teacher_id}", teacher_id, "你在讨论中被提及。"),
            (f"c:discussion:{mention_id}:{author_id}", author_id, "你的讨论有新回复。"),
            (f"c:discussion:{response_id}:{author_id}", author_id, "你的讨论有新回复。"),
        }
        assert all(
            row.target_json
            == {
                "kind": "discussion",
                "id": str(thread_id),
                "project_id": str(scope.project.id),
                "course_id": None,
            }
            for row in delivered
        )


def test_two_concurrent_replies_with_same_parent_version_both_persist(pg_scope):
    engine, scope = pg_scope
    with Session(engine) as session:
        row = discussion_tests.important(session, scope, discussion_tests.create(session, scope))
        session.commit()

    def reply_a(session):
        return discussion_tests.reply(session, scope, row, actor="member", body="Concurrent A")

    def reply_b(session):
        return discussion_tests.reply(session, scope, row, actor="leader", body="Concurrent B")

    results = race(engine, [reply_a, reply_b])
    assert all(isinstance(result, dict) for result in results), results
    with Session(engine) as session:
        result = list_replies(session, scope.users["teacher"], scope.project.id, UUID(row["id"]))
        assert {r["body"] for r in result["items"]} == {"Concurrent A", "Concurrent B"}
        assert session.scalar(select(func.count()).select_from(DiscussionSourceSnapshot)) == 3
        latest = session.scalar(
            select(DiscussionSourceSnapshot)
            .order_by(DiscussionSourceSnapshot.version_no.desc())
            .limit(1)
        )
        assert len(latest.content_json["replies"]) == 2


def test_concurrent_duplicate_reply_creates_only_one_reply_and_notification(pg_scope):
    engine, scope = pg_scope
    with Session(engine) as session:
        row = discussion_tests.create(session, scope)
        session.commit()

    def reply(session):
        return discussion_tests.reply(session, scope, row, key="same-reply")

    results = race(engine, [reply, reply])
    assert results[0] == results[1]
    with Session(engine) as session:
        assert session.scalar(select(func.count()).select_from(DiscussionReply)) == 1
        requests = list(
            session.scalars(
                select(IntegrationOutbox).where(
                    IntegrationOutbox.event_type == "notification.requested"
                )
            )
        )
        reply_requests = [event for event in requests if event.payload_json["reply_id"]]
        assert len(reply_requests) == 1


def test_concurrent_importance_updates_reject_stale_metadata_version(pg_scope):
    engine, scope = pg_scope
    with Session(engine) as session:
        row = discussion_tests.create(session, scope)
        session.commit()

    def mark(session):
        return discussion_tests.important(session, scope, row)

    results = race(engine, [mark, mark])
    assert sum(isinstance(result, dict) for result in results) == 1
    conflict = next(result for result in results if isinstance(result, ApiError))
    assert conflict.code == "VERSION_CONFLICT"
    with Session(engine) as session:
        assert session.scalar(select(func.count()).select_from(DiscussionSourceSnapshot)) == 1


def test_downgrade_refuses_to_drop_an_unconverted_discussion(pg_scope):
    engine, scope = pg_scope
    with Session(engine) as session:
        row = discussion_tests.create(session, scope)
        session.commit()
    schema = engine.get_execution_options()["schema_translate_map"][None]
    migration = importlib.import_module("migrations.versions.0008_c_discussions")
    with pytest.raises(DBAPIError, match="preserve discussion data"):
        with engine.begin() as connection:
            # The UUID schema is generated by the fixture, not request data.
            connection.exec_driver_sql('SET LOCAL search_path TO "' + schema + '"')
            context = MigrationContext.configure(connection)
            with Operations.context(context):
                migration.downgrade()
    with Session(engine) as session:
        assert (
            discussion_tests.get_discussion(
                session, scope.users["author"], scope.project.id, UUID(row["id"])
            )["title"]
            == "Design discussion"
        )
    assert "discussions" in inspect(engine).get_table_names(schema=schema)
