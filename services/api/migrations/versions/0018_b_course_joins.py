"""B-1 course joins: join policy, join requests, B idempotency receipts.

Revision ID: 0018
Revises: 0017

- b_command_receipts: idempotency receipts shared by every B write;
- b_course_join_policies: per-course admission mode (direct / approval);
- b_course_join_requests: approval-mode join requests (one pending per student);
- course_members: at most one current membership per (course, user).
  Creating this index fails if duplicate current memberships already exist;
  resolve them first (set left_at on the older rows).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0018"
down_revision: str | None = "0017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "b_command_receipts",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("actor_id", sa.UUID(), nullable=False),
        sa.Column("operation", sa.String(length=100), nullable=False),
        sa.Column("idempotency_key", sa.String(length=128), nullable=False),
        sa.Column("request_hash", sa.String(length=64), nullable=False),
        sa.Column("status_code", sa.SmallInteger(), nullable=False),
        sa.Column(
            "response_json",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["actor_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "actor_id", "operation", "idempotency_key", name="uq_b_command_receipts_key"
        ),
    )
    op.create_table(
        "b_course_join_policies",
        sa.Column("course_id", sa.UUID(), nullable=False),
        sa.Column("mode", sa.String(length=16), server_default=sa.text("'direct'"), nullable=False),
        sa.Column("updated_by", sa.UUID(), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("lock_version", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.CheckConstraint("mode IN ('direct', 'approval')", name="ck_b_course_join_policies_mode"),
        sa.ForeignKeyConstraint(["course_id"], ["courses.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["updated_by"],
            ["users.id"],
        ),
        sa.PrimaryKeyConstraint("course_id"),
    )
    op.create_table(
        "b_course_join_requests",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("course_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column(
            "status", sa.String(length=16), server_default=sa.text("'pending'"), nullable=False
        ),
        sa.Column("message", sa.Text(), nullable=True),
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
            "status <> 'rejected' OR length(trim(coalesce(decision_reason, ''))) > 0",
            name="ck_b_course_join_requests_reject_reason",
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'approved', 'rejected', 'cancelled')",
            name="ck_b_course_join_requests_status",
        ),
        sa.ForeignKeyConstraint(["course_id"], ["courses.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["decided_by"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_b_course_join_requests_course_status",
        "b_course_join_requests",
        ["course_id", "status"],
        unique=False,
    )
    op.create_index(
        "uq_b_course_join_requests_pending",
        "b_course_join_requests",
        ["course_id", "user_id"],
        unique=True,
        postgresql_where=sa.text("status = 'pending'"),
        sqlite_where=sa.text("status = 'pending'"),
    )
    op.create_index(
        "uq_course_members_current",
        "course_members",
        ["course_id", "user_id"],
        unique=True,
        postgresql_where=sa.text("left_at IS NULL"),
        sqlite_where=sa.text("left_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "uq_course_members_current",
        table_name="course_members",
        postgresql_where=sa.text("left_at IS NULL"),
        sqlite_where=sa.text("left_at IS NULL"),
    )
    op.drop_index(
        "uq_b_course_join_requests_pending",
        table_name="b_course_join_requests",
        postgresql_where=sa.text("status = 'pending'"),
        sqlite_where=sa.text("status = 'pending'"),
    )
    op.drop_index("ix_b_course_join_requests_course_status", table_name="b_course_join_requests")
    op.drop_table("b_course_join_requests")
    op.drop_table("b_course_join_policies")
    op.drop_table("b_command_receipts")
