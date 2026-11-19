"""A 共享日志补操作人角色与结果；新增 AI 调用用量表。

Revision ID: 0021
Revises: 0020
"""

import sqlalchemy as sa
from alembic import op

revision = "0021"
down_revision = "0020"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 只加列，不改已有记录（a_audit_events 有禁止 UPDATE 的触发器，DDL 不受影响）。
    op.add_column("a_audit_events", sa.Column("actor_role", sa.String(length=32), nullable=True))
    op.add_column(
        "a_audit_events",
        sa.Column(
            "result", sa.String(length=16), server_default=sa.text("'success'"), nullable=False
        ),
    )
    op.create_table(
        "a_ai_usage_events",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "occurred_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("user_id", sa.UUID(), nullable=True),
        sa.Column("project_id", sa.UUID(), nullable=True),
        sa.Column("feature", sa.String(length=60), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=True),
        sa.Column("model", sa.String(length=120), nullable=True),
        sa.Column("success", sa.Boolean(), nullable=False),
        sa.Column("error_code", sa.String(length=40), nullable=True),
        sa.Column("input_tokens", sa.Integer(), nullable=True),
        sa.Column("output_tokens", sa.Integer(), nullable=True),
        sa.Column("cost", sa.Numeric(precision=14, scale=6), nullable=True),
        sa.Column("currency", sa.String(length=8), nullable=True),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_a_ai_usage_user", "a_ai_usage_events", ["user_id", "occurred_at"])
    op.create_index("ix_a_ai_usage_feature", "a_ai_usage_events", ["feature", "occurred_at"])
    op.create_index("ix_a_ai_usage_project", "a_ai_usage_events", ["project_id", "occurred_at"])


def downgrade() -> None:
    op.drop_index("ix_a_ai_usage_project", table_name="a_ai_usage_events")
    op.drop_index("ix_a_ai_usage_feature", table_name="a_ai_usage_events")
    op.drop_index("ix_a_ai_usage_user", table_name="a_ai_usage_events")
    op.drop_table("a_ai_usage_events")
    op.drop_column("a_audit_events", "result")
    op.drop_column("a_audit_events", "actor_role")
