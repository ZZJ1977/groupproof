"""A shared services: audit log, notifications, action items, upload receipts.

Revision ID: 0018
Revises: 0017

- a_audit_events：A4-02 操作记录，触发器禁止 UPDATE / DELETE（只能加不能改不能删）；
- a_inboxes / a_notifications / a_inbox_replays：A4-01 站内通知与已读幂等；
- a_action_items：A4-03 待办；
- a_upload_receipts：A4-04 文件上传凭证（服务端核对指纹、大小、类型后才可用）。
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "a_action_items",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("recipient_id", sa.UUID(), nullable=False),
        sa.Column("category", sa.String(length=16), nullable=False),
        sa.Column("title", sa.String(length=300), nullable=False),
        sa.Column("description", sa.String(length=2000), nullable=False),
        sa.Column(
            "status", sa.String(length=16), server_default=sa.text("'pending'"), nullable=False
        ),
        sa.Column(
            "priority", sa.String(length=16), server_default=sa.text("'medium'"), nullable=False
        ),
        sa.Column("target_json", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("source_key", sa.String(length=200), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("due_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("closed_by", sa.UUID(), nullable=True),
        sa.CheckConstraint(
            "(status = 'pending') = (closed_at IS NULL)", name="ck_a_action_items_closed"
        ),
        sa.CheckConstraint(
            "category IN ('task', 'verification', 'evidence', 'rule', 'appeal', "
            "'member', 'course')",
            name="ck_a_action_items_cat",
        ),
        sa.CheckConstraint(
            "priority IN ('low', 'medium', 'high')", name="ck_a_action_items_priority"
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'completed', 'rejected')", name="ck_a_action_items_status"
        ),
        sa.ForeignKeyConstraint(["closed_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["recipient_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("recipient_id", "source_key", name="uq_a_action_items_source"),
    )
    op.create_index(
        "ix_a_action_items_recipient",
        "a_action_items",
        ["recipient_id", "status", "created_at"],
        unique=False,
    )
    op.create_table(
        "a_audit_events",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "occurred_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("actor_id", sa.UUID(), nullable=True),
        sa.Column("action", sa.String(length=120), nullable=False),
        sa.Column("target_type", sa.String(length=60), nullable=False),
        sa.Column("target_id", sa.String(length=120), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=True),
        sa.Column("course_id", sa.UUID(), nullable=True),
        sa.Column("before_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("after_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("request_id", sa.String(length=64), nullable=True),
        sa.ForeignKeyConstraint(["actor_id"], ["users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_a_audit_events_actor", "a_audit_events", ["actor_id", "occurred_at"], unique=False
    )
    op.create_index(
        "ix_a_audit_events_course", "a_audit_events", ["course_id", "occurred_at"], unique=False
    )
    op.create_index(
        "ix_a_audit_events_project", "a_audit_events", ["project_id", "occurred_at"], unique=False
    )
    op.create_index(
        "ix_a_audit_events_target",
        "a_audit_events",
        ["target_type", "target_id", "occurred_at"],
        unique=False,
    )
    op.create_table(
        "a_inbox_replays",
        sa.Column("recipient_id", sa.UUID(), nullable=False),
        sa.Column("idempotency_key", sa.String(length=128), nullable=False),
        sa.Column("request_hash", sa.String(length=64), nullable=False),
        sa.Column("receipt_json", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["recipient_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("recipient_id", "idempotency_key"),
    )
    op.create_table(
        "a_inboxes",
        sa.Column("recipient_id", sa.UUID(), nullable=False),
        sa.Column("version", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("snapshot_id", sa.UUID(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("version >= 0", name="ck_a_inboxes_version"),
        sa.ForeignKeyConstraint(["recipient_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("recipient_id"),
    )
    op.create_table(
        "a_notifications",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("recipient_id", sa.UUID(), nullable=False),
        sa.Column("category", sa.String(length=16), nullable=False),
        sa.Column("title", sa.String(length=300), nullable=False),
        sa.Column("description", sa.String(length=2000), nullable=False),
        sa.Column("target_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("dedupe_key", sa.String(length=200), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("lock_version", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column(
            "email_status", sa.String(length=16), server_default=sa.text("'none'"), nullable=False
        ),
        sa.Column("email_attempts", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("email_sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "category IN ('course', 'project', 'system')", name="ck_a_notifications_cat"
        ),
        sa.CheckConstraint(
            "email_status IN ('none', 'pending', 'sent', 'failed')",
            name="ck_a_notifications_email_status",
        ),
        sa.CheckConstraint("lock_version >= 0", name="ck_a_notifications_version"),
        sa.ForeignKeyConstraint(["recipient_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("recipient_id", "dedupe_key", name="uq_a_notifications_dedupe"),
    )
    op.create_index(
        "ix_a_notifications_email_pending",
        "a_notifications",
        ["email_status"],
        unique=False,
        postgresql_where=sa.text("email_status = 'pending'"),
    )
    op.create_index(
        "ix_a_notifications_recipient",
        "a_notifications",
        ["recipient_id", "created_at"],
        unique=False,
    )
    op.create_table(
        "a_upload_receipts",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("scope", sa.String(length=16), nullable=False),
        sa.Column("scope_id", sa.UUID(), nullable=False),
        sa.Column("actor_id", sa.UUID(), nullable=False),
        sa.Column("provider", sa.String(length=80), nullable=False),
        sa.Column("bucket", sa.String(length=120), nullable=False),
        sa.Column("object_id", sa.String(length=255), nullable=False),
        sa.Column("filename", sa.String(length=255), nullable=False),
        sa.Column("declared_mime", sa.String(length=200), nullable=False),
        sa.Column("declared_size", sa.BigInteger(), nullable=False),
        sa.Column(
            "status", sa.String(length=16), server_default=sa.text("'pending'"), nullable=False
        ),
        sa.Column("content_hash", sa.String(length=64), nullable=True),
        sa.Column("size_bytes", sa.BigInteger(), nullable=True),
        sa.Column("mime_type", sa.String(length=200), nullable=True),
        sa.Column("revision", sa.String(length=255), nullable=True),
        sa.Column(
            "scan_status", sa.String(length=16), server_default=sa.text("'pending'"), nullable=False
        ),
        sa.Column("rejection_reason", sa.String(length=200), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("upload_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "scan_status IN ('pending', 'clean', 'rejected')", name="ck_a_upload_receipts_scan"
        ),
        sa.CheckConstraint("scope IN ('project', 'course')", name="ck_a_upload_receipts_scope"),
        sa.CheckConstraint(
            "status IN ('pending', 'completed', 'rejected')", name="ck_a_upload_receipts_status"
        ),
        sa.CheckConstraint("declared_size >= 0", name="ck_a_upload_receipts_size"),
        sa.ForeignKeyConstraint(["actor_id"], ["users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("object_id"),
    )
    op.create_index(
        "ix_a_upload_receipts_scope",
        "a_upload_receipts",
        ["scope", "scope_id", "created_at"],
        unique=False,
    )

    op.execute(
        """
        CREATE FUNCTION a_audit_events_append_only() RETURNS trigger AS $$
        BEGIN
            RAISE EXCEPTION 'a_audit_events is append-only';
        END;
        $$ LANGUAGE plpgsql
        """
    )
    op.execute(
        "CREATE TRIGGER a_audit_events_no_change BEFORE UPDATE OR DELETE ON a_audit_events "
        "FOR EACH ROW EXECUTE FUNCTION a_audit_events_append_only()"
    )
    op.execute(
        "CREATE TRIGGER a_audit_events_no_truncate BEFORE TRUNCATE ON a_audit_events "
        "FOR EACH STATEMENT EXECUTE FUNCTION a_audit_events_append_only()"
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS a_audit_events_no_truncate ON a_audit_events")
    op.execute("DROP TRIGGER IF EXISTS a_audit_events_no_change ON a_audit_events")
    op.execute("DROP FUNCTION IF EXISTS a_audit_events_append_only()")
    op.drop_index("ix_a_upload_receipts_scope", table_name="a_upload_receipts")
    op.drop_table("a_upload_receipts")
    op.drop_index("ix_a_notifications_recipient", table_name="a_notifications")
    op.drop_index(
        "ix_a_notifications_email_pending",
        table_name="a_notifications",
        postgresql_where=sa.text("email_status = 'pending'"),
    )
    op.drop_table("a_notifications")
    op.drop_table("a_inboxes")
    op.drop_table("a_inbox_replays")
    op.drop_index("ix_a_audit_events_target", table_name="a_audit_events")
    op.drop_index("ix_a_audit_events_project", table_name="a_audit_events")
    op.drop_index("ix_a_audit_events_course", table_name="a_audit_events")
    op.drop_index("ix_a_audit_events_actor", table_name="a_audit_events")
    op.drop_table("a_audit_events")
    op.drop_index("ix_a_action_items_recipient", table_name="a_action_items")
    op.drop_table("a_action_items")
