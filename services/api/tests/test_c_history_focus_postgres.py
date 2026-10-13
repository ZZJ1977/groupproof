"""Focused history paging uses actual PostgreSQL UUID/window query semantics."""

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
import test_c_evidence_postgres as postgres_tests
from sqlalchemy import update
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import ProgressEvent, ProjectMember
from app.modules.c.discussion_models import Discussion, DiscussionReply
from app.modules.c.discussion_service import list_replies
from app.modules.c.execution_history_router import list_progress_history

pg_scope = postgres_tests.pg_scope


@pytest.mark.parametrize("kind", ["reply", "progress"])
def test_pg_focus_window_current_page_uuid_ties_and_revocation(pg_scope, kind):
    engine, scope = pg_scope
    actor = scope.users["author"]
    instant = datetime(2026, 10, 14, tzinfo=UTC)
    ids = sorted(uuid4() for _ in range(13))
    discussion_id = uuid4()

    def row(identifier, occurred_at):
        if kind == "reply":
            return DiscussionReply(
                id=identifier,
                discussion_id=discussion_id,
                author_id=actor.id,
                body="Persisted reply",
                created_at=occurred_at,
            )
        return ProgressEvent(
            id=identifier,
            project_id=scope.project.id,
            task_id=scope.task.id,
            actor_id=actor.id,
            progress_before=10,
            progress_after=20,
            reason="Persisted progress",
            created_at=occurred_at,
        )

    def read(session, focus):
        if kind == "reply":
            return list_replies(
                session,
                actor,
                scope.project.id,
                discussion_id,
                page=99,
                page_size=5,
                focus_reply_id=focus,
            )
        return list_progress_history(
            session,
            actor,
            scope.project.id,
            scope.task.id,
            page=99,
            page_size=5,
            focus_event_id=focus,
        )

    with Session(engine) as writer:
        if kind == "reply":
            writer.add(
                Discussion(
                    id=discussion_id,
                    project_id=scope.project.id,
                    author_id=actor.id,
                    title="Focus target",
                    body="Only current project readers may locate replies.",
                )
            )
            writer.flush()
        writer.add_all(row(identifier, instant) for identifier in ids)
        writer.commit()

    with Session(engine) as reader:
        before = read(reader, ids[-1])
        assert before["page"] == 3 and before["total"] == 13
        assert [UUID(str(item["id"])) for item in before["items"]] == ids[10:]
        with Session(engine) as writer:
            # Earlier reply / newer progress sorts before the target even when
            # inserted after the reader's first call. Keep the same focus URL.
            new_time = instant + timedelta(days=-1 if kind == "reply" else 1)
            writer.add_all(row(uuid4(), new_time) for _ in range(5))
            writer.commit()
        after = read(reader, ids[-1])
        assert after["page"] == 4 and after["total"] == 18
        assert [UUID(str(item["id"])) for item in after["items"]] == ids[10:]
        with pytest.raises(ApiError) as missing:
            read(reader, uuid4())
        assert missing.value.status_code == 404
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
        with pytest.raises(ApiError) as denied:
            read(reader, ids[-1])
        assert denied.value.status_code == 403
