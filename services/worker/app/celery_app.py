"""Celery application and queue configuration for the background worker."""

from __future__ import annotations

import os

from celery import Celery


def get_redis_url() -> str:
    return os.getenv("REDIS_URL", "redis://localhost:6379/0")


celery_app = Celery(
    "groupproof",
    broker=get_redis_url(),
    backend=get_redis_url(),
    include=["app.tasks.progress"],
)

celery_app.conf.update(
    task_track_started=True,
    result_extended=True,
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone=os.getenv("DATABASE_TIMEZONE", "Asia/Shanghai"),
    enable_utc=False,
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    broker_connection_retry_on_startup=True,
)
