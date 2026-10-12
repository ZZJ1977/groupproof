"""C logical course files and retained immutable versions.

Revision ID: 0011
Revises: 0010
Existing A files and B snapshot tables remain unchanged.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "c_course_files",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("course_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("name_key", sa.String(255), nullable=False),
        sa.Column("category", sa.String(32), nullable=False),
        sa.Column("latest_version_no", sa.Integer(), nullable=False),
        sa.Column("official_version_no", sa.Integer(), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("lock_version", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["course_id"], ["courses.id"]),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.UniqueConstraint("course_id", "name_key", name="uq_c_course_file_course_name"),
        sa.CheckConstraint("latest_version_no > 0", name="ck_c_course_file_latest"),
        sa.CheckConstraint(
            "official_version_no IS NULL OR "
            "(official_version_no > 0 AND official_version_no <= latest_version_no)",
            name="ck_c_course_file_official",
        ),
        sa.CheckConstraint(
            "category IN ('documents', 'images', 'exports')", name="ck_c_course_file_category"
        ),
    )
    op.create_index("ix_c_course_files_course_id", "c_course_files", ["course_id"])
    op.create_table(
        "c_course_file_versions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("file_id", sa.Uuid(), nullable=False),
        sa.Column("version_no", sa.Integer(), nullable=False),
        sa.Column("receipt_id", sa.Uuid(), nullable=False),
        sa.Column("storage_provider", sa.String(80), nullable=False),
        sa.Column("storage_object_id", sa.String(255), nullable=False),
        sa.Column("storage_revision", sa.String(255), nullable=False),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("original_name", sa.String(255), nullable=False),
        sa.Column("extension", sa.String(16), nullable=False),
        sa.Column("mime_type", sa.String(200), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("uploaded_by", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["file_id"], ["c_course_files.id"]),
        sa.ForeignKeyConstraint(["uploaded_by"], ["users.id"]),
        sa.UniqueConstraint("receipt_id"),
        sa.UniqueConstraint("file_id", "version_no", name="uq_c_course_file_version"),
        sa.CheckConstraint("version_no > 0", name="ck_c_course_file_version"),
        sa.CheckConstraint("size_bytes BETWEEN 0 AND 52428800", name="ck_c_course_file_size"),
    )
    op.create_index("ix_c_course_file_versions_file_id", "c_course_file_versions", ["file_id"])
    op.create_table(
        "c_course_file_decisions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("file_id", sa.Uuid(), nullable=False),
        sa.Column("version_id", sa.Uuid(), nullable=False),
        sa.Column("actor_id", sa.Uuid(), nullable=False),
        sa.Column("action", sa.String(32), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("resulting_lock_version", sa.Integer(), nullable=False),
        sa.Column("previous_official_version_no", sa.Integer(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["file_id"], ["c_course_files.id"]),
        sa.ForeignKeyConstraint(["version_id"], ["c_course_file_versions.id"]),
        sa.ForeignKeyConstraint(["actor_id"], ["users.id"]),
        sa.CheckConstraint(
            "action IN ('created', 'appended', 'published')", name="ck_c_course_file_action"
        ),
        sa.CheckConstraint("length(trim(reason)) > 0", name="ck_c_course_file_reason"),
    )
    op.create_index("ix_c_course_file_decisions_file_id", "c_course_file_decisions", ["file_id"])
    op.create_table(
        "c_course_file_outbox",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("course_id", sa.Uuid(), nullable=False),
        sa.Column("aggregate_id", sa.Uuid(), nullable=False),
        sa.Column("event_type", sa.String(80), nullable=False),
        sa.Column(
            "payload_json", sa.JSON().with_variant(postgresql.JSONB(), "postgresql"), nullable=False
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["course_id"], ["courses.id"]),
    )
    for column in ("course_id", "aggregate_id", "delivered_at"):
        op.create_index(f"ix_c_course_file_outbox_{column}", "c_course_file_outbox", [column])
    op.create_table(
        "c_course_file_requests",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("actor_id", sa.Uuid(), nullable=False),
        sa.Column("course_id", sa.Uuid(), nullable=False),
        sa.Column("operation", sa.String(100), nullable=False),
        sa.Column("idempotency_key", sa.String(128), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column(
            "response_json",
            sa.JSON().with_variant(postgresql.JSONB(), "postgresql"),
            nullable=False,
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["actor_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["course_id"], ["courses.id"]),
        sa.UniqueConstraint(
            "actor_id", "course_id", "operation", "idempotency_key", name="uq_c_course_file_request"
        ),
    )


def downgrade() -> None:
    # Refuse to silently delete byte provenance/history or orphan pending events.
    op.execute(
        sa.text("""
        DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM c_course_files)
                OR EXISTS (SELECT 1 FROM c_course_file_versions)
                OR EXISTS (SELECT 1 FROM c_course_file_decisions)
                OR EXISTS (SELECT 1 FROM c_course_file_outbox)
                OR EXISTS (SELECT 1 FROM c_course_file_requests) THEN
                RAISE EXCEPTION 'Cannot downgrade: preserve C course file data first';
            END IF;
        END $$;
    """)
    )
    op.drop_table("c_course_file_requests")
    op.drop_table("c_course_file_outbox")
    op.drop_table("c_course_file_decisions")
    op.drop_table("c_course_file_versions")
    op.drop_table("c_course_files")
