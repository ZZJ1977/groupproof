"""A6 飞书只读同步：项目绑定的群和群消息快照。

Revision ID: 0019
Revises: 0018

- a_feishu_chat_links：项目负责人绑定的飞书群；
- a_feishu_messages：同步下来的群消息（按 project_id + message_id 幂等）。
"""

import sqlalchemy as sa
from alembic import op

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "a_feishu_chat_links",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("chat_id", sa.String(length=200), nullable=False),
        sa.Column("linked_by_id", sa.UUID(), nullable=True),
        sa.Column(
            "linked_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["linked_by_id"], ["users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", "chat_id", name="uq_a_feishu_chat_links_project_chat"),
    )
    op.create_table(
        "a_feishu_messages",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("chat_id", sa.String(length=200), nullable=False),
        sa.Column("message_id", sa.String(length=200), nullable=False),
        sa.Column("sender_open_id", sa.String(length=200), nullable=True),
        sa.Column("sender_type", sa.String(length=32), nullable=False),
        sa.Column("msg_type", sa.String(length=40), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("content_hash", sa.String(length=64), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "synced_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "project_id", "message_id", name="uq_a_feishu_messages_project_message"
        ),
    )
    op.create_index(
        "ix_a_feishu_messages_project_time",
        "a_feishu_messages",
        ["project_id", "occurred_at", "id"],
    )


def downgrade() -> None:
    op.drop_index("ix_a_feishu_messages_project_time", table_name="a_feishu_messages")
    op.drop_table("a_feishu_messages")
    op.drop_table("a_feishu_chat_links")
