"""A6 飞书完整消息：消息版本、附件引用。

Revision ID: 0023
Revises: 0022
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0023"
down_revision = "0022"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "a_feishu_messages",
        sa.Column("version_no", sa.Integer(), server_default=sa.text("1"), nullable=False),
    )
    op.create_table(
        "a_feishu_message_versions",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("message_row_id", sa.UUID(), nullable=False),
        sa.Column("version_no", sa.Integer(), nullable=False),
        sa.Column("content_hash", sa.String(length=64), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("attachments", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("deleted", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "recorded_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["message_row_id"], ["a_feishu_messages.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("message_row_id", "version_no", name="uq_a_feishu_versions_message_no"),
    )
    op.create_table(
        "a_feishu_attachments",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("message_row_id", sa.UUID(), nullable=False),
        sa.Column("file_key", sa.String(length=200), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("name", sa.String(length=300), nullable=True),
        sa.Column("size_bytes", sa.BigInteger(), nullable=True),
        sa.Column("content_sha256", sa.String(length=64), nullable=True),
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("available", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.ForeignKeyConstraint(["message_row_id"], ["a_feishu_messages.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("message_row_id", "file_key", name="uq_a_feishu_attachments_key"),
    )


def downgrade() -> None:
    op.drop_table("a_feishu_attachments")
    op.drop_table("a_feishu_message_versions")
    op.drop_column("a_feishu_messages", "version_no")
