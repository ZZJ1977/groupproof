"""B-10 course settings columns and versioned course rules table.

Revision ID: 0033
Revises: 0032
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0033"
down_revision: str | None = "0032"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("courses", sa.Column("description", sa.Text(), nullable=True))
    op.add_column("courses", sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True))
    op.create_table(
        "b_course_rule_versions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("course_id", sa.UUID(), nullable=False),
        sa.Column("version_no", sa.Integer(), nullable=False),
        sa.Column(
            "status", sa.String(length=20), server_default=sa.text("'draft'"), nullable=False
        ),
        sa.Column(
            "rules_json",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column("change_summary", sa.Text(), nullable=True),
        sa.Column("published_by", sa.UUID(), nullable=True),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('draft', 'published', 'archived')", name="ck_rule_version_status"
        ),
        sa.ForeignKeyConstraint(["course_id"], ["courses.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["published_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("course_id", "version_no", name="uq_rule_version_course_no"),
    )


def downgrade() -> None:
    op.drop_table("b_course_rule_versions")
    op.drop_column("courses", "archived_at")
    op.drop_column("courses", "description")
