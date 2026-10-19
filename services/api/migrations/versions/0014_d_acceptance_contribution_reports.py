"""Persist D acceptance, contribution and report history.

Revision ID: 0014
Revises: 0013

The tables are append-only history boundaries.  Completeness checks and
calculation runs are never overwritten; invalidated criterion results remain
queryable for audit, while report rendering can rely on its frozen JSON
snapshot instead of mutable project rows.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def document() -> sa.types.TypeEngine:
    return sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def created() -> sa.Column:
    return sa.Column(
        "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
    )


def upgrade() -> None:
    op.create_table(
        "integrity_checks",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "project_id",
            sa.Uuid(),
            sa.ForeignKey("projects.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "task_id", sa.Uuid(), sa.ForeignKey("tasks.id", ondelete="RESTRICT"), nullable=False
        ),
        sa.Column(
            "checked_by", sa.Uuid(), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
        ),
        sa.Column("rule_version", sa.String(64), nullable=False),
        sa.Column("total_criteria", sa.Integer(), nullable=False),
        sa.Column("covered_criteria", sa.Integer(), nullable=False),
        sa.Column("coverage_rate", sa.Numeric(5, 2), nullable=False),
        sa.Column("status", sa.String(16), server_default="incomplete", nullable=False),
        sa.Column(
            "missing_criteria_json",
            document(),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("pending_sources", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("details_json", document()),
        sa.Column(
            "checked_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        created(),
        sa.CheckConstraint(
            "length(trim(rule_version)) > 0", name="ck_integrity_checks_rule_version"
        ),
        sa.CheckConstraint("total_criteria >= 0", name="ck_integrity_checks_total"),
        sa.CheckConstraint(
            "covered_criteria >= 0 AND covered_criteria <= total_criteria",
            name="ck_integrity_checks_covered",
        ),
        sa.CheckConstraint(
            "coverage_rate >= 0 AND coverage_rate <= 100", name="ck_integrity_checks_rate"
        ),
        sa.CheckConstraint(
            "coverage_rate = CASE WHEN total_criteria = 0 THEN 0 ELSE "
            "round(CAST(covered_criteria AS NUMERIC) * 100 / total_criteria, 2) END",
            name="ck_integrity_checks_rate_matches_counts",
        ),
        sa.CheckConstraint(
            "status IN ('passed', 'incomplete', 'blocked')", name="ck_integrity_checks_status"
        ),
        sa.CheckConstraint("pending_sources >= 0", name="ck_integrity_checks_pending_sources"),
    )
    op.create_index("ix_integrity_checks_project_id", "integrity_checks", ["project_id"])
    op.create_index("ix_integrity_checks_task_id", "integrity_checks", ["task_id"])
    op.create_index(
        "ix_integrity_checks_task_checked_at",
        "integrity_checks",
        ["project_id", "task_id", "checked_at"],
    )

    op.create_table(
        "verification_runs",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "integrity_check_id",
            sa.Uuid(),
            sa.ForeignKey("integrity_checks.id", ondelete="RESTRICT"),
        ),
        sa.Column(
            "project_id",
            sa.Uuid(),
            sa.ForeignKey("projects.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "task_id", sa.Uuid(), sa.ForeignKey("tasks.id", ondelete="RESTRICT"), nullable=False
        ),
        sa.Column(
            "triggered_by",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("result", sa.String(16), server_default="pending", nullable=False),
        sa.Column("confidence", sa.Numeric(5, 4)),
        sa.Column("status", sa.String(16), server_default="queued", nullable=False),
        sa.Column("engine_version", sa.String(64), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
        created(),
        sa.CheckConstraint(
            "result IN ('pending', 'passed', 'failed', 'uncertain')",
            name="ck_verification_runs_result",
        ),
        sa.CheckConstraint(
            "status IN ('queued', 'running', 'completed', 'failed')",
            name="ck_verification_runs_status",
        ),
        sa.CheckConstraint(
            "confidence IS NULL OR confidence BETWEEN 0 AND 1",
            name="ck_verification_runs_confidence",
        ),
    )
    op.create_index("ix_verification_runs_project_id", "verification_runs", ["project_id"])
    op.create_index("ix_verification_runs_task_id", "verification_runs", ["task_id"])
    op.create_index(
        "ix_verification_runs_integrity_check_id", "verification_runs", ["integrity_check_id"]
    )

    op.create_table(
        "criterion_results",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "verification_run_id",
            sa.Uuid(),
            sa.ForeignKey("verification_runs.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "criterion_id",
            sa.Uuid(),
            sa.ForeignKey("acceptance_criteria.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("result", sa.String(16), nullable=False),
        sa.Column("confidence", sa.Numeric(5, 4)),
        sa.Column("reason", sa.Text()),
        sa.Column("remediation", sa.Text()),
        sa.Column("invalidated_at", sa.DateTime(timezone=True)),
        sa.Column("invalidated_by", sa.Uuid(), sa.ForeignKey("users.id", ondelete="RESTRICT")),
        sa.Column("invalidated_reason", sa.Text()),
        created(),
        sa.UniqueConstraint(
            "verification_run_id", "criterion_id", name="uq_criterion_results_run_criterion"
        ),
        sa.CheckConstraint(
            "result IN ('passed', 'failed', 'uncertain', 'not_applicable')",
            name="ck_criterion_results_result",
        ),
        sa.CheckConstraint(
            "confidence IS NULL OR confidence BETWEEN 0 AND 1",
            name="ck_criterion_results_confidence",
        ),
        sa.CheckConstraint(
            "(invalidated_at IS NULL AND invalidated_by IS NULL AND invalidated_reason IS NULL) "
            "OR (invalidated_at IS NOT NULL AND invalidated_by IS NOT NULL "
            "AND length(trim(invalidated_reason)) > 0)",
            name="ck_criterion_results_invalidation",
        ),
    )
    op.create_index(
        "ix_criterion_results_verification_run_id", "criterion_results", ["verification_run_id"]
    )
    op.create_index("ix_criterion_results_criterion_id", "criterion_results", ["criterion_id"])
    op.create_index(
        "ix_criterion_results_active",
        "criterion_results",
        ["criterion_id", "created_at"],
        postgresql_where=sa.text("invalidated_at IS NULL"),
    )

    op.create_table(
        "contribution_calculations",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "project_id",
            sa.Uuid(),
            sa.ForeignKey("projects.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("formula_version", sa.String(64), nullable=False),
        sa.Column("status", sa.String(16), server_default="completed", nullable=False),
        sa.Column("input_hash", sa.String(128)),
        sa.Column("basis_version", sa.String(128)),
        sa.Column("basis_snapshot_id", sa.Uuid()),
        sa.Column(
            "calculated_by",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "calculated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
        created(),
        sa.CheckConstraint(
            "length(trim(formula_version)) > 0", name="ck_contribution_calculations_formula"
        ),
        sa.CheckConstraint(
            "(basis_snapshot_id IS NOT NULL) OR "
            "(basis_version IS NOT NULL AND length(trim(basis_version)) > 0)",
            name="ck_contribution_calculations_basis",
        ),
        sa.CheckConstraint(
            "status IN ('queued', 'running', 'completed', 'failed', 'superseded')",
            name="ck_contribution_calculations_status",
        ),
    )
    op.create_index(
        "ix_contribution_calculations_project_id", "contribution_calculations", ["project_id"]
    )

    op.create_table(
        "contribution_snapshots",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "project_id",
            sa.Uuid(),
            sa.ForeignKey("projects.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "calculation_id",
            sa.Uuid(),
            sa.ForeignKey("contribution_calculations.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("version_no", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(16), server_default="draft", nullable=False),
        sa.Column(
            "created_by", sa.Uuid(), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
        ),
        sa.Column("frozen_at", sa.DateTime(timezone=True)),
        created(),
        sa.UniqueConstraint(
            "project_id", "version_no", name="uq_contribution_snapshots_project_version"
        ),
        sa.CheckConstraint("version_no > 0", name="ck_contribution_snapshots_version"),
        sa.CheckConstraint(
            "status IN ('draft', 'frozen', 'superseded')", name="ck_contribution_snapshots_status"
        ),
    )
    op.create_index(
        "ix_contribution_snapshots_project_id", "contribution_snapshots", ["project_id"]
    )
    op.create_index(
        "ix_contribution_snapshots_calculation_id", "contribution_snapshots", ["calculation_id"]
    )

    op.create_table(
        "contribution_items",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "snapshot_id",
            sa.Uuid(),
            sa.ForeignKey("contribution_snapshots.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
        ),
        sa.Column("task_credit", sa.Numeric(12, 3), nullable=False),
        sa.Column("collaboration_credit", sa.Numeric(12, 3), nullable=False),
        sa.Column("share", sa.Numeric(7, 4), nullable=False),
        sa.Column("acceptance_rate", sa.Numeric(7, 4), nullable=False),
        sa.Column("status", sa.String(16), server_default="formal", nullable=False),
        sa.Column("note", sa.Text()),
        created(),
        sa.UniqueConstraint("snapshot_id", "user_id", name="uq_contribution_items_snapshot_user"),
        sa.CheckConstraint("task_credit >= 0", name="ck_contribution_items_task_credit"),
        sa.CheckConstraint(
            "collaboration_credit >= 0", name="ck_contribution_items_collaboration_credit"
        ),
        sa.CheckConstraint("share >= 0 AND share <= 100", name="ck_contribution_items_share"),
        sa.CheckConstraint(
            "acceptance_rate >= 0 AND acceptance_rate <= 100",
            name="ck_contribution_items_acceptance_rate",
        ),
        sa.CheckConstraint(
            "status IN ('draft', 'formal', 'disputed', 'superseded')",
            name="ck_contribution_items_status",
        ),
    )
    op.create_index("ix_contribution_items_snapshot_id", "contribution_items", ["snapshot_id"])
    op.create_index("ix_contribution_items_user_id", "contribution_items", ["user_id"])

    op.create_table(
        "contribution_item_tasks",
        sa.Column(
            "contribution_item_id",
            sa.Uuid(),
            sa.ForeignKey("contribution_items.id", ondelete="RESTRICT"),
            primary_key=True,
        ),
        sa.Column(
            "task_id",
            sa.Uuid(),
            sa.ForeignKey("tasks.id", ondelete="RESTRICT"),
            primary_key=True,
        ),
        sa.Column("ratio", sa.Numeric(7, 4), nullable=False),
        sa.CheckConstraint("ratio >= 0 AND ratio <= 100", name="ck_contribution_item_tasks_ratio"),
    )
    op.create_index("ix_contribution_item_tasks_task_id", "contribution_item_tasks", ["task_id"])

    op.create_table(
        "reports",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "project_id",
            sa.Uuid(),
            sa.ForeignKey("projects.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "created_by", sa.Uuid(), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
        ),
        sa.Column("status", sa.String(16), server_default="draft", nullable=False),
        sa.Column("current_format", sa.String(16)),
        sa.Column(
            "includes_appendix", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
        created(),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("lock_version", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.CheckConstraint(
            "status IN ('draft', 'generating', 'generated', 'finalized', 'failed')",
            name="ck_reports_status",
        ),
    )
    op.create_index("ix_reports_project_id", "reports", ["project_id"])

    op.create_table(
        "report_snapshots",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "report_id", sa.Uuid(), sa.ForeignKey("reports.id", ondelete="RESTRICT"), nullable=False
        ),
        sa.Column(
            "baseline_version_id",
            sa.Uuid(),
            sa.ForeignKey("baseline_versions.id", ondelete="SET NULL"),
        ),
        sa.Column(
            "plan_version_id",
            sa.Uuid(),
            sa.ForeignKey("plan_versions.id", ondelete="SET NULL"),
        ),
        sa.Column(
            "contribution_snapshot_id",
            sa.Uuid(),
            sa.ForeignKey("contribution_snapshots.id", ondelete="SET NULL"),
        ),
        sa.Column("version_no", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(16), server_default="generating", nullable=False),
        sa.Column("data_snapshot", document(), nullable=False),
        sa.Column(
            "snapshot_created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("finalized_at", sa.DateTime(timezone=True)),
        created(),
        sa.UniqueConstraint("report_id", "version_no", name="uq_report_snapshots_report_version"),
        sa.CheckConstraint("version_no > 0", name="ck_report_snapshots_version"),
        sa.CheckConstraint(
            "status IN ('generating', 'generated', 'finalized', 'failed')",
            name="ck_report_snapshots_status",
        ),
    )
    op.create_index("ix_report_snapshots_report_id", "report_snapshots", ["report_id"])
    op.create_index(
        "ix_report_snapshots_contribution_snapshot_id",
        "report_snapshots",
        ["contribution_snapshot_id"],
    )


def downgrade() -> None:
    tables = (
        "report_snapshots",
        "reports",
        "contribution_item_tasks",
        "contribution_items",
        "contribution_snapshots",
        "contribution_calculations",
        "criterion_results",
        "verification_runs",
        "integrity_checks",
    )
    connection = op.get_bind()
    for table in tables:
        if connection.execute(sa.text(f"SELECT 1 FROM {table} LIMIT 1")).first() is not None:
            raise RuntimeError(
                "Cannot downgrade: preserve D acceptance, contribution and report history first"
            )

    op.drop_index("ix_report_snapshots_contribution_snapshot_id", table_name="report_snapshots")
    op.drop_index("ix_report_snapshots_report_id", table_name="report_snapshots")
    op.drop_table("report_snapshots")
    op.drop_index("ix_reports_project_id", table_name="reports")
    op.drop_table("reports")
    op.drop_table("contribution_item_tasks")
    op.drop_index("ix_contribution_items_user_id", table_name="contribution_items")
    op.drop_index("ix_contribution_items_snapshot_id", table_name="contribution_items")
    op.drop_table("contribution_items")
    op.drop_index("ix_contribution_snapshots_calculation_id", table_name="contribution_snapshots")
    op.drop_index("ix_contribution_snapshots_project_id", table_name="contribution_snapshots")
    op.drop_table("contribution_snapshots")
    op.drop_index("ix_contribution_calculations_project_id", table_name="contribution_calculations")
    op.drop_table("contribution_calculations")
    op.drop_index("ix_criterion_results_active", table_name="criterion_results")
    op.drop_index("ix_criterion_results_criterion_id", table_name="criterion_results")
    op.drop_index("ix_criterion_results_verification_run_id", table_name="criterion_results")
    op.drop_table("criterion_results")
    op.drop_index("ix_verification_runs_integrity_check_id", table_name="verification_runs")
    op.drop_index("ix_verification_runs_task_id", table_name="verification_runs")
    op.drop_index("ix_verification_runs_project_id", table_name="verification_runs")
    op.drop_table("verification_runs")
    op.drop_index("ix_integrity_checks_task_checked_at", table_name="integrity_checks")
    op.drop_index("ix_integrity_checks_task_id", table_name="integrity_checks")
    op.drop_index("ix_integrity_checks_project_id", table_name="integrity_checks")
    op.drop_table("integrity_checks")
