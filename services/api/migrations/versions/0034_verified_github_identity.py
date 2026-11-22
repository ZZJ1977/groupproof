"""Verified personal GitHub identities and their OAuth transactions.

Revision ID: 0034
Revises: 0033
"""

import sqlalchemy as sa
from alembic import op

revision = "0034"
down_revision = "0033"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "verified_github_identities",
        sa.Column("user_id", sa.Uuid(), primary_key=True),
        sa.Column("github_user_id", sa.BigInteger(), nullable=False),
        sa.Column("login", sa.String(39), nullable=False),
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("github_user_id", name="uq_verified_github_identity"),
    )
    op.create_table(
        "github_link_transactions",
        sa.Column("user_id", sa.Uuid(), primary_key=True),
        sa.Column("session_id", sa.String(64), nullable=False),
        sa.Column("state_digest", sa.String(64), nullable=False),
        sa.Column("code_verifier", sa.String(128), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["session_id"], ["auth_sessions.id"], ondelete="CASCADE"),
    )


def downgrade() -> None:
    op.drop_table("github_link_transactions")
    op.drop_table("verified_github_identities")
