"""A4 inbox port. No production adapter or synthetic notification rows.

A must authorize the recipient on every call. Page counts and version describe
one atomic inbox snapshot. Mutations must join the supplied Session transaction,
lock the recipient inbox, CAS its version/snapshot and the single item version,
and replay an unchanged Idempotency-Key exactly once (changed payload: 409).
All-read marks the entire inbox at that snapshot, not merely the current page.
New delivery or read changes invalidate a stale snapshot with 409. A owns audit
and replay persistence. Adapters must not commit or perform remote side effects;
a remote A service needs a durable coordination protocol before connection.
"""

from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.modules.c.inbox_schemas import (
    ActionItemFilters,
    ActionItemRecord,
    MarkAllNotificationsRead,
    MarkNotificationRead,
    NotificationFilters,
    NotificationReadReceipt,
    NotificationRecord,
)


@dataclass(frozen=True)
class NotificationPage:
    recipient_id: UUID
    items: tuple[NotificationRecord, ...]
    total: int
    total_all: int
    unread_total: int
    snapshot_id: UUID
    inbox_version: int


@dataclass(frozen=True)
class ActionItemPage:
    recipient_id: UUID
    items: tuple[ActionItemRecord, ...]
    total: int


class InboxPort(Protocol):
    def notifications(
        self, session: Session, *, recipient_id: UUID, filters: NotificationFilters
    ) -> NotificationPage: ...

    def action_items(
        self, session: Session, *, recipient_id: UUID, filters: ActionItemFilters
    ) -> ActionItemPage: ...

    def mark_read(
        self,
        session: Session,
        *,
        recipient_id: UUID,
        notification_id: UUID,
        command: MarkNotificationRead,
        idempotency_key: str,
    ) -> NotificationReadReceipt: ...

    def mark_all_read(
        self,
        session: Session,
        *,
        recipient_id: UUID,
        command: MarkAllNotificationsRead,
        idempotency_key: str,
    ) -> NotificationReadReceipt: ...


class UnavailableInboxPort:
    def notifications(self, *_, **__):
        raise ApiError(503, "INBOX_SOURCE_UNAVAILABLE", "A notifications are not connected.")

    def action_items(self, *_, **__):
        raise ApiError(503, "ACTION_ITEMS_SOURCE_UNAVAILABLE", "A action items are not connected.")

    def mark_read(self, *_, **__):
        raise ApiError(
            503, "INBOX_WRITE_UNAVAILABLE", "A notification read service is not connected."
        )

    def mark_all_read(self, *_, **__):
        raise ApiError(
            503, "INBOX_WRITE_UNAVAILABLE", "A notification read service is not connected."
        )


def get_inbox_port() -> InboxPort:
    return UnavailableInboxPort()
