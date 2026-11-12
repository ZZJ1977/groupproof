"""A5 GitHub 活动：提交、合并请求、CI 运行记录，以及 GitHub 用户名与本站用户的对应。

Revision ID: 0022
Revises: 0021
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0022"
down_revision = "0021"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "a_github_activities",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("link_id", sa.UUID(), nullable=False),
        sa.Column("kind", sa.String(length=24), nullable=False),
        sa.Column("external_id", sa.String(length=120), nullable=False),
        sa.Column("title", sa.String(length=240), nullable=False),
        sa.Column("summary", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("state", sa.String(length=40), nullable=True),
        sa.Column("author_login", sa.String(length=120), nullable=True),
        sa.Column("author_name", sa.String(length=240), nullable=True),
        sa.Column("author_email", sa.String(length=320), nullable=True),
        sa.Column("author_user_id", sa.UUID(), nullable=True),
        sa.Column("url", sa.String(length=500), nullable=True),
        sa.Column("detail", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("revision", sa.String(length=64), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "synced_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["link_id"], ["a_github_repo_links.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["author_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("link_id", "kind", "external_id", name="uq_a_github_activities_item"),
    )
    op.create_index(
        "ix_a_github_activities_project_time",
        "a_github_activities",
        ["project_id", "occurred_at", "id"],
    )
    op.create_index(
        "ix_a_github_activities_author", "a_github_activities", ["project_id", "author_user_id"]
    )
    op.create_table(
        "a_github_user_links",
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("login", sa.String(length=120), nullable=False),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id"),
        sa.UniqueConstraint("login", name="uq_a_github_user_links_login"),
    )


def downgrade() -> None:
    op.drop_table("a_github_user_links")
    op.drop_index("ix_a_github_activities_author", table_name="a_github_activities")
    op.drop_index("ix_a_github_activities_project_time", table_name="a_github_activities")
    op.drop_table("a_github_activities")
