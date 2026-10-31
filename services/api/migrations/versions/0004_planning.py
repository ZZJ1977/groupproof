"""Create modules, requirements, source references, and milestones.

Revision ID: 0004
Revises: 0003
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

UUID = postgresql.UUID(as_uuid=True)
TIMESTAMPTZ = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "functional_modules",
        sa.Column("id", UUID, server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("project_id", UUID, nullable=False),
        sa.Column("owner_id", UUID, nullable=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("description", sa.Text, nullable=True),
        sa.Column("core", sa.Boolean, server_default=sa.text("false"), nullable=False),
        sa.Column("progress_percent", sa.SmallInteger, server_default=sa.text("0"), nullable=False),
        sa.Column("sort_order", sa.Integer, server_default=sa.text("0"), nullable=False),
        sa.Column(
            "created_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.Column(
            "updated_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.Column("lock_version", sa.Integer, server_default=sa.text("0"), nullable=False),
        sa.CheckConstraint(
            "progress_percent BETWEEN 0 AND 100", name="ck_functional_modules_progress"
        ),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", "name", name="uq_functional_modules_project_name"),
    )
    op.create_index("ix_functional_modules_project_id", "functional_modules", ["project_id"])
    op.create_index("ix_functional_modules_owner_id", "functional_modules", ["owner_id"])

    op.create_table(
        "requirements",
        sa.Column("id", UUID, server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("project_id", UUID, nullable=False),
        sa.Column("module_id", UUID, nullable=False),
        sa.Column("title", sa.String(240), nullable=False),
        sa.Column("description", sa.Text, nullable=True),
        sa.Column("priority", sa.String(16), server_default="medium", nullable=False),
        sa.Column("status", sa.String(32), server_default="draft", nullable=False),
        sa.Column("source_summary", sa.Text, nullable=True),
        sa.Column("created_by", UUID, nullable=True),
        sa.Column(
            "created_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.Column(
            "updated_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.Column("lock_version", sa.Integer, server_default=sa.text("0"), nullable=False),
        sa.CheckConstraint(
            "priority IN ('high', 'medium', 'low')", name="ck_requirements_priority"
        ),
        sa.CheckConstraint(
            "status IN ('draft', 'confirmed', 'in_progress', 'implemented', 'verified')",
            name="ck_requirements_status",
        ),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["module_id"], ["functional_modules.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_requirements_project_id", "requirements", ["project_id"])
    op.create_index("ix_requirements_module_id", "requirements", ["module_id"])
    op.create_index("ix_requirements_status", "requirements", ["status"])

    op.create_table(
        "source_references",
        sa.Column("id", UUID, server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("project_id", UUID, nullable=False),
        sa.Column("created_by", UUID, nullable=True),
        sa.Column("source_type", sa.String(32), nullable=False),
        sa.Column("external_id", sa.String(255), nullable=True),
        sa.Column("source_uri", sa.Text, nullable=True),
        sa.Column("title", sa.String(240), nullable=True),
        sa.Column("content_hash", sa.String(128), nullable=True),
        sa.Column("metadata_json", postgresql.JSONB, nullable=True),
        sa.Column(
            "created_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_source_references_project_id", "source_references", ["project_id"])
    op.create_index("ix_source_references_type", "source_references", ["source_type"])

    op.create_table(
        "requirement_source_references",
        sa.Column("requirement_id", UUID, nullable=False),
        sa.Column("source_reference_id", UUID, nullable=False),
        sa.Column("relation_type", sa.String(32), server_default="supports", nullable=False),
        sa.ForeignKeyConstraint(["requirement_id"], ["requirements.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["source_reference_id"], ["source_references.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("requirement_id", "source_reference_id"),
    )

    op.create_table(
        "requirement_conflicts",
        sa.Column("id", UUID, server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("project_id", UUID, nullable=False),
        sa.Column("left_requirement_id", UUID, nullable=False),
        sa.Column("right_requirement_id", UUID, nullable=False),
        sa.Column("conflict_type", sa.String(32), nullable=False),
        sa.Column("description", sa.Text, nullable=True),
        sa.Column("status", sa.String(32), server_default="open", nullable=False),
        sa.Column(
            "created_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.Column(
            "updated_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.CheckConstraint(
            "left_requirement_id <> right_requirement_id", name="ck_requirement_conflict_distinct"
        ),
        sa.CheckConstraint(
            "status IN ('open', 'resolved', 'ignored')", name="ck_requirement_conflicts_status"
        ),
        sa.ForeignKeyConstraint(["left_requirement_id"], ["requirements.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["right_requirement_id"], ["requirements.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_requirement_conflicts_project_id", "requirement_conflicts", ["project_id"])
    op.create_index("ix_requirement_conflicts_status", "requirement_conflicts", ["status"])

    op.create_table(
        "conflict_resolutions",
        sa.Column("id", UUID, server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("conflict_id", UUID, nullable=False),
        sa.Column("resolved_by", UUID, nullable=False),
        sa.Column("decision", sa.String(32), nullable=False),
        sa.Column("reason", sa.Text, nullable=False),
        sa.Column(
            "created_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.ForeignKeyConstraint(["conflict_id"], ["requirement_conflicts.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["resolved_by"], ["users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_conflict_resolutions_conflict_id", "conflict_resolutions", ["conflict_id"])

    op.create_table(
        "milestones",
        sa.Column("id", UUID, server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("project_id", UUID, nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("description", sa.Text, nullable=True),
        sa.Column("deadline", TIMESTAMPTZ, nullable=True),
        sa.Column("status", sa.String(32), server_default="not_started", nullable=False),
        sa.Column("progress_percent", sa.SmallInteger, server_default=sa.text("0"), nullable=False),
        sa.Column("sort_order", sa.Integer, server_default=sa.text("0"), nullable=False),
        sa.Column(
            "created_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.Column(
            "updated_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.Column("lock_version", sa.Integer, server_default=sa.text("0"), nullable=False),
        sa.CheckConstraint(
            "status IN ('not_started', 'in_progress', 'completed', 'at_risk')",
            name="ck_milestones_status",
        ),
        sa.CheckConstraint("progress_percent BETWEEN 0 AND 100", name="ck_milestones_progress"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_milestones_project_id", "milestones", ["project_id"])
    op.create_index("ix_milestones_status", "milestones", ["status"])


def downgrade() -> None:
    op.drop_index("ix_milestones_status", table_name="milestones")
    op.drop_index("ix_milestones_project_id", table_name="milestones")
    op.drop_table("milestones")
    op.drop_index("ix_conflict_resolutions_conflict_id", table_name="conflict_resolutions")
    op.drop_table("conflict_resolutions")
    op.drop_index("ix_requirement_conflicts_status", table_name="requirement_conflicts")
    op.drop_index("ix_requirement_conflicts_project_id", table_name="requirement_conflicts")
    op.drop_table("requirement_conflicts")
    op.drop_table("requirement_source_references")
    op.drop_index("ix_source_references_type", table_name="source_references")
    op.drop_index("ix_source_references_project_id", table_name="source_references")
    op.drop_table("source_references")
    op.drop_index("ix_requirements_status", table_name="requirements")
    op.drop_index("ix_requirements_module_id", table_name="requirements")
    op.drop_index("ix_requirements_project_id", table_name="requirements")
    op.drop_table("requirements")
    op.drop_index("ix_functional_modules_owner_id", table_name="functional_modules")
    op.drop_index("ix_functional_modules_project_id", table_name="functional_modules")
    op.drop_table("functional_modules")
