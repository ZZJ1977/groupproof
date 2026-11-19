"""Exercise notification routing, command replay and rollback at the C/A boundary."""

from uuid import UUID

import pytest
import test_c_course_files as course_files
import test_c_discussions as discussions
import test_c_files as files
from sqlalchemy import select

from app.api.errors import ApiError
from app.modules.c.course_files_schemas import PublishCourseFileVersion
from app.modules.c.course_files_service import publish_version
from app.modules.c.discussion_models import Discussion
from app.modules.c.discussion_schemas import CreateDiscussion, ReplyDiscussion
from app.modules.c.discussion_service import add_reply, create_discussion
from app.modules.c.evidence_router import commit_command
from app.modules.c.files_schemas import DesignateFileVersion
from app.modules.c.files_service import designate_version
from app.modules.c.inbox_schemas import InboxTarget
from app.modules.c.notification_delivery import get_notification_writer

db = discussions.db
scope = course_files.scope


@pytest.fixture
def delivered():
    entries = []
    provider = get_notification_writer()

    def write(session, **kwargs):
        InboxTarget.model_validate(kwargs["target"])
        if provider is not None:
            row = provider(session, **kwargs)
            assert row.recipient_id == kwargs["recipient"]
            assert row.dedupe_key == kwargs["dedupe_key"]
        entries.append(kwargs)

    return entries, write


def test_discussion_and_reply_notify_exact_recipients_once(db, scope, delivered):
    entries, write = delivered
    author, member, teacher = (scope.users[k] for k in ("author", "member", "teacher"))
    create = CreateDiscussion(title="Review", body="Please review", mention_user_ids=[teacher.id])
    for _ in range(2):
        thread = create_discussion(db, author, scope.project.id, create, "new", writer=write)
    assert {r["recipient"] for r in entries} == {member.id, teacher.id, scope.users["leader"].id}
    assert len(entries) == 3
    discussion_id = UUID(thread["id"])
    reply = ReplyDiscussion(
        expected_version=thread["lock_version"], body="Reviewed", mention_user_ids=[author.id]
    )
    for _ in range(2):
        add_reply(db, member, scope.project.id, discussion_id, reply, "reply", writer=write)
    assert len(entries) == 4 and entries[-1]["recipient"] == author.id
    assert all(r["target"]["id"] == discussion_id for r in entries)
    notices = discussions.pending_notifications(db)
    assert len(notices) == 4 and all(r.delivered_at is not None for r in notices)


def test_notification_failure_rolls_back_discussion_and_receipt(db, scope):
    def unavailable(*args, **kwargs):
        raise ApiError(503, "INBOX_WRITE_UNAVAILABLE", "Inbox write failed.")

    with pytest.raises(ApiError):
        commit_command(
            db,
            lambda: create_discussion(
                db,
                scope.users["author"],
                scope.project.id,
                CreateDiscussion(title="Rollback", body="Rollback test"),
                "rollback",
                writer=unavailable,
            ),
        )
    assert db.scalar(select(Discussion).where(Discussion.project_id == scope.project.id)) is None
    assert discussions.pending_notifications(db) == []


def test_project_official_version_notifies_current_members_once(db, scope, delivered):
    entries, write = delivered
    storage = files.StorageFake(scope)
    row = files.create(db, scope, storage)
    command = DesignateFileVersion(
        version_id=row["versions"][0]["id"],
        expected_version=row["lock_version"],
        reason="Reviewed by project",
    )
    for _ in range(2):
        designate_version(
            db,
            scope.users["leader"],
            scope.project.id,
            UUID(row["id"]),
            command,
            "official",
            writer=write,
        )
    assert {r["recipient"] for r in entries} == {scope.users["author"].id, scope.users["member"].id}
    assert len(entries) == 2 and all(r["target"]["project_id"] == scope.project.id for r in entries)


def test_course_publication_excludes_disabled_members_and_foreign_students(db, scope, delivered):
    entries, write = delivered
    scope.users["member"].status = "disabled"
    row = course_files.create(db, scope, course_files.StorageFake(scope))
    command = PublishCourseFileVersion(
        version_id=row["versions"][0]["id"],
        expected_version=row["lock_version"],
        reason="Course requirements",
    )
    for _ in range(2):
        publish_version(
            db,
            scope.users["teacher"],
            scope.course.id,
            UUID(row["id"]),
            command,
            "official",
            writer=write,
        )
    assert {r["recipient"] for r in entries} == {scope.users["author"].id, scope.users["ta"].id}
    assert len(entries) == 2 and all(r["target"]["course_id"] == scope.course.id for r in entries)
