"""D6 teacher comments, versioned rules, acknowledgements, and grade basis.

Revision ID: 0031
Revises: 0030
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0031"
down_revision = "0030"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "course_rule_versions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("course_id", sa.Uuid(), sa.ForeignKey("courses.id"), nullable=False),
        sa.Column("version_no", sa.Integer(), nullable=False),
        sa.Column("actor_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("rules", JSONB(), nullable=False),
        sa.Column("effective_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint("course_id", "version_no"),
    )
    op.create_index("ix_course_rule_versions_course_id", "course_rule_versions", ["course_id"])
    op.create_table(
        "course_rule_confirmations",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "version_id", sa.Uuid(), sa.ForeignKey("course_rule_versions.id"), nullable=False
        ),
        sa.Column("project_id", sa.Uuid(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("actor_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column(
            "confirmed_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint("version_id", "project_id"),
    )
    op.create_index(
        "ix_course_rule_confirmations_version_id", "course_rule_confirmations", ["version_id"]
    )
    op.create_table(
        "teacher_report_comments",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("project_id", sa.Uuid(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("snapshot_id", sa.Uuid(), sa.ForeignKey("report_snapshots.id"), nullable=False),
        sa.Column("actor_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index(
        "ix_teacher_report_comments_project_id", "teacher_report_comments", ["project_id"]
    )
    op.create_table(
        "course_grades",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("course_id", sa.Uuid(), sa.ForeignKey("courses.id"), nullable=False),
        sa.Column("project_id", sa.Uuid(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column(
            "report_snapshot_id", sa.Uuid(), sa.ForeignKey("report_snapshots.id"), nullable=False
        ),
        sa.Column(
            "contribution_archive_id",
            sa.Uuid(),
            sa.ForeignKey("contribution_archives.id"),
            nullable=False,
        ),
        sa.Column("actor_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("score", sa.Numeric(5, 2), nullable=False),
        sa.Column("comment", sa.Text(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint("score >= 0 AND score <= 100"),
    )
    op.create_index("ix_course_grades_course_id", "course_grades", ["course_id"])
    op.create_index("ix_course_grades_project_id", "course_grades", ["project_id"])


def downgrade() -> None:
    op.drop_index("ix_course_grades_project_id", table_name="course_grades")
    op.drop_index("ix_course_grades_course_id", table_name="course_grades")
    op.drop_table("course_grades")
    op.drop_index("ix_teacher_report_comments_project_id", table_name="teacher_report_comments")
    op.drop_table("teacher_report_comments")
    op.drop_index("ix_course_rule_confirmations_version_id", table_name="course_rule_confirmations")
    op.drop_table("course_rule_confirmations")
    op.drop_index("ix_course_rule_versions_course_id", table_name="course_rule_versions")
    op.drop_table("course_rule_versions")
