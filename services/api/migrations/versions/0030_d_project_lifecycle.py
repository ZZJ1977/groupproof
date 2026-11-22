"""D5 immutable archive and reopen provenance.

Revision ID: 0030
Revises: 0029
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0030"
down_revision = "0029"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "project_archives",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "project_id", sa.Uuid(), sa.ForeignKey("projects.id"), nullable=False, unique=True
        ),
        sa.Column("actor_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("snapshot", JSONB(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_table(
        "project_reopens",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("source_project_id", sa.Uuid(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column(
            "new_project_id", sa.Uuid(), sa.ForeignKey("projects.id"), nullable=False, unique=True
        ),
        sa.Column("actor_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("version_label", sa.String(80), nullable=False),
        sa.Column("copy_scope", sa.String(16), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint("copy_scope IN ('full','baseline')"),
    )
    op.create_index(
        "ix_project_reopens_source_project_id", "project_reopens", ["source_project_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_project_reopens_source_project_id", table_name="project_reopens")
    op.drop_table("project_reopens")
    op.drop_table("project_archives")
