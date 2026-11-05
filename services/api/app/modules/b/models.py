"""B-owned tables. Core course/group/project tables live in app.db.models.core."""

from __future__ import annotations

from datetime import date, datetime
from uuid import UUID, uuid4

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from app.db.base import Base

DocumentJSON = JSON().with_variant(JSONB(), "postgresql")


class BCommandReceipt(Base):
    """Idempotency receipts for every B write (one per actor + operation + key)."""

    __tablename__ = "b_command_receipts"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    actor_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    operation: Mapped[str] = mapped_column(String(100))
    idempotency_key: Mapped[str] = mapped_column(String(128))
    request_hash: Mapped[str] = mapped_column(String(64))
    status_code: Mapped[int] = mapped_column(SmallInteger)
    response_json: Mapped[dict] = mapped_column(DocumentJSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint(
            "actor_id", "operation", "idempotency_key", name="uq_b_command_receipts_key"
        ),
    )


class BCourseJoinPolicy(Base):
    """How students join a course: directly with the invite code, or after teacher approval.

    Absent row = ``direct``. Courses have no such setting elsewhere (C's
    ``grouping_mode`` governs group formation, not course admission).
    """

    __tablename__ = "b_course_join_policies"

    course_id: Mapped[UUID] = mapped_column(
        ForeignKey("courses.id", ondelete="CASCADE"), primary_key=True
    )
    mode: Mapped[str] = mapped_column(String(16), server_default=text("'direct'"))
    updated_by: Mapped[UUID | None] = mapped_column(ForeignKey("users.id"))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    lock_version: Mapped[int] = mapped_column(Integer, server_default=text("0"))

    __table_args__ = (
        CheckConstraint("mode IN ('direct', 'approval')", name="ck_b_course_join_policies_mode"),
    )


class BCourseJoinRequest(Base):
    __tablename__ = "b_course_join_requests"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    course_id: Mapped[UUID] = mapped_column(ForeignKey("courses.id", ondelete="CASCADE"))
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    status: Mapped[str] = mapped_column(String(16), server_default=text("'pending'"))
    message: Mapped[str | None] = mapped_column(Text)
    decided_by: Mapped[UUID | None] = mapped_column(ForeignKey("users.id"))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decision_reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    lock_version: Mapped[int] = mapped_column(Integer, server_default=text("0"))

    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'approved', 'rejected', 'cancelled')",
            name="ck_b_course_join_requests_status",
        ),
        CheckConstraint(
            "status <> 'rejected' OR length(trim(coalesce(decision_reason, ''))) > 0",
            name="ck_b_course_join_requests_reject_reason",
        ),
        Index(
            "uq_b_course_join_requests_pending",
            "course_id",
            "user_id",
            unique=True,
            postgresql_where=text("status = 'pending'"),
            sqlite_where=text("status = 'pending'"),
        ),
        Index("ix_b_course_join_requests_course_status", "course_id", "status"),
    )


class BGroupInvitation(Base):
    """B2-03. ``pending`` waits for the invitee (before the formation deadline);
    ``awaiting_teacher`` waits for a course teacher (after the deadline)."""

    __tablename__ = "b_group_invitations"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    group_id: Mapped[UUID] = mapped_column(ForeignKey("groups.id", ondelete="CASCADE"))
    course_id: Mapped[UUID] = mapped_column(ForeignKey("courses.id", ondelete="CASCADE"))
    inviter_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    invitee_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    status: Mapped[str] = mapped_column(String(20), server_default=text("'pending'"))
    decided_by: Mapped[UUID | None] = mapped_column(ForeignKey("users.id"))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decision_reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    lock_version: Mapped[int] = mapped_column(Integer, server_default=text("0"))

    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'awaiting_teacher', 'accepted', 'declined', "
            "'approved', 'rejected', 'cancelled')",
            name="ck_b_group_invitations_status",
        ),
        CheckConstraint("inviter_id <> invitee_id", name="ck_b_group_invitations_not_self"),
        Index(
            "uq_b_group_invitations_open",
            "group_id",
            "invitee_id",
            unique=True,
            postgresql_where=text("status IN ('pending', 'awaiting_teacher')"),
            sqlite_where=text("status IN ('pending', 'awaiting_teacher')"),
        ),
        Index("ix_b_group_invitations_invitee_status", "invitee_id", "status"),
    )


class BLeaderChangeRequest(Base):
    """B2-05. Every member except the requester must confirm; the leader switches
    when the last one does. ``required_user_ids`` is fixed when the request starts."""

    __tablename__ = "b_leader_change_requests"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    group_id: Mapped[UUID] = mapped_column(ForeignKey("groups.id", ondelete="CASCADE"))
    requested_by: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    previous_leader_id: Mapped[UUID | None] = mapped_column(ForeignKey("users.id"))
    candidate_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    reason: Mapped[str] = mapped_column(Text)
    required_user_ids: Mapped[list] = mapped_column(DocumentJSON)
    status: Mapped[str] = mapped_column(String(16), server_default=text("'pending'"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    lock_version: Mapped[int] = mapped_column(Integer, server_default=text("0"))

    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'approved', 'rejected', 'cancelled')",
            name="ck_b_leader_change_requests_status",
        ),
        CheckConstraint("length(trim(reason)) > 0", name="ck_b_leader_change_requests_reason"),
        Index(
            "uq_b_leader_change_requests_pending",
            "group_id",
            unique=True,
            postgresql_where=text("status = 'pending'"),
            sqlite_where=text("status = 'pending'"),
        ),
    )


class BLeaderChangeConfirmation(Base):
    __tablename__ = "b_leader_change_confirmations"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    request_id: Mapped[UUID] = mapped_column(
        ForeignKey("b_leader_change_requests.id", ondelete="CASCADE")
    )
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    decision: Mapped[str] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("request_id", "user_id", name="uq_b_leader_change_confirmations_user"),
        CheckConstraint(
            "decision IN ('confirm', 'reject')", name="ck_b_leader_change_confirmations_decision"
        ),
    )


class BCourseProjectTemplate(Base):
    """Per-course milestone template copied into each new project (B3-01).

    ``milestones`` is a list of ``{title, description, deadline}``. Courses had
    no stored template before; teachers maintain it through B's endpoint.
    """

    __tablename__ = "b_course_project_templates"

    course_id: Mapped[UUID] = mapped_column(
        ForeignKey("courses.id", ondelete="CASCADE"), primary_key=True
    )
    milestones: Mapped[list] = mapped_column(DocumentJSON)
    updated_by: Mapped[UUID | None] = mapped_column(ForeignKey("users.id"))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    lock_version: Mapped[int] = mapped_column(Integer, server_default=text("0"))


class BProjectDraft(Base):
    """Server-side wizard draft for page 35, one per group (survives browsers)."""

    __tablename__ = "b_project_drafts"

    group_id: Mapped[UUID] = mapped_column(
        ForeignKey("groups.id", ondelete="CASCADE"), primary_key=True
    )
    payload: Mapped[dict] = mapped_column(DocumentJSON)
    step: Mapped[int] = mapped_column(SmallInteger, server_default=text("0"))
    updated_by: Mapped[UUID | None] = mapped_column(ForeignKey("users.id"))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    lock_version: Mapped[int] = mapped_column(Integer, server_default=text("0"))

    __table_args__ = (CheckConstraint("step BETWEEN 0 AND 10", name="ck_b_project_drafts_step"),)


class BProjectSchedule(Base):
    """B3-03 planned start date (the planned end is ``projects.final_deadline``).

    Kept in a B table so the shared ``projects`` table keeps its columns.
    """

    __tablename__ = "b_project_schedules"

    project_id: Mapped[UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    start_date: Mapped[date] = mapped_column(Date)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class BProjectMaterial(Base):
    """B3-04 project materials: pasted text, or an A4-04 upload whose text comes
    from A4-05 (``extract_status`` mirrors ``MaterialTextPort``)."""

    __tablename__ = "b_project_materials"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(8))
    title: Mapped[str] = mapped_column(String(255))
    text_content: Mapped[str | None] = mapped_column(Text)
    receipt_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("a_upload_receipts.id", ondelete="RESTRICT")
    )
    extract_status: Mapped[str] = mapped_column(String(16))
    extract_reason: Mapped[str | None] = mapped_column(String(300))
    created_by: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint("kind IN ('text', 'file')", name="ck_b_project_materials_kind"),
        CheckConstraint(
            "extract_status IN ('ready', 'pending', 'failed', 'unavailable')",
            name="ck_b_project_materials_extract",
        ),
        CheckConstraint(
            "(kind = 'text' AND text_content IS NOT NULL AND receipt_id IS NULL) "
            "OR (kind = 'file' AND receipt_id IS NOT NULL)",
            name="ck_b_project_materials_source",
        ),
        UniqueConstraint("project_id", "receipt_id", name="uq_b_project_materials_receipt"),
        Index("ix_b_project_materials_project", "project_id", "created_at"),
    )
