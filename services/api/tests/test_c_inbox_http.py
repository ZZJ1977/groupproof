"""HTTP boundary with persisted SQLite A-fixture rows, not a live notification service."""

from uuid import uuid4

import pytest
import test_c_inbox as inbox_tests
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app.api.auth import get_current_user
from app.api.errors import install_exception_handlers
from app.db.session import get_session
from app.modules.c.daily_router import router as daily_router
from app.modules.c.inbox_ports import UnavailableInboxPort, get_inbox_port
from app.modules.c.inbox_router import router

db = inbox_tests.db
scope = inbox_tests.scope
inbox = inbox_tests.inbox


@pytest.fixture()
def api(db, scope, inbox):
    app = FastAPI()

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        request.state.request_id = str(uuid4())
        return await call_next(request)

    install_exception_handlers(app)
    app.include_router(router, prefix="/api/v1")
    app.include_router(daily_router, prefix="/api/v1")
    app.dependency_overrides[get_session] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: scope.users["author"]
    app.dependency_overrides[get_inbox_port] = lambda: inbox
    return app


@pytest.fixture()
def client(api):
    with TestClient(api) as client:
        yield client


def single(client):
    page = client.get("/api/v1/me/notifications").json()["data"]
    row = next(item for item in page["items"] if item["read_at"] is None)
    return f"/api/v1/me/notifications/{row['id']}/read", {
        "expected_version": row["lock_version"],
        "expected_inbox_version": page["inbox_version"],
        "snapshot_id": page["snapshot_id"],
    }


def test_home_counts_follow_committed_reads_and_keep_other_recipient_isolated(client, api, scope):
    def counts():
        response = client.get("/api/v1/home/summary")
        assert response.status_code == 200, response.text
        return response.json()["data"]

    assert counts()["unread_notifications"] == 11
    assert counts()["pending_action_items"] == 1
    path, body = single(client)
    result = client.post(path, json=body, headers={"Idempotency-Key": "home-read"})
    assert result.status_code == 200
    assert counts()["unread_notifications"] == 10
    replay = client.post(path, json=body, headers={"Idempotency-Key": "home-read"})
    assert replay.status_code == 200
    assert counts()["unread_notifications"] == 10
    page = client.get("/api/v1/me/notifications").json()["data"]
    result = client.post(
        "/api/v1/me/notifications/read-all",
        json={"expected_inbox_version": page["inbox_version"], "snapshot_id": page["snapshot_id"]},
        headers={"Idempotency-Key": "home-all"},
    )
    assert result.status_code == 200
    assert counts()["unread_notifications"] == 0
    api.dependency_overrides[get_current_user] = lambda: scope.users["outsider"]
    assert counts()["unread_notifications"] == 11


def test_http_list_read_retry_all_and_action_targets(client, scope):
    response = client.get("/api/v1/me/notifications")
    assert response.status_code == 200 and response.headers["cache-control"] == "private, no-store"
    assert response.json()["meta"]["request_id"]
    path, body = single(client)
    first = client.post(path, json=body, headers={"Idempotency-Key": "one"})
    assert first.status_code == 200, first.text
    assert (
        client.post(path, json=body, headers={"Idempotency-Key": "one"}).json()["data"]
        == first.json()["data"]
    )
    page = client.get("/api/v1/me/notifications?state=unread").json()["data"]
    assert page["total"] == page["unread_total"] == 10
    result = client.post(
        "/api/v1/me/notifications/read-all",
        json={"expected_inbox_version": page["inbox_version"], "snapshot_id": page["snapshot_id"]},
        headers={"Idempotency-Key": "all"},
    )
    assert result.status_code == 200 and result.json()["data"]["marked_count"] == 10
    action = client.get("/api/v1/me/action-items").json()["data"]["items"][0]
    assert action["recipient_id"] == str(scope.users["author"].id)
    assert action["href"] == f"/projects/{scope.project.id}/tasks/{scope.task.id}/verification"
    assert (
        client.post(f"/api/v1/me/action-items/{action['id']}/complete", json={}).status_code == 404
    )


@pytest.mark.parametrize(
    "query", ["page=0", "page_size=51", "state=other", "recipient_id=forged", "category=task"]
)
def test_http_notification_query_whitelist(client, query):
    assert client.get("/api/v1/me/notifications?" + query).status_code == 422


@pytest.mark.parametrize(
    "query", ["status=other", "category=other", "recipient_id=forged", "page=0"]
)
def test_http_action_query_whitelist(client, query):
    assert client.get("/api/v1/me/action-items?" + query).status_code == 422


@pytest.mark.parametrize(
    "extra",
    [
        {"recipient_id": str(uuid4())},
        {"url": "https://evil.test"},
        {"expected_version": True},
        {"snapshot_id": "mock-id"},
    ],
)
def test_http_read_rejects_forged_scope_and_versions(client, extra):
    path, body = single(client)
    response = client.post(path, json={**body, **extra}, headers={"Idempotency-Key": "bad"})
    assert response.status_code == 422
    assert client.get("/api/v1/me/notifications").json()["data"]["unread_total"] == 11


def test_http_stale_conflict_and_missing_key_preserve_read_state(client):
    path, body = single(client)
    assert client.post(path, json=body).status_code == 422
    assert (
        client.post(
            path, json={**body, "expected_inbox_version": 8}, headers={"Idempotency-Key": "bad"}
        ).status_code
        == 409
    )
    assert client.get("/api/v1/me/notifications").json()["data"]["unread_total"] == 11


def test_http_default_port_unavailable_and_production_auth_closed(client, api, monkeypatch):
    api.dependency_overrides[get_inbox_port] = lambda: UnavailableInboxPort()
    for path in ("/api/v1/me/notifications", "/api/v1/me/action-items"):
        assert client.get(path).status_code == 503
    assert (
        client.post(
            "/api/v1/me/notifications/read-all",
            json={"snapshot_id": str(uuid4()), "expected_inbox_version": 0},
            headers={"Idempotency-Key": "all"},
        ).status_code
        == 503
    )
    api.dependency_overrides.pop(get_current_user)
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("ENABLE_DEMO_AUTH", "true")
    assert (
        client.get("/api/v1/me/notifications", headers={"X-Demo-User-Id": str(uuid4())}).status_code
        == 401
    )


def test_http_bad_receipt_transaction_rolls_back_before_error(client, inbox):
    path, body = single(client)
    inbox.bad_receipt = {"recipient_id": uuid4()}
    assert client.post(path, json=body, headers={"Idempotency-Key": "one"}).status_code == 503
    assert client.get("/api/v1/me/notifications").json()["data"]["unread_total"] == 11
    inbox.bad_receipt = {}
    assert client.post(path, json=body, headers={"Idempotency-Key": "one"}).status_code == 200
