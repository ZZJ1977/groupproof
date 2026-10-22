"""HTTP contract tests against persisted service fixtures, not fake repositories."""

from uuid import uuid4

import pytest
import test_c_evidence as evidence_tests
from fastapi.testclient import TestClient

from app.api.auth import get_current_user
from app.db.session import get_session
from app.main import app

db = evidence_tests.db
scope = evidence_tests.scope


@pytest.fixture()
def client(db, scope):
    app.dependency_overrides[get_session] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: scope.users["author"]
    with TestClient(app) as client:
        try:
            yield client
        finally:
            app.dependency_overrides.clear()


def test_http_evidence_and_note_return_typed_contract(client, scope):
    base = f"/api/v1/projects/{scope.project.id}"
    response = client.post(
        base + "/evidence",
        json=evidence_tests.command(scope).model_dump(mode="json"),
        headers={"Idempotency-Key": "http-evidence"},
    )
    assert response.status_code == 201, response.text
    data = response.json()["data"]
    assert data["status"] == "candidate" and data["lock_version"] == 0
    assert response.headers["cache-control"] == "private, no-store"
    assert response.json()["meta"]["request_id"] == response.headers["x-request-id"]
    adopted = client.post(
        base + f"/evidence/{data['id']}/adopt",
        json={"expected_version": 0, "reason": "Reviewed"},
        headers={"Idempotency-Key": "http-adopt"},
    )
    assert adopted.status_code == 200 and adopted.json()["data"]["effective"]
    listing = client.get(base + "/evidence/effective?page=1&page_size=10").json()["data"]
    assert listing["page"] == 1 and listing["page_size"] == 10 and listing["total"] == 1
    detail = client.get(base + f"/evidence/{data['id']}").json()["data"]
    assert len(detail["decisions"]) == 2 and len(detail["source_snapshots"]) == 1
    note_url = base + f"/tasks/{scope.task.id}/note"
    assert client.get(note_url).json()["data"] is None
    note = client.put(
        note_url,
        json={"expected_version": 0, "title": "Work", "body": "First"},
        headers={"Idempotency-Key": "http-note"},
    )
    assert note.status_code == 200, note.text
    assert note.json()["data"]["versions"][0]["body"] == "First"


@pytest.mark.parametrize("case", ["no_key", "blank_reason", "invalid_uuid", "extra_actor"])
def test_http_invalid_commands_use_error_envelope_and_no_store(client, scope, case):
    base = f"/api/v1/projects/{scope.project.id}/evidence"
    body = evidence_tests.command(scope).model_dump(mode="json")
    headers = {"Idempotency-Key": "bad-input"}
    if case == "no_key":
        headers = {}
    elif case == "invalid_uuid":
        body["task_id"] = "mock-task-id"
    elif case == "extra_actor":
        body["author_id"] = str(scope.users["teacher"].id)
    if case == "blank_reason":
        response = client.post(
            base + f"/{uuid4()}/adopt",
            json={"expected_version": 0, "reason": "   "},
            headers=headers,
        )
    else:
        response = client.post(base, json=body, headers=headers)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"
    assert response.headers["cache-control"] == "private, no-store"


def test_canonical_authentication_does_not_accept_demo_header_in_production(db, scope, monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("ENABLE_DEMO_AUTH", "true")
    app.dependency_overrides[get_session] = lambda: db
    try:
        with TestClient(app) as client:
            response = client.get(
                f"/api/v1/projects/{scope.project.id}/evidence",
                headers={"X-Demo-User-Id": str(scope.users["author"].id)},
            )
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "UNAUTHENTICATED"
    finally:
        app.dependency_overrides.clear()


def test_openapi_exposes_response_models_and_documented_errors():
    schema = app.openapi()
    responses = schema["paths"]["/api/v1/projects/{project_id}/evidence"]["get"]["responses"]
    assert "$ref" in responses["200"]["content"]["application/json"]["schema"]
    assert {"401", "403", "404", "409", "422", "503"} <= set(responses)
    assert schema["components"]["schemas"]["EvidencePageDTO"]["properties"]["page_size"]
