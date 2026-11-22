"""Store self-reported GitHub and Feishu accounts on user profiles.

Revision ID: 0033
Revises: 0032
"""

import sqlalchemy as sa
from alembic import op

revision = "0033"
down_revision = "0032"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("github_username", sa.String(39), nullable=True))
    op.add_column("users", sa.Column("feishu_account", sa.String(120), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "feishu_account")
    op.drop_column("users", "github_username")

