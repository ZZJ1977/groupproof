from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
import test_c_discussions as discussion_tests
from fastapi.testclient import TestClient

from app.api.auth import get_current_user
from app.db.session import get_session
from app.main import app
from app.modules.c.discussion_models import DiscussionReply

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


def test_focus_reply_uses_persisted_order_instead_of_assuming_last_page(client, db, scope):
    thread = discussion_tests.create(db, scope)
    base = datetime(2026, 10, 14, tzinfo=UTC)
    for index in range(12):
        result = discussion_tests.reply(db, scope, thread, body=f"Reply {index}")
        row = db.get(DiscussionReply, UUID(result["reply"]["id"]))
        # The last committed reply need not have the newest transaction timestamp.
        row.created_at = base + (
            timedelta(minutes=index) if index < 11 else timedelta(minutes=5, seconds=30)
        )
        db.flush()
    endpoint = f"/api/v1/projects/{scope.project.id}/discussions/{thread['id']}/replies"
    response = client.get(endpoint + f"?page=99&page_size=5&focus_reply_id={row.id}")
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["page"] == 2 and data["total"] == 12
    assert str(row.id) in {item["id"] for item in data["items"]}
    assert response.headers["cache-control"] == "private, no-store"


def test_focus_reply_stays_in_authorized_thread(client, db, scope):
    thread = discussion_tests.create(db, scope)
    other = discussion_tests.create(db, scope)
    foreign_reply = discussion_tests.reply(db, scope, other)
    endpoint = f"/api/v1/projects/{scope.project.id}/discussions/{thread['id']}/replies"
    for target in (foreign_reply["reply"]["id"], str(uuid4())):
        response = client.get(endpoint + f"?focus_reply_id={target}")
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "DISCUSSION_REPLY_NOT_FOUND"
    assert client.get(endpoint + "?focus_reply_id=invalid").status_code == 422
