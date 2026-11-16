"""Persist D report download history.

Revision ID: 0026
Revises: 0025
"""

import sqlalchemy as sa
from alembic import op

revision = "0026"
down_revision = "0025"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("report_snapshots", sa.Column("created_by", sa.Uuid(), sa.ForeignKey("users.id")))
    op.create_table(
        "report_downloads",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("snapshot_id", sa.Uuid(), sa.ForeignKey("report_snapshots.id"), nullable=False),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("file_format", sa.String(8), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.CheckConstraint("file_format IN ('pdf','docx')", name="ck_report_downloads_format"),
    )
    op.create_index("ix_report_downloads_snapshot_id", "report_downloads", ["snapshot_id"])


def downgrade() -> None:
    op.drop_index("ix_report_downloads_snapshot_id", table_name="report_downloads")
    op.drop_table("report_downloads")
    op.drop_column("report_snapshots", "created_by")
