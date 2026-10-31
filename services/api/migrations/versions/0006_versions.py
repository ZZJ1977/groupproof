"""Create baseline and plan version tables.

Revision ID: 0006
Revises: 0005
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None

UUID = postgresql.UUID(as_uuid=True)
TIMESTAMPTZ = sa.DateTime(timezone=True)
JSONB = postgresql.JSONB


def upgrade() -> None:
    op.create_table(
        "baseline_versions",
        sa.Column("id", UUID, server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("project_id", UUID, nullable=False),
        sa.Column("version_no", sa.Integer, nullable=False),
        sa.Column("based_on_version_id", UUID, nullable=True),
        sa.Column("created_by", UUID, nullable=False),
        sa.Column("status", sa.String(32), server_default="draft", nullable=False),
        sa.Column("snapshot_json", JSONB, nullable=False),
        sa.Column("confirmed_at", TIMESTAMPTZ, nullable=True),
        sa.Column("frozen_at", TIMESTAMPTZ, nullable=True),
        sa.Column(
            "created_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.Column(
            "updated_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.Column("lock_version", sa.Integer, server_default=sa.text("0"), nullable=False),
        sa.CheckConstraint(
            "status IN ('draft', 'confirmed', 'frozen', 'archived')",
            name="ck_baseline_versions_status",
        ),
        sa.ForeignKeyConstraint(
            ["based_on_version_id"], ["baseline_versions.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "project_id", "version_no", name="uq_baseline_versions_project_version"
        ),
    )
    op.create_index("ix_baseline_versions_project_id", "baseline_versions", ["project_id"])
    op.create_index("ix_baseline_versions_status", "baseline_versions", ["status"])

    op.create_table(
        "baseline_confirmations",
        sa.Column("id", UUID, server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("baseline_version_id", UUID, nullable=False),
        sa.Column("user_id", UUID, nullable=False),
        sa.Column("status", sa.String(32), server_default="pending", nullable=False),
        sa.Column("comment", sa.Text, nullable=True),
        sa.Column("confirmed_at", TIMESTAMPTZ, nullable=True),
        sa.CheckConstraint(
            "status IN ('pending', 'confirmed', 'rejected')",
            name="ck_baseline_confirmations_status",
        ),
        sa.ForeignKeyConstraint(
            ["baseline_version_id"], ["baseline_versions.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "baseline_version_id", "user_id", name="uq_baseline_confirmations_member"
        ),
    )
    op.create_index("ix_baseline_confirmations_user_id", "baseline_confirmations", ["user_id"])

    op.create_table(
        "plan_versions",
        sa.Column("id", UUID, server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("project_id", UUID, nullable=False),
        sa.Column("version_no", sa.Integer, nullable=False),
        sa.Column("based_on_version_id", UUID, nullable=True),
        sa.Column("created_by", UUID, nullable=False),
        sa.Column("status", sa.String(32), server_default="draft", nullable=False),
        sa.Column("snapshot_json", JSONB, nullable=False),
        sa.Column("confirmed_at", TIMESTAMPTZ, nullable=True),
        sa.Column("frozen_at", TIMESTAMPTZ, nullable=True),
        sa.Column(
            "created_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.Column(
            "updated_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.Column("lock_version", sa.Integer, server_default=sa.text("0"), nullable=False),
        sa.CheckConstraint(
            "status IN ('draft', 'confirmed', 'frozen', 'archived')", name="ck_plan_versions_status"
        ),
        sa.ForeignKeyConstraint(["based_on_version_id"], ["plan_versions.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", "version_no", name="uq_plan_versions_project_version"),
    )
    op.create_index("ix_plan_versions_project_id", "plan_versions", ["project_id"])
    op.create_index("ix_plan_versions_status", "plan_versions", ["status"])

    op.create_table(
        "plan_confirmations",
        sa.Column("id", UUID, server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("plan_version_id", UUID, nullable=False),
        sa.Column("user_id", UUID, nullable=False),
        sa.Column("status", sa.String(32), server_default="pending", nullable=False),
        sa.Column("comment", sa.Text, nullable=True),
        sa.Column("confirmed_at", TIMESTAMPTZ, nullable=True),
        sa.CheckConstraint(
            "status IN ('pending', 'confirmed', 'rejected')", name="ck_plan_confirmations_status"
        ),
        sa.ForeignKeyConstraint(["plan_version_id"], ["plan_versions.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("plan_version_id", "user_id", name="uq_plan_confirmations_member"),
    )
    op.create_index("ix_plan_confirmations_user_id", "plan_confirmations", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_plan_confirmations_user_id", table_name="plan_confirmations")
    op.drop_table("plan_confirmations")
    op.drop_index("ix_plan_versions_status", table_name="plan_versions")
    op.drop_index("ix_plan_versions_project_id", table_name="plan_versions")
    op.drop_table("plan_versions")
    op.drop_index("ix_baseline_confirmations_user_id", table_name="baseline_confirmations")
    op.drop_table("baseline_confirmations")
    op.drop_index("ix_baseline_versions_status", table_name="baseline_versions")
    op.drop_index("ix_baseline_versions_project_id", table_name="baseline_versions")
    op.drop_table("baseline_versions")
