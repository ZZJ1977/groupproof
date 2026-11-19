"""B course announcements and read receipts tables.

Revision ID: 0035
Revises: 0034
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0035"
down_revision: str | None = "0034"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "b_course_announcements",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("course_id", sa.UUID(), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column(
            "priority", sa.String(length=16), server_default=sa.text("'normal'"), nullable=False
        ),
        sa.Column("is_pinned", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "status", sa.String(length=16), server_default=sa.text("'published'"), nullable=False
        ),
        sa.Column("published_by", sa.UUID(), nullable=False),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
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
            "priority IN ('normal', 'important', 'urgent')", name="ck_b_announcement_priority"
        ),
        sa.CheckConstraint("status IN ('draft', 'published')", name="ck_b_announcement_status"),
        sa.ForeignKeyConstraint(["course_id"], ["courses.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["published_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_b_course_announcements_course_id",
        "b_course_announcements",
        ["course_id"],
        unique=False,
    )

    op.create_table(
        "b_announcement_reads",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("announcement_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column(
            "read_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["announcement_id"], ["b_course_announcements.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("announcement_id", "user_id", name="uq_b_announcement_read"),
    )
    op.create_index(
        "ix_b_announcement_reads_user_id", "b_announcement_reads", ["user_id"], unique=False
    )


def downgrade() -> None:
    op.drop_index("ix_b_announcement_reads_user_id", table_name="b_announcement_reads")
    op.drop_table("b_announcement_reads")
    op.drop_index("ix_b_course_announcements_course_id", table_name="b_course_announcements")
    op.drop_table("b_course_announcements")
