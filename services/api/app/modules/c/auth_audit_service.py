"""Read A's persisted authentication audit without altering or enriching its facts.

No historical role, reason, before/after or business-resource event is invented.
Imported/unknown metadata is redacted. A remains the only writer of these rows.
"""

from typing import get_args
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy import func, select, true
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.auth.models import AuthAuditEvent
from app.db.models import User
from app.modules.c.auth_audit_schemas import (
    AuthAuditAction,
    AuthAuditFilters,
    AuthAuditLogDTO,
    AuthAuditPageDTO,
)
from app.modules.c.governance_common import current_actor, utc
from app.modules.c.school_email import has_verified_school_email

KNOWN_ACTIONS = frozenset(get_args(AuthAuditAction))
# Field names only. Never return arbitrary changed_fields strings or nested JSON,
# even if an old import put credential values inside this nominally metadata field.
SAFE_CHANGED_FIELDS = frozenset(
    {
        "name",
        "username",
        "studentId",
        "college",
        "requestedIdentity",
        "schoolEmail",
        "accountStatus",
        "auth_identities",
        "changeAuthorizedUntil",
        "creationGrant",
        "credentialVersion",
        "email",
        "loginEmailVerifiedAt",
        "passwordHash",
        "password_credentials",
        "pendingSchoolEmail",
        "preferredLocale",
        "roles",
        "session",
        "teacherReviewStatus",
        "users",
        "purpose:password_recovery",
        "purpose:school_email_verify",
        "purpose:change_authorization",
        "purpose:login_email_verification",
    }
)


def require_auth_audit_admin(session: Session, user: User) -> None:
    actor = current_actor(session, user, admin=True)
    if not has_verified_school_email(session, actor):
        raise ApiError(403, "EMAIL_NOT_VERIFIED", "A verified administrator is required.")


def projection():
    # Omit request_id and every unrelated auth table; adding a model field cannot
    # accidentally expand this API or expose credential/session content.
    return (
        AuthAuditEvent.id,
        AuthAuditEvent.event_type,
        AuthAuditEvent.actor_id,
        AuthAuditEvent.target_user_id,
        AuthAuditEvent.result,
        AuthAuditEvent.changed_fields,
        AuthAuditEvent.created_at,
    )


def user_reference(value):
    if value is None:
        return None, False
    try:
        return UUID(value), False
    except (ValueError, TypeError, AttributeError):
        # Legacy noncanonical actor IDs are not remapped by guessing names/roles.
        return None, True


def audit_data(row) -> AuthAuditLogDTO:
    actor_id, actor_redacted = (
        ("system", False) if row["actor_id"] == "system" else user_reference(row["actor_id"])
    )
    target_id, target_redacted = user_reference(row["target_user_id"])
    action = row["event_type"] if row["event_type"] in KNOWN_ACTIONS else "unrecognized"
    result = row["result"] if row["result"] in {"success", "failure"} else "unknown"
    fields = row["changed_fields"]
    safe_fields = (
        list(
            dict.fromkeys(
                field for field in fields if isinstance(field, str) and field in SAFE_CHANGED_FIELDS
            )
        )
        if isinstance(fields, list)
        else []
    )
    redacted_fields = not isinstance(fields, list) or any(
        not isinstance(field, str) or field not in SAFE_CHANGED_FIELDS for field in fields
    )
    try:
        return AuthAuditLogDTO(
            id=row["id"],
            action=action,
            actor_id=actor_id,
            target_user_id=target_id,
            result=result,
            occurred_at=utc(row["created_at"]),
            changed_fields=safe_fields,
            metadata_redacted=(
                actor_redacted
                or target_redacted
                or redacted_fields
                or action == "unrecognized"
                or result == "unknown"
            ),
        )
    except (ValidationError, AttributeError, TypeError, ValueError) as error:
        # Do not echo malformed stored IDs/timestamps or raw provider data.
        raise ApiError(
            503, "AUTH_AUDIT_RECORD_INVALID", "An audit record is unavailable."
        ) from error


def list_auth_audit_logs(
    session: Session, user: User, filters: AuthAuditFilters
) -> AuthAuditPageDTO:
    require_auth_audit_admin(session, user)
    conditions = []
    for column, value in (
        (AuthAuditEvent.event_type, filters.action),
        (AuthAuditEvent.result, filters.result),
        (AuthAuditEvent.actor_id, filters.actor_id),
        (AuthAuditEvent.target_user_id, filters.target_user_id),
    ):
        if value is not None:
            conditions.append(column == str(value))
    if filters.since is not None:
        conditions.append(AuthAuditEvent.created_at >= utc(filters.since))
    if filters.until is not None:
        conditions.append(AuthAuditEvent.created_at < utc(filters.until))
    filtered = select(*projection()).where(*conditions).cte("auth_audit_filtered")
    total = select(func.count().label("total")).select_from(filtered).cte("auth_audit_total")
    page = (
        select(filtered)
        .order_by(filtered.c.created_at.desc(), filtered.c.id.asc())
        .offset((filters.page - 1) * filters.page_size)
        .limit(filters.page_size)
        .cte("auth_audit_page")
    )
    # One SQL snapshot for page and total, including a page beyond the last row.
    rows = (
        session.execute(
            select(total.c.total, *page.c)
            .select_from(total.outerjoin(page, true()))
            .order_by(page.c.created_at.desc(), page.c.id.asc())
        )
        .mappings()
        .all()
    )
    return AuthAuditPageDTO(
        items=[audit_data(row) for row in rows if row["id"] is not None],
        total=rows[0]["total"],
        page=filters.page,
        page_size=filters.page_size,
    )


def get_auth_audit_log(session: Session, user: User, record_id: str) -> AuthAuditLogDTO:
    require_auth_audit_admin(session, user)
    row = (
        session.execute(select(*projection()).where(AuthAuditEvent.id == record_id))
        .mappings()
        .one_or_none()
    )
    if row is None:
        raise ApiError(
            404, "AUTH_AUDIT_LOG_NOT_FOUND", "The authentication audit log was not found."
        )
    return audit_data(row)
