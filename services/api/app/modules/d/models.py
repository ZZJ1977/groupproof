"""D-owned acceptance, contribution and report history models.

The tables in this module are append-only history boundaries.  A new check,
calculation or report snapshot creates a new row; downstream readers must
filter invalidated acceptance results and render reports from their stored
snapshot instead of re-reading mutable project tables.
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import (
    JSON,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
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

DocumentJSON = JSON().with_variant(JSONB(), "postgresql")


class IntegrityCheck(Base):
    """Immutable completeness result for one task at one point in time."""

    __tablename__ = "integrity_checks"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    project_id: Mapped[UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="RESTRICT"), index=True
    )
    task_id: Mapped[UUID] = mapped_column(ForeignKey("tasks.id", ondelete="RESTRICT"), index=True)
    checked_by: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    rule_version: Mapped[str] = mapped_column(String(64))
    total_criteria: Mapped[int] = mapped_column(Integer)
    covered_criteria: Mapped[int] = mapped_column(Integer)
    coverage_rate: Mapped[float] = mapped_column(Numeric(5, 2))
    status: Mapped[str] = mapped_column(
        String(16), default="incomplete", server_default=text("'incomplete'")
    )
    missing_criteria_json: Mapped[list] = mapped_column(
        DocumentJSON, default=list, server_default=text("'[]'")
    )
    pending_sources: Mapped[int] = mapped_column(
        Integer, default=0, server_default=text("0"), nullable=False
    )
    details_json: Mapped[dict | list | None] = mapped_column(DocumentJSON)
    checked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint("length(trim(rule_version)) > 0", name="ck_integrity_checks_rule_version"),
        CheckConstraint("total_criteria >= 0", name="ck_integrity_checks_total"),
        CheckConstraint(
            "covered_criteria >= 0 AND covered_criteria <= total_criteria",
            name="ck_integrity_checks_covered",
        ),
        CheckConstraint(
            "coverage_rate >= 0 AND coverage_rate <= 100", name="ck_integrity_checks_rate"
        ),
        CheckConstraint(
            "coverage_rate = CASE WHEN total_criteria = 0 THEN 0 ELSE "
            "round(CAST(covered_criteria AS NUMERIC) * 100 / total_criteria, 2) END",
            name="ck_integrity_checks_rate_matches_counts",
        ),
        CheckConstraint(
            "status IN ('passed', 'incomplete', 'blocked')", name="ck_integrity_checks_status"
        ),
        CheckConstraint("pending_sources >= 0", name="ck_integrity_checks_pending_sources"),
        Index(
            "ix_integrity_checks_task_checked_at",
            "project_id",
            "task_id",
            "checked_at",
        ),
    )


class VerificationRun(Base):
    """A deterministic or AI acceptance run linked to its completeness check."""

    __tablename__ = "verification_runs"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    integrity_check_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("integrity_checks.id", ondelete="RESTRICT"), index=True
    )
    project_id: Mapped[UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="RESTRICT"), index=True
    )
    task_id: Mapped[UUID] = mapped_column(ForeignKey("tasks.id", ondelete="RESTRICT"), index=True)
    triggered_by: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    result: Mapped[str] = mapped_column(
        String(16), default="pending", server_default=text("'pending'")
    )
    confidence: Mapped[float | None] = mapped_column(Numeric(5, 4))
    status: Mapped[str] = mapped_column(
        String(16), default="queued", server_default=text("'queued'")
    )
    engine_version: Mapped[str] = mapped_column(String(64))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint(
            "result IN ('pending', 'passed', 'failed', 'uncertain')",
            name="ck_verification_runs_result",
        ),
        CheckConstraint(
            "status IN ('queued', 'running', 'completed', 'failed')",
            name="ck_verification_runs_status",
        ),
        CheckConstraint(
            "confidence IS NULL OR confidence BETWEEN 0 AND 1",
            name="ck_verification_runs_confidence",
        ),
    )


class CriterionResult(Base):
    """One criterion outcome; invalidation keeps the original result intact."""

    __tablename__ = "criterion_results"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    verification_run_id: Mapped[UUID] = mapped_column(
        ForeignKey("verification_runs.id", ondelete="RESTRICT"), index=True
    )
    criterion_id: Mapped[UUID] = mapped_column(
        ForeignKey("acceptance_criteria.id", ondelete="RESTRICT"), index=True
    )
    result: Mapped[str] = mapped_column(String(16))
    confidence: Mapped[float | None] = mapped_column(Numeric(5, 4))
    reason: Mapped[str | None] = mapped_column(Text)
    remediation: Mapped[str | None] = mapped_column(Text)
    invalidated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    invalidated_by: Mapped[UUID | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    invalidated_reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint(
            "verification_run_id", "criterion_id", name="uq_criterion_results_run_criterion"
        ),
        CheckConstraint(
            "result IN ('passed', 'failed', 'uncertain', 'not_applicable')",
            name="ck_criterion_results_result",
        ),
        CheckConstraint(
            "confidence IS NULL OR confidence BETWEEN 0 AND 1",
            name="ck_criterion_results_confidence",
        ),
        CheckConstraint(
            "(invalidated_at IS NULL AND invalidated_by IS NULL AND invalidated_reason IS NULL) "
            "OR (invalidated_at IS NOT NULL AND invalidated_by IS NOT NULL "
            "AND length(trim(invalidated_reason)) > 0)",
            name="ck_criterion_results_invalidation",
        ),
        Index(
            "ix_criterion_results_active",
            "criterion_id",
            "created_at",
            postgresql_where=text("invalidated_at IS NULL"),
        ),
    )


class ContributionCalculation(Base):
    """One immutable contribution calculation invocation and its basis."""

    __tablename__ = "contribution_calculations"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    project_id: Mapped[UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="RESTRICT"), index=True
    )
    formula_version: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(
        String(16), default="completed", server_default=text("'completed'")
    )
    input_hash: Mapped[str | None] = mapped_column(String(128))
    basis_version: Mapped[str | None] = mapped_column(String(128))
    basis_snapshot_id: Mapped[UUID | None] = mapped_column(Uuid)
    calculated_by: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    calculated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint(
            "length(trim(formula_version)) > 0", name="ck_contribution_calculations_formula"
        ),
        CheckConstraint(
            "(basis_snapshot_id IS NOT NULL) OR "
            "(basis_version IS NOT NULL AND length(trim(basis_version)) > 0)",
            name="ck_contribution_calculations_basis",
        ),
        CheckConstraint(
            "status IN ('queued', 'running', 'completed', 'failed', 'superseded')",
            name="ck_contribution_calculations_status",
        ),
    )


class ContributionSnapshot(Base):
    """Versioned, optionally frozen projection of one calculation."""

    __tablename__ = "contribution_snapshots"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    project_id: Mapped[UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="RESTRICT"), index=True
    )
    calculation_id: Mapped[UUID] = mapped_column(
        ForeignKey("contribution_calculations.id", ondelete="RESTRICT"), index=True
    )
    version_no: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16), default="draft", server_default=text("'draft'"))
    created_by: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    frozen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint(
            "project_id", "version_no", name="uq_contribution_snapshots_project_version"
        ),
        CheckConstraint("version_no > 0", name="ck_contribution_snapshots_version"),
        CheckConstraint(
            "status IN ('draft', 'frozen', 'superseded')", name="ck_contribution_snapshots_status"
        ),
    )


class ContributionItem(Base):
    """One member's persisted result within a contribution snapshot."""

    __tablename__ = "contribution_items"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    snapshot_id: Mapped[UUID] = mapped_column(
        ForeignKey("contribution_snapshots.id", ondelete="RESTRICT"), index=True
    )
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), index=True)
    task_credit: Mapped[float] = mapped_column(Numeric(12, 3))
    collaboration_credit: Mapped[float] = mapped_column(Numeric(12, 3))
    share: Mapped[float] = mapped_column(Numeric(7, 4))
    acceptance_rate: Mapped[float] = mapped_column(Numeric(7, 4))
    status: Mapped[str] = mapped_column(
        String(16), default="formal", server_default=text("'formal'")
    )
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("snapshot_id", "user_id", name="uq_contribution_items_snapshot_user"),
        CheckConstraint("task_credit >= 0", name="ck_contribution_items_task_credit"),
        CheckConstraint(
            "collaboration_credit >= 0", name="ck_contribution_items_collaboration_credit"
        ),
        CheckConstraint("share >= 0 AND share <= 100", name="ck_contribution_items_share"),
        CheckConstraint(
            "acceptance_rate >= 0 AND acceptance_rate <= 100",
            name="ck_contribution_items_acceptance_rate",
        ),
        CheckConstraint(
            "status IN ('draft', 'formal', 'disputed', 'superseded')",
            name="ck_contribution_items_status",
        ),
    )


class ContributionItemTask(Base):
    """Trace each member result back to the tasks and ratios that produced it."""

    __tablename__ = "contribution_item_tasks"

    contribution_item_id: Mapped[UUID] = mapped_column(
        ForeignKey("contribution_items.id", ondelete="RESTRICT"), primary_key=True
    )
    task_id: Mapped[UUID] = mapped_column(
        ForeignKey("tasks.id", ondelete="RESTRICT"), primary_key=True
    )
    ratio: Mapped[float] = mapped_column(Numeric(7, 4))

    __table_args__ = (
        CheckConstraint("ratio >= 0 AND ratio <= 100", name="ck_contribution_item_tasks_ratio"),
        Index("ix_contribution_item_tasks_task_id", "task_id"),
    )


class Report(Base):
    """Mutable report identity whose generated versions are immutable snapshots."""

    __tablename__ = "reports"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    project_id: Mapped[UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="RESTRICT"), index=True
    )
    created_by: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    status: Mapped[str] = mapped_column(String(16), default="draft", server_default=text("'draft'"))
    current_format: Mapped[str | None] = mapped_column(String(16))
    includes_appendix: Mapped[bool] = mapped_column(
        default=False, server_default=text("false"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    lock_version: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"))

    __table_args__ = (
        CheckConstraint(
            "status IN ('draft', 'generating', 'generated', 'finalized', 'failed')",
            name="ck_reports_status",
        ),
    )


class ReportSnapshot(Base):
    """Frozen input used for rendering/exporting one report version."""

    __tablename__ = "report_snapshots"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    report_id: Mapped[UUID] = mapped_column(
        ForeignKey("reports.id", ondelete="RESTRICT"), index=True
    )
    baseline_version_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("baseline_versions.id", ondelete="SET NULL")
    )
    plan_version_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("plan_versions.id", ondelete="SET NULL")
    )
    contribution_snapshot_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("contribution_snapshots.id", ondelete="SET NULL")
    )
    version_no: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(
        String(16), default="generating", server_default=text("'generating'")
    )
    data_snapshot: Mapped[dict] = mapped_column(DocumentJSON)
    snapshot_created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    finalized_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("report_id", "version_no", name="uq_report_snapshots_report_version"),
        CheckConstraint("version_no > 0", name="ck_report_snapshots_version"),
        CheckConstraint(
            "status IN ('generating', 'generated', 'finalized', 'failed')",
            name="ck_report_snapshots_status",
        ),
        Index("ix_report_snapshots_contribution_snapshot_id", "contribution_snapshot_id"),
    )
