from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from uuid import UUID, uuid4

from fastapi.testclient import TestClient

from app.api.auth import get_current_user
from app.db.session import get_session
from app.main import app

PROJECT_ID = uuid4()
LEADER_ID = uuid4()
MEMBER_ID = uuid4()


class FakeResult:
    def __init__(self, row: dict[str, object] | None) -> None:
        self.row = row

    def mappings(self) -> FakeResult:
        return self

    def one_or_none(self) -> dict[str, object] | None:
        return self.row


class FakeSession:
    def __init__(self, project: SimpleNamespace | None, membership: SimpleNamespace | None) -> None:
        self.project = project
        self.membership = membership
        self.updated = False
        self.rolled_back = False

    def get(self, model: object, _object_id: UUID) -> SimpleNamespace | None:
        return self.project

    def scalar(self, _statement: object) -> SimpleNamespace | None:
        return self.membership

    def execute(self, _statement: object) -> FakeResult:
        if self.project.lock_version != 2:
            return FakeResult(None)
        self.project.name = "Renamed project"
        self.project.lock_version = 3
        self.updated = True
        return FakeResult(
            {
                "id": self.project.id,
                "name": self.project.name,
                "description": self.project.description,
                "lifecycle": self.project.lifecycle,
                "lock_version": self.project.lock_version,
                "updated_at": self.project.updated_at,
            }
        )

    def commit(self) -> None:
        return None

    def rollback(self) -> None:
        self.rolled_back = True

    def close(self) -> None:
        return None


def project(*, version: int = 2) -> SimpleNamespace:
    return SimpleNamespace(
        id=PROJECT_ID,
        name="Seed project",
        description="Example",
        lifecycle="active",
        lock_version=version,
        updated_at=datetime(2026, 10, 10, 12, 0),
    )


def user(user_id: UUID = LEADER_ID) -> SimpleNamespace:
    return SimpleNamespace(id=user_id, status="active")


def override_dependencies(session: FakeSession, current_user: SimpleNamespace = user()) -> None:
    app.dependency_overrides[get_current_user] = lambda: current_user
    app.dependency_overrides[get_session] = lambda: session


def teardown_dependencies() -> None:
    app.dependency_overrides.clear()


def test_project_read_requires_authentication_by_default() -> None:
    response = TestClient(app).get(f"/api/examples/projects/{PROJECT_ID}")

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "UNAUTHENTICATED"


def test_project_read_returns_data_envelope_and_request_id() -> None:
    session = FakeSession(project(), SimpleNamespace(role="leader"))
    override_dependencies(session)
    try:
        response = TestClient(app).get(f"/api/examples/projects/{PROJECT_ID}")
    finally:
        teardown_dependencies()

    assert response.status_code == 200
    body = response.json()
    assert body["data"]["id"] == str(PROJECT_ID)
    assert body["data"]["lock_version"] == 2
    assert body["meta"]["request_id"] == response.headers["x-request-id"]


def test_project_read_rejects_non_member_with_error_envelope() -> None:
    session = FakeSession(project(), None)
    override_dependencies(session)
    try:
        response = TestClient(app).get(f"/api/examples/projects/{PROJECT_ID}")
    finally:
        teardown_dependencies()

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "PROJECT_ACCESS_DENIED"
    assert response.json()["meta"]["request_id"] == response.headers["x-request-id"]


def test_project_read_reports_404_for_missing_project() -> None:
    session = FakeSession(None, None)
    override_dependencies(session)
    try:
        response = TestClient(app).get(f"/api/examples/projects/{PROJECT_ID}")
    finally:
        teardown_dependencies()

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "PROJECT_NOT_FOUND"


def test_member_cannot_rename_project() -> None:
    session = FakeSession(project(), SimpleNamespace(role="member"))
    override_dependencies(session, user(MEMBER_ID))
    try:
        response = TestClient(app).patch(
            f"/api/examples/projects/{PROJECT_ID}",
            json={"name": "Renamed project", "expected_version": 2},
        )
    finally:
        teardown_dependencies()

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "PROJECT_ACCESS_DENIED"
    assert session.updated is False


def test_project_rename_uses_expected_version_and_increments_lock_version() -> None:
    session = FakeSession(project(), SimpleNamespace(role="leader"))
    override_dependencies(session)
    try:
        response = TestClient(app).patch(
            f"/api/examples/projects/{PROJECT_ID}",
            json={"name": "Renamed project", "expected_version": 2},
        )
    finally:
        teardown_dependencies()

    assert response.status_code == 200
    assert session.updated is True
    assert response.json()["data"]["lock_version"] == 3


def test_project_rename_reports_stale_version_as_409() -> None:
    session = FakeSession(project(version=1), SimpleNamespace(role="leader"))
    override_dependencies(session)
    try:
        response = TestClient(app).patch(
            f"/api/examples/projects/{PROJECT_ID}",
            json={"name": "Renamed project", "expected_version": 2},
        )
    finally:
        teardown_dependencies()

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "VERSION_CONFLICT"
    assert response.json()["error"]["details"] == {
        "expected_version": 2,
        "current_version": 1,
    }


def test_validation_errors_use_the_same_error_envelope() -> None:
    session = FakeSession(project(), SimpleNamespace(role="leader"))
    override_dependencies(session)
    try:
        response = TestClient(app).patch(
            f"/api/examples/projects/{PROJECT_ID}",
            json={"name": "", "expected_version": -1},
        )
    finally:
        teardown_dependencies()

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"
    assert response.json()["meta"]["request_id"] == response.headers["x-request-id"]
