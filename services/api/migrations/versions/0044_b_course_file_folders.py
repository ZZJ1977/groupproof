"""B course material folders, items, and versions tables.

Revision ID: 0044
Revises: 0043
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0044"
down_revision: str | None = "0043"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "b_course_file_folders",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("course_id", sa.UUID(), nullable=False),
        sa.Column("parent_id", sa.Uuid(), nullable=True),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("sort_order", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("created_by", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["course_id"], ["courses.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["parent_id"], ["b_course_file_folders.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_b_course_file_folders_course_id", "b_course_file_folders", ["course_id"], unique=False
    )

    op.create_table(
        "b_course_material_items",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("course_id", sa.UUID(), nullable=False),
        sa.Column("folder_id", sa.Uuid(), nullable=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column(
            "visibility", sa.String(length=20), server_default=sa.text("'all'"), nullable=False
        ),
        sa.Column(
            "status", sa.String(length=20), server_default=sa.text("'published'"), nullable=False
        ),
        sa.Column("latest_version_no", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column(
            "mime_type",
            sa.String(length=200),
            server_default=sa.text("'application/octet-stream'"),
            nullable=False,
        ),
        sa.Column("size_bytes", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("uploaded_by", sa.UUID(), nullable=False),
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
            "visibility IN ('all', 'grouped', 'staff')", name="ck_b_material_visibility"
        ),
        sa.CheckConstraint("status IN ('draft', 'published')", name="ck_b_material_status"),
        sa.CheckConstraint("latest_version_no > 0", name="ck_b_material_latest_v"),
        sa.ForeignKeyConstraint(["course_id"], ["courses.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["folder_id"], ["b_course_file_folders.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["uploaded_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_b_course_material_items_course_id",
        "b_course_material_items",
        ["course_id"],
        unique=False,
    )
    op.create_index(
        "ix_b_course_material_items_folder_id",
        "b_course_material_items",
        ["folder_id"],
        unique=False,
    )

    op.create_table(
        "b_course_material_versions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("material_id", sa.Uuid(), nullable=False),
        sa.Column("version_no", sa.Integer(), nullable=False),
        sa.Column("original_name", sa.String(length=255), nullable=False),
        sa.Column(
            "mime_type",
            sa.String(length=200),
            server_default=sa.text("'application/octet-stream'"),
            nullable=False,
        ),
        sa.Column("size_bytes", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("checksum", sa.String(length=64), server_default=sa.text("''"), nullable=False),
        sa.Column("storage_key", sa.String(length=500), nullable=True),
        sa.Column("content_base64", sa.Text(), nullable=True),
        sa.Column("change_note", sa.Text(), nullable=True),
        sa.Column("uploaded_by", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("version_no > 0", name="ck_b_material_version_no"),
        sa.ForeignKeyConstraint(
            ["material_id"], ["b_course_material_items.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["uploaded_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("material_id", "version_no", name="uq_b_material_version"),
    )
    op.create_index(
        "ix_b_course_material_versions_material_id",
        "b_course_material_versions",
        ["material_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_b_course_material_versions_material_id", table_name="b_course_material_versions"
    )
    op.drop_table("b_course_material_versions")
    op.drop_index("ix_b_course_material_items_folder_id", table_name="b_course_material_items")
    op.drop_index("ix_b_course_material_items_course_id", table_name="b_course_material_items")
    op.drop_table("b_course_material_items")
    op.drop_index("ix_b_course_file_folders_course_id", table_name="b_course_file_folders")
    op.drop_table("b_course_file_folders")

