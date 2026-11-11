"""A 的公共服务数据表：操作记录、通知、待办、上传凭证。

表名统一以 ``a_`` 开头，迁移见 ``migrations/versions/0017_a_shared_services.py``。
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy import text as sa_text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.models.core import UUIDType

NOTIFICATION_CATEGORIES = ("course", "project", "system")
ACTION_ITEM_CATEGORIES = ("task", "verification", "evidence", "rule", "appeal", "member", "course")
ACTION_ITEM_STATUSES = ("pending", "completed", "rejected")
ACTION_ITEM_PRIORITIES = ("low", "medium", "high")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


class AuditEvent(Base):
    """A4-02 操作记录：谁、什么时候、对什么、改前改后、为什么。数据库触发器禁止修改和删除。"""

    __tablename__ = "a_audit_events"

    id: Mapped[UUID] = mapped_column(UUIDType, primary_key=True)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    actor_id: Mapped[UUID | None] = mapped_column(
        UUIDType, ForeignKey("users.id", ondelete="RESTRICT")
    )
    action: Mapped[str] = mapped_column(String(120), nullable=False)
    target_type: Mapped[str] = mapped_column(String(60), nullable=False)
    target_id: Mapped[str] = mapped_column(String(120), nullable=False)
    project_id: Mapped[UUID | None] = mapped_column(UUIDType)
    course_id: Mapped[UUID | None] = mapped_column(UUIDType)
    before_json: Mapped[dict | list | None] = mapped_column(JSONB)
    after_json: Mapped[dict | list | None] = mapped_column(JSONB)
    reason: Mapped[str | None] = mapped_column(Text)
    request_id: Mapped[str | None] = mapped_column(String(64))

    __table_args__ = (
        Index("ix_a_audit_events_target", "target_type", "target_id", "occurred_at"),
        Index("ix_a_audit_events_project", "project_id", "occurred_at"),
        Index("ix_a_audit_events_course", "course_id", "occurred_at"),
        Index("ix_a_audit_events_actor", "actor_id", "occurred_at"),
    )


class Inbox(Base):
    """每个收件人一行：任何投递或已读变化都让 version+1 并换新 snapshot_id。"""

    __tablename__ = "a_inboxes"

    recipient_id: Mapped[UUID] = mapped_column(
        UUIDType, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sa_text("0"))
    snapshot_id: Mapped[UUID] = mapped_column(UUIDType, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (CheckConstraint("version >= 0", name="ck_a_inboxes_version"),)


class Notification(Base):
    """A4-01 站内通知；email_status 记录“重要事情发邮件”的投递情况。"""

    __tablename__ = "a_notifications"

    id: Mapped[UUID] = mapped_column(UUIDType, primary_key=True)
    recipient_id: Mapped[UUID] = mapped_column(
        UUIDType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    category: Mapped[str] = mapped_column(String(16), nullable=False)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    description: Mapped[str] = mapped_column(String(2000), nullable=False)
    target_json: Mapped[dict | None] = mapped_column(JSONB)
    dedupe_key: Mapped[str | None] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    lock_version: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sa_text("0"))
    email_status: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=sa_text("'none'")
    )
    email_attempts: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=sa_text("0")
    )
    email_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(_in("category", NOTIFICATION_CATEGORIES), name="ck_a_notifications_cat"),
        CheckConstraint(
            _in("email_status", ("none", "pending", "sent", "failed")),
            name="ck_a_notifications_email_status",
        ),
        CheckConstraint("lock_version >= 0", name="ck_a_notifications_version"),
        UniqueConstraint("recipient_id", "dedupe_key", name="uq_a_notifications_dedupe"),
        Index("ix_a_notifications_recipient", "recipient_id", "created_at"),
        Index(
            "ix_a_notifications_email_pending",
            "email_status",
            postgresql_where=sa_text("email_status = 'pending'"),
        ),
    )


class InboxReplay(Base):
    """已读操作的幂等记录：同一个 Idempotency-Key 重放返回同一张回执。"""

    __tablename__ = "a_inbox_replays"

    recipient_id: Mapped[UUID] = mapped_column(
        UUIDType, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    idempotency_key: Mapped[str] = mapped_column(String(128), primary_key=True)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    receipt_json: Mapped[dict] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class ActionItem(Base):
    """A4-03 待办：需要别人处理的事统一存这里，处理完关闭。"""

    __tablename__ = "a_action_items"

    id: Mapped[UUID] = mapped_column(UUIDType, primary_key=True)
    recipient_id: Mapped[UUID] = mapped_column(
        UUIDType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    category: Mapped[str] = mapped_column(String(16), nullable=False)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    description: Mapped[str] = mapped_column(String(2000), nullable=False)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=sa_text("'pending'")
    )
    priority: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=sa_text("'medium'")
    )
    target_json: Mapped[dict] = mapped_column(JSONB, nullable=False)
    source_key: Mapped[str | None] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closed_by: Mapped[UUID | None] = mapped_column(
        UUIDType, ForeignKey("users.id", ondelete="SET NULL")
    )

    __table_args__ = (
        CheckConstraint(_in("category", ACTION_ITEM_CATEGORIES), name="ck_a_action_items_cat"),
        CheckConstraint(_in("status", ACTION_ITEM_STATUSES), name="ck_a_action_items_status"),
        CheckConstraint(_in("priority", ACTION_ITEM_PRIORITIES), name="ck_a_action_items_priority"),
        CheckConstraint(
            "(status = 'pending') = (closed_at IS NULL)", name="ck_a_action_items_closed"
        ),
        UniqueConstraint("recipient_id", "source_key", name="uq_a_action_items_source"),
        Index("ix_a_action_items_recipient", "recipient_id", "status", "created_at"),
    )


class UploadReceipt(Base):
    """A4-04 上传凭证：先发上传链接（pending），上传后服务端重新算指纹再标为 completed。"""

    __tablename__ = "a_upload_receipts"

    id: Mapped[UUID] = mapped_column(UUIDType, primary_key=True)
    scope: Mapped[str] = mapped_column(String(16), nullable=False)
    scope_id: Mapped[UUID] = mapped_column(UUIDType, nullable=False)
    actor_id: Mapped[UUID] = mapped_column(
        UUIDType, ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    provider: Mapped[str] = mapped_column(String(80), nullable=False)
    bucket: Mapped[str] = mapped_column(String(120), nullable=False)
    object_id: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    declared_mime: Mapped[str] = mapped_column(String(200), nullable=False)
    declared_size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=sa_text("'pending'")
    )
    content_hash: Mapped[str | None] = mapped_column(String(64))
    size_bytes: Mapped[int | None] = mapped_column(BigInteger)
    mime_type: Mapped[str | None] = mapped_column(String(200))
    revision: Mapped[str | None] = mapped_column(String(255))
    scan_status: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=sa_text("'pending'")
    )
    rejection_reason: Mapped[str | None] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    upload_expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(_in("scope", ("project", "course")), name="ck_a_upload_receipts_scope"),
        CheckConstraint(
            _in("status", ("pending", "completed", "rejected")), name="ck_a_upload_receipts_status"
        ),
        CheckConstraint(
            _in("scan_status", ("pending", "clean", "rejected")),
            name="ck_a_upload_receipts_scan",
        ),
        CheckConstraint("declared_size >= 0", name="ck_a_upload_receipts_size"),
        Index("ix_a_upload_receipts_scope", "scope", "scope_id", "created_at"),
    )


class FeishuChatLink(Base):
    """A6-01/02：项目负责人把一个飞书群（chat_id）绑定到项目，之后只读同步它的消息。"""

    __tablename__ = "a_feishu_chat_links"

    id: Mapped[UUID] = mapped_column(UUIDType, primary_key=True)
    project_id: Mapped[UUID] = mapped_column(
        UUIDType, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    chat_id: Mapped[str] = mapped_column(String(200), nullable=False)
    linked_by_id: Mapped[UUID | None] = mapped_column(
        UUIDType, ForeignKey("users.id", ondelete="RESTRICT")
    )
    linked_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint("project_id", "chat_id", name="uq_a_feishu_chat_links_project_chat"),
    )


class FeishuMessage(Base):
    """A6-03：飞书群消息的本地快照（只读同步）。删除的消息保留行，正文清空并标记 deleted。"""

    __tablename__ = "a_feishu_messages"

    id: Mapped[UUID] = mapped_column(UUIDType, primary_key=True)
    project_id: Mapped[UUID] = mapped_column(
        UUIDType, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    chat_id: Mapped[str] = mapped_column(String(200), nullable=False)
    message_id: Mapped[str] = mapped_column(String(200), nullable=False)
    sender_open_id: Mapped[str | None] = mapped_column(String(200))
    sender_type: Mapped[str] = mapped_column(String(32), nullable=False)
    msg_type: Mapped[str] = mapped_column(String(40), nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    deleted: Mapped[bool] = mapped_column(nullable=False, server_default=sa_text("false"))
    synced_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint("project_id", "message_id", name="uq_a_feishu_messages_project_message"),
        Index("ix_a_feishu_messages_project_time", "project_id", "occurred_at", "id"),
    )


class GithubRepoLink(Base):
    """A5：项目绑定的 GitHub 仓库（通过 GitHub App 只读访问；不保存任何令牌）。"""

    __tablename__ = "a_github_repo_links"

    id: Mapped[UUID] = mapped_column(UUIDType, primary_key=True)
    project_id: Mapped[UUID] = mapped_column(
        UUIDType, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    owner: Mapped[str] = mapped_column(String(100), nullable=False)
    repo: Mapped[str] = mapped_column(String(100), nullable=False)
    installation_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    default_branch: Mapped[str] = mapped_column(String(200), nullable=False)
    linked_by_id: Mapped[UUID | None] = mapped_column(
        UUIDType, ForeignKey("users.id", ondelete="RESTRICT")
    )
    linked_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        UniqueConstraint("project_id", "owner", "repo", name="uq_a_github_repo_links_project_repo"),
    )


class GithubFile(Base):
    """A5：仓库文本文件的快照，用于分析功能是否实现。以 blob_sha 判断是否变化。"""

    __tablename__ = "a_github_files"

    id: Mapped[UUID] = mapped_column(UUIDType, primary_key=True)
    project_id: Mapped[UUID] = mapped_column(
        UUIDType, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    link_id: Mapped[UUID] = mapped_column(
        UUIDType, ForeignKey("a_github_repo_links.id", ondelete="CASCADE"), nullable=False
    )
    path: Mapped[str] = mapped_column(String(1000), nullable=False)
    blob_sha: Mapped[str] = mapped_column(String(64), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    synced_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint("link_id", "path", name="uq_a_github_files_link_path"),
        Index("ix_a_github_files_project", "project_id", "path"),
    )
