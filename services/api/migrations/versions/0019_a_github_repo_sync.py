"""A5 GitHub 只读接入：项目绑定的仓库与文件快照。

Revision ID: 0019
Revises: 0018
"""

import sqlalchemy as sa
from alembic import op

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "a_github_repo_links",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("owner", sa.String(length=100), nullable=False),
        sa.Column("repo", sa.String(length=100), nullable=False),
        sa.Column("installation_id", sa.BigInteger(), nullable=False),
        sa.Column("default_branch", sa.String(length=200), nullable=False),
        sa.Column("linked_by_id", sa.UUID(), nullable=True),
        sa.Column(
            "linked_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column("last_synced_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["linked_by_id"], ["users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "project_id", "owner", "repo", name="uq_a_github_repo_links_project_repo"
        ),
    )
    op.create_table(
        "a_github_files",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("link_id", sa.UUID(), nullable=False),
        sa.Column("path", sa.String(length=1000), nullable=False),
        sa.Column("blob_sha", sa.String(length=64), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column(
            "synced_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["link_id"], ["a_github_repo_links.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("link_id", "path", name="uq_a_github_files_link_path"),
    )
    op.create_index("ix_a_github_files_project", "a_github_files", ["project_id", "path"])


def downgrade() -> None:
    op.drop_index("ix_a_github_files_project", table_name="a_github_files")
    op.drop_table("a_github_files")
    op.drop_table("a_github_repo_links")
