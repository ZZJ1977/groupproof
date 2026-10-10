"""Bind old-email confirmation to the requested new school email.

Revision ID: 0004
Revises: 0003
"""
from alembic import op
import sqlalchemy as sa

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("email_challenges", sa.Column("change_target_email_normalized", sa.String(255), nullable=True))


def downgrade():
    op.drop_column("email_challenges", "change_target_email_normalized")
