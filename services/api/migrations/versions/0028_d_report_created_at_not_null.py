"""Match report audit timestamps to the non-null ORM columns.

Revision ID: 0028
Revises: 0027
"""

import sqlalchemy as sa
from alembic import op

revision = "0028"
down_revision = "0027"
branch_labels = None
depends_on = None

_TABLES = (
    "report_artifacts",
    "report_download_links",
    "report_downloads",
    "report_reviews",
)


def upgrade() -> None:
    for table in _TABLES:
        op.execute(sa.text(f"UPDATE {table} SET created_at = now() WHERE created_at IS NULL"))
        op.alter_column(
            table,
            "created_at",
            existing_type=sa.DateTime(timezone=True),
            existing_server_default=sa.func.now(),
            nullable=False,
        )


def downgrade() -> None:
    for table in _TABLES:
        op.alter_column(
            table,
            "created_at",
            existing_type=sa.DateTime(timezone=True),
            existing_server_default=sa.func.now(),
            nullable=True,
        )
