"""Week 5 human acceptance and formal outcome history.

Revision ID: 0025
Revises: 0024
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0025"
down_revision = "0024"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("verification_runs", sa.Column("task_version", sa.Integer()))
    op.create_table(
        "acceptance_decisions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "verification_run_id",
            sa.Uuid(),
            sa.ForeignKey("verification_runs.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "actor_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
        ),
        sa.Column("revision_no", sa.Integer(), nullable=False),
        sa.Column("decision", sa.String(16), nullable=False),
        sa.Column("responsibility_share", sa.Numeric(7, 4)),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "decision IN ('confirmed', 'rejected')", name="ck_acceptance_decisions_decision"
        ),
        sa.CheckConstraint("revision_no > 0", name="ck_acceptance_decisions_revision"),
        sa.UniqueConstraint(
            "verification_run_id",
            "actor_id",
            "revision_no",
            name="uq_acceptance_decisions_revision",
        ),
        sa.CheckConstraint("length(trim(reason)) > 0", name="ck_acceptance_decisions_reason"),
        sa.CheckConstraint(
            "responsibility_share IS NULL OR responsibility_share BETWEEN 0 AND 100",
            name="ck_acceptance_decisions_share",
        ),
    )
    op.create_index(
        "ix_acceptance_decisions_verification_run_id",
        "acceptance_decisions",
        ["verification_run_id"],
    )
    op.create_table(
        "formal_outcomes",
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
            "verification_run_id",
            sa.Uuid(),
            sa.ForeignKey("verification_runs.id", ondelete="RESTRICT"),
            nullable=False,
            unique=True,
        ),
        sa.Column(
            "basis_json",
            sa.JSON().with_variant(JSONB(), "postgresql"),
            nullable=False,
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("invalidated_at", sa.DateTime(timezone=True)),
        sa.Column("invalidated_reason", sa.Text()),
    )
    op.create_index("ix_formal_outcomes_project_id", "formal_outcomes", ["project_id"])
    op.create_index("ix_formal_outcomes_task_id", "formal_outcomes", ["task_id"])
    op.add_column("contribution_item_tasks", sa.Column("formal_outcome_id", sa.Uuid()))
    op.create_foreign_key(
        "fk_contribution_item_tasks_formal_outcome_id",
        "contribution_item_tasks",
        "formal_outcomes",
        ["formal_outcome_id"],
        ["id"],
        ondelete="RESTRICT",
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_contribution_item_tasks_formal_outcome_id",
        "contribution_item_tasks",
        type_="foreignkey",
    )
    op.drop_column("contribution_item_tasks", "formal_outcome_id")
    op.drop_table("formal_outcomes")
    op.drop_table("acceptance_decisions")
    op.drop_column("verification_runs", "task_version")
