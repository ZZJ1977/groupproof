"""B writes serialize with C execution and course closure using real PostgreSQL locks."""

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from queue import Queue
from time import monotonic, sleep

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import Course, Project, ProjectMember, User
from app.modules.b.requirements_service import require_draft_writer
from tests.b_fixtures import b_postgres_schema, b_test_database_url, build_b_world


@pytest.fixture
def world():
    with b_postgres_schema(b_test_database_url()) as engine:
        with Session(engine) as session:
            data = build_b_world(session)
            session.commit()
        yield engine, data


def test_course_cannot_end_between_b_write_authorization_and_commit(world):
    engine, data = world
    with Session(engine) as writer, Session(engine) as closer:
        require_draft_writer(writer, writer.get(User, data.leader_id), data.project_id)
        closer.execute(text("SET LOCAL lock_timeout = '100ms'"))
        with pytest.raises(DBAPIError):
            closer.execute(
                text("UPDATE courses SET status='ended' WHERE id=:id"), {"id": data.course_id}
            )
        closer.rollback()
        writer.rollback()
        closer.get(Course, data.course_id).status = "ended"
        closer.commit()
        with pytest.raises(ApiError) as blocked:
            require_draft_writer(writer, writer.get(User, data.leader_id), data.project_id)
        assert blocked.value.code == "PROJECT_READ_ONLY"


def test_member_removed_while_waiting_for_project_lock_cannot_write(world):
    engine, data = world
    ready = Queue()

    def attempt():
        with Session(engine) as writer:
            ready.put(writer.scalar(text("SELECT pg_backend_pid()")))
            return require_draft_writer(
                writer, writer.get(User, data.member_ids[0]), data.project_id
            )

    with Session(engine) as owner, ThreadPoolExecutor(max_workers=1) as pool:
        owner.scalar(select(Project).where(Project.id == data.project_id).with_for_update())
        future = pool.submit(attempt)
        pid = ready.get(timeout=5)
        deadline = monotonic() + 5
        while monotonic() < deadline:
            if owner.scalar(
                text("SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid=:pid AND NOT granted)"),
                {"pid": pid},
            ):
                break
            sleep(0.01)
        else:
            owner.rollback()
            pytest.fail("B writer did not wait for the held project row")
        member = owner.scalar(
            select(ProjectMember).where(
                ProjectMember.project_id == data.project_id,
                ProjectMember.user_id == data.member_ids[0],
                ProjectMember.left_at.is_(None),
            )
        )
        member.left_at = datetime.now(UTC)
        owner.commit()
        with pytest.raises(ApiError) as blocked:
            future.result(timeout=5)
        assert blocked.value.code in {"PROJECT_NOT_FOUND", "PROJECT_MEMBER_REQUIRED"}
