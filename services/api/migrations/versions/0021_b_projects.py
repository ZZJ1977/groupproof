"""B-3 projects: course milestone templates, wizard drafts, project materials.

Revision ID: 0021
Revises: 0020

- b_course_project_templates: milestones copied into each new project;
- b_project_drafts: page 35 wizard draft, one per group;
- b_project_schedules: planned start date (the end is projects.final_deadline);
- b_project_materials: pasted text or A4-04 uploads with their extract status;
- projects: unique index so each group has at most one project.
  Creating the index fails if a group already owns two projects.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0021"
down_revision: str | None = "0020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "b_course_project_templates",
        sa.Column("course_id", sa.UUID(), nullable=False),
        sa.Column(
            "milestones",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column("updated_by", sa.UUID(), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("lock_version", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.ForeignKeyConstraint(["course_id"], ["courses.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["updated_by"],
            ["users.id"],
        ),
        sa.PrimaryKeyConstraint("course_id"),
    )
    op.create_table(
        "b_project_drafts",
        sa.Column("group_id", sa.UUID(), nullable=False),
        sa.Column(
            "payload",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column("step", sa.SmallInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("updated_by", sa.UUID(), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("lock_version", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.CheckConstraint("step BETWEEN 0 AND 10", name="ck_b_project_drafts_step"),
        sa.ForeignKeyConstraint(["group_id"], ["groups.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["updated_by"],
            ["users.id"],
        ),
        sa.PrimaryKeyConstraint("group_id"),
    )
    op.create_table(
        "b_project_materials",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("kind", sa.String(length=8), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("text_content", sa.Text(), nullable=True),
        sa.Column("receipt_id", sa.UUID(), nullable=True),
        sa.Column("extract_status", sa.String(length=16), nullable=False),
        sa.Column("extract_reason", sa.String(length=300), nullable=True),
        sa.Column("created_by", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "(kind = 'text' AND text_content IS NOT NULL AND receipt_id IS NULL) "
            "OR (kind = 'file' AND receipt_id IS NOT NULL)",
            name="ck_b_project_materials_source",
        ),
        sa.CheckConstraint(
            "extract_status IN ('ready', 'pending', 'failed', 'unavailable')",
            name="ck_b_project_materials_extract",
        ),
        sa.CheckConstraint("kind IN ('text', 'file')", name="ck_b_project_materials_kind"),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["receipt_id"], ["a_upload_receipts.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", "receipt_id", name="uq_b_project_materials_receipt"),
    )
    op.create_index(
        "ix_b_project_materials_project",
        "b_project_materials",
        ["project_id", "created_at"],
        unique=False,
    )
    op.create_table(
        "b_project_schedules",
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("project_id"),
    )
    op.create_index(
        "uq_projects_group",
        "projects",
        ["group_id"],
        unique=True,
        postgresql_where=sa.text("group_id IS NOT NULL"),
        sqlite_where=sa.text("group_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "uq_projects_group",
        table_name="projects",
        postgresql_where=sa.text("group_id IS NOT NULL"),
        sqlite_where=sa.text("group_id IS NOT NULL"),
    )
    op.drop_table("b_project_schedules")
    op.drop_index("ix_b_project_materials_project", table_name="b_project_materials")
    op.drop_table("b_project_materials")
    op.drop_table("b_project_drafts")
    op.drop_table("b_course_project_templates")
