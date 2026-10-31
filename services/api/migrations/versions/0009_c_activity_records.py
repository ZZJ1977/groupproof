"""C4 source-record decisions and immutable source history.

Revision ID: 0009
Revises: 0008
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "c_activity_records",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("project_id", sa.Uuid(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("source_type", sa.String(16), nullable=False),
        sa.Column("source_id", sa.Uuid(), nullable=False),
        sa.Column("source_identity", sa.String(500), nullable=False),
        sa.Column("status", sa.String(16), server_default="candidate", nullable=False),
        sa.Column("task_id", sa.Uuid(), sa.ForeignKey("tasks.id")),
        sa.Column("evidence_id", sa.Uuid(), sa.ForeignKey("evidence.id"), unique=True),
        sa.Column("lock_version", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint("project_id", "source_type", "source_id", name="uq_c_activity_source"),
        sa.UniqueConstraint(
            "project_id", "source_type", "source_identity", name="uq_c_activity_identity"
        ),
        sa.CheckConstraint("source_type IN ('github', 'feishu')", name="ck_c_activity_source_type"),
        sa.CheckConstraint(
            "status IN ('candidate', 'adopted', 'ignored')", name="ck_c_activity_status"
        ),
        sa.CheckConstraint("lock_version >= 0", name="ck_c_activity_version"),
        sa.CheckConstraint(
            "(status = 'adopted' AND evidence_id IS NOT NULL AND task_id IS NOT NULL) "
            "OR (status <> 'adopted' AND evidence_id IS NULL)",
            name="ck_c_activity_adoption",
        ),
    )
    op.create_index("ix_c_activity_records_project_id", "c_activity_records", ["project_id"])
    document = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
    op.create_table(
        "c_activity_decisions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("record_id", sa.Uuid(), sa.ForeignKey("c_activity_records.id"), nullable=False),
        sa.Column("actor_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("version_no", sa.Integer(), nullable=False),
        sa.Column("action", sa.String(16), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("before_json", document, nullable=False),
        sa.Column("after_json", document, nullable=False),
        sa.Column("source_revision", sa.Text(), nullable=False),
        sa.Column("source_hash", sa.String(64), nullable=False),
        sa.Column("source_snapshot", document, nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint("record_id", "version_no", name="uq_c_activity_decision_version"),
        sa.CheckConstraint("version_no > 0", name="ck_c_activity_decision_version"),
        sa.CheckConstraint(
            "action IN ('associate', 'adopt', 'ignore', 'restore')", name="ck_c_activity_action"
        ),
        sa.CheckConstraint("length(trim(reason)) > 0", name="ck_c_activity_reason"),
    )
    op.create_index("ix_c_activity_decisions_record_id", "c_activity_decisions", ["record_id"])


def downgrade() -> None:
    # A C decision is evidence provenance, not a disposable synchronization cache.
    connection = op.get_bind()
    for table in ("c_activity_records", "c_activity_decisions"):
        if connection.execute(sa.text(f"SELECT 1 FROM {table} LIMIT 1")).first() is not None:
            raise RuntimeError("Cannot downgrade: preserve C4 activity decisions before migration")
    op.drop_table("c_activity_decisions")
    op.drop_table("c_activity_records")
