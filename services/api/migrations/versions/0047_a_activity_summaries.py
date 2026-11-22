"""Cache evidence-grounded AI summaries for source activities.

Revision ID: 0047
Revises: 0046
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect
from sqlalchemy.dialects import postgresql

revision: str = "0047"
down_revision: str | None = "0046"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def document() -> sa.types.TypeEngine:
    return sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    # A database that recorded the temporary A-side 0042 skipped B's
    # permissions migration because Alembic considers the revision applied.
    # Repair that one schema delta while moving the database to the new head.
    if "course_staff" in inspector.get_table_names():
        course_staff_columns = {column["name"] for column in inspector.get_columns("course_staff")}
        if "permissions" not in course_staff_columns:
            op.add_column(
                "course_staff",
                sa.Column(
                    "permissions",
                    sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
                    server_default=sa.text("'{}'"),
                    nullable=False,
                ),
            )
    # Earlier staging/local rollouts used the same table under the temporary
    # A-side revision 0042. The develop line already owns revision 0042 for
    # B permissions, so the feature is replayed as 0047. Reuse a compatible
    # table when it already exists instead of failing the rollout.
    if "a_activity_summaries" in inspector.get_table_names():
        return
    op.create_table(
        "a_activity_summaries",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("source_type", sa.String(length=32), nullable=False),
        sa.Column("source_id", sa.Uuid(), nullable=False),
        sa.Column("source_revision", sa.String(length=255), nullable=False),
        sa.Column("prompt_version", sa.String(length=64), nullable=False),
        sa.Column("input_hash", sa.String(length=64), nullable=False),
        sa.Column(
            "status", sa.String(length=24), server_default=sa.text("'pending'"), nullable=False
        ),
        sa.Column("result_json", document(), nullable=True),
        sa.Column("provider", sa.String(length=32), nullable=True),
        sa.Column("model", sa.String(length=120), nullable=True),
        sa.Column("is_placeholder", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "needs_human_review", sa.Boolean(), server_default=sa.text("true"), nullable=False
        ),
        sa.Column("error_code", sa.String(length=64), nullable=True),
        sa.Column("generated_at", sa.DateTime(timezone=True), nullable=True),
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
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "source_type",
            "source_id",
            "source_revision",
            "prompt_version",
            "input_hash",
            name="uq_a_activity_summaries_source_version",
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'ready', 'failed')", name="ck_a_activity_summaries_status"
        ),
    )
    op.create_index(
        "ix_a_activity_summaries_project_source",
        "a_activity_summaries",
        ["project_id", "source_type", "source_id"],
    )
    op.create_index(
        "ix_a_activity_summaries_status", "a_activity_summaries", ["project_id", "status"]
    )


def downgrade() -> None:
    op.drop_index("ix_a_activity_summaries_status", table_name="a_activity_summaries")
    op.drop_index("ix_a_activity_summaries_project_source", table_name="a_activity_summaries")
    op.drop_table("a_activity_summaries")
