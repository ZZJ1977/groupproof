"""Persist D risk records and transition history.

Revision ID: 0017
Revises: 0016
"""

import sqlalchemy as sa
from alembic import op

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "risks",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("project_id", sa.Uuid(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("task_id", sa.Uuid(), sa.ForeignKey("tasks.id")),
        sa.Column("milestone_id", sa.Uuid(), sa.ForeignKey("milestones.id")),
        sa.Column("owner_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("title", sa.String(240), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("level", sa.String(16), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("due_at", sa.DateTime(timezone=True)),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("lock_version", sa.Integer(), server_default="0", nullable=False),
        sa.CheckConstraint("level IN ('low','medium','high')", name="ck_risks_level"),
        sa.CheckConstraint("status IN ('open','mitigating','closed')", name="ck_risks_status"),
        sa.CheckConstraint(
            "task_id IS NOT NULL OR milestone_id IS NOT NULL", name="ck_risks_target"
        ),
    )
    op.create_index("ix_risks_project_id", "risks", ["project_id"])
    op.create_table(
        "risk_events",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("risk_id", sa.Uuid(), sa.ForeignKey("risks.id"), nullable=False),
        sa.Column("actor_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("event_type", sa.String(16), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index("ix_risk_events_risk_id", "risk_events", ["risk_id"])


def downgrade() -> None:
    op.drop_index("ix_risk_events_risk_id", table_name="risk_events")
    op.drop_table("risk_events")
    op.drop_index("ix_risks_project_id", table_name="risks")
    op.drop_table("risks")
