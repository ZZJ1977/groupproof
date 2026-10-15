from uuid import UUID

from pydantic import ValidationError
from sqlalchemy import select

from app.api.errors import ApiError
from app.db.models import User
from app.modules.c.inbox_ports import ActionItemPage, NotificationPage
from app.modules.c.inbox_schemas import (
    ActionItemRecord,
    NotificationReadReceipt,
    NotificationRecord,
)
from app.modules.c.school_email import has_verified_school_email


def actor(session, user, *, write=False):
    query = select(User).where(User.id == user.id).execution_options(populate_existing=True)
    current = session.scalar(query.with_for_update() if write else query)
    if current is None:
        raise ApiError(401, "UNAUTHENTICATED", "A current account is required.")
    if current.status != "active" or not has_verified_school_email(session, current, lock=write):
        raise ApiError(403, "INBOX_ACCOUNT_INELIGIBLE", "An active verified account is required.")
    return current


def invalid(message="A returned an invalid or cross-recipient inbox response."):
    return ApiError(503, "INBOX_SOURCE_INVALID", message)


def validate(model, value):
    try:
        return model.model_validate(value.model_dump() if isinstance(value, model) else value)
    except (ValidationError, TypeError, ValueError) as error:
        raise invalid() from error


def target_href(target):
    if target is None:
        return None
    if target.kind == "course":
        return f"/courses/{target.course_id}/rules"
    if target.kind == "rule_change":
        return f"/courses/{target.course_id}/rule-changes?change={target.id}"
    if target.kind == "member_change":
        return f"/teacher/courses/{target.course_id}/member-changes?request={target.id}"
    if target.kind == "appeal":
        return f"/teacher/courses/{target.course_id}/appeals?appeal={target.id}"
    base = f"/projects/{target.project_id}"
    return {
        "project": base,
        "task": f"{base}/tasks/{target.id}",
        "verification": f"{base}/tasks/{target.id}/verification",
        "evidence": f"{base}/evidence?evidence={target.id}",
        "discussion": f"{base}/discussions?discussion={target.id}",
        "baseline": f"{base}/setup",
        "plan": f"{base}/planning",
    }[target.kind]


def validate_page(page, kind, current, filters):
    if (
        not isinstance(page, kind)
        or page.recipient_id != current.id
        or type(page.total) is not int
        or page.total < 0
        or not isinstance(page.items, tuple)
    ):
        raise invalid()
    if len(page.items) != min(
        filters.page_size, max(0, page.total - (filters.page - 1) * filters.page_size)
    ):
        raise invalid("A returned an incomplete inbox page.")
    model = NotificationRecord if kind is NotificationPage else ActionItemRecord
    rows = [validate(model, row) for row in page.items]
    if len({row.id for row in rows}) != len(rows):
        raise invalid("A returned repeated inbox records.")
    if rows != sorted(rows, key=lambda row: (-row.created_at.timestamp(), str(row.id))):
        raise invalid("A returned an unstable inbox order.")
    for row in rows:
        if row.recipient_id != current.id or (
            filters.category != "all" and row.category != filters.category
        ):
            raise invalid()
    return rows


def notifications(session, user, filters, port):
    current = actor(session, user)
    page = port.notifications(
        session, recipient_id=current.id, filters=filters.model_copy(deep=True)
    )
    rows = validate_page(page, NotificationPage, current, filters)
    if (
        any(
            type(n) is not int or n < 0
            for n in (page.total_all, page.unread_total, page.inbox_version)
        )
        or not isinstance(page.snapshot_id, UUID)
        or page.total > page.total_all
        or page.unread_total > page.total_all
    ):
        raise invalid("A returned invalid notification counts or snapshot.")
    visible_unread = sum(row.read_at is None for row in rows)
    if (
        visible_unread > page.unread_total
        or len(rows) - visible_unread > page.total_all - page.unread_total
    ):
        raise invalid("A unread count contradicts its page.")
    if (filters.state == "unread" and page.total > page.unread_total) or (
        filters.state == "read" and page.total > page.total_all - page.unread_total
    ):
        raise invalid("A filtered total exceeds the matching inbox count.")
    if filters.category == "all":
        expected = {
            "all": page.total_all,
            "unread": page.unread_total,
            "read": page.total_all - page.unread_total,
        }[filters.state]
        if page.total != expected:
            raise invalid("A unread count does not match the unfiltered total.")
    if any(
        (filters.state == "unread" and row.read_at is not None)
        or (filters.state == "read" and row.read_at is None)
        for row in rows
    ):
        raise invalid("A did not apply the notification state filter.")
    return {
        "items": [{**row.model_dump(), "href": target_href(row.target)} for row in rows],
        "total": page.total,
        "total_all": page.total_all,
        "unread_total": page.unread_total,
        "page": filters.page,
        "page_size": filters.page_size,
        "snapshot_id": page.snapshot_id,
        "inbox_version": page.inbox_version,
    }


def action_items(session, user, filters, port):
    current = actor(session, user)
    page = port.action_items(
        session, recipient_id=current.id, filters=filters.model_copy(deep=True)
    )
    rows = validate_page(page, ActionItemPage, current, filters)
    if any(filters.status != "all" and row.status != filters.status for row in rows):
        raise invalid("A did not apply the action-item status filter.")
    return {
        "items": [{**row.model_dump(), "href": target_href(row.target)} for row in rows],
        "total": page.total,
        "page": filters.page,
        "page_size": filters.page_size,
    }


def mark_read(session, user, command, key, port, *, notification_id=None):
    current = actor(session, user, write=True)
    if (
        not key
        or key != key.strip()
        or len(key) > 128
        or any(ord(c) < 33 or ord(c) == 127 for c in key)
    ):
        raise ApiError(422, "INVALID_IDEMPOTENCY_KEY", "A valid Idempotency-Key is required.")
    operation = "single" if notification_id else "all"
    expected_version = command.expected_version if notification_id else None
    kwargs = {
        "recipient_id": current.id,
        "command": command.model_copy(deep=True),
        "idempotency_key": key,
    }
    result = (
        port.mark_read(session, notification_id=notification_id, **kwargs)
        if notification_id
        else port.mark_all_read(session, **kwargs)
    )
    receipt = validate(NotificationReadReceipt, result)
    if (
        receipt.recipient_id != current.id
        or receipt.operation != operation
        or receipt.notification_id != notification_id
        or receipt.idempotency_key != key
        or receipt.snapshot_id != command.snapshot_id
        or receipt.expected_version != expected_version
        or receipt.expected_inbox_version != command.expected_inbox_version
        or receipt.unread_before > receipt.total_all
        or receipt.unread_after != receipt.unread_before - receipt.marked_count
        or receipt.resulting_inbox_version
        != command.expected_inbox_version + bool(receipt.marked_count)
    ):
        raise invalid("A did not confirm the exact read command, snapshot and counts.")
    if notification_id:
        if (
            receipt.marked_count not in (0, 1)
            or receipt.resulting_version != expected_version + receipt.marked_count
        ):
            raise invalid("A did not confirm the exact notification version.")
    elif receipt.resulting_version is not None or receipt.unread_after != 0:
        raise invalid("A did not confirm all snapshot notifications read.")
    return receipt.model_dump()
