"""SQLAlchemy service tests; SQLite is explicitly not PostgreSQL locking coverage."""

from __future__ import annotations

import os
from uuid import UUID, uuid4

import pytest
import test_c_evidence as evidence_tests
from pydantic import ValidationError
from sqlalchemy import JSON, MetaData, create_engine, event, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.api.errors import ApiError
from app.db.base import Base
from app.db.models import Milestone, Requirement
from app.modules.c import discussion_service
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
from app.modules.c.discussion_service import (
    add_reply,
    create_discussion,
    get_discussion,
    list_discussions,
    list_replies,
    mark_important,
    resolve_discussion_source,
)
from app.modules.c.models import IntegrationOutbox, RequestIdempotency

scope = evidence_tests.scope
count = evidence_tests.count


@pytest.fixture()
def db():
    url = os.getenv("C_TEST_DATABASE_URL")
    if url:
        engine = create_engine(url)
    else:
        engine = create_engine(
            "sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False}
        )

        @event.listens_for(engine, "connect")
        def enforce_foreign_keys(connection, _):
            connection.execute("PRAGMA foreign_keys=ON")

        metadata = MetaData()
        for table in Base.metadata.sorted_tables:
            portable = table.to_metadata(metadata)
            for column in portable.columns:
                if isinstance(column.type, JSONB):
                    column.type = JSON()
                if (
                    column.server_default is not None
                    and str(column.server_default.arg) == "gen_random_uuid()"
                ):
                    column.server_default = None
        metadata.create_all(engine)
    with engine.connect() as connection:
        transaction = connection.begin()
        session = Session(
            connection, expire_on_commit=False, join_transaction_mode="create_savepoint"
        )
        try:
            yield session
        finally:
            session.close()
            transaction.rollback()
    engine.dispose()


@pytest.fixture()
def linked_scope(db, scope):
    requirement = Requirement(
        id=uuid4(),
        project_id=scope.project.id,
        module_id=scope.task.module_id,
        title="Discuss requirement",
    )
    other_requirement = Requirement(
        id=uuid4(),
        project_id=scope.other_project.id,
        module_id=scope.other_task.module_id,
        title="Other requirement",
    )
    milestone = Milestone(id=uuid4(), project_id=scope.project.id, title="First milestone")
    other_milestone = Milestone(
        id=uuid4(), project_id=scope.other_project.id, title="Other milestone"
    )
    db.add_all([requirement, other_requirement, milestone, other_milestone])
    db.flush()
    scope.requirement = requirement
    scope.other_requirement = other_requirement
    scope.milestone = milestone
    scope.other_milestone = other_milestone
    return scope


def create(db, scope, *, actor="author", key=None, **values):
    payload = {"title": "Design discussion", "body": "How should we implement this?", **values}
    return create_discussion(
        db, scope.users[actor], scope.project.id, CreateDiscussion(**payload), key or str(uuid4())
    )


def reply(db, scope, row, *, actor="member", key=None, **values):
    payload = {
        "expected_version": row["lock_version"],
        "body": "I suggest a concrete plan.",
        **values,
    }
    return add_reply(
        db,
        scope.users[actor],
        scope.project.id,
        UUID(row["id"]),
        ReplyDiscussion(**payload),
        key or str(uuid4()),
    )


def important(db, scope, row, *, actor="author", value=True, key=None):
    return mark_important(
        db,
        scope.users[actor],
        scope.project.id,
        UUID(row["id"]),
        MarkDiscussionImportant(
            expected_version=row["lock_version"],
            is_important=value,
            reason="This thread records the implementation decision.",
        ),
        key or str(uuid4()),
    )


def pending_notifications(db):
    return list(
        db.scalars(
            select(IntegrationOutbox).where(
                IntegrationOutbox.event_type == "notification.requested"
            )
        )
    )


def test_create_linked_thread_persists_mentions_audit_and_pending_notifications(db, linked_scope):
    s = linked_scope
    row = create(
        db,
        s,
        task_id=s.task.id,
        requirement_id=s.requirement.id,
        module_id=s.task.module_id,
        milestone_id=s.milestone.id,
        mention_user_ids=[s.users["teacher"].id],
    )
    assert row["author_id"] == str(s.users["author"].id)
    assert row["task_id"] == str(s.task.id) and row["milestone_id"] == str(s.milestone.id)
    assert count(db, Discussion) == count(db, DiscussionMention) == 1
    notifications = pending_notifications(db)
    assert {r.payload_json["recipient_id"] for r in notifications} == {
        str(s.users["member"].id),
        str(s.users["leader"].id),
        str(s.users["teacher"].id),
    }
    assert all(
        r.delivered_at is None and r.payload_json["delivery_status"] == "pending"
        for r in notifications
    )
    assert (
        db.scalar(
            select(IntegrationOutbox).where(IntegrationOutbox.event_type == "discussion.created")
        )
        is not None
    )


@pytest.mark.parametrize("field", ["task_id", "requirement_id", "module_id", "milestone_id"])
def test_links_reject_foreign_project_objects_without_any_side_effects(db, linked_scope, field):
    s = linked_scope
    foreign = {
        "task_id": s.other_task.id,
        "requirement_id": s.other_requirement.id,
        "module_id": s.other_task.module_id,
        "milestone_id": s.other_milestone.id,
    }
    with pytest.raises(ApiError) as error:
        with db.begin_nested():
            create(db, s, **{field: foreign[field]})
    assert error.value.code == "DISCUSSION_LINK_MISMATCH"
    assert (
        count(db, Discussion) == count(db, RequestIdempotency) == count(db, IntegrationOutbox) == 0
    )


@pytest.mark.parametrize("actor", ["outsider", "other_teacher", "admin"])
def test_mentions_cannot_notify_users_without_project_read_access(db, scope, actor):
    with pytest.raises(ApiError) as error:
        with db.begin_nested():
            create(db, scope, mention_user_ids=[scope.users[actor].id])
    assert error.value.code == "DISCUSSION_MENTION_INVALID"
    assert count(db, Discussion) == 0


def test_create_and_reply_retry_do_not_duplicate_rows_or_notifications(db, scope):
    row = create(db, scope, key="create-once")
    assert create(db, scope, key="create-once") == row
    first = reply(db, scope, row, key="reply-once", mention_user_ids=[scope.users["teacher"].id])
    assert (
        reply(db, scope, row, key="reply-once", mention_user_ids=[scope.users["teacher"].id])
        == first
    )
    assert (
        count(db, Discussion)
        == count(db, DiscussionReply)
        == count(db, DiscussionReplyMention)
        == 1
    )
    assert len(pending_notifications(db)) == 4  # two members; author and teacher for the reply
    with pytest.raises(ApiError) as error:
        with db.begin_nested():
            reply(db, scope, row, key="reply-once", body="Different body")
    assert error.value.code == "IDEMPOTENCY_CONFLICT"


def test_same_parent_version_accepts_two_independent_reply_appends(db, scope):
    row = create(db, scope)
    first = reply(db, scope, row, body="Reply A")
    second = reply(db, scope, row, body="Reply B", actor="leader")
    assert first["reply"]["id"] != second["reply"]["id"]
    assert second["discussion"]["lock_version"] == 0
    assert second["discussion"]["reply_count"] == 2
    replies = list_replies(db, scope.users["teacher"], scope.project.id, UUID(row["id"]))
    assert {item["body"] for item in replies["items"]} == {"Reply A", "Reply B"}


def test_importance_change_rejects_reply_with_stale_parent_version(db, scope):
    row = create(db, scope)
    important(db, scope, row)
    with pytest.raises(ApiError) as error:
        with db.begin_nested():
            reply(db, scope, row)
    assert error.value.code == "VERSION_CONFLICT"
    assert count(db, DiscussionReply) == 0


@pytest.mark.parametrize("actor", ["author", "leader", "teacher"])
def test_author_leader_teacher_may_mark_important(db, scope, actor):
    row = create(db, scope)
    result = important(db, scope, row, actor=actor)
    assert result["is_important"] and result["lock_version"] == 1
    assert result["evidence_source_id"] == row["id"] and result["source_snapshot_id"]


@pytest.mark.parametrize("actor", ["member", "ta", "outsider", "other_teacher", "admin"])
def test_unauthorized_importance_change_is_rejected(db, scope, actor):
    row = create(db, scope)
    with pytest.raises(ApiError) as error:
        important(db, scope, row, actor=actor)
    assert error.value.status_code == 403
    assert count(db, DiscussionSourceSnapshot) == 0


def test_snapshot_revisions_preserve_old_thread_and_revoke_new_evidence_eligibility(db, scope):
    row = important(db, scope, create(db, scope))
    original = resolve_discussion_source(
        db, scope.users["author"], scope.project.id, UUID(row["id"])
    )
    replied = reply(db, scope, row, body="Additional reasoning")
    newer = resolve_discussion_source(db, scope.users["teacher"], scope.project.id, UUID(row["id"]))
    assert newer.identity == original.identity and newer.revision != original.revision
    assert original.content["replies"] == [] and len(newer.content["replies"]) == 1
    unmarked = important(db, scope, replied["discussion"], value=False)
    assert unmarked["evidence_source_id"] is None
    with pytest.raises(ApiError) as error:
        resolve_discussion_source(db, scope.users["author"], scope.project.id, UUID(row["id"]))
    assert error.value.code == "DISCUSSION_NOT_IMPORTANT"
    retained = resolve_discussion_source(
        db, scope.users["author"], scope.project.id, UUID(row["id"]), require_important=False
    )
    assert retained.content["is_important"] is False
    assert db.get(DiscussionSourceSnapshot, UUID(original.revision)).content_json["replies"] == []
    events = list(
        db.scalars(
            select(IntegrationOutbox).where(
                IntegrationOutbox.event_type == "discussion.source_changed"
            )
        )
    )
    assert len(events) == 3 and all(event.delivered_at is None for event in events)


def test_outbox_failure_rolls_back_discussion_mentions_and_idempotency(db, scope, monkeypatch):
    def fail(*args, **kwargs):
        raise RuntimeError("outbox unavailable")

    monkeypatch.setattr(discussion_service, "emit_event", fail)
    with pytest.raises(RuntimeError):
        with db.begin_nested():
            create(db, scope, mention_user_ids=[scope.users["member"].id])
    assert (
        count(db, Discussion) == count(db, DiscussionMention) == count(db, RequestIdempotency) == 0
    )


def test_discussion_is_available_during_planning_before_baseline_freeze(db, scope):
    scope.project.setup_status = "draft"
    scope.plan.status = "draft"
    db.flush()
    assert create(db, scope)["status"] == "open"


@pytest.mark.parametrize("kind", ["unverified", "archived", "course_ended", "ta"])
def test_read_only_or_unverified_actors_cannot_write(db, scope, kind):
    if kind == "unverified":
        scope.users["author"].email_binding.verified_at = None
    elif kind == "archived":
        scope.project.lifecycle = "archived"
    elif kind == "course_ended":
        scope.course.status = "ended"
    db.flush()
    with pytest.raises(ApiError) as error:
        create(db, scope, actor="ta" if kind == "ta" else "author")
    assert error.value.status_code == 403
    assert count(db, Discussion) == 0


def test_ta_reads_thread_and_filters_apply_before_pagination(db, scope):
    create(db, scope, title="Architecture", task_id=scope.task.id)
    create(db, scope, title="Other topic")
    result = list_discussions(
        db,
        scope.users["ta"],
        scope.project.id,
        task_id=scope.task.id,
        q="Architecture",
        page=1,
        page_size=1,
    )
    assert result["total"] == 1 and result["page_size"] == 1
    assert (
        get_discussion(db, scope.users["ta"], scope.project.id, UUID(result["items"][0]["id"]))[
            "title"
        ]
        == "Architecture"
    )


def test_extra_author_and_duplicate_mentions_are_rejected():
    with pytest.raises(ValidationError):
        CreateDiscussion(title="A", body="B", author_id=uuid4())
    target = uuid4()
    with pytest.raises(ValidationError):
        ReplyDiscussion(expected_version=0, body="Hello", mention_user_ids=[target, target])
    with pytest.raises(ValidationError):
        MarkDiscussionImportant(expected_version=0, is_important=True, reason="   ")


def test_cross_project_discussion_cannot_be_read_or_replied(db, scope):
    row = create(db, scope)
    for operation in [
        lambda: get_discussion(
            db, scope.users["outsider"], scope.other_project.id, UUID(row["id"])
        ),
        lambda: add_reply(
            db,
            scope.users["outsider"],
            scope.other_project.id,
            UUID(row["id"]),
            ReplyDiscussion(expected_version=0, body="cross project"),
            "cross-project",
        ),
    ]:
        with pytest.raises(ApiError) as error:
            with db.begin_nested():
                operation()
        assert error.value.code == "DISCUSSION_NOT_FOUND"


@pytest.mark.parametrize("change", ["reply", "unmark"])
def test_important_discussion_evidence_is_invalidated_in_same_local_transaction(db, scope, change):
    from app.modules.c.evidence_schemas import CreateEvidence, DecideEvidence
    from app.modules.c.evidence_service import create_evidence, decide_evidence, list_evidence
    from app.modules.c.models import Evidence, EvidenceSourceSnapshot
    from app.modules.c.source_ports import UnavailableSourcePort

    thread = important(db, scope, create(db, scope, task_id=scope.task.id))
    candidate = create_evidence(
        db,
        scope.users["author"],
        scope.project.id,
        CreateEvidence(
            task_id=scope.task.id,
            title="Agreed implementation",
            description="Decision",
            source_type="discussion",
            source_id=UUID(thread["id"]),
            criterion_ids=[scope.criterion.id],
        ),
        "discussion-evidence",
        UnavailableSourcePort(),
    )
    adopted = decide_evidence(
        db,
        scope.users["author"],
        scope.project.id,
        UUID(candidate["id"]),
        DecideEvidence(expected_version=0, reason="Checked the recorded decision"),
        "adopt-discussion-evidence",
        decision="adopted",
    )
    old_snapshot = db.scalar(
        select(EvidenceSourceSnapshot).where(
            EvidenceSourceSnapshot.evidence_id == UUID(adopted["id"]),
            EvidenceSourceSnapshot.version_no == 1,
        )
    )
    original_content = old_snapshot.content_json.copy()
    assert (
        list_evidence(db, scope.users["teacher"], scope.project.id, effective_only=True)["total"]
        == 1
    )
    if change == "reply":
        reply(db, scope, thread, body="The decision now needs another constraint.")
    else:
        important(db, scope, thread, value=False)
    evidence = db.get(Evidence, UUID(adopted["id"]))
    assert evidence.status == "formal" and evidence.source_changed
    assert (
        list_evidence(db, scope.users["teacher"], scope.project.id, effective_only=True)["total"]
        == 0
    )
    db.refresh(old_snapshot)
    assert old_snapshot.content_json == original_content
    assert (
        db.scalar(
            select(IntegrationOutbox).where(
                IntegrationOutbox.aggregate_id == evidence.id,
                IntegrationOutbox.event_type == "evidence.source_changed",
            )
        )
        is not None
    )
