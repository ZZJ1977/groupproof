"""Celery client used by the API to enqueue worker tasks."""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from celery import Celery

from .store import (
    TASK_EVENT_TTL_SECONDS,
    get_redis,
    initialize_state,
    task_events_key,
    task_state_key,
)


def get_redis_url() -> str:
    return os.getenv("REDIS_URL", "redis://localhost:6379/0")


celery_client = Celery("groupproof-api", broker=get_redis_url(), backend=get_redis_url())
celery_client.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    task_track_started=True,
    timezone=os.getenv("DATABASE_TIMEZONE", "Asia/Shanghai"),
    enable_utc=False,
)


def enqueue_task(
    task_name: str,
    *,
    args: list[Any] | None = None,
    kwargs: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Queue a registered worker task and return its id and progress URL.

    Business modules can use this helper after validating the actor and input.
    Worker tasks should publish progress with ``TaskProgressStore.publish``.
    """

    task_id = str(uuid4())
    redis_client = get_redis()
    try:
        initialize_state(redis_client, task_id)
        celery_client.send_task(task_name, args=args or [], kwargs=kwargs or {}, task_id=task_id)
    except Exception as exc:
        # Keep the failure observable even when Redis is reachable but the
        # broker is not. In a deployment the two may use different instances.
        try:
            event = {
                "task_id": task_id,
                "status": "FAILURE",
                "progress": 0,
                "message": "任务无法排队",
                "result": None,
                "error": str(exc),
                "updated_at": datetime.now(UTC).isoformat(),
            }
            event_id = redis_client.xadd(
                task_events_key(task_id),
                {"data": json.dumps(event, ensure_ascii=False)},
                maxlen=1000,
                approximate=True,
            )
            redis_client.hset(
                task_state_key(task_id),
                mapping={
                    "status": "FAILURE",
                    "message": event["message"],
                    "error": str(exc),
                    "updated_at": event["updated_at"],
                    "latest_event_id": event_id,
                },
            )
            redis_client.expire(task_events_key(task_id), TASK_EVENT_TTL_SECONDS)
            redis_client.expire(task_state_key(task_id), TASK_EVENT_TTL_SECONDS)
        finally:
            redis_client.close()
        raise
    redis_client.close()
    return {
        "task_id": task_id,
        "status": "PENDING",
        "stream_url": f"/api/tasks/{task_id}/events",
    }


def enqueue_demo_task(*, steps: int, delay_seconds: float, fail: bool) -> dict[str, Any]:
    return enqueue_task(
        "app.tasks.progress.run_demo_task",
        args=[steps, delay_seconds, fail],
    )
