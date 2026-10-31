"""ERD discussions/replies plus explicit mention links and immutable source captures."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.models.core import LockVersionMixin, TimestampMixin
from app.modules.c.models import DocumentJSON


class Discussion(TimestampMixin, LockVersionMixin, Base):
    __tablename__ = "discussions"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id"), index=True)
    author_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    task_id: Mapped[UUID | None] = mapped_column(ForeignKey("tasks.id"), index=True)
    requirement_id: Mapped[UUID | None] = mapped_column(ForeignKey("requirements.id"), index=True)
    module_id: Mapped[UUID | None] = mapped_column(ForeignKey("functional_modules.id"), index=True)
    milestone_id: Mapped[UUID | None] = mapped_column(ForeignKey("milestones.id"), index=True)
    title: Mapped[str] = mapped_column(String(240))
    body: Mapped[str] = mapped_column(Text)
    is_important: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"))
    status: Mapped[str] = mapped_column(String(32), default="open", server_default="open")

    __table_args__ = (
        CheckConstraint("status IN ('open', 'closed')", name="ck_discussions_status"),
        CheckConstraint("length(trim(title)) > 0", name="ck_discussions_title"),
        CheckConstraint("length(trim(body)) > 0", name="ck_discussions_body"),
    )


class DiscussionReply(TimestampMixin, Base):
    """Append-only child rows; replies do not overwrite an array on the parent."""

    __tablename__ = "discussion_replies"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    discussion_id: Mapped[UUID] = mapped_column(ForeignKey("discussions.id"), index=True)
    author_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    body: Mapped[str] = mapped_column(Text)

    __table_args__ = (CheckConstraint("length(trim(body)) > 0", name="ck_discussion_replies_body"),)


class DiscussionMention(Base):
    __tablename__ = "discussion_mentions"

    discussion_id: Mapped[UUID] = mapped_column(ForeignKey("discussions.id"), primary_key=True)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)


class DiscussionReplyMention(Base):
    __tablename__ = "discussion_reply_mentions"

    reply_id: Mapped[UUID] = mapped_column(ForeignKey("discussion_replies.id"), primary_key=True)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)


class DiscussionSourceSnapshot(Base):
    """Immutable complete thread capture produced by importance/reply mutations."""

    __tablename__ = "discussion_source_snapshots"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    discussion_id: Mapped[UUID] = mapped_column(ForeignKey("discussions.id"), index=True)
    captured_by: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    version_no: Mapped[int] = mapped_column(Integer)
    is_important: Mapped[bool] = mapped_column(Boolean)
    content_hash: Mapped[str] = mapped_column(String(64))
    content_json: Mapped[dict] = mapped_column(DocumentJSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("discussion_id", "version_no", name="uq_discussion_source_version"),
        CheckConstraint("version_no > 0", name="ck_discussion_source_version"),
    )
