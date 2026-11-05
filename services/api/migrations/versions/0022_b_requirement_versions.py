"""B-5 requirement management: numbers, versions, criteria to re-check.

Revision ID: 0022
Revises: 0021

- b_project_counters / b_requirement_codes: R-001 style numbers, never reused;
- b_requirement_versions: every saved state; after the freeze a reason is required;
- b_criterion_rechecks: acceptance criteria whose requirement changed.
Existing requirements are numbered oldest first and get version 1.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0022"
down_revision: str | None = "0021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "b_project_counters",
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("requirement_seq", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("project_id"),
    )
    op.create_table(
        "b_requirement_codes",
        sa.Column("requirement_id", sa.UUID(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["requirement_id"], ["requirements.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("requirement_id"),
        sa.UniqueConstraint("project_id", "seq", name="uq_b_requirement_codes_seq"),
    )
    op.create_table(
        "b_requirement_versions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("requirement_id", sa.UUID(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("version_no", sa.Integer(), nullable=False),
        sa.Column(
            "snapshot",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("after_freeze", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("created_by", sa.UUID(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "NOT after_freeze OR length(trim(coalesce(reason, ''))) > 0",
            name="ck_b_requirement_versions_reason",
        ),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["requirement_id"], ["requirements.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("requirement_id", "version_no", name="uq_b_requirement_versions_no"),
    )
    op.create_table(
        "b_criterion_rechecks",
        sa.Column("criterion_id", sa.UUID(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("task_id", sa.UUID(), nullable=False),
        sa.Column("requirement_id", sa.UUID(), nullable=False),
        sa.Column("requirement_version_no", sa.Integer(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("flagged_by", sa.UUID(), nullable=True),
        sa.Column(
            "flagged_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "verification_notified", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
        sa.Column("cleared_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["criterion_id"], ["acceptance_criteria.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["flagged_by"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["requirement_id"], ["requirements.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("criterion_id"),
    )
    op.create_index(
        "ix_b_criterion_rechecks_task", "b_criterion_rechecks", ["task_id"], unique=False
    )
    # Existing requirements get numbers (oldest first) and a first version.
    op.execute(
        """
        INSERT INTO b_requirement_codes (requirement_id, project_id, seq)
        SELECT id, project_id,
               row_number() OVER (PARTITION BY project_id ORDER BY created_at, id)
        FROM requirements
        """
    )
    op.execute(
        """
        INSERT INTO b_project_counters (project_id, requirement_seq)
        SELECT project_id, max(seq) FROM b_requirement_codes GROUP BY project_id
        """
    )
    op.execute(
        """
        INSERT INTO b_requirement_versions
            (id, requirement_id, project_id, version_no, snapshot, created_by, created_at)
        SELECT gen_random_uuid(), id, project_id, 1,
               jsonb_build_object(
                   'title', title, 'description', description, 'priority', priority,
                   'status', status, 'module_id', module_id::text
               ),
               created_by, created_at
        FROM requirements
        """
    )


def downgrade() -> None:
    op.drop_index("ix_b_criterion_rechecks_task", table_name="b_criterion_rechecks")
    op.drop_table("b_criterion_rechecks")
    op.drop_table("b_requirement_versions")
    op.drop_table("b_requirement_codes")
    op.drop_table("b_project_counters")
