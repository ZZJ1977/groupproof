"""A 的公共服务数据表：操作记录、通知、待办、上传凭证。

表名统一以 ``a_`` 开头，迁移见 ``migrations/versions/0018_a_shared_services.py``。
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
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
    # 操作发生那一刻操作人的角色（之后角色变了也不影响历史记录）和操作结果。
    actor_role: Mapped[str | None] = mapped_column(String(32))
    result: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=sa_text("'success'")
    )

    __table_args__ = (
        Index("ix_a_audit_events_target", "target_type", "target_id", "occurred_at"),
        Index("ix_a_audit_events_project", "project_id", "occurred_at"),
        Index("ix_a_audit_events_course", "course_id", "occurred_at"),
        Index("ix_a_audit_events_actor", "actor_id", "occurred_at"),
    )


class AiUsageEvent(Base):
    """A7 每次 AI 调用一行：谁、哪个功能、哪个模型、成败、token 和费用，供 C 做后台统计。"""

    __tablename__ = "a_ai_usage_events"

    id: Mapped[UUID] = mapped_column(UUIDType, primary_key=True)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    user_id: Mapped[UUID | None] = mapped_column(
        UUIDType, ForeignKey("users.id", ondelete="SET NULL")
    )
    project_id: Mapped[UUID | None] = mapped_column(UUIDType)
    feature: Mapped[str] = mapped_column(String(60), nullable=False)
    provider: Mapped[str | None] = mapped_column(String(32))
    model: Mapped[str | None] = mapped_column(String(120))
    success: Mapped[bool] = mapped_column(Boolean, nullable=False)
    error_code: Mapped[str | None] = mapped_column(String(40))
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    cost: Mapped[Decimal | None] = mapped_column(Numeric(14, 6))
    currency: Mapped[str | None] = mapped_column(String(8))
    latency_ms: Mapped[int | None] = mapped_column(Integer)

    __table_args__ = (
        Index("ix_a_ai_usage_user", "user_id", "occurred_at"),
        Index("ix_a_ai_usage_feature", "feature", "occurred_at"),
        Index("ix_a_ai_usage_project", "project_id", "occurred_at"),
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
    # 每次内容变化（编辑、附件变化、删除）加 1，历史版本保存在 a_feishu_message_versions。
    version_no: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sa_text("1"))
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


class GithubActivity(Base):
    """A5：仓库的提交、合并请求和 CI 运行记录（只读同步）。

    来源在 GitHub 上查不到时保留行并标记 deleted，不会把读取失败当成删除。
    """

    __tablename__ = "a_github_activities"

    id: Mapped[UUID] = mapped_column(UUIDType, primary_key=True)
    project_id: Mapped[UUID] = mapped_column(
        UUIDType, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    link_id: Mapped[UUID] = mapped_column(
        UUIDType, ForeignKey("a_github_repo_links.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(String(24), nullable=False)  # commit|pull_request|ci_run
    external_id: Mapped[str] = mapped_column(String(120), nullable=False)  # sha / PR 号 / run id
    title: Mapped[str] = mapped_column(String(240), nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False, server_default=sa_text("''"))
    state: Mapped[str | None] = mapped_column(String(40))  # open|closed|merged|success|failure...
    author_login: Mapped[str | None] = mapped_column(String(120))
    author_name: Mapped[str | None] = mapped_column(String(240))
    author_email: Mapped[str | None] = mapped_column(String(320))
    author_user_id: Mapped[UUID | None] = mapped_column(
        UUIDType, ForeignKey("users.id", ondelete="SET NULL")
    )
    url: Mapped[str | None] = mapped_column(String(500))
    detail: Mapped[dict | None] = mapped_column(JSONB)
    revision: Mapped[str] = mapped_column(String(64), nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    deleted: Mapped[bool] = mapped_column(nullable=False, server_default=sa_text("false"))
    synced_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint("link_id", "kind", "external_id", name="uq_a_github_activities_item"),
        Index("ix_a_github_activities_project_time", "project_id", "occurred_at", "id"),
        Index("ix_a_github_activities_author", "project_id", "author_user_id"),
    )


class GithubUserLink(Base):
    """A5：本站用户自己声明的 GitHub 用户名，用来把提交作者对应到本站用户。"""

    __tablename__ = "a_github_user_links"

    user_id: Mapped[UUID] = mapped_column(
        UUIDType, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    login: Mapped[str] = mapped_column(String(120), nullable=False)  # 小写
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (UniqueConstraint("login", name="uq_a_github_user_links_login"),)


class FeishuMessageVersion(Base):
    """A6：飞书消息的每一个版本（脱敏后的全文和附件摘要），只增不改。"""

    __tablename__ = "a_feishu_message_versions"

    id: Mapped[UUID] = mapped_column(UUIDType, primary_key=True)
    message_row_id: Mapped[UUID] = mapped_column(
        UUIDType, ForeignKey("a_feishu_messages.id", ondelete="CASCADE"), nullable=False
    )
    version_no: Mapped[int] = mapped_column(Integer, nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    attachments: Mapped[list | None] = mapped_column(JSONB)
    deleted: Mapped[bool] = mapped_column(nullable=False, server_default=sa_text("false"))
    recorded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint("message_row_id", "version_no", name="uq_a_feishu_versions_message_no"),
    )


class FeishuAttachment(Base):
    """A6：飞书消息里的附件引用（图片、文件、语音、视频）。

    ``file_key`` 是飞书侧的资源编号；核验时用机器人凭证下载并算出 SHA-256，之后任何人都能
    对照这个指纹确认附件没有被替换。内容本身不入库。
    """

    __tablename__ = "a_feishu_attachments"

    id: Mapped[UUID] = mapped_column(UUIDType, primary_key=True)
    message_row_id: Mapped[UUID] = mapped_column(
        UUIDType, ForeignKey("a_feishu_messages.id", ondelete="CASCADE"), nullable=False
    )
    file_key: Mapped[str] = mapped_column(String(200), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)  # image|file|audio|media
    name: Mapped[str | None] = mapped_column(String(300))
    size_bytes: Mapped[int | None] = mapped_column(BigInteger)
    content_sha256: Mapped[str | None] = mapped_column(String(64))
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    available: Mapped[bool] = mapped_column(nullable=False, server_default=sa_text("true"))

    __table_args__ = (
        UniqueConstraint("message_row_id", "file_key", name="uq_a_feishu_attachments_key"),
    )


class AccessGrant(Base):
    """A 临时只读授权：C 的访问申请批准后由 A 生效；到期或撤销后立即失效。

    ``command_id`` 是 C 批准动作的稳定编号，同一个编号重复调用只会得到同一份授权。
    """

    __tablename__ = "a_access_grants"

    id: Mapped[UUID] = mapped_column(UUIDType, primary_key=True)
    request_id: Mapped[UUID] = mapped_column(UUIDType, nullable=False)
    command_id: Mapped[UUID] = mapped_column(UUIDType, nullable=False)
    applicant_id: Mapped[UUID] = mapped_column(
        UUIDType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    reviewer_id: Mapped[UUID | None] = mapped_column(
        UUIDType, ForeignKey("users.id", ondelete="SET NULL")
    )
    project_id: Mapped[UUID] = mapped_column(
        UUIDType, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    resource_type: Mapped[str] = mapped_column(String(16), nullable=False)  # project|task|evidence
    resource_id: Mapped[UUID] = mapped_column(UUIDType, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_by_id: Mapped[UUID | None] = mapped_column(
        UUIDType, ForeignKey("users.id", ondelete="SET NULL")
    )
    revoke_reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint("request_id", name="uq_a_access_grants_request"),
        UniqueConstraint("command_id", name="uq_a_access_grants_command"),
        CheckConstraint(
            "resource_type IN ('project', 'task', 'evidence')", name="ck_a_access_grants_type"
        ),
        Index("ix_a_access_grants_lookup", "applicant_id", "project_id", "expires_at"),
    )
