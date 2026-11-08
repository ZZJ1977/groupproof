"""B-8 milestones and member removal/leaving with task handover.

Revision ID: 0025
Revises: 0024

- b_milestone_deliverables / b_milestone_deliverable_events: B7-02 deliverables
  ticked by the leader, every tick and untick recorded; ``file_id`` points at
  C's c_logical_files without a foreign key so C's migrations stay independent;
- b_milestone_date_changes: B7-04 deadline changes with a reason;
- b_membership_change_requests / b_task_handovers: B2-04/06/07 removal and
  leaving with one receiver per unfinished task; at most one open request per
  member and group.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0025"
down_revision: str | None = "0024"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "b_membership_change_requests",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("course_id", sa.UUID(), nullable=False),
        sa.Column("group_id", sa.UUID(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=True),
        sa.Column("change_type", sa.String(length=16), nullable=False),
        sa.Column("member_id", sa.UUID(), nullable=False),
        sa.Column("requested_by", sa.UUID(), nullable=False),
        sa.Column(
            "status", sa.String(length=16), server_default=sa.text("'pending'"), nullable=False
        ),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("teacher_comment", sa.Text(), nullable=True),
        sa.Column("decided_by", sa.UUID(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("applied_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("lock_version", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.CheckConstraint(
            "change_type IN ('remove', 'leave')", name="ck_b_membership_change_requests_type"
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'needs_info', 'approved', 'rejected', 'applied')",
            name="ck_b_membership_change_requests_status",
        ),
        sa.ForeignKeyConstraint(["course_id"], ["courses.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["decided_by"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(["group_id"], ["groups.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["member_id"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(
            ["requested_by"],
            ["users.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "uq_b_membership_change_requests_open",
        "b_membership_change_requests",
        ["group_id", "member_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('pending', 'needs_info')"),
    )
    op.create_table(
        "b_milestone_date_changes",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("milestone_id", sa.UUID(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("old_deadline", sa.DateTime(timezone=True), nullable=True),
        sa.Column("new_deadline", sa.DateTime(timezone=True), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("changed_by", sa.UUID(), nullable=False),
        sa.Column(
            "changed_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("length(trim(reason)) > 0", name="ck_b_milestone_date_changes_reason"),
        sa.ForeignKeyConstraint(
            ["changed_by"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(["milestone_id"], ["milestones.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "b_milestone_deliverables",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("milestone_id", sa.UUID(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("sort_order", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("done", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("done_by", sa.UUID(), nullable=True),
        sa.Column("done_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("file_id", sa.Uuid(), nullable=True),
        sa.Column("created_by", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("lock_version", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(
            ["done_by"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(["milestone_id"], ["milestones.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_b_milestone_deliverables_milestone",
        "b_milestone_deliverables",
        ["milestone_id"],
        unique=False,
    )
    op.create_table(
        "b_milestone_deliverable_events",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("deliverable_id", sa.Uuid(), nullable=False),
        sa.Column("action", sa.String(length=16), nullable=False),
        sa.Column("file_id", sa.Uuid(), nullable=True),
        sa.Column("actor_id", sa.UUID(), nullable=False),
        sa.Column(
            "at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.CheckConstraint(
            "action IN ('checked', 'unchecked')", name="ck_b_milestone_deliverable_events_action"
        ),
        sa.ForeignKeyConstraint(
            ["actor_id"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(
            ["deliverable_id"], ["b_milestone_deliverables.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "b_task_handovers",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("request_id", sa.Uuid(), nullable=False),
        sa.Column("task_id", sa.UUID(), nullable=False),
        sa.Column("from_user_id", sa.UUID(), nullable=False),
        sa.Column("to_user_id", sa.UUID(), nullable=False),
        sa.Column("applied_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["from_user_id"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(
            ["request_id"], ["b_membership_change_requests.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["to_user_id"],
            ["users.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("request_id", "task_id", name="uq_b_task_handovers_task"),
    )


def downgrade() -> None:
    op.drop_table("b_task_handovers")
    op.drop_table("b_milestone_deliverable_events")
    op.drop_index("ix_b_milestone_deliverables_milestone", table_name="b_milestone_deliverables")
    op.drop_table("b_milestone_deliverables")
    op.drop_table("b_milestone_date_changes")
    op.drop_index(
        "uq_b_membership_change_requests_open",
        table_name="b_membership_change_requests",
        postgresql_where=sa.text("status IN ('pending', 'needs_info')"),
    )
    op.drop_table("b_membership_change_requests")
