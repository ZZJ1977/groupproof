"""Course-scoped replay and pending events, committed with the file mutation."""

from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.modules.c.course_files_models import CourseFileOutbox, CourseFileRequest
from app.modules.c.integration_events import content_hash


def emit_event(
    session: Session, *, course_id: UUID, aggregate_id: UUID, event_type: str, payload: dict
) -> UUID:
    event_id = uuid4()
    session.add(
        CourseFileOutbox(
            id=event_id,
            course_id=course_id,
            aggregate_id=aggregate_id,
            event_type=event_type,
            payload_json=payload,
        )
    )
    return event_id


def claim_request(
    session: Session, *, actor_id: UUID, course_id: UUID, operation: str, key: str, payload: dict
) -> tuple[CourseFileRequest, dict | None]:
    if not key or key != key.strip() or len(key) > 128:
        raise ApiError(422, "INVALID_IDEMPOTENCY_KEY", "A nonblank Idempotency-Key is required.")
    fingerprint = content_hash(payload)
    lookup = select(CourseFileRequest).where(
        CourseFileRequest.actor_id == actor_id,
        CourseFileRequest.course_id == course_id,
        CourseFileRequest.operation == operation,
        CourseFileRequest.idempotency_key == key,
    )
    record = session.scalar(lookup)
    if record is None:
        try:
            with session.begin_nested():
                record = CourseFileRequest(
                    actor_id=actor_id,
                    course_id=course_id,
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


def finish_request(session: Session, record: CourseFileRequest, response: dict) -> dict:
    record.response_json = response
    session.flush()
    return response
