"""B course appeals and appeal decisions tables.

Revision ID: 0036
Revises: 0035
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0036"
down_revision: str | None = "0035"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "b_course_appeals",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("course_id", sa.UUID(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("appellant_id", sa.UUID(), nullable=False),
        sa.Column(
            "appeal_type",
            sa.String(length=32),
            server_default=sa.text("'contribution'"),
            nullable=False,
        ),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("supplement_text", sa.Text(), nullable=True),
        sa.Column(
            "evidence_json",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column(
            "status", sa.String(length=24), server_default=sa.text("'pending'"), nullable=False
        ),
        sa.Column("resolved_by", sa.UUID(), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "appeal_type IN ('contribution', 'task', 'score', 'other')",
            name="ck_b_course_appeal_type",
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'need_supplement', 'accepted', 'rejected')",
            name="ck_b_course_appeal_status",
        ),
        sa.ForeignKeyConstraint(["appellant_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["course_id"], ["courses.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["resolved_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_b_course_appeals_course_id", "b_course_appeals", ["course_id"], unique=False
    )
    op.create_index(
        "ix_b_course_appeals_project_id", "b_course_appeals", ["project_id"], unique=False
    )

    op.create_table(
        "b_course_appeal_decisions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("appeal_id", sa.Uuid(), nullable=False),
        sa.Column("actor_id", sa.UUID(), nullable=False),
        sa.Column("action", sa.String(length=32), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("snapshot_id", sa.Uuid(), nullable=True),
        sa.Column(
            "adjustments_json",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "action IN ('reject', 'accept', 'request_supplement', 'supplement_submitted')",
            name="ck_b_appeal_decision_action",
        ),
        sa.ForeignKeyConstraint(["actor_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["appeal_id"], ["b_course_appeals.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_b_course_appeal_decisions_appeal_id",
        "b_course_appeal_decisions",
        ["appeal_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_b_course_appeal_decisions_appeal_id", table_name="b_course_appeal_decisions")
    op.drop_table("b_course_appeal_decisions")
    op.drop_index("ix_b_course_appeals_project_id", table_name="b_course_appeals")
    op.drop_index("ix_b_course_appeals_course_id", table_name="b_course_appeals")
    op.drop_table("b_course_appeals")
