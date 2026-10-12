"""Real relational authorization/pagination tests; SQLite is not PG locking proof."""

from datetime import UTC, datetime
from uuid import uuid4

import pytest
import test_c_discussions as discussion_tests
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.api.auth import get_current_user
from app.api.errors import install_exception_handlers
from app.db.models import ProgressEvent, ProjectMember
from app.db.session import get_session
from app.main import request_context
from app.modules.c.execution_history_router import router

db = discussion_tests.db
scope = discussion_tests.scope


@pytest.fixture()
def client(db, scope):
    app = FastAPI()
    app.middleware("http")(request_context)
    install_exception_handlers(app)
    app.include_router(router, prefix="/api/v1")
    app.dependency_overrides[get_session] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: scope.users["author"]
    with TestClient(app) as result:
        yield result


def endpoint(scope):
    return f"/api/v1/projects/{scope.project.id}/tasks/{scope.task.id}/progress-history"


def add_event(db, scope, *, task=None, project=None, reason="Saved progress"):
    event = ProgressEvent(
        id=uuid4(),
        project_id=(project or scope.project).id,
        task_id=(task or scope.task).id,
        actor_id=scope.users["author"].id,
        from_status="in_progress",
        to_status="in_progress",
        progress_before=0,
        progress_after=40,
        reason=reason,
        created_at=datetime(2026, 10, 12, tzinfo=UTC),
    )
    db.add(event)
    db.flush()
    return event


def test_history_stable_paging_and_no_foreign_project_rows(client, db, scope):
    events = [add_event(db, scope) for _ in range(3)]
    add_event(db, scope, task=scope.other_task, project=scope.other_project, reason="Other project")
    expected = sorted(str(event.id) for event in events)
    result = client.get(endpoint(scope) + "?page=2&page_size=1")
    assert result.status_code == 200
    assert result.headers["Cache-Control"] == "private, no-store"
    data = result.json()["data"]
    assert data["total"] == 3
    assert data["items"][0]["id"] == expected[1]
    assert data["items"][0]["reason"] == "Saved progress"
    assert "actor_id" not in data["items"][0]
    assert client.get(endpoint(scope) + "?page=9&page_size=1").json()["data"]["items"] == []


def test_mismatched_task_and_deleted_task_do_not_reveal_history(client, db, scope):
    result = client.get(endpoint(scope).replace(str(scope.task.id), str(scope.other_task.id)))
    assert result.status_code == 404
    assert client.get(endpoint(scope).replace(str(scope.task.id), str(uuid4()))).status_code == 404


def test_current_membership_rechecked_after_revocation(client, db, scope):
    add_event(db, scope)
    assert client.get(endpoint(scope)).status_code == 200
    member = db.scalar(
        select(ProjectMember).where(
            ProjectMember.project_id == scope.project.id,
            ProjectMember.user_id == scope.users["author"].id,
        )
    )
    member.left_at = datetime.now(UTC)
    db.flush()
    assert client.get(endpoint(scope)).status_code == 403


def test_disabled_actor_denied_and_archived_project_readable(client, db, scope):
    scope.project.lifecycle = "archived"
    scope.course.status = "ended"
    db.flush()
    assert client.get(endpoint(scope)).status_code == 200
    scope.users["author"].status = "disabled"
    db.flush()
    assert client.get(endpoint(scope)).status_code == 403


@pytest.mark.parametrize("query", ["page=0", "page_size=0", "page_size=101"])
def test_pagination_bounds(client, scope, query):
    assert client.get(endpoint(scope) + "?" + query).status_code == 422
