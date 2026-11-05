"""B-4 requirements analysis, conflicts and baseline review.

Revision ID: 0021
Revises: 0020

- b_analysis_runs: one A7-03 analysis per row; at most one processing per project;
- b_requirement_meta / b_module_meta: AI or manual origin and "edited by a person",
  so re-analysis only replaces untouched AI items;
- b_baseline_scopes: project scope written before the baseline is submitted;
- b_baseline_checklist_items: manual review ticks (rule items are computed).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0021"
down_revision: str | None = "0020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "b_analysis_runs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("requested_by", sa.UUID(), nullable=False),
        sa.Column(
            "status", sa.String(length=16), server_default=sa.text("'processing'"), nullable=False
        ),
        sa.Column(
            "material_ids",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column(
            "summary",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=True,
        ),
        sa.Column("error_code", sa.String(length=64), nullable=True),
        sa.Column("error_message", sa.String(length=300), nullable=True),
        sa.Column("is_placeholder", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('processing', 'succeeded', 'failed', 'unavailable')",
            name="ck_b_analysis_runs_status",
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["requested_by"],
            ["users.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_b_analysis_runs_project", "b_analysis_runs", ["project_id", "created_at"], unique=False
    )
    op.create_index(
        "uq_b_analysis_runs_processing",
        "b_analysis_runs",
        ["project_id"],
        unique=True,
        postgresql_where=sa.text("status = 'processing'"),
        sqlite_where=sa.text("status = 'processing'"),
    )
    op.create_table(
        "b_baseline_checklist_items",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("item_key", sa.String(length=40), nullable=False),
        sa.Column("checked_by", sa.UUID(), nullable=False),
        sa.Column(
            "checked_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["checked_by"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", "item_key", name="uq_b_baseline_checklist_items_key"),
    )
    op.create_table(
        "b_baseline_scopes",
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("in_scope", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("out_of_scope", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("updated_by", sa.UUID(), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("lock_version", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["updated_by"],
            ["users.id"],
        ),
        sa.PrimaryKeyConstraint("project_id"),
    )
    op.create_table(
        "b_module_meta",
        sa.Column("module_id", sa.UUID(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("origin", sa.String(length=8), nullable=False),
        sa.Column("edited_by_human", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.CheckConstraint("origin IN ('ai', 'manual')", name="ck_b_module_meta_origin"),
        sa.ForeignKeyConstraint(["module_id"], ["functional_modules.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("module_id"),
    )
    op.create_table(
        "b_requirement_meta",
        sa.Column("requirement_id", sa.UUID(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("origin", sa.String(length=8), nullable=False),
        sa.Column("edited_by_human", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("excluded", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("ai_key", sa.String(length=64), nullable=True),
        sa.Column("analysis_run_id", sa.Uuid(), nullable=True),
        sa.CheckConstraint("origin IN ('ai', 'manual')", name="ck_b_requirement_meta_origin"),
        sa.ForeignKeyConstraint(["analysis_run_id"], ["b_analysis_runs.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["requirement_id"], ["requirements.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("requirement_id"),
    )
    op.create_index(
        "ix_b_requirement_meta_project",
        "b_requirement_meta",
        ["project_id", "origin"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_b_requirement_meta_project", table_name="b_requirement_meta")
    op.drop_table("b_requirement_meta")
    op.drop_table("b_module_meta")
    op.drop_table("b_baseline_scopes")
    op.drop_table("b_baseline_checklist_items")
    op.drop_index(
        "uq_b_analysis_runs_processing",
        table_name="b_analysis_runs",
        postgresql_where=sa.text("status = 'processing'"),
        sqlite_where=sa.text("status = 'processing'"),
    )
    op.drop_index("ix_b_analysis_runs_project", table_name="b_analysis_runs")
    op.drop_table("b_analysis_runs")
