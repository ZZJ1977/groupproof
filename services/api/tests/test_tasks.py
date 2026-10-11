from __future__ import annotations

import json

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.main import app as main_app
from app.modules.tasks import router as task_router_module
from app.modules.tasks.store import format_sse, initialize_state, iter_events, read_state


class FakeRedis:
    def __init__(self) -> None:
        self.hashes: dict[str, dict[str, str]] = {}
        self.streams: dict[str, list[tuple[str, dict[str, str]]]] = {}
        self.next_id = 0

    def hset(self, key: str, key_or_mapping=None, value=None, mapping=None):
        values = mapping or ({key_or_mapping: value} if key_or_mapping is not None else {})
        self.hashes.setdefault(key, {}).update({str(k): str(v) for k, v in values.items()})

    def hgetall(self, key: str):
        return dict(self.hashes.get(key, {}))

    def xadd(self, key: str, fields: dict[str, str], **_kwargs):
        self.next_id += 1
        event_id = f"{self.next_id}-0"
        self.streams.setdefault(key, []).append((event_id, fields))
        return event_id

    def expire(self, *_args, **_kwargs):
        return True

    def close(self):
        return None

    def xread(self, streams: dict[str, str], **_kwargs):
        key, cursor = next(iter(streams.items()))
        cursor_number = int(cursor.split("-", 1)[0])
        entries = [
            entry
            for entry in self.streams.get(key, [])
            if int(entry[0].split("-", 1)[0]) > cursor_number
        ]
        return [(key, entries)] if entries else []


def test_initialize_state_can_be_replayed_as_sse_events() -> None:
    redis = FakeRedis()
    event = initialize_state(redis, "task-1")

    assert event["status"] == "PENDING"
    assert read_state(redis, "task-1")["status"] == "PENDING"
    replayed = list(iter_events(redis, "task-1", timeout_seconds=0.1))
    assert replayed[0]["event_id"] == event["event_id"]
    assert "event: pending" in format_sse(replayed[0])
    assert json.loads(format_sse(replayed[0]).split("data: ", 1)[1])["task_id"] == "task-1"


def test_sse_heartbeat_is_comment_only() -> None:
    assert format_sse({"heartbeat": True}) == ": keep-alive\n\n"


def test_demo_task_submission_is_closed_when_app_env_is_unset(monkeypatch) -> None:
    monkeypatch.delenv("APP_ENV", raising=False)

    response = TestClient(main_app).post("/api/tasks", json={"steps": 2})

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"


def test_task_routes_return_contract_and_stream(monkeypatch) -> None:
    redis = FakeRedis()
    initialize_state(redis, "task-3")
    app = FastAPI()

    @app.middleware("http")
    async def request_context(request, call_next):
        request.state.request_id = "test-request"
        return await call_next(request)

    app.include_router(task_router_module.router)
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setattr(task_router_module, "get_redis", lambda: redis)
    monkeypatch.setattr(
        task_router_module,
        "enqueue_demo_task",
        lambda **_payload: {
            "task_id": "task-3",
            "status": "PENDING",
            "stream_url": "/api/tasks/task-3/events",
        },
    )

    client = TestClient(app)
    created = client.post("/api/tasks", json={"steps": 2})
    assert created.status_code == 202
    assert created.json()["data"]["task_id"] == "task-3"

    state = client.get("/api/tasks/task-3")
    assert state.status_code == 200
    assert state.json()["data"]["status"] == "PENDING"

    events = client.get("/api/tasks/task-3/events?timeout=0.1")
    assert events.status_code == 200
    assert events.headers["content-type"].startswith("text/event-stream")
    assert "event: pending" in events.text
