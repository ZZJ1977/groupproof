from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import User
from app.modules.c.governance_models import GovernanceIdempotency, GovernanceOutbox
from app.modules.c.integration_events import content_hash


def utc(value: datetime) -> datetime:
    return value.astimezone(UTC) if value.tzinfo else value.replace(tzinfo=UTC)


def current_actor(session: Session, user: User, *, admin=False, write=False) -> User:
    statement = select(User).where(User.id == user.id).execution_options(populate_existing=True)
    if write:
        statement = statement.with_for_update()
    actor = session.scalar(statement)
    if actor is None:
        raise ApiError(401, "UNAUTHENTICATED", "A current account is required.")
    if actor.status != "active":
        raise ApiError(403, "ACCOUNT_INACTIVE", "The account is not active.")
    if admin and actor.global_role != "admin":
        raise ApiError(403, "ADMIN_REQUIRED", "An administrator account is required.")
    if write and actor.email_verified_at is None:
        raise ApiError(403, "EMAIL_NOT_VERIFIED", "Verify the account email before changes.")
    return actor


def claim(session: Session, actor_id: UUID, operation: str, key: str, payload: dict):
    if not key or key != key.strip() or len(key) > 128:
        raise ApiError(422, "INVALID_IDEMPOTENCY_KEY", "A nonblank Idempotency-Key is required.")
    digest = content_hash(payload)
    query = select(GovernanceIdempotency).where(
        GovernanceIdempotency.actor_id == actor_id,
        GovernanceIdempotency.operation == operation,
        GovernanceIdempotency.key == key,
    )
    row = session.scalar(query)
    if row is None:
        try:
            with session.begin_nested():
                row = GovernanceIdempotency(
                    actor_id=actor_id,
                    operation=operation,
                    key=key,
                    request_hash=digest,
                    response_json={},
                )
                session.add(row)
                session.flush()
            return row, None
        except IntegrityError:
            row = session.scalar(query)
            if row is None:
                raise
    if row.request_hash != digest:
        raise ApiError(409, "IDEMPOTENCY_CONFLICT", "This key was used with another request.")
    if not row.response_json:
        raise ApiError(409, "REQUEST_IN_PROGRESS", "This request is not yet complete.")
    return row, row.response_json


def finish(session, row, result):
    row.response_json = result
    session.flush()
    return result


def event(session, aggregate_id, event_type, payload):
    session.add(
        GovernanceOutbox(aggregate_id=aggregate_id, event_type=event_type, payload_json=payload)
    )


def history_data(rows) -> list[dict]:
    return [
        {
            "id": str(row.id),
            "actor_id": str(row.actor_id),
            "version_no": row.version_no,
            "action": getattr(row, "action", None) or row.decision,
            "reason": row.reason,
            "before": row.before_json,
            "after": row.after_json,
            "created_at": utc(row.created_at).isoformat(),
        }
        for row in rows
    ]
