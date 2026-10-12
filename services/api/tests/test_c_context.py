"""C selector reads never grant mutation authority or expose unrelated objects."""

import pytest
import test_c_discussions as fixtures
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.auth import get_current_user
from app.api.errors import ApiError, install_exception_handlers
from app.db.session import get_session
from app.main import request_context
from app.modules.c.context_router import CProjectContextDTO, project_context, router

db = fixtures.db
scope = fixtures.scope


def test_context_contains_real_tasks_criteria_without_private_user_fields(db, scope):
    result = project_context(db, scope.users["author"], scope.project.id)
    dto = CProjectContextDTO.model_validate(result)
    assert dto.project.id == scope.project.id
    task = next(task for task in dto.tasks if task.id == scope.task.id)
    assert task.criteria and task.can_capture_evidence and task.can_associate
    assert dto.permissions.can_manage_files and dto.permissions.can_discuss
    assert all(set(member) == {"id", "title"} for member in result["members"])
    assert "email" not in dto.model_dump_json()


@pytest.mark.parametrize("role", ["outsider", "admin"])
def test_context_denies_unrelated_actors(db, scope, role):
    with pytest.raises(ApiError):
        project_context(db, scope.users[role], scope.project.id)


def test_context_ta_readonly_and_archival_refresh(db, scope):
    ta = project_context(db, scope.users["ta"], scope.project.id)
    assert not any(ta["permissions"].values())
    scope.project.lifecycle = "archived"
    db.flush()
    result = project_context(db, scope.users["author"], scope.project.id)
    assert result["tasks"] and not any(result["permissions"].values())
    assert not any(t["can_associate"] or t["can_capture_evidence"] for t in result["tasks"])


def test_context_baseline_and_task_state_limit_capture(db, scope):
    scope.task.status = "completed"
    db.flush()
    task = project_context(db, scope.users["author"], scope.project.id)["tasks"][0]
    assert not task["can_capture_evidence"]
    scope.project.setup_status = "draft"
    db.flush()
    permissions = project_context(db, scope.users["author"], scope.project.id)["permissions"]
    assert permissions["can_discuss"] and permissions["can_manage_files"]
    assert not permissions["can_manage_activity"]


def test_context_refreshes_actor_and_http_contract(db, scope):
    application = FastAPI()
    application.middleware("http")(request_context)
    install_exception_handlers(application)
    application.include_router(router, prefix="/api/v1")
    application.dependency_overrides[get_session] = lambda: db
    application.dependency_overrides[get_current_user] = lambda: scope.users["author"]
    with TestClient(application) as client:
        result = client.get(f"/api/v1/projects/{scope.project.id}/c-context")
        assert result.status_code == 200, result.text
        assert result.headers["Cache-Control"] == "private, no-store"
        scope.users["author"].status = "disabled"
        db.flush()
        assert client.get(f"/api/v1/projects/{scope.project.id}/c-context").status_code == 403
