from uuid import UUID

import pytest
import test_c_discussions as discussion_tests
from fastapi.testclient import TestClient

from app.api.auth import get_current_user
from app.db.session import get_session
from app.main import app

db = discussion_tests.db
scope = discussion_tests.scope


@pytest.fixture()
def client(db, scope):
    app.dependency_overrides[get_session] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: scope.users["author"]
    with TestClient(app) as client:
        try:
            yield client
        finally:
            app.dependency_overrides.clear()


def test_http_discussion_reply_important_and_read_contract(client, scope):
    base = f"/api/v1/projects/{scope.project.id}/discussions"
    created = client.post(
        base,
        json={
            "title": "Decision",
            "body": "Proposed approach",
            "task_id": str(scope.task.id),
            "mention_user_ids": [str(scope.users["teacher"].id)],
        },
        headers={"Idempotency-Key": "http-create-discussion"},
    )
    assert created.status_code == 201, created.text
    row = created.json()["data"]
    assert row["author_id"] == str(scope.users["author"].id)
    assert created.headers["cache-control"] == "private, no-store"
    reply = client.post(
        base + f"/{row['id']}/replies",
        json={"expected_version": 0, "body": "Agreed"},
        headers={"Idempotency-Key": "http-reply"},
    )
    assert reply.status_code == 201 and reply.json()["data"]["discussion"]["reply_count"] == 1
    marked = client.put(
        base + f"/{row['id']}/important",
        json={"expected_version": 0, "is_important": True, "reason": "Decision reached"},
        headers={"Idempotency-Key": "http-important"},
    )
    assert marked.status_code == 200, marked.text
    assert marked.json()["data"]["evidence_source_id"] == row["id"]
    UUID(marked.json()["data"]["source_snapshot_id"])
    assert client.get(base + "?is_important=true&page=1&page_size=1").json()["data"]["total"] == 1
    assert client.get(base + f"/{row['id']}/replies").json()["data"]["total"] == 1


def test_http_cannot_impersonate_author_and_requires_idempotency_key(client, scope):
    base = f"/api/v1/projects/{scope.project.id}/discussions"
    for body, headers in [
        (
            {"title": "A", "body": "B", "author_id": str(scope.users["teacher"].id)},
            {"Idempotency-Key": "bad-author"},
        ),
        ({"title": "A", "body": "B"}, {}),
    ]:
        response = client.post(base, json=body, headers=headers)
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "VALIDATION_ERROR"
        assert response.headers["cache-control"] == "private, no-store"


def test_openapi_discussion_operations_have_typed_responses():
    schema = app.openapi()
    for path, methods in schema["paths"].items():
        if "/discussions" not in path:
            continue
        for operation in methods.values():
            assert {"401", "403", "404", "409", "422"} <= set(operation["responses"])
            success = operation["responses"].get("200") or operation["responses"]["201"]
            assert "$ref" in success["content"]["application/json"]["schema"]
    assert "DiscussionDTO" in schema["components"]["schemas"]
