"""C evidence, immutable source/note versions and transactional delivery records.

Evidence, EvidenceCriterion and EvidenceDecision follow docs/ERD.md. The other
tables are explicit additions for reproducible sources and reliable delivery.
No binary storage or third-party synchronization is implemented by these models.
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import (
    JSON,
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
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.models.core import LockVersionMixin, TimestampMixin

DocumentJSON = JSON().with_variant(JSONB(), "postgresql")


class Evidence(TimestampMixin, LockVersionMixin, Base):
    __tablename__ = "evidence"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id"), index=True)
    task_id: Mapped[UUID] = mapped_column(ForeignKey("tasks.id"), index=True)
    author_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    source_reference_id: Mapped[UUID | None] = mapped_column(ForeignKey("source_references.id"))
    title: Mapped[str] = mapped_column(String(240))
    description: Mapped[str] = mapped_column(Text)
    source_type: Mapped[str] = mapped_column(String(32))
    source_url: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32), default="candidate", index=True)
    source_changed: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false")
    )

    __table_args__ = (
        CheckConstraint(
            "status IN ('candidate', 'pending_confirmation', 'formal', 'withdrawn', 'void')",
            name="ck_evidence_status",
        ),
        CheckConstraint(
            "source_type IN ('manual', 'task_note', 'file', 'screenshot', 'github', 'feishu')",
            name="ck_evidence_source_type",
        ),
    )


class EvidenceCriterion(Base):
    __tablename__ = "evidence_criteria"

    evidence_id: Mapped[UUID] = mapped_column(ForeignKey("evidence.id"), primary_key=True)
    criterion_id: Mapped[UUID] = mapped_column(
        ForeignKey("acceptance_criteria.id"), primary_key=True, index=True
    )


class EvidenceDecision(Base):
    __tablename__ = "evidence_decisions"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    evidence_id: Mapped[UUID] = mapped_column(ForeignKey("evidence.id"), index=True)
    actor_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    decision: Mapped[str] = mapped_column(String(32))
    resulting_status: Mapped[str] = mapped_column(String(32))
    reason: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint("length(trim(reason)) > 0", name="ck_evidence_decisions_reason"),
        CheckConstraint(
            "decision IN ('submitted', 'adopted', 'withdrawn', 'source_changed')",
            name="ck_evidence_decisions_decision",
        ),
    )


class EvidenceSourceSnapshot(Base):
    """Append-only capture. Version one remains the originally submitted source."""

    __tablename__ = "evidence_source_snapshots"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    evidence_id: Mapped[UUID] = mapped_column(ForeignKey("evidence.id"), index=True)
    version_no: Mapped[int] = mapped_column(Integer)
    source_identity: Mapped[str] = mapped_column(String(255))
    source_revision: Mapped[str] = mapped_column(String(255))
    content_hash: Mapped[str] = mapped_column(String(64))
    content_json: Mapped[dict] = mapped_column(DocumentJSON)
    captured_by: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("evidence_id", "version_no", name="uq_evidence_snapshot_version"),
        CheckConstraint("version_no > 0", name="ck_evidence_snapshot_version"),
    )


class TaskNote(TimestampMixin, LockVersionMixin, Base):
    __tablename__ = "task_notes"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id"), index=True)
    task_id: Mapped[UUID] = mapped_column(ForeignKey("tasks.id"), unique=True)
    current_version_no: Mapped[int] = mapped_column(Integer, default=0)


class TaskNoteVersion(Base):
    __tablename__ = "task_note_versions"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    note_id: Mapped[UUID] = mapped_column(ForeignKey("task_notes.id"), index=True)
    version_no: Mapped[int] = mapped_column(Integer)
    edited_by: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    title: Mapped[str] = mapped_column(String(240))
    body: Mapped[str] = mapped_column(Text)
    content_hash: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("note_id", "version_no", name="uq_task_note_version"),
        CheckConstraint("version_no > 0", name="ck_task_note_version"),
    )


class IntegrationOutbox(Base):
    """Stored with the domain mutation; a later worker must dispatch and acknowledge."""

    __tablename__ = "c_integration_outbox"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id"), index=True)
    aggregate_id: Mapped[UUID] = mapped_column(Uuid, index=True)
    event_type: Mapped[str] = mapped_column(String(80))
    payload_json: Mapped[dict] = mapped_column(DocumentJSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)


class RequestIdempotency(Base):
    __tablename__ = "c_request_idempotency"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    actor_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id"))
    operation: Mapped[str] = mapped_column(String(100))
    idempotency_key: Mapped[str] = mapped_column(String(128))
    request_hash: Mapped[str] = mapped_column(String(64))
    response_json: Mapped[dict] = mapped_column(DocumentJSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint(
            "actor_id", "project_id", "operation", "idempotency_key", name="uq_c_idempotency"
        ),
    )
