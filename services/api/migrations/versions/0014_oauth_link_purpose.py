"""Add link purpose and target user to OAuth transactions.

Revision ID: 0014
Revises: 0013

- oauth_transactions.purpose：事务用途 login|link，非空，默认 'login'。
- oauth_transactions.user_id：purpose=link 时的目标用户，可空，随用户级联删除。
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None

UUID = postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    op.add_column(
        "oauth_transactions",
        sa.Column("purpose", sa.String(16), server_default=sa.text("'login'"), nullable=False),
    )
    op.add_column("oauth_transactions", sa.Column("user_id", UUID, nullable=True))
    op.create_foreign_key(
        None, "oauth_transactions", "users", ["user_id"], ["id"], ondelete="CASCADE"
    )


def downgrade() -> None:
    op.drop_constraint("oauth_transactions_user_id_fkey", "oauth_transactions", type_="foreignkey")
    op.drop_column("oauth_transactions", "user_id")
    op.drop_column("oauth_transactions", "purpose")
