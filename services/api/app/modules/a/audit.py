"""A4-02 记操作记录：一行代码记下谁、什么时候、对什么、改前改后、为什么。

用法（在业务事务里调用，随业务一起提交或回滚）::

    from app.modules.a.audit import record_audit

    record_audit(
        session,
        actor=user,
        action="task.status.changed",
        target=("task", task.id),
        project_id=task.project_id,
        before={"status": "todo"},
        after={"status": "done"},
        reason="组长确认完成",
        result="success",  # 可选：success | failure | denied
        request=request,  # 可选，用于串起同一请求的日志
    )

记录只能新增：数据库触发器拒绝对 a_audit_events 的 UPDATE / DELETE / TRUNCATE。
查询页（54，由 C 做）调用 :func:`list_audit_events`。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from fastapi.encoders import jsonable_encoder
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import User
from app.modules.a.models import AuditEvent

AUDIT_RESULTS = ("success", "failure", "denied")
MAX_SNAPSHOT_CHARS = 20_000
# 改前改后快照里不允许出现的字段（大小写不敏感，按字段名包含匹配）。
SECRET_FIELD_MARKERS = ("password", "secret", "token", "code_hash", "api_key", "private_key")


def _scrub(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: (
                "[redacted]"
                if any(marker in str(key).lower() for marker in SECRET_FIELD_MARKERS)
                else _scrub(item)
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_scrub(item) for item in value]
    return value


def _snapshot(value: Any) -> Any:
    if value is None:
        return None
    encoded = _scrub(jsonable_encoder(value))
    if len(str(encoded)) > MAX_SNAPSHOT_CHARS:
        raise ValueError("Audit snapshot is too large; record only the changed fields.")
    return encoded


def record_audit(
    session: Session,
    *,
    actor: User | UUID | None,
    action: str,
    target: tuple[str, UUID | str],
    project_id: UUID | None = None,
    course_id: UUID | None = None,
    before: Any = None,
    after: Any = None,
    reason: str | None = None,
    request: Any = None,
    occurred_at: datetime | None = None,
    result: str = "success",
    actor_role: str | None = None,
) -> AuditEvent:
    """新增一条操作记录（只 flush 不 commit）。actor=None 表示系统操作。"""
    action = action.strip()
    target_type, target_id = target
    if not action or len(action) > 120:
        raise ValueError("action must be 1-120 characters, e.g. 'task.status.changed'.")
    if not str(target_type).strip() or not str(target_id).strip():
        raise ValueError("target must be (type, id).")
    if result not in AUDIT_RESULTS:
        raise ValueError(f"result must be one of {AUDIT_RESULTS}.")
    actor_id = actor.id if isinstance(actor, User) else actor
    if actor_role is None and actor_id is not None:
        # 记下操作发生时的角色；之后账号角色变化不会改写历史。
        user = actor if isinstance(actor, User) else session.get(User, actor_id)
        actor_role = user.global_role if user is not None else None
    request_id = getattr(getattr(request, "state", None), "request_id", None)
    event = AuditEvent(
        id=uuid4(),
        occurred_at=occurred_at or datetime.now(UTC),
        actor_id=actor_id,
        action=action,
        target_type=str(target_type)[:60],
        target_id=str(target_id)[:120],
        project_id=project_id,
        course_id=course_id,
        before_json=_snapshot(before),
        after_json=_snapshot(after),
        reason=reason,
        request_id=request_id,
        actor_role=actor_role,
        result=result,
    )
    session.add(event)
    session.flush()
    return event


@dataclass(frozen=True)
class AuditPage:
    items: tuple[AuditEvent, ...]
    total: int


def list_audit_events(
    session: Session,
    *,
    project_id: UUID | None = None,
    course_id: UUID | None = None,
    actor_id: UUID | None = None,
    target: tuple[str, UUID | str] | None = None,
    action_prefix: str | None = None,
    result: str | None = None,
    actor_role: str | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    page: int = 1,
    page_size: int = 20,
) -> AuditPage:
    """按项目 / 课程 / 操作人 / 对象 / 时间查询，新的在前。权限由调用方先判断。"""
    if page < 1 or not 1 <= page_size <= 100:
        raise ValueError("page >= 1 and 1 <= page_size <= 100")
    conditions = []
    if project_id is not None:
        conditions.append(AuditEvent.project_id == project_id)
    if course_id is not None:
        conditions.append(AuditEvent.course_id == course_id)
    if actor_id is not None:
        conditions.append(AuditEvent.actor_id == actor_id)
    if target is not None:
        conditions.append(AuditEvent.target_type == target[0])
        conditions.append(AuditEvent.target_id == str(target[1]))
    if action_prefix:
        escaped = action_prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        conditions.append(AuditEvent.action.like(f"{escaped}%", escape="\\"))
    if result is not None:
        conditions.append(AuditEvent.result == result)
    if actor_role is not None:
        conditions.append(AuditEvent.actor_role == actor_role)
    if since is not None:
        conditions.append(AuditEvent.occurred_at >= since)
    if until is not None:
        conditions.append(AuditEvent.occurred_at < until)
    total = session.scalar(select(func.count()).select_from(AuditEvent).where(*conditions)) or 0
    rows = session.scalars(
        select(AuditEvent)
        .where(*conditions)
        .order_by(AuditEvent.occurred_at.desc(), AuditEvent.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return AuditPage(tuple(rows), total)
