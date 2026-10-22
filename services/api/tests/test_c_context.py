"""C selector reads never grant mutation authority or expose unrelated objects."""

from datetime import UTC, datetime
from uuid import uuid4

import pytest
import test_c_discussions as fixtures
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.api.auth import get_current_user
from app.api.errors import ApiError, install_exception_handlers
from app.db.models import CourseStaff, ProjectMember
from app.db.session import get_session
from app.main import request_context
from app.modules.c.context_router import CProjectContextDTO, project_context, router
from app.modules.c.models import Evidence

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


def test_task_description_is_project_scoped_and_does_not_become_a_note(db, scope):
    scope.task.description = "Implement the persisted task requirements."
    scope.other_task.description = "Other project description"
    db.flush()
    result = project_context(db, scope.users["author"], scope.project.id)
    assert result["tasks"][0]["description"] == scope.task.description
    assert (
        "Other project description"
        not in CProjectContextDTO.model_validate(result).model_dump_json()
    )


def test_evidence_author_selector_retains_history_without_granting_membership(db, scope):
    for actor in ("author", "teacher"):
        db.add(
            Evidence(
                id=uuid4(),
                project_id=scope.project.id,
                task_id=scope.task.id,
                author_id=scope.users[actor].id,
                title="Historical evidence",
                description="Saved",
                source_type="manual",
                status="withdrawn",
            )
        )
    db.add(
        Evidence(
            id=uuid4(),
            project_id=scope.other_project.id,
            task_id=scope.other_task.id,
            author_id=scope.users["outsider"].id,
            title="Other evidence",
            description="Saved",
            source_type="manual",
            status="candidate",
        )
    )
    db.scalar(
        select(ProjectMember).where(
            ProjectMember.project_id == scope.project.id,
            ProjectMember.user_id == scope.users["author"].id,
        )
    ).left_at = datetime.now(UTC)
    scope.users["author"].status = "disabled"
    db.flush()
    result = project_context(db, scope.users["member"], scope.project.id)
    assert {item["id"] for item in result["evidence_authors"]} == {
        scope.users["author"].id,
        scope.users["teacher"].id,
    }
    assert scope.users["author"].id not in {item["id"] for item in result["members"]}
    assert scope.users["author"].id not in {item["id"] for item in result["mention_targets"]}
    assert all(set(item) == {"id", "title"} for item in result["evidence_authors"])
    assert "email" not in CProjectContextDTO.model_validate(result).model_dump_json()


def test_mention_targets_include_current_teacher_ta_and_exclude_other_course_people(db, scope):
    result = project_context(db, scope.users["member"], scope.project.id)
    assert {item["id"] for item in result["mention_targets"]} == {
        scope.users[name].id for name in ("author", "member", "leader", "teacher", "ta")
    }
    assert result["evidence_authors"] == []
    assert all(set(item) == {"id", "title"} for item in result["mention_targets"])
    db.scalar(
        select(CourseStaff).where(
            CourseStaff.course_id == scope.course.id,
            CourseStaff.user_id == scope.users["ta"].id,
        )
    ).left_at = datetime.now(UTC)
    db.flush()
    refreshed = project_context(db, scope.users["member"], scope.project.id)
    assert scope.users["ta"].id not in {item["id"] for item in refreshed["mention_targets"]}
