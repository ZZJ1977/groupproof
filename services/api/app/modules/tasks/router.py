"""HTTP endpoints for background task submission and progress streaming."""

from __future__ import annotations

import os
from collections.abc import Iterator
from typing import Any

from fastapi import APIRouter, Header, Query, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from redis.exceptions import RedisError

from app.api.errors import ApiError
from app.api.responses import SuccessResponse, success

from .queue import enqueue_demo_task
from .store import format_sse, get_redis, iter_events, read_state

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


class DemoTaskRequest(BaseModel):
    steps: int = Field(default=5, ge=1, le=100)
    delay_seconds: float = Field(default=0.1, ge=0, le=30)
    fail: bool = False


class TaskResponse(BaseModel):
    task_id: str
    status: str
    progress: int = 0
    message: str = ""
    result: Any = None
    error: str = ""
    updated_at: str = ""
    latest_event_id: str | None = None
    stream_url: str | None = None


@router.post("", response_model=SuccessResponse[TaskResponse], status_code=status.HTTP_202_ACCEPTED)
def create_demo_task(payload: DemoTaskRequest, request: Request) -> SuccessResponse[TaskResponse]:
    if os.getenv("APP_ENV", "production").lower() not in {"development", "test"}:
        raise ApiError(404, "NOT_FOUND", "Task not found.")
    try:
        return success(TaskResponse(**enqueue_demo_task(**payload.model_dump())), request)
    except RedisError as exc:
        raise ApiError(503, "TASK_SERVICE_UNAVAILABLE", "任务服务暂不可用") from exc
    except Exception as exc:
        raise ApiError(503, "TASK_ENQUEUE_FAILED", "任务无法排队") from exc


@router.get("/{task_id}", response_model=SuccessResponse[TaskResponse])
def get_task(task_id: str, request: Request) -> SuccessResponse[TaskResponse]:
    redis_client = get_redis()
    try:
        state = read_state(redis_client, task_id)
    except RedisError as exc:
        raise ApiError(503, "TASK_SERVICE_UNAVAILABLE", "任务服务暂不可用") from exc
    finally:
        redis_client.close()
    if state is None:
        raise ApiError(404, "TASK_NOT_FOUND", "任务不存在")
    return success(TaskResponse(**state), request)


@router.get("/{task_id}/events")
def task_events(
    task_id: str,
    last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
    timeout: float = Query(default=30.0, ge=0, le=300),
) -> StreamingResponse:
    redis_client = get_redis()
    try:
        state = read_state(redis_client, task_id)
    except RedisError as exc:
        redis_client.close()
        raise ApiError(503, "TASK_SERVICE_UNAVAILABLE", "任务服务暂不可用") from exc
    if state is None:
        redis_client.close()
        raise ApiError(404, "TASK_NOT_FOUND", "任务不存在")

    def stream() -> Iterator[str]:
        try:
            for event in iter_events(
                redis_client,
                task_id,
                last_event_id=last_event_id or "0-0",
                timeout_seconds=timeout,
            ):
                yield format_sse(event)
        finally:
            redis_client.close()

    media_type = "text/event-stream"
    return StreamingResponse(
        stream(),
        media_type=media_type,
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
