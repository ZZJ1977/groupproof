"""Record when each auth session last authenticated.

Revision ID: 0016
Revises: 0015

- auth_sessions.authenticated_at：本会话最近一次真实认证的时间，会话轮换时保留；
  “近期认证”按会话判断，不再用用户级 last_login_at。历史会话为空，回退到 created_at。
"""

import sqlalchemy as sa
from alembic import op

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "auth_sessions", sa.Column("authenticated_at", sa.DateTime(timezone=True), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("auth_sessions", "authenticated_at")
