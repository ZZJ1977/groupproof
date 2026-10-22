"""C logical project files and retained immutable versions.

Revision ID: 0010
Revises: 0009
Existing A files and B snapshot tables remain unchanged.
"""

import sqlalchemy as sa
from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "c_logical_files",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
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
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.UniqueConstraint("project_id", "name_key", name="uq_c_file_project_name"),
        sa.CheckConstraint("latest_version_no > 0", name="ck_c_file_latest"),
        sa.CheckConstraint(
            "official_version_no IS NULL OR "
            "(official_version_no > 0 AND official_version_no <= latest_version_no)",
            name="ck_c_file_official",
        ),
        sa.CheckConstraint(
            "category IN ('documents', 'images', 'exports')", name="ck_c_file_category"
        ),
    )
    op.create_index("ix_c_logical_files_project_id", "c_logical_files", ["project_id"])
    op.create_table(
        "c_file_versions",
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
        sa.ForeignKeyConstraint(["file_id"], ["c_logical_files.id"]),
        sa.ForeignKeyConstraint(["uploaded_by"], ["users.id"]),
        sa.UniqueConstraint("receipt_id"),
        sa.UniqueConstraint("file_id", "version_no", name="uq_c_file_version"),
        sa.CheckConstraint("version_no > 0", name="ck_c_file_version"),
        sa.CheckConstraint("size_bytes BETWEEN 0 AND 52428800", name="ck_c_file_size"),
    )
    op.create_index("ix_c_file_versions_file_id", "c_file_versions", ["file_id"])
    op.create_table(
        "c_file_decisions",
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
        sa.ForeignKeyConstraint(["file_id"], ["c_logical_files.id"]),
        sa.ForeignKeyConstraint(["version_id"], ["c_file_versions.id"]),
        sa.ForeignKeyConstraint(["actor_id"], ["users.id"]),
        sa.CheckConstraint(
            "action IN ('created', 'appended', 'designated')", name="ck_c_file_action"
        ),
        sa.CheckConstraint("length(trim(reason)) > 0", name="ck_c_file_reason"),
    )
    op.create_index("ix_c_file_decisions_file_id", "c_file_decisions", ["file_id"])


def downgrade() -> None:
    # Refuse to silently delete byte provenance/history or orphan pending events.
    op.execute(
        sa.text("""
        DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM c_logical_files)
                OR EXISTS (SELECT 1 FROM c_file_versions)
                OR EXISTS (SELECT 1 FROM c_file_decisions)
                OR EXISTS (SELECT 1 FROM c_integration_outbox WHERE event_type LIKE 'file.%')
                OR EXISTS (SELECT 1 FROM c_request_idempotency WHERE operation LIKE 'file.%') THEN
                RAISE EXCEPTION 'Cannot downgrade: preserve C file data and plan migration first';
            END IF;
        END $$;
    """)
    )
    op.drop_table("c_file_decisions")
    op.drop_table("c_file_versions")
    op.drop_table("c_logical_files")
