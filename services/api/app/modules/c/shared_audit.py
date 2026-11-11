"""C7 read view of operation records exposed by A4-02."""

from datetime import datetime
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import User
from app.modules.c.auth_audit_service import require_auth_audit_admin
from app.modules.c.governance_common import utc
from app.modules.c.governance_read_schemas import SAFE_AUDIT_METADATA_FIELDS


class SharedAuditFilters(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action_prefix: str | None = Field(default=None, min_length=1, max_length=120)
    actor_id: UUID | None = None
    target_type: str | None = Field(default=None, min_length=1, max_length=60)
    target_id: str | None = Field(default=None, min_length=1, max_length=120)
    since: AwareDatetime | None = None
    until: AwareDatetime | None = None
    page: int = Field(default=1, ge=1, le=1_000_000)
    page_size: int = Field(default=10, ge=1, le=100)


class SharedAuditRow(BaseModel):
    id: UUID
    occurred_at: datetime
    action: str
    actor_id: UUID | None
    target_type: str
    target_id: str
    reason: str | None
    before: dict | None
    after: dict | None
    metadata_redacted: bool


class SharedAuditPage(BaseModel):
    items: list[SharedAuditRow]
    total: int
    page: int
    page_size: int


def snapshot_fields(raw):
    if raw is None:
        return None, False
    if not isinstance(raw, dict):
        return None, True
    safe = {
        key: value
        for key, value in raw.items()
        if key in SAFE_AUDIT_METADATA_FIELDS and not isinstance(value, dict | list)
    }
    return safe, len(safe) != len(raw)


def shared_audit_page(session: Session, user: User, filters: SharedAuditFilters) -> SharedAuditPage:
    require_auth_audit_admin(session, user)
    if (filters.target_type is None) != (filters.target_id is None):
        raise ApiError(422, "INVALID_AUDIT_TARGET", "Provide both the target type and identifier.")
    if filters.since and filters.until and filters.since >= filters.until:
        raise ApiError(422, "INVALID_AUDIT_PERIOD", "Start must precede the end.")
    try:
        from app.modules.a.audit import list_audit_events
    except ModuleNotFoundError as exc:
        if exc.name != "app.modules.a.audit":
            raise
        raise ApiError(
            503, "AUDIT_SOURCE_UNAVAILABLE", "The operation audit service is unavailable."
        ) from exc

    source = list_audit_events(
        session,
        action_prefix=filters.action_prefix,
        actor_id=filters.actor_id,
        target=(filters.target_type, filters.target_id)
        if filters.target_type is not None
        else None,
        since=filters.since,
        until=filters.until,
        page=filters.page,
        page_size=filters.page_size,
    )
    rows = []
    for event in source.items:
        before, before_redacted = snapshot_fields(event.before_json)
        after, after_redacted = snapshot_fields(event.after_json)
        rows.append(
            SharedAuditRow(
                id=event.id,
                occurred_at=utc(event.occurred_at),
                action=event.action,
                actor_id=event.actor_id,
                target_type=event.target_type,
                target_id=event.target_id,
                reason=event.reason,
                before=before,
                after=after,
                metadata_redacted=before_redacted or after_redacted,
            )
        )
    return SharedAuditPage(
        items=rows, total=source.total, page=filters.page, page_size=filters.page_size
    )
