"""Transaction-local events and idempotency. Helpers never commit a session."""

from __future__ import annotations

import hashlib
import json
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.modules.c.models import IntegrationOutbox, RequestIdempotency


def content_hash(value: object) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def emit_event(
    session: Session, *, project_id: UUID, aggregate_id: UUID, event_type: str, payload: dict
) -> UUID:
    event_id = uuid4()
    session.add(
        IntegrationOutbox(
            id=event_id,
            project_id=project_id,
            aggregate_id=aggregate_id,
            event_type=event_type,
            payload_json=payload,
        )
    )
    return event_id


def claim_request(
    session: Session,
    *,
    actor_id: UUID,
    project_id: UUID,
    operation: str,
    key: str,
    payload: dict,
) -> tuple[RequestIdempotency, dict | None]:
    """A unique DB row serializes duplicate commands, including concurrent retries.

    A nested savepoint keeps a losing INSERT from rolling back unrelated domain
    work. Same key with a different body is always a conflict, never a replay.
    """
    if not key or key != key.strip() or len(key) > 128:
        raise ApiError(422, "INVALID_IDEMPOTENCY_KEY", "A nonblank Idempotency-Key is required.")
    fingerprint = content_hash(payload)
    lookup = select(RequestIdempotency).where(
        RequestIdempotency.actor_id == actor_id,
        RequestIdempotency.project_id == project_id,
        RequestIdempotency.operation == operation,
        RequestIdempotency.idempotency_key == key,
    )
    record = session.scalar(lookup)
    if record is None:
        try:
            with session.begin_nested():
                record = RequestIdempotency(
                    actor_id=actor_id,
                    project_id=project_id,
                    operation=operation,
                    idempotency_key=key,
                    request_hash=fingerprint,
                    response_json={},
                )
                session.add(record)
                session.flush()
            return record, None
        except IntegrityError:
            record = session.scalar(lookup)
            if record is None:
                raise
    if record.request_hash != fingerprint:
        raise ApiError(409, "IDEMPOTENCY_CONFLICT", "This key was used with a different request.")
    if not record.response_json:
        raise ApiError(409, "REQUEST_IN_PROGRESS", "This request has not completed; retry later.")
    return record, record.response_json


def finish_request(session: Session, record: RequestIdempotency, response: dict) -> dict:
    record.response_json = response
    session.flush()
    return response
