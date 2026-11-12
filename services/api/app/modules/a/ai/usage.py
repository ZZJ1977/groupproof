"""A7 AI 用量记录：每次 AI 调用记一行（用户、功能、模型、成败、token、费用）。

调用方把 ``usage=AIUsageContext(user_id=..., project_id=...)`` 传给 AI 函数即可；不传则不记录。
记录用独立的数据库会话提交，所以即使调用方的业务事务回滚、或者 AI 调用失败，用量也不会丢，
并且记录本身出错也绝不影响 AI 调用的结果。
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from functools import wraps
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.modules.a.models import AiUsageEvent

logger = logging.getLogger("groupproof.a.ai.usage")

_CALL: ContextVar[dict[str, Any] | None] = ContextVar("a_ai_call", default=None)


@dataclass(frozen=True)
class AIUsageContext:
    user_id: UUID | None = None
    project_id: UUID | None = None
    # 测试可替换；默认用正式会话工厂（独立会话，单独提交）。
    session_factory: Callable[[], Session] | None = None


def note_provider_call(provider: Any) -> None:
    """函数层在拿到厂商后调用：记下厂商和模型。"""
    call = _CALL.get()
    if call is not None:
        call["provider"] = getattr(provider, "name", None)
        call["model"] = getattr(provider, "model", None) or getattr(provider, "name", None)


def note_provider_usage(provider: Any) -> None:
    """厂商成功返回后调用：取走这次调用的 token 和费用。"""
    call = _CALL.get()
    usage = getattr(provider, "last_usage", None)
    if call is not None and isinstance(usage, dict):
        call["usage"] = usage


def _int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _cost(value: Any) -> Decimal | None:
    if isinstance(value, bool) or not isinstance(value, int | float | str | Decimal):
        return None
    try:
        cost = Decimal(str(value))
    except ArithmeticError:
        return None
    return cost if cost >= 0 else None


def record_usage(
    ctx: AIUsageContext,
    *,
    feature: str,
    call: dict[str, Any],
    success: bool,
    error_code: str | None,
    latency_ms: int,
) -> None:
    usage = call.get("usage") or {}
    try:
        if ctx.session_factory is not None:
            factory = ctx.session_factory
        else:
            from app.db.session import SessionLocal as factory
        with factory() as session:
            session.add(
                AiUsageEvent(
                    id=uuid4(),
                    user_id=ctx.user_id,
                    project_id=ctx.project_id,
                    feature=feature,
                    provider=call.get("provider"),
                    model=call.get("model"),
                    success=success,
                    error_code=error_code,
                    input_tokens=_int(usage.get("input_tokens")),
                    output_tokens=_int(usage.get("output_tokens")),
                    cost=_cost(usage.get("cost")),
                    currency=(str(usage["currency"])[:8] if usage.get("currency") else None),
                    latency_ms=latency_ms,
                )
            )
            session.commit()
    except Exception:  # noqa: BLE001 - 记录失败不能影响 AI 功能
        logger.exception("failed to record AI usage for %s", feature)


def metered(feature: str):
    """给 AI 函数加上 ``usage=`` 参数：有它就记一行用量，没有就和原来一样。"""

    def decorate(fn):
        @wraps(fn)
        def wrapper(*args, usage: AIUsageContext | None = None, **kwargs):
            if usage is None:
                return fn(*args, **kwargs)
            call: dict[str, Any] = {}
            token = _CALL.set(call)
            started = time.perf_counter()
            error_code: str | None = None
            try:
                return fn(*args, **kwargs)
            except ApiError as exc:
                error_code = exc.code
                raise
            except Exception:
                error_code = "INTERNAL_ERROR"
                raise
            finally:
                _CALL.reset(token)
                record_usage(
                    usage,
                    feature=feature,
                    call=call,
                    success=error_code is None,
                    error_code=error_code,
                    latency_ms=int((time.perf_counter() - started) * 1000),
                )

        return wrapper

    return decorate


@dataclass(frozen=True)
class UsagePage:
    items: tuple[AiUsageEvent, ...]
    total: int


def _conditions(user_id, project_id, feature, since, until, success):
    conditions = []
    if user_id is not None:
        conditions.append(AiUsageEvent.user_id == user_id)
    if project_id is not None:
        conditions.append(AiUsageEvent.project_id == project_id)
    if feature:
        conditions.append(AiUsageEvent.feature == feature)
    if success is not None:
        conditions.append(AiUsageEvent.success == success)
    if since is not None:
        conditions.append(AiUsageEvent.occurred_at >= since)
    if until is not None:
        conditions.append(AiUsageEvent.occurred_at < until)
    return conditions


def list_ai_usage(
    session: Session,
    *,
    user_id: UUID | None = None,
    project_id: UUID | None = None,
    feature: str | None = None,
    success: bool | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    page: int = 1,
    page_size: int = 20,
) -> UsagePage:
    """逐条查询，新的在前。权限由调用方先判断。"""
    if page < 1 or not 1 <= page_size <= 100:
        raise ValueError("page >= 1 and 1 <= page_size <= 100")
    where = _conditions(user_id, project_id, feature, since, until, success)
    total = session.scalar(select(func.count()).select_from(AiUsageEvent).where(*where)) or 0
    rows = session.scalars(
        select(AiUsageEvent)
        .where(*where)
        .order_by(AiUsageEvent.occurred_at.desc(), AiUsageEvent.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return UsagePage(tuple(rows), total)


def summarize_ai_usage(
    session: Session,
    *,
    user_id: UUID | None = None,
    project_id: UUID | None = None,
    feature: str | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
) -> list[dict[str, Any]]:
    """按功能 + 模型汇总：调用数、失败数、token、费用（没有费用的调用不计入费用）。"""
    where = _conditions(user_id, project_id, feature, since, until, None)
    rows = session.execute(
        select(
            AiUsageEvent.feature,
            AiUsageEvent.model,
            func.max(AiUsageEvent.currency).label("currency"),
            func.count().label("calls"),
            func.sum(case((AiUsageEvent.success.is_(False), 1), else_=0)).label("failures"),
            func.coalesce(func.sum(AiUsageEvent.input_tokens), 0).label("input_tokens"),
            func.coalesce(func.sum(AiUsageEvent.output_tokens), 0).label("output_tokens"),
            func.coalesce(func.sum(AiUsageEvent.cost), 0).label("cost"),
        )
        .where(*where)
        .group_by(AiUsageEvent.feature, AiUsageEvent.model)
        .order_by(AiUsageEvent.feature, AiUsageEvent.model)
    ).all()
    return [
        {
            "feature": r.feature,
            "model": r.model,
            "currency": r.currency,
            "calls": int(r.calls),
            "failures": int(r.failures or 0),
            "input_tokens": int(r.input_tokens),
            "output_tokens": int(r.output_tokens),
            "cost": r.cost,
        }
        for r in rows
    ]
