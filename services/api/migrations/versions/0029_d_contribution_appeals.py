"""D2 collaboration notes, appeals, decisions and contribution archives.

Revision ID: 0029
Revises: 0028
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0029"
down_revision = "0028"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "collaboration_notes",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("project_id", sa.Uuid(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("member_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("author_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("restored_from", sa.Uuid(), sa.ForeignKey("collaboration_notes.id")),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint("project_id", "member_id", "revision"),
    )
    op.create_index("ix_collaboration_notes_project_id", "collaboration_notes", ["project_id"])
    op.create_table(
        "contribution_appeals",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("project_id", sa.Uuid(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column(
            "snapshot_id", sa.Uuid(), sa.ForeignKey("contribution_snapshots.id"), nullable=False
        ),
        sa.Column("member_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("task_id", sa.Uuid(), sa.ForeignKey("tasks.id"), nullable=False),
        sa.Column("evidence_id", sa.Uuid(), sa.ForeignKey("evidence.id"), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("status", sa.String(16), server_default=sa.text("'pending'"), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint("status IN ('pending','upheld','adjusted','returned')"),
    )
    op.create_index("ix_contribution_appeals_project_id", "contribution_appeals", ["project_id"])
    op.create_table(
        "appeal_decisions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("appeal_id", sa.Uuid(), sa.ForeignKey("contribution_appeals.id"), nullable=False),
        sa.Column("teacher_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("action", sa.String(16), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("adjusted_share", sa.Numeric(7, 4)),
        sa.Column("resulting_snapshot_id", sa.Uuid(), sa.ForeignKey("contribution_snapshots.id")),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index("ix_appeal_decisions_appeal_id", "appeal_decisions", ["appeal_id"])
    op.create_table(
        "contribution_archives",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("project_id", sa.Uuid(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column(
            "snapshot_id", sa.Uuid(), sa.ForeignKey("contribution_snapshots.id"), nullable=False
        ),
        sa.Column("source_kind", sa.String(16), nullable=False),
        sa.Column("source_id", sa.Uuid(), nullable=False),
        sa.Column("data", JSONB(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint("source_kind", "source_id"),
    )
    op.create_index("ix_contribution_archives_project_id", "contribution_archives", ["project_id"])


def downgrade() -> None:
    for table in (
        "contribution_archives",
        "appeal_decisions",
        "contribution_appeals",
        "collaboration_notes",
    ):
        op.drop_index(
            f"ix_{table}_{'appeal_id' if table == 'appeal_decisions' else 'project_id'}",
            table_name=table,
        )
        op.drop_table(table)
