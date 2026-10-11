from __future__ import annotations

import json

from app.progress import TaskProgressStore, task_events_key, task_state_key


class FakeRedis:
    def __init__(self) -> None:
        self.hashes: dict[str, dict[str, str]] = {}
        self.streams: dict[str, list[tuple[str, dict[str, str]]]] = {}

    def hset(self, key: str, key_or_mapping=None, value=None, mapping=None):
        values = mapping or (
            {key_or_mapping: value} if key_or_mapping is not None else {}
        )
        self.hashes.setdefault(key, {}).update(
            {str(k): str(v) for k, v in values.items()}
        )

    def xadd(self, key: str, fields: dict[str, str], **_kwargs):
        event_id = f"{len(self.streams.get(key, [])) + 1}-0"
        self.streams.setdefault(key, []).append((event_id, fields))
        return event_id

    def expire(self, *_args, **_kwargs):
        return True


def test_progress_store_persists_state_and_event() -> None:
    redis = FakeRedis()
    event = TaskProgressStore(redis).publish(
        "task-2", status="PROGRESS", progress=45, message="处理中"
    )

    assert redis.hashes[task_state_key("task-2")]["status"] == "PROGRESS"
    assert redis.hashes[task_state_key("task-2")]["progress"] == "45"
    stored = redis.streams[task_events_key("task-2")][0][1]["data"]
    assert json.loads(stored)["message"] == "处理中"
    assert event["event_id"] == "1-0"
