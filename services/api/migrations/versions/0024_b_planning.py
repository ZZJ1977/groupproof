"""B-6 task planning: task numbers and versions, AI suggestions, confirmations.

Revision ID: 0024
Revises: 0023

- b_task_meta / b_project_counters.task_seq: T-001 numbers and content versions;
- b_task_versions: every saved definition of a task;
- b_task_suggestions: AI suggestions, unique per (project, fingerprint);
- b_plan_confirmation_snapshots: task versions a member confirmed;
- b_criterion_invalidations: requests to D to void old results.
Existing tasks are numbered oldest first with content version 1.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0024"
down_revision: str | None = "0023"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "b_criterion_invalidations",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("task_id", sa.UUID(), nullable=False),
        sa.Column(
            "criterion_ids",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column("task_content_version", sa.Integer(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("accepted", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("requested_by", sa.UUID(), nullable=False),
        sa.Column(
            "requested_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["requested_by"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_b_criterion_invalidations_task", "b_criterion_invalidations", ["task_id"], unique=False
    )
    op.create_table(
        "b_plan_confirmation_snapshots",
        sa.Column("confirmation_id", sa.UUID(), nullable=False),
        sa.Column(
            "task_versions",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["confirmation_id"], ["plan_confirmations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("confirmation_id"),
    )
    op.create_table(
        "b_task_meta",
        sa.Column("task_id", sa.UUID(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("content_version", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column(
            "origin", sa.String(length=16), server_default=sa.text("'manual'"), nullable=False
        ),
        sa.Column("suggestion_id", sa.Uuid(), nullable=True),
        sa.CheckConstraint("origin IN ('manual', 'ai')", name="ck_b_task_meta_origin"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("task_id"),
        sa.UniqueConstraint("project_id", "seq", name="uq_b_task_meta_seq"),
    )
    op.create_table(
        "b_task_suggestions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("requirement_id", sa.UUID(), nullable=False),
        sa.Column("fingerprint", sa.String(length=64), nullable=False),
        sa.Column("title", sa.String(length=240), nullable=False),
        sa.Column("description", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column(
            "acceptance_criteria",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column("provider", sa.String(length=40), nullable=False),
        sa.Column("is_placeholder", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "status", sa.String(length=16), server_default=sa.text("'pending'"), nullable=False
        ),
        sa.Column("adopted_task_id", sa.UUID(), nullable=True),
        sa.Column("created_by", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("handled_by", sa.UUID(), nullable=True),
        sa.Column("handled_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('pending', 'adopted', 'dismissed')", name="ck_b_task_suggestions_status"
        ),
        sa.ForeignKeyConstraint(["adopted_task_id"], ["tasks.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(
            ["handled_by"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["requirement_id"], ["requirements.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", "fingerprint", name="uq_b_task_suggestions_fingerprint"),
    )
    op.create_table(
        "b_task_versions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("task_id", sa.UUID(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("plan_version_id", sa.UUID(), nullable=True),
        sa.Column("version_no", sa.Integer(), nullable=False),
        sa.Column(
            "snapshot",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column("created_by", sa.UUID(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(["plan_version_id"], ["plan_versions.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("task_id", "version_no", name="uq_b_task_versions_no"),
    )
    op.add_column(
        "b_project_counters",
        sa.Column("task_seq", sa.Integer(), server_default=sa.text("0"), nullable=False),
    )
    op.execute(
        """
        INSERT INTO b_task_meta (task_id, project_id, seq, content_version, origin)
        SELECT id, project_id,
               row_number() OVER (PARTITION BY project_id ORDER BY created_at, id), 1, 'manual'
        FROM tasks
        """
    )
    op.execute(
        """
        INSERT INTO b_project_counters (project_id, requirement_seq, task_seq)
        SELECT project_id, 0, max(seq) FROM b_task_meta GROUP BY project_id
        ON CONFLICT (project_id) DO UPDATE SET task_seq = EXCLUDED.task_seq
        """
    )


def downgrade() -> None:
    op.drop_column("b_project_counters", "task_seq")
    op.drop_table("b_task_versions")
    op.drop_table("b_task_suggestions")
    op.drop_table("b_task_meta")
    op.drop_table("b_plan_confirmation_snapshots")
    op.drop_index("ix_b_criterion_invalidations_task", table_name="b_criterion_invalidations")
    op.drop_table("b_criterion_invalidations")
