"""Background report exports and teacher review.

Revision ID: 0027
Revises: 0026
"""

import sqlalchemy as sa
from alembic import op

revision = "0027"
down_revision = "0026"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("ck_reports_status", "reports", type_="check")
    op.create_check_constraint(
        "ck_reports_status",
        "reports",
        "status IN ('draft','generating','generated','submitted','returned','finalized','failed')",
    )
    op.create_table(
        "report_artifacts",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("snapshot_id", sa.Uuid(), sa.ForeignKey("report_snapshots.id"), nullable=False),
        sa.Column("requested_by", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("file_format", sa.String(8), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("content", sa.LargeBinary()),
        sa.Column("error", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint("file_format IN ('pdf','docx')", name="ck_report_artifacts_format"),
        sa.CheckConstraint(
            "status IN ('pending','generating','ready','failed')",
            name="ck_report_artifacts_status",
        ),
    )
    op.create_index("ix_report_artifacts_snapshot_id", "report_artifacts", ["snapshot_id"])
    op.create_table(
        "report_download_links",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("artifact_id", sa.Uuid(), sa.ForeignKey("report_artifacts.id"), nullable=False),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index(
        "ix_report_download_links_artifact_id", "report_download_links", ["artifact_id"]
    )
    op.create_table(
        "report_reviews",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("report_id", sa.Uuid(), sa.ForeignKey("reports.id"), nullable=False),
        sa.Column("snapshot_id", sa.Uuid(), sa.ForeignKey("report_snapshots.id"), nullable=False),
        sa.Column("actor_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("action", sa.String(16), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.CheckConstraint(
            "action IN ('submitted','returned','finalized')",
            name="ck_report_reviews_action",
        ),
    )
    op.create_index("ix_report_reviews_report_id", "report_reviews", ["report_id"])


def downgrade() -> None:
    op.drop_index("ix_report_download_links_artifact_id", table_name="report_download_links")
    op.drop_table("report_download_links")
    op.drop_index("ix_report_reviews_report_id", table_name="report_reviews")
    op.drop_table("report_reviews")
    op.drop_index("ix_report_artifacts_snapshot_id", table_name="report_artifacts")
    op.drop_table("report_artifacts")
    op.execute("UPDATE reports SET status='generated' WHERE status IN ('submitted','returned')")
    op.drop_constraint("ck_reports_status", "reports", type_="check")
    op.create_check_constraint(
        "ck_reports_status",
        "reports",
        "status IN ('draft','generating','generated','finalized','failed')",
    )
