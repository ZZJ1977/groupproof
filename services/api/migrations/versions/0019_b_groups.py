"""B-2 groups: group invitations, leader change requests and confirmations.

Revision ID: 0019
Revises: 0018
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0019"
down_revision: str | None = "0018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "b_group_invitations",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("group_id", sa.UUID(), nullable=False),
        sa.Column("course_id", sa.UUID(), nullable=False),
        sa.Column("inviter_id", sa.UUID(), nullable=False),
        sa.Column("invitee_id", sa.UUID(), nullable=False),
        sa.Column(
            "status", sa.String(length=20), server_default=sa.text("'pending'"), nullable=False
        ),
        sa.Column("decided_by", sa.UUID(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("decision_reason", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("lock_version", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.CheckConstraint(
            "status IN ('pending', 'awaiting_teacher', 'accepted', 'declined', "
            "'approved', 'rejected', 'cancelled')",
            name="ck_b_group_invitations_status",
        ),
        sa.CheckConstraint("inviter_id <> invitee_id", name="ck_b_group_invitations_not_self"),
        sa.ForeignKeyConstraint(["course_id"], ["courses.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["decided_by"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(["group_id"], ["groups.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["invitee_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["inviter_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_b_group_invitations_invitee_status",
        "b_group_invitations",
        ["invitee_id", "status"],
        unique=False,
    )
    op.create_index(
        "uq_b_group_invitations_open",
        "b_group_invitations",
        ["group_id", "invitee_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('pending', 'awaiting_teacher')"),
        sqlite_where=sa.text("status IN ('pending', 'awaiting_teacher')"),
    )
    op.create_table(
        "b_leader_change_requests",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("group_id", sa.UUID(), nullable=False),
        sa.Column("requested_by", sa.UUID(), nullable=False),
        sa.Column("previous_leader_id", sa.UUID(), nullable=True),
        sa.Column("candidate_id", sa.UUID(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column(
            "required_user_ids",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column(
            "status", sa.String(length=16), server_default=sa.text("'pending'"), nullable=False
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("lock_version", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.CheckConstraint(
            "status IN ('pending', 'approved', 'rejected', 'cancelled')",
            name="ck_b_leader_change_requests_status",
        ),
        sa.CheckConstraint("length(trim(reason)) > 0", name="ck_b_leader_change_requests_reason"),
        sa.ForeignKeyConstraint(["candidate_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["group_id"], ["groups.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["previous_leader_id"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(["requested_by"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "uq_b_leader_change_requests_pending",
        "b_leader_change_requests",
        ["group_id"],
        unique=True,
        postgresql_where=sa.text("status = 'pending'"),
        sqlite_where=sa.text("status = 'pending'"),
    )
    op.create_table(
        "b_leader_change_confirmations",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("request_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("decision", sa.String(length=16), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "decision IN ('confirm', 'reject')", name="ck_b_leader_change_confirmations_decision"
        ),
        sa.ForeignKeyConstraint(
            ["request_id"], ["b_leader_change_requests.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("request_id", "user_id", name="uq_b_leader_change_confirmations_user"),
    )


def downgrade() -> None:
    op.drop_table("b_leader_change_confirmations")
    op.drop_index(
        "uq_b_leader_change_requests_pending",
        table_name="b_leader_change_requests",
        postgresql_where=sa.text("status = 'pending'"),
        sqlite_where=sa.text("status = 'pending'"),
    )
    op.drop_table("b_leader_change_requests")
    op.drop_index(
        "uq_b_group_invitations_open",
        table_name="b_group_invitations",
        postgresql_where=sa.text("status IN ('pending', 'awaiting_teacher')"),
        sqlite_where=sa.text("status IN ('pending', 'awaiting_teacher')"),
    )
    op.drop_index("ix_b_group_invitations_invitee_status", table_name="b_group_invitations")
    op.drop_table("b_group_invitations")
