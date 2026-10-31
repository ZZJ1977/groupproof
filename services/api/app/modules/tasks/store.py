"""Redis read/write helpers for Celery task state and SSE events.

This mirrors ``services/worker/app/progress.py``. The API and worker are built
as separate Docker images, so the compact Redis protocol is intentionally kept
in both services rather than importing across service boundaries.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from datetime import UTC, datetime
from time import monotonic
from typing import Any

from redis import Redis

TASK_KEY_PREFIX = "groupproof:task:"
TASK_EVENT_TTL_SECONDS = 24 * 60 * 60
TERMINAL_STATUSES = frozenset({"SUCCESS", "FAILURE", "REVOKED"})


def get_redis_url() -> str:
    return os.getenv("REDIS_URL", "redis://localhost:6379/0")


def task_state_key(task_id: str) -> str:
    return f"{TASK_KEY_PREFIX}{task_id}"


def task_events_key(task_id: str) -> str:
    return f"{task_state_key(task_id)}:events"


def get_redis() -> Redis:
    return Redis.from_url(get_redis_url(), decode_responses=True)


def _decode_result(value: str | bytes | None) -> Any:
    if isinstance(value, bytes):
        value = value.decode("utf-8")
    if not value:
        return None
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return value


def read_state(redis_client: Redis, task_id: str) -> dict[str, Any] | None:
    values = redis_client.hgetall(task_state_key(task_id))
    if not values:
        return None
    values = {
        (key.decode("utf-8") if isinstance(key, bytes) else key): (
            value.decode("utf-8") if isinstance(value, bytes) else value
        )
        for key, value in values.items()
    }
    return {
        "task_id": values.get("task_id", task_id),
        "status": values.get("status", "PENDING"),
        "progress": int(values.get("progress", 0)),
        "message": values.get("message", ""),
        "result": _decode_result(values.get("result")),
        "error": values.get("error", ""),
        "updated_at": values.get("updated_at", ""),
        "latest_event_id": values.get("latest_event_id"),
    }


def initialize_state(redis_client: Redis, task_id: str) -> dict[str, Any]:
    """Create a visible PENDING state before publishing to the broker."""

    state = {
        "task_id": task_id,
        "status": "PENDING",
        "progress": "0",
        "message": "任务排队中",
        "result": "",
        "error": "",
        "updated_at": datetime.now(UTC).isoformat(),
    }
    state_key = task_state_key(task_id)
    redis_client.hset(state_key, mapping=state)
    event = {
        "task_id": task_id,
        "status": "PENDING",
        "progress": 0,
        "message": "任务排队中",
        "result": None,
        "error": "",
        "updated_at": state["updated_at"],
    }
    event_id = redis_client.xadd(
        task_events_key(task_id),
        {"data": json.dumps(event, ensure_ascii=False)},
        maxlen=1000,
        approximate=True,
    )
    redis_client.hset(state_key, "latest_event_id", event_id)
    redis_client.expire(state_key, TASK_EVENT_TTL_SECONDS)
    redis_client.expire(task_events_key(task_id), TASK_EVENT_TTL_SECONDS)
    return {**event, "event_id": event_id}


def iter_events(
    redis_client: Redis,
    task_id: str,
    *,
    last_event_id: str = "0-0",
    timeout_seconds: float = 30.0,
) -> Iterator[dict[str, Any]]:
    """Read existing and newly appended stream entries until terminal state."""

    cursor = last_event_id or "0-0"
    deadline = monotonic() + max(0.0, timeout_seconds)
    stream_key = task_events_key(task_id)
    last_heartbeat = monotonic()

    while True:
        remaining = deadline - monotonic()
        if remaining <= 0:
            return
        # A one second block provides heartbeats without holding a request
        # indefinitely when a worker is unavailable.
        block_ms = min(1000, max(1, int(remaining * 1000)))
        rows = redis_client.xread({stream_key: cursor}, count=100, block=block_ms)
        if not rows:
            state = read_state(redis_client, task_id)
            if state is None or state["status"] in TERMINAL_STATUSES:
                return
            if monotonic() - last_heartbeat >= 15:
                yield {"heartbeat": True}
                last_heartbeat = monotonic()
            continue
        for _stream, entries in rows:
            for event_id, fields in entries:
                cursor = event_id
                raw = fields.get("data", "{}")
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8")
                event = json.loads(raw) if isinstance(raw, str) else raw
                event["event_id"] = event_id
                yield event
                if event.get("status") in TERMINAL_STATUSES:
                    return


def format_sse(event: dict[str, Any]) -> str:
    """Serialize one event according to the SSE wire format."""

    if event.get("heartbeat"):
        return ": keep-alive\n\n"
    event_id = event.get("event_id", "")
    if isinstance(event_id, bytes):
        event_id = event_id.decode("utf-8")
    status = event.get("status", "message").lower()
    payload = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
    return f"id: {event_id}\nevent: {status}\ndata: {payload}\n\n"
