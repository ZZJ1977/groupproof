"""D acceptance records and manually managed risks."""

from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Numeric, String, Text, Uuid, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.models.core import LockVersionMixin, TimestampMixin


class VerificationRun(Base):
    __tablename__ = "verification_runs"
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id"), nullable=False, index=True)
    task_id: Mapped[UUID] = mapped_column(ForeignKey("tasks.id"), nullable=False, index=True)
    triggered_by: Mapped[UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    result: Mapped[str] = mapped_column(String(32), nullable=False)
    confidence: Mapped[float | None] = mapped_column(Numeric(5, 4))
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    engine_version: Mapped[str | None] = mapped_column(String(80))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class CriterionResult(Base):
    __tablename__ = "criterion_results"
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    verification_run_id: Mapped[UUID] = mapped_column(
        ForeignKey("verification_runs.id"), nullable=False, index=True
    )
    criterion_id: Mapped[UUID] = mapped_column(ForeignKey("acceptance_criteria.id"), nullable=False)
    result: Mapped[str] = mapped_column(String(32), nullable=False)
    confidence: Mapped[float | None] = mapped_column(Numeric(5, 4))
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    remediation: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class CriterionResultEvidence(Base):
    __tablename__ = "criterion_result_evidence"
    criterion_result_id: Mapped[UUID] = mapped_column(
        ForeignKey("criterion_results.id"), primary_key=True
    )
    evidence_id: Mapped[UUID] = mapped_column(ForeignKey("evidence.id"), primary_key=True)


class VerificationConfirmation(Base):
    __tablename__ = "verification_confirmations"
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    criterion_result_id: Mapped[UUID] = mapped_column(
        ForeignKey("criterion_results.id"), nullable=False
    )
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    comment: Mapped[str | None] = mapped_column(Text)
    confirmed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class VerifiedWork(Base):
    __tablename__ = "verified_work"
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id"), nullable=False)
    task_id: Mapped[UUID] = mapped_column(ForeignKey("tasks.id"), nullable=False)
    criterion_result_id: Mapped[UUID] = mapped_column(
        ForeignKey("criterion_results.id"), nullable=False
    )
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    confirmation_id: Mapped[UUID] = mapped_column(
        ForeignKey("verification_confirmations.id"), nullable=False
    )
    accepted_weight: Mapped[float] = mapped_column(Numeric(10, 3), nullable=False)
    accepted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class EvidenceCoverageSnapshot(Base):
    __tablename__ = "evidence_coverage_snapshots"
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id"), nullable=False)
    task_id: Mapped[UUID] = mapped_column(ForeignKey("tasks.id"), nullable=False)
    checked_by: Mapped[UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    coverage_json: Mapped[dict] = mapped_column(JSONB, nullable=False)
    checked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Risk(TimestampMixin, LockVersionMixin, Base):
    __tablename__ = "risks"
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id"), nullable=False, index=True)
    task_id: Mapped[UUID | None] = mapped_column(ForeignKey("tasks.id"))
    milestone_id: Mapped[UUID | None] = mapped_column(ForeignKey("milestones.id"))
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    title: Mapped[str] = mapped_column(String(240), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    level: Mapped[str] = mapped_column(String(16), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="open")
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (
        CheckConstraint("level IN ('low','medium','high')", name="ck_risks_level"),
        CheckConstraint("status IN ('open','mitigating','closed')", name="ck_risks_status"),
        CheckConstraint("task_id IS NOT NULL OR milestone_id IS NOT NULL", name="ck_risks_target"),
    )


class RiskEvent(Base):
    __tablename__ = "risk_events"
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    risk_id: Mapped[UUID] = mapped_column(ForeignKey("risks.id"), nullable=False, index=True)
    actor_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    event_type: Mapped[str] = mapped_column(String(16), nullable=False)
    note: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
