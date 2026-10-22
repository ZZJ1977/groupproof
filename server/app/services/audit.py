"""认证/注册审计：只记录事件、结果和变更字段名，不记录 token、验证码或完整邮箱。"""
from __future__ import annotations

from sqlalchemy.orm import Session as DbSession

from ..models import AuthAuditEvent
from ..security import new_token


def record(
    db: DbSession,
    event_type: str,
    *,
    actor_id: str | None = None,
    target_user_id: str | None = None,
    request_id: str | None = None,
    result: str = "success",
    changed_fields: list[str] | None = None,
) -> None:
    db.add(
        AuthAuditEvent(
            id=new_token()[:32],
            event_type=event_type,
            actor_id=actor_id,
            target_user_id=target_user_id,
            request_id=request_id,
            result=result,
            changed_fields=changed_fields or [],
        )
    )
