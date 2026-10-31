"""Redis-backed task state and event publishing.

The API service implements the read side of the same small protocol. Keeping
the protocol in Redis means a worker restart does not lose the last known
state, and SSE clients can replay events after reconnecting.
"""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from typing import Any

from redis import Redis


TASK_KEY_PREFIX = "groupproof:task:"
TASK_EVENT_TTL_SECONDS = 24 * 60 * 60


def get_redis_url() -> str:
    return os.getenv("REDIS_URL", "redis://localhost:6379/0")


def task_state_key(task_id: str) -> str:
    return f"{TASK_KEY_PREFIX}{task_id}"


def task_events_key(task_id: str) -> str:
    return f"{task_state_key(task_id)}:events"


class TaskProgressStore:
    """Publish task state snapshots and append-only events to Redis."""

    def __init__(self, redis_client: Redis | None = None) -> None:
        self.redis = redis_client or Redis.from_url(
            get_redis_url(), decode_responses=True
        )

    def publish(
        self,
        task_id: str,
        *,
        status: str,
        progress: int = 0,
        message: str = "",
        result: Any = None,
        error: str = "",
    ) -> dict[str, Any]:
        """Persist one snapshot and append it to the task's Redis Stream."""

        event: dict[str, Any] = {
            "task_id": task_id,
            "status": status,
            "progress": max(0, min(100, int(progress))),
            "message": message,
            "result": result,
            "error": error,
            "updated_at": datetime.now(UTC).isoformat(),
        }
        state = {
            "task_id": task_id,
            "status": status,
            "progress": str(event["progress"]),
            "message": message,
            "result": json.dumps(result, ensure_ascii=False)
            if result is not None
            else "",
            "error": error,
            "updated_at": event["updated_at"],
        }
        state_key = task_state_key(task_id)
        stream_key = task_events_key(task_id)
        self.redis.hset(state_key, mapping=state)
        event_id = self.redis.xadd(
            stream_key,
            {"data": json.dumps(event, ensure_ascii=False)},
            maxlen=1000,
            approximate=True,
        )
        self.redis.hset(state_key, "latest_event_id", event_id)
        self.redis.expire(state_key, TASK_EVENT_TTL_SECONDS)
        self.redis.expire(stream_key, TASK_EVENT_TTL_SECONDS)
        return {**event, "event_id": event_id}
