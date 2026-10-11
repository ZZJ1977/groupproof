"""Create identity, users, courses, and course membership tables.

Revision ID: 0002
Revises: 0001
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

UUID = postgresql.UUID(as_uuid=True)
TIMESTAMPTZ = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", UUID, server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("username", sa.String(80), nullable=False),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("student_id", sa.String(80), nullable=True),
        sa.Column("college", sa.String(160), nullable=False),
        sa.Column("global_role", sa.String(32), server_default="student", nullable=False),
        sa.Column("status", sa.String(32), server_default="pending", nullable=False),
        sa.Column("email_verified_at", TIMESTAMPTZ, nullable=True),
        sa.Column("avatar_color", sa.String(32), nullable=True),
        sa.Column(
            "created_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.Column(
            "updated_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.Column("lock_version", sa.Integer, server_default=sa.text("0"), nullable=False),
        sa.CheckConstraint(
            "global_role IN ('student', 'teacher', 'ta', 'admin')", name="ck_users_global_role"
        ),
        sa.CheckConstraint("status IN ('active', 'disabled', 'pending')", name="ck_users_status"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("username", name="uq_users_username"),
        sa.UniqueConstraint("email", name="uq_users_email"),
        sa.UniqueConstraint("student_id", name="uq_users_student_id"),
    )

    op.create_table(
        "sessions",
        sa.Column("id", UUID, server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", UUID, nullable=False),
        sa.Column("provider", sa.String(32), nullable=False),
        sa.Column("refresh_token_hash", sa.String(255), nullable=False),
        sa.Column("expires_at", TIMESTAMPTZ, nullable=False),
        sa.Column("last_seen_at", TIMESTAMPTZ, nullable=True),
        sa.Column("revoked_at", TIMESTAMPTZ, nullable=True),
        sa.Column(
            "created_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_sessions_user_id", "sessions", ["user_id"])

    op.create_table(
        "email_verifications",
        sa.Column("id", UUID, server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", UUID, nullable=False),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("purpose", sa.String(32), nullable=False),
        sa.Column("code_hash", sa.String(255), nullable=False),
        sa.Column("expires_at", TIMESTAMPTZ, nullable=False),
        sa.Column("verified_at", TIMESTAMPTZ, nullable=True),
        sa.Column("attempts", sa.Integer, server_default=sa.text("0"), nullable=False),
        sa.Column(
            "created_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_email_verifications_user_id", "email_verifications", ["user_id"])

    op.create_table(
        "oauth_connections",
        sa.Column("id", UUID, server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", UUID, nullable=False),
        sa.Column("provider", sa.String(32), nullable=False),
        sa.Column("provider_subject", sa.String(255), nullable=False),
        sa.Column("access_token_encrypted", sa.Text, nullable=True),
        sa.Column("refresh_token_encrypted", sa.Text, nullable=True),
        sa.Column("scopes_json", postgresql.JSONB, nullable=True),
        sa.Column("token_expires_at", TIMESTAMPTZ, nullable=True),
        sa.Column(
            "created_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.Column(
            "updated_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "provider", "provider_subject", name="uq_oauth_connections_provider_subject"
        ),
    )
    op.create_index("ix_oauth_connections_user_id", "oauth_connections", ["user_id"])

    op.create_table(
        "courses",
        sa.Column("id", UUID, server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("owner_id", UUID, nullable=False),
        sa.Column("code", sa.String(64), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("college", sa.String(160), nullable=False),
        sa.Column("semester", sa.String(64), nullable=False),
        sa.Column("status", sa.String(32), server_default="draft", nullable=False),
        sa.Column("project_deadline", TIMESTAMPTZ, nullable=True),
        sa.Column("formation_deadline", TIMESTAMPTZ, nullable=True),
        sa.Column("grouping_mode", sa.String(32), server_default="free", nullable=False),
        sa.Column("min_group_size", sa.SmallInteger, server_default=sa.text("1"), nullable=False),
        sa.Column("max_group_size", sa.SmallInteger, server_default=sa.text("8"), nullable=False),
        sa.Column(
            "created_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.Column(
            "updated_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.Column("lock_version", sa.Integer, server_default=sa.text("0"), nullable=False),
        sa.CheckConstraint("status IN ('draft', 'active', 'ended')", name="ck_courses_status"),
        sa.CheckConstraint(
            "grouping_mode IN ('free', 'approval')", name="ck_courses_grouping_mode"
        ),
        sa.CheckConstraint(
            "min_group_size > 0 AND max_group_size >= min_group_size", name="ck_courses_group_size"
        ),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], name="fk_courses_owner_id_users"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("code", "semester", name="uq_courses_code_semester"),
    )
    op.create_index("ix_courses_owner_id", "courses", ["owner_id"])

    op.create_table(
        "course_staff",
        sa.Column("course_id", UUID, nullable=False),
        sa.Column("user_id", UUID, nullable=False),
        sa.Column("role", sa.String(32), nullable=False),
        sa.Column(
            "joined_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.Column("left_at", TIMESTAMPTZ, nullable=True),
        sa.Column(
            "created_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.CheckConstraint("role IN ('teacher', 'ta')", name="ck_course_staff_role"),
        sa.ForeignKeyConstraint(["course_id"], ["courses.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("course_id", "user_id"),
    )
    op.create_index("ix_course_staff_user_id", "course_staff", ["user_id"])

    op.create_table(
        "course_members",
        sa.Column("id", UUID, server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("course_id", UUID, nullable=False),
        sa.Column("user_id", UUID, nullable=False),
        sa.Column("role", sa.String(32), server_default="student", nullable=False),
        sa.Column("status", sa.String(32), server_default="active", nullable=False),
        sa.Column(
            "joined_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.Column("left_at", TIMESTAMPTZ, nullable=True),
        sa.Column(
            "created_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.Column(
            "updated_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.Column("lock_version", sa.Integer, server_default=sa.text("0"), nullable=False),
        sa.CheckConstraint("role IN ('student', 'teacher', 'ta')", name="ck_course_members_role"),
        sa.CheckConstraint(
            "status IN ('active', 'pending', 'left')", name="ck_course_members_status"
        ),
        sa.ForeignKeyConstraint(["course_id"], ["courses.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_course_members_course_id", "course_members", ["course_id"])
    op.create_index("ix_course_members_user_id", "course_members", ["user_id"])
    op.create_index(
        "uq_course_members_active",
        "course_members",
        ["course_id", "user_id"],
        unique=True,
        postgresql_where=sa.text("left_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_course_members_active", table_name="course_members")
    op.drop_index("ix_course_members_user_id", table_name="course_members")
    op.drop_index("ix_course_members_course_id", table_name="course_members")
    op.drop_table("course_members")
    op.drop_index("ix_course_staff_user_id", table_name="course_staff")
    op.drop_table("course_staff")
    op.drop_index("ix_courses_owner_id", table_name="courses")
    op.drop_table("courses")
    op.drop_index("ix_oauth_connections_user_id", table_name="oauth_connections")
    op.drop_table("oauth_connections")
    op.drop_index("ix_email_verifications_user_id", table_name="email_verifications")
    op.drop_table("email_verifications")
    op.drop_index("ix_sessions_user_id", table_name="sessions")
    op.drop_table("sessions")
    op.drop_table("users")
