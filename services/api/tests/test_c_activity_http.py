"""Isolated HTTP contract; installing this test app never changes production wiring."""

from uuid import uuid4

import pytest
import test_c_activity as activity_tests
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.auth import get_current_user
from app.api.errors import install_exception_handlers
from app.db.session import get_session
from app.modules.c.activity_ports import get_activity_source_port
from app.modules.c.activity_router import router

db = activity_tests.db
scope = activity_tests.scope
sources = activity_tests.sources


@pytest.fixture()
def app(db, scope, sources):
    app = FastAPI()
    app.include_router(router, prefix="/api/v1")
    install_exception_handlers(app)

    @app.middleware("http")
    async def context(request, next_handler):
        request.state.request_id = "activity-http-test"
        response = await next_handler(request)
        response.headers["Cache-Control"] = "private, no-store"
        return response

    app.dependency_overrides[get_session] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: scope.users["author"]
    app.dependency_overrides[get_activity_source_port] = lambda: sources
    return app


@pytest.fixture()
def client(app):
    with TestClient(app) as client:
        yield client


def base(scope):
    return f"/api/v1/projects/{scope.project.id}/activities/feishu"


def test_http_query_detail_adopt_and_history_have_typed_authoritative_results(
    client, scope, sources
):
    url = base(scope)
    source_id = activity_tests.first(sources).id
    response = client.get(url + "?page=1&page_size=10&status=candidate")
    assert response.status_code == 200, response.text
    assert response.json()["data"]["total"] == 1
    assert response.headers["cache-control"] == "private, no-store"
    detail = client.get(f"{url}/{source_id}").json()["data"]
    assert detail["lock_version"] == 0 and detail["record_id"] is None
    response = client.post(
        f"{url}/{source_id}/decisions",
        json=activity_tests.adopt_command(scope).model_dump(mode="json"),
        headers={"Idempotency-Key": "http-adoption"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["data"]["evidence_id"]
    history = client.get(f"{url}/{source_id}/history").json()["data"]
    assert history["status"] == "adopted" and len(history["decisions"]) == 1
    assert (
        history["decisions"][0]["source_snapshot"]["source"]["body"] == "Original authorized source"
    )


def test_http_missing_key_or_forged_fields_are_422(client, scope, sources):
    url = f"{base(scope)}/{activity_tests.first(sources).id}/decisions"
    command = activity_tests.adopt_command(scope).model_dump(mode="json")
    cases = [
        (command, {}),
        ({**command, "author_id": str(uuid4())}, {"Idempotency-Key": "forged"}),
        ({**command, "source_snapshot": {"body": "forged"}}, {"Idempotency-Key": "forged-source"}),
    ]
    for body, headers in cases:
        response = client.post(url, json=body, headers=headers)
        assert response.status_code == 422, response.text
        assert response.json()["error"]["code"] == "VALIDATION_ERROR"


@pytest.mark.parametrize(
    "suffix",
    [
        "?page=0",
        "?page_size=101",
        "?task_id=mock-task",
        "?status=formal",
        "?since=2026-01-01T00:00:00",
        "?since=2026-01-02T00:00:00Z&until=2026-01-01T00:00:00Z",
    ],
)
def test_http_rejects_invalid_query(client, scope, suffix):
    assert client.get(base(scope) + suffix).status_code == 422


def test_http_default_provider_is503_and_replay_remains_available(client, app, scope, sources):
    url = f"{base(scope)}/{activity_tests.first(sources).id}"
    body = activity_tests.adopt_command(scope).model_dump(mode="json")
    headers = {"Idempotency-Key": "http-replay"}
    result = client.post(url + "/decisions", json=body, headers=headers)
    assert result.status_code == 200
    del app.dependency_overrides[get_activity_source_port]
    assert client.get(base(scope)).status_code == 503
    assert client.get(url).status_code == 503
    assert client.get(url + "/history").status_code == 200
    replay = client.post(url + "/decisions", json=body, headers=headers)
    assert replay.status_code == 200 and replay.json()["data"] == result.json()["data"]


def test_http_permission_precedes_source_lookup(client, app, scope, sources):
    app.dependency_overrides[get_current_user] = lambda: scope.users["outsider"]
    assert client.get(base(scope)).status_code == 403
    assert (
        client.post(
            f"{base(scope)}/{activity_tests.first(sources).id}/decisions",
            json=activity_tests.adopt_command(scope).model_dump(mode="json"),
            headers={"Idempotency-Key": "denied"},
        ).status_code
        == 403
    )
    assert not sources.calls


def test_openapi_activity_routes_use_typed_payloads_and_responses(app):
    spec = app.openapi()
    operations = [
        operation
        for path, methods in spec["paths"].items()
        if "/activities/" in path
        for method, operation in methods.items()
        if method in {"get", "post", "put"}
    ]
    assert len(operations) == 5
    for operation in operations:
        assert "$ref" in operation["responses"]["200"]["content"]["application/json"]["schema"]
        assert all(
            str(status) in operation["responses"] for status in (401, 403, 404, 409, 422, 503)
        )
    assert spec["components"]["schemas"]["DecideActivity"]["additionalProperties"] is False
