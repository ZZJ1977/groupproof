"""Example long-running task used to verify Celery, Redis and SSE together."""

from __future__ import annotations

import time
from typing import Any

from celery import Task

from app.celery_app import celery_app
from app.progress import TaskProgressStore


class ProgressTask(Task):
    """Base task that exposes a Redis progress publisher to future tasks."""

    _progress_store: TaskProgressStore | None = None

    @property
    def progress_store(self) -> TaskProgressStore:
        if self._progress_store is None:
            self._progress_store = TaskProgressStore()
        return self._progress_store


@celery_app.task(
    bind=True,
    base=ProgressTask,
    name="app.tasks.progress.run_demo_task",
    acks_late=True,
)
def run_demo_task(
    self: ProgressTask,
    steps: int = 5,
    delay_seconds: float = 0.1,
    fail: bool = False,
) -> dict[str, Any]:
    """Run a deterministic, observable task for integration and smoke tests."""

    steps = max(1, min(int(steps), 100))
    delay_seconds = max(0.0, min(float(delay_seconds), 30.0))
    task_id = self.request.id
    store = self.progress_store

    try:
        store.publish(task_id, status="STARTED", progress=0, message="任务已开始")
        for step in range(1, steps + 1):
            if delay_seconds:
                time.sleep(delay_seconds)
            progress = round(step * 100 / steps)
            store.publish(
                task_id,
                status="PROGRESS",
                progress=progress,
                message=f"已完成第 {step}/{steps} 步",
            )
            self.update_state(
                state="PROGRESS",
                meta={"progress": progress, "message": f"已完成第 {step}/{steps} 步"},
            )

        if fail:
            raise RuntimeError("示例任务按请求失败")

        result = {"steps": steps, "message": "示例任务已完成"}
        store.publish(
            task_id, status="SUCCESS", progress=100, message="任务已完成", result=result
        )
        return result
    except Exception as exc:
        store.publish(
            task_id,
            status="FAILURE",
            progress=0,
            message="任务失败",
            error=str(exc),
        )
        raise
