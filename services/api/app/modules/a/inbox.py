"""A4-01 发通知、A4-03 建待办 / 关待办，以及 C 收件箱页面用的数据接口（InboxPort）。

一行代码发通知 / 建待办（在业务事务里调用，随业务一起提交）::

    from app.modules.a.inbox import notify, create_action_item, close_action_item

    notify(session, recipient=leader, category="project", title="验收被退回",
           description="任务 T-3 的验收被老师退回", target={"kind": "task", "id": task.id,
           "project_id": project.id}, email=True)

    item = create_action_item(session, recipient=teacher, category="member",
                              title="入组申请待审批", target={...}, source_key=f"join:{req.id}")
    close_action_item(session, item.id, status="completed", actor=teacher)

- ``target`` 的格式与 C 的 ``InboxTarget`` 一致（kind / id / project_id 或 course_id），
  写入前就校验，坏数据进不了库；
- ``dedupe_key`` / ``source_key`` 让同一件事重复调用只产生一条；
- ``email=True`` 只把通知标为待发邮件，事务提交后才真正发送（发送失败不影响业务）。
"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import UTC, datetime
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from sqlalchemy import Text, case, cast, event, func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import User
from app.modules.a.models import (
    ACTION_ITEM_CATEGORIES,
    ACTION_ITEM_PRIORITIES,
    NOTIFICATION_CATEGORIES,
    ActionItem,
    Inbox,
    InboxReplay,
    Notification,
)
from app.modules.c.inbox_ports import ActionItemPage, NotificationPage
from app.modules.c.inbox_schemas import (
    ActionItemFilters,
    ActionItemRecord,
    InboxTarget,
    MarkAllNotificationsRead,
    MarkNotificationRead,
    NotificationFilters,
    NotificationReadReceipt,
    NotificationRecord,
)

logger = logging.getLogger("groupproof.a.inbox")

_PENDING_EMAIL_FLAG = "a_inbox_pending_email"
MAX_EMAIL_ATTEMPTS = 5


def _now() -> datetime:
    return datetime.now(UTC)


def _recipient_id(recipient: User | UUID) -> UUID:
    return recipient.id if isinstance(recipient, User) else recipient


def _target_json(target: InboxTarget | dict | None) -> dict | None:
    if target is None:
        return None
    try:
        parsed = InboxTarget.model_validate(target)
    except ValueError as exc:
        raise ValueError(f"Invalid inbox target: {exc}") from exc
    return parsed.model_dump(mode="json")


def default_snapshot_id(recipient_id: UUID) -> UUID:
    """没有任何通知的收件箱用固定快照号，读接口因此不需要写库。"""
    return uuid5(NAMESPACE_URL, f"groupproof:inbox:{recipient_id}")


def _ensure_inbox(session: Session, recipient_id: UUID) -> None:
    """收件箱行不存在时以初始状态创建（并发创建由主键冲突兜底）。"""
    if session.get_bind().dialect.name == "postgresql":
        session.execute(
            insert(Inbox)
            .values(
                recipient_id=recipient_id,
                version=0,
                snapshot_id=default_snapshot_id(recipient_id),
                updated_at=_now(),
            )
            .on_conflict_do_nothing(index_elements=[Inbox.recipient_id])
        )
        return
    if session.get(Inbox, recipient_id) is None:
        session.add(
            Inbox(
                recipient_id=recipient_id,
                version=0,
                snapshot_id=default_snapshot_id(recipient_id),
                updated_at=_now(),
            )
        )
        session.flush()


def _bump_inbox(session: Session, recipient_id: UUID) -> Inbox:
    """锁住收件箱并 version+1、换新快照（投递和已读变化都调用）。"""
    _ensure_inbox(session, recipient_id)
    inbox = session.scalar(
        select(Inbox)
        .where(Inbox.recipient_id == recipient_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    inbox.version += 1
    inbox.snapshot_id = uuid4()
    inbox.updated_at = _now()
    session.flush()
    return inbox


# ------------------------------------------------------------------ A4-01 发通知


def notify(
    session: Session,
    *,
    recipient: User | UUID,
    category: str,
    title: str,
    description: str = "",
    target: InboxTarget | dict | None = None,
    email: bool = False,
    dedupe_key: str | None = None,
) -> Notification:
    """给某人发一条站内通知；email=True 时事务提交后再发邮件。"""
    if category not in NOTIFICATION_CATEGORIES:
        raise ValueError(f"category must be one of {NOTIFICATION_CATEGORIES}")
    title = title.strip()
    if not 1 <= len(title) <= 300 or len(description) > 2000:
        raise ValueError("title must be 1-300 characters and description at most 2000.")
    recipient_id = _recipient_id(recipient)
    target_json = _target_json(target)
    if dedupe_key is not None:
        existing = session.scalar(
            select(Notification).where(
                Notification.recipient_id == recipient_id,
                Notification.dedupe_key == dedupe_key,
            )
        )
        if existing is not None:
            return existing
    _bump_inbox(session, recipient_id)
    row = Notification(
        id=uuid4(),
        recipient_id=recipient_id,
        category=category,
        title=title,
        description=description,
        target_json=target_json,
        dedupe_key=dedupe_key,
        created_at=_now(),
        lock_version=0,
        email_status="pending" if email else "none",
        email_attempts=0,
    )
    session.add(row)
    session.flush()
    if email:
        session.info[_PENDING_EMAIL_FLAG] = True
    return row


def deliver_pending_emails(session: Session, *, limit: int = 50) -> dict[str, int]:
    """发送待发的通知邮件并记录结果；可由提交后钩子或定时任务调用。"""
    from app.auth.services.mailer import send_email

    rows = session.scalars(
        select(Notification)
        .where(
            Notification.email_status == "pending",
            Notification.email_attempts < MAX_EMAIL_ATTEMPTS,
        )
        .order_by(Notification.created_at)
        .limit(limit)
        .with_for_update(skip_locked=True)
    ).all()
    result = {"sent": 0, "failed": 0, "skipped": 0}
    for row in rows:
        user = session.get(User, row.recipient_id)
        row.email_attempts += 1
        if user is None or not user.email or user.status != "active":
            row.email_status = "failed"
            result["skipped"] += 1
            continue
        body = f"{row.description}\n\n请登录 GroupProof 查看详情。" if row.description else ""
        try:
            send_email(user.email, f"[GroupProof] {row.title}", body or row.title, "notification")
        except Exception:  # noqa: BLE001 - 邮件失败不影响站内通知
            logger.warning("notification email failed id=%s", row.id, exc_info=True)
            if row.email_attempts >= MAX_EMAIL_ATTEMPTS:
                row.email_status = "failed"
            result["failed"] += 1
            continue
        row.email_status = "sent"
        row.email_sent_at = _now()
        result["sent"] += 1
    session.flush()
    return result


@event.listens_for(Session, "after_commit")
def _send_emails_after_commit(session: Session) -> None:
    if not session.info.pop(_PENDING_EMAIL_FLAG, False):
        return
    try:
        from app.db.session import SessionLocal

        with SessionLocal() as delivery:
            deliver_pending_emails(delivery)
            delivery.commit()
    except Exception:  # noqa: BLE001 - 失败的邮件保持 pending，下次再试
        logger.warning("deferred notification email delivery failed", exc_info=True)


# ------------------------------------------------------------------ A4-03 待办


def create_action_item(
    session: Session,
    *,
    recipient: User | UUID,
    category: str,
    title: str,
    target: InboxTarget | dict,
    description: str = "",
    priority: str = "medium",
    due_at: datetime | None = None,
    source_key: str | None = None,
) -> ActionItem:
    """给某人建一条待办。source_key 相同的待办只会有一条（重复调用返回原来那条）。"""
    if category not in ACTION_ITEM_CATEGORIES:
        raise ValueError(f"category must be one of {ACTION_ITEM_CATEGORIES}")
    if priority not in ACTION_ITEM_PRIORITIES:
        raise ValueError(f"priority must be one of {ACTION_ITEM_PRIORITIES}")
    if due_at is not None and due_at.tzinfo is None:
        raise ValueError("due_at must be timezone-aware.")
    recipient_id = _recipient_id(recipient)
    target_json = _target_json(target)
    now = _now()
    # 用 C 的记录模型校验“待办类别 ↔ 处理页面”是否匹配，坏数据不进库。
    ActionItemRecord.model_validate(
        {
            "id": uuid4(),
            "recipient_id": recipient_id,
            "category": category,
            "title": title,
            "description": description,
            "status": "pending",
            "priority": priority,
            "created_at": now,
            "due_at": due_at,
            "target": target_json,
        }
    )
    if source_key is not None:
        existing = session.scalar(
            select(ActionItem).where(
                ActionItem.recipient_id == recipient_id, ActionItem.source_key == source_key
            )
        )
        if existing is not None:
            return existing
    row = ActionItem(
        id=uuid4(),
        recipient_id=recipient_id,
        category=category,
        title=title.strip(),
        description=description,
        status="pending",
        priority=priority,
        target_json=target_json,
        source_key=source_key,
        created_at=now,
        due_at=due_at,
    )
    session.add(row)
    session.flush()
    return row


def close_action_item(
    session: Session,
    item_id: UUID,
    *,
    status: str = "completed",
    actor: User | UUID | None = None,
) -> ActionItem:
    """关闭待办（completed / rejected）。已关闭的再关一次不报错，保持第一次的结果。"""
    if status not in {"completed", "rejected"}:
        raise ValueError("status must be 'completed' or 'rejected'.")
    row = session.scalar(
        select(ActionItem)
        .where(ActionItem.id == item_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None:
        raise ApiError(404, "ACTION_ITEM_NOT_FOUND", "待办不存在。")
    if row.status == "pending":
        row.status = status
        row.closed_at = _now()
        row.closed_by = _recipient_id(actor) if actor is not None else None
        session.flush()
    return row


def close_action_items_by_source(
    session: Session, source_key: str, *, status: str = "completed", actor: User | UUID | None
) -> int:
    """按 source_key 关闭所有人的同一件待办（例如多个老师都收到的审批，一人处理后全部关闭）。"""
    if status not in {"completed", "rejected"}:
        raise ValueError("status must be 'completed' or 'rejected'.")
    result = session.execute(
        update(ActionItem)
        .where(ActionItem.source_key == source_key, ActionItem.status == "pending")
        .values(
            status=status,
            closed_at=_now(),
            closed_by=_recipient_id(actor) if actor is not None else None,
        )
    )
    session.flush()
    return result.rowcount or 0


# ------------------------------------------------------------------ C 收件箱数据接口


def _notification_record(row: Notification) -> NotificationRecord:
    return NotificationRecord(
        id=row.id,
        recipient_id=row.recipient_id,
        category=row.category,
        title=row.title,
        description=row.description,
        created_at=row.created_at,
        read_at=row.read_at,
        lock_version=row.lock_version,
        target=row.target_json,
    )


def _action_record(row: ActionItem) -> ActionItemRecord:
    return ActionItemRecord(
        id=row.id,
        recipient_id=row.recipient_id,
        category=row.category,
        title=row.title,
        description=row.description,
        status=row.status,
        priority=row.priority,
        created_at=row.created_at,
        due_at=row.due_at,
        target=row.target_json,
    )


def _request_hash(payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, default=str, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


class DatabaseInboxPort:
    """C 的 InboxPort 的正式实现：读写都在调用方的事务里，不自行提交。"""

    def _inbox_state(self, session: Session, recipient_id: UUID, *, lock: bool = False):
        statement = select(Inbox).where(Inbox.recipient_id == recipient_id)
        if lock:
            statement = statement.with_for_update()
        inbox = session.scalar(statement.execution_options(populate_existing=True))
        if inbox is None:
            return None, 0, default_snapshot_id(recipient_id)
        return inbox, inbox.version, inbox.snapshot_id

    def _counts(self, session: Session, recipient_id: UUID) -> tuple[int, int]:
        total_all, unread = session.execute(
            select(
                func.count(Notification.id),
                func.coalesce(func.sum(case((Notification.read_at.is_(None), 1), else_=0)), 0),
            ).where(Notification.recipient_id == recipient_id)
        ).one()
        return int(total_all), int(unread)

    def notifications(
        self, session: Session, *, recipient_id: UUID, filters: NotificationFilters
    ) -> NotificationPage:
        _, version, snapshot_id = self._inbox_state(session, recipient_id)
        conditions = [Notification.recipient_id == recipient_id]
        if filters.state == "unread":
            conditions.append(Notification.read_at.is_(None))
        elif filters.state == "read":
            conditions.append(Notification.read_at.is_not(None))
        if filters.category != "all":
            conditions.append(Notification.category == filters.category)
        total = session.scalar(select(func.count(Notification.id)).where(*conditions)) or 0
        rows = session.scalars(
            select(Notification)
            .where(*conditions)
            .order_by(Notification.created_at.desc(), cast(Notification.id, Text))
            .offset((filters.page - 1) * filters.page_size)
            .limit(filters.page_size)
            .execution_options(populate_existing=True)
        ).all()
        total_all, unread = self._counts(session, recipient_id)
        return NotificationPage(
            recipient_id=recipient_id,
            items=tuple(_notification_record(row) for row in rows),
            total=int(total),
            total_all=total_all,
            unread_total=unread,
            snapshot_id=snapshot_id,
            inbox_version=version,
        )

    def action_items(
        self, session: Session, *, recipient_id: UUID, filters: ActionItemFilters
    ) -> ActionItemPage:
        conditions = [ActionItem.recipient_id == recipient_id]
        if filters.status != "all":
            conditions.append(ActionItem.status == filters.status)
        if filters.category != "all":
            conditions.append(ActionItem.category == filters.category)
        total = session.scalar(select(func.count(ActionItem.id)).where(*conditions)) or 0
        rows = session.scalars(
            select(ActionItem)
            .where(*conditions)
            .order_by(ActionItem.created_at.desc(), cast(ActionItem.id, Text))
            .offset((filters.page - 1) * filters.page_size)
            .limit(filters.page_size)
            .execution_options(populate_existing=True)
        ).all()
        return ActionItemPage(
            recipient_id=recipient_id,
            items=tuple(_action_record(row) for row in rows),
            total=int(total),
        )

    def _replay(self, session, recipient_id, key, request_hash):
        replay = session.get(InboxReplay, (recipient_id, key))
        if replay is None:
            return None
        if replay.request_hash != request_hash:
            raise ApiError(
                409, "IDEMPOTENCY_KEY_REUSED", "该请求编号已用于另一个操作，请刷新后重试。"
            )
        return NotificationReadReceipt.model_validate(replay.receipt_json)

    def _check_snapshot(self, version, snapshot_id, command) -> None:
        if command.expected_inbox_version != version or command.snapshot_id != snapshot_id:
            raise ApiError(409, "INBOX_SNAPSHOT_STALE", "通知列表已有变化，请刷新后再试。")

    def _save(self, session, recipient_id, key, request_hash, receipt) -> NotificationReadReceipt:
        session.add(
            InboxReplay(
                recipient_id=recipient_id,
                idempotency_key=key,
                request_hash=request_hash,
                receipt_json=receipt.model_dump(mode="json"),
            )
        )
        session.flush()
        return receipt

    def mark_read(
        self,
        session: Session,
        *,
        recipient_id: UUID,
        notification_id: UUID,
        command: MarkNotificationRead,
        idempotency_key: str,
    ) -> NotificationReadReceipt:
        request_hash = _request_hash(
            {"op": "single", "id": str(notification_id), **command.model_dump(mode="json")}
        )
        # 先锁收件箱（不存在时先建一行），保证同一收件人的已读操作串行。
        _ensure_inbox(session, recipient_id)
        inbox, version, snapshot_id = self._inbox_state(session, recipient_id, lock=True)
        replay = self._replay(session, recipient_id, idempotency_key, request_hash)
        if replay is not None:
            return replay
        self._check_snapshot(version, snapshot_id, command)
        row = session.scalar(
            select(Notification)
            .where(Notification.id == notification_id, Notification.recipient_id == recipient_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if row is None:
            raise ApiError(404, "NOTIFICATION_NOT_FOUND", "通知不存在。")
        if row.lock_version != command.expected_version:
            raise ApiError(409, "NOTIFICATION_VERSION_CONFLICT", "通知已被修改，请刷新后再试。")
        total_all, unread_before = self._counts(session, recipient_id)
        now = _now()
        marked = 0
        if row.read_at is None:
            row.read_at = max(now, row.created_at)
            row.lock_version += 1
            marked = 1
            inbox.version += 1
            inbox.snapshot_id = uuid4()
            inbox.updated_at = now
            session.flush()
        receipt = NotificationReadReceipt(
            recipient_id=recipient_id,
            operation="single",
            notification_id=notification_id,
            idempotency_key=idempotency_key,
            snapshot_id=command.snapshot_id,
            expected_version=command.expected_version,
            expected_inbox_version=command.expected_inbox_version,
            resulting_version=command.expected_version + marked,
            resulting_inbox_version=command.expected_inbox_version + marked,
            total_all=total_all,
            unread_before=unread_before,
            unread_after=unread_before - marked,
            marked_count=marked,
            read_at=row.read_at,
        )
        return self._save(session, recipient_id, idempotency_key, request_hash, receipt)

    def mark_all_read(
        self,
        session: Session,
        *,
        recipient_id: UUID,
        command: MarkAllNotificationsRead,
        idempotency_key: str,
    ) -> NotificationReadReceipt:
        request_hash = _request_hash({"op": "all", **command.model_dump(mode="json")})
        _ensure_inbox(session, recipient_id)
        inbox, version, snapshot_id = self._inbox_state(session, recipient_id, lock=True)
        replay = self._replay(session, recipient_id, idempotency_key, request_hash)
        if replay is not None:
            return replay
        self._check_snapshot(version, snapshot_id, command)
        total_all, unread_before = self._counts(session, recipient_id)
        now = _now()
        marked = 0
        if unread_before:
            result = session.execute(
                update(Notification)
                .where(
                    Notification.recipient_id == recipient_id,
                    Notification.read_at.is_(None),
                )
                .values(
                    read_at=func.greatest(now, Notification.created_at),
                    lock_version=Notification.lock_version + 1,
                )
                .execution_options(synchronize_session=False)
            )
            marked = result.rowcount or 0
            inbox.version += 1
            inbox.snapshot_id = uuid4()
            inbox.updated_at = now
            session.flush()
        receipt = NotificationReadReceipt(
            recipient_id=recipient_id,
            operation="all",
            notification_id=None,
            idempotency_key=idempotency_key,
            snapshot_id=command.snapshot_id,
            expected_version=None,
            expected_inbox_version=command.expected_inbox_version,
            resulting_version=None,
            resulting_inbox_version=command.expected_inbox_version + bool(marked),
            total_all=total_all,
            unread_before=unread_before,
            unread_after=unread_before - marked,
            marked_count=marked,
            read_at=now,
        )
        return self._save(session, recipient_id, idempotency_key, request_hash, receipt)


def get_database_inbox_port() -> DatabaseInboxPort:
    return DatabaseInboxPort()
