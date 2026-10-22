"""C-owned triage and task links; immutable captures never replace A source rows."""

from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.models.core import LockVersionMixin, TimestampMixin
from app.modules.c.models import DocumentJSON


class ActivityRecordState(TimestampMixin, LockVersionMixin, Base):
    __tablename__ = "c_activity_records"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id"), index=True)
    source_type: Mapped[str] = mapped_column(String(16))
    source_id: Mapped[UUID] = mapped_column(Uuid)
    source_identity: Mapped[str] = mapped_column(String(500))
    status: Mapped[str] = mapped_column(String(16), default="candidate", server_default="candidate")
    task_id: Mapped[UUID | None] = mapped_column(ForeignKey("tasks.id"))
    evidence_id: Mapped[UUID | None] = mapped_column(ForeignKey("evidence.id"), unique=True)

    __table_args__ = (
        UniqueConstraint("project_id", "source_type", "source_id", name="uq_c_activity_source"),
        UniqueConstraint(
            "project_id", "source_type", "source_identity", name="uq_c_activity_identity"
        ),
        CheckConstraint("source_type IN ('github', 'feishu')", name="ck_c_activity_source_type"),
        CheckConstraint(
            "status IN ('candidate', 'adopted', 'ignored')", name="ck_c_activity_status"
        ),
        CheckConstraint("lock_version >= 0", name="ck_c_activity_version"),
        CheckConstraint(
            "(status = 'adopted' AND evidence_id IS NOT NULL AND task_id IS NOT NULL) "
            "OR (status <> 'adopted' AND evidence_id IS NULL)",
            name="ck_c_activity_adoption",
        ),
    )


class ActivityRecordDecision(Base):
    __tablename__ = "c_activity_decisions"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    record_id: Mapped[UUID] = mapped_column(ForeignKey("c_activity_records.id"), index=True)
    actor_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    version_no: Mapped[int] = mapped_column(Integer)
    action: Mapped[str] = mapped_column(String(16))
    reason: Mapped[str] = mapped_column(Text)
    before_json: Mapped[dict] = mapped_column(DocumentJSON)
    after_json: Mapped[dict] = mapped_column(DocumentJSON)
    source_revision: Mapped[str] = mapped_column(Text)
    source_hash: Mapped[str] = mapped_column(String(64))
    source_snapshot: Mapped[dict] = mapped_column(DocumentJSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("record_id", "version_no", name="uq_c_activity_decision_version"),
        CheckConstraint("version_no > 0", name="ck_c_activity_decision_version"),
        CheckConstraint(
            "action IN ('associate', 'adopt', 'ignore', 'restore')", name="ck_c_activity_action"
        ),
        CheckConstraint("length(trim(reason)) > 0", name="ck_c_activity_reason"),
    )
