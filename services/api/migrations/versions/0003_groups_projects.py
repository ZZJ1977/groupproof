"""Create groups, projects, and their membership tables.

Revision ID: 0003
Revises: 0002
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

UUID = postgresql.UUID(as_uuid=True)
TIMESTAMPTZ = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "groups",
        sa.Column("id", UUID, server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("course_id", UUID, nullable=False),
        sa.Column("leader_id", UUID, nullable=True),
        sa.Column("name", sa.String(160), nullable=False),
        sa.Column("direction", sa.String(200), nullable=True),
        sa.Column("roster_frozen", sa.Boolean, server_default=sa.text("false"), nullable=False),
        sa.Column(
            "created_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.Column(
            "updated_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.Column("lock_version", sa.Integer, server_default=sa.text("0"), nullable=False),
        sa.ForeignKeyConstraint(["course_id"], ["courses.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["leader_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("course_id", "name", name="uq_groups_course_name"),
    )
    op.create_index("ix_groups_course_id", "groups", ["course_id"])
    op.create_index("ix_groups_leader_id", "groups", ["leader_id"])

    op.create_table(
        "group_members",
        sa.Column("id", UUID, server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("group_id", UUID, nullable=False),
        sa.Column("user_id", UUID, nullable=False),
        sa.Column("role", sa.String(32), server_default="member", nullable=False),
        sa.Column(
            "joined_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.Column("left_at", TIMESTAMPTZ, nullable=True),
        sa.Column(
            "created_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.CheckConstraint("role IN ('leader', 'member')", name="ck_group_members_role"),
        sa.ForeignKeyConstraint(["group_id"], ["groups.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_group_members_group_id", "group_members", ["group_id"])
    op.create_index("ix_group_members_user_id", "group_members", ["user_id"])
    op.create_index(
        "uq_group_members_active",
        "group_members",
        ["group_id", "user_id"],
        unique=True,
        postgresql_where=sa.text("left_at IS NULL"),
    )

    op.create_table(
        "projects",
        sa.Column("id", UUID, server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("course_id", UUID, nullable=True),
        sa.Column("group_id", UUID, nullable=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("description", sa.Text, nullable=True),
        sa.Column("project_type", sa.String(80), nullable=True),
        sa.Column("language", sa.String(16), nullable=True),
        sa.Column("visibility", sa.String(32), server_default="members", nullable=False),
        sa.Column("setup_status", sa.String(32), server_default="not_initialized", nullable=False),
        sa.Column("setup_step", sa.SmallInteger, server_default=sa.text("0"), nullable=False),
        sa.Column("lifecycle", sa.String(32), server_default="active", nullable=False),
        sa.Column("final_deadline", TIMESTAMPTZ, nullable=True),
        sa.Column("archived_at", TIMESTAMPTZ, nullable=True),
        sa.Column(
            "created_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.Column(
            "updated_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.Column("lock_version", sa.Integer, server_default=sa.text("0"), nullable=False),
        sa.CheckConstraint("visibility IN ('members', 'course')", name="ck_projects_visibility"),
        sa.CheckConstraint(
            "setup_status IN ('not_initialized', 'draft', 'pending_confirmation', 'frozen')",
            name="ck_projects_setup_status",
        ),
        sa.CheckConstraint(
            "lifecycle IN ('active', 'finalized', 'archived')", name="ck_projects_lifecycle"
        ),
        sa.CheckConstraint("setup_step >= 0", name="ck_projects_setup_step"),
        sa.ForeignKeyConstraint(["course_id"], ["courses.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["group_id"], ["groups.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_projects_course_id", "projects", ["course_id"])
    op.create_index("uq_projects_group_id", "projects", ["group_id"], unique=True)

    op.create_table(
        "project_members",
        sa.Column("id", UUID, server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("project_id", UUID, nullable=False),
        sa.Column("user_id", UUID, nullable=False),
        sa.Column("role", sa.String(32), server_default="member", nullable=False),
        sa.Column(
            "joined_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.Column("left_at", TIMESTAMPTZ, nullable=True),
        sa.Column(
            "created_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.CheckConstraint("role IN ('leader', 'member')", name="ck_project_members_role"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_project_members_project_id", "project_members", ["project_id"])
    op.create_index("ix_project_members_user_id", "project_members", ["user_id"])
    op.create_index(
        "uq_project_members_active",
        "project_members",
        ["project_id", "user_id"],
        unique=True,
        postgresql_where=sa.text("left_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_project_members_active", table_name="project_members")
    op.drop_index("ix_project_members_user_id", table_name="project_members")
    op.drop_index("ix_project_members_project_id", table_name="project_members")
    op.drop_table("project_members")
    op.drop_index("uq_projects_group_id", table_name="projects")
    op.drop_index("ix_projects_course_id", table_name="projects")
    op.drop_table("projects")
    op.drop_index("uq_group_members_active", table_name="group_members")
    op.drop_index("ix_group_members_user_id", table_name="group_members")
    op.drop_index("ix_group_members_group_id", table_name="group_members")
    op.drop_table("group_members")
    op.drop_index("ix_groups_leader_id", table_name="groups")
    op.drop_index("ix_groups_course_id", table_name="groups")
    op.drop_table("groups")
