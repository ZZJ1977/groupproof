"""数据库限流计数：跨进程一致（多实例部署共用同一数据库窗口）。"""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from ..models import RateLimitCounter, utcnow


class RateLimitExceeded(Exception):
    def __init__(self, retry_after_seconds: int) -> None:
        self.retry_after_seconds = retry_after_seconds


def _window_start(now: datetime, seconds: int) -> datetime:
    epoch = datetime(1970, 1, 1)
    elapsed = int((now - epoch).total_seconds()) // seconds * seconds
    return epoch + timedelta(seconds=elapsed)


def check_and_increment(
    db: DbSession,
    bucket_key: str,
    *,
    limit: int,
    window_seconds: int,
    now: datetime | None = None,
) -> None:
    now = now or utcnow()
    start = _window_start(now, window_seconds)
    counter = db.execute(
        select(RateLimitCounter).where(RateLimitCounter.bucket_key == bucket_key, RateLimitCounter.window_start == start)
    ).scalar_one_or_none()
    if counter is None:
        counter = RateLimitCounter(bucket_key=bucket_key, window_start=start, count=0)
        db.add(counter)
        db.flush()
    if counter.count >= limit:
        retry = int((start + timedelta(seconds=window_seconds) - now).total_seconds()) + 1
        raise RateLimitExceeded(max(retry, 1))
    counter.count += 1
