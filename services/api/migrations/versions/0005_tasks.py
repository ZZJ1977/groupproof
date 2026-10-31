"""Create tasks, task links, acceptance criteria, and progress events.

Revision ID: 0005
Revises: 0004
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None

UUID = postgresql.UUID(as_uuid=True)
TIMESTAMPTZ = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "tasks",
        sa.Column("id", UUID, server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("project_id", UUID, nullable=False),
        sa.Column("module_id", UUID, nullable=False),
        sa.Column("parent_task_id", UUID, nullable=True),
        sa.Column("created_by", UUID, nullable=True),
        sa.Column("title", sa.String(240), nullable=False),
        sa.Column("description", sa.Text, nullable=True),
        sa.Column("priority", sa.String(16), server_default="medium", nullable=False),
        sa.Column("weight", sa.Numeric(8, 3), server_default=sa.text("1"), nullable=False),
        sa.Column("status", sa.String(32), server_default="not_started", nullable=False),
        sa.Column("progress_percent", sa.SmallInteger, server_default=sa.text("0"), nullable=False),
        sa.Column("started_at", TIMESTAMPTZ, nullable=True),
        sa.Column("completed_at", TIMESTAMPTZ, nullable=True),
        sa.Column(
            "created_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.Column(
            "updated_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.Column("lock_version", sa.Integer, server_default=sa.text("0"), nullable=False),
        sa.CheckConstraint("priority IN ('high', 'medium', 'low')", name="ck_tasks_priority"),
        sa.CheckConstraint(
            "status IN ('not_started', 'in_progress', 'pending_submission', "
            "'pending_verification', 'completed')",
            name="ck_tasks_status",
        ),
        sa.CheckConstraint("weight > 0", name="ck_tasks_weight"),
        sa.CheckConstraint("progress_percent BETWEEN 0 AND 100", name="ck_tasks_progress"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["module_id"], ["functional_modules.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["parent_task_id"], ["tasks.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_tasks_project_id", "tasks", ["project_id"])
    op.create_index("ix_tasks_module_id", "tasks", ["module_id"])
    op.create_index("ix_tasks_parent_task_id", "tasks", ["parent_task_id"])
    op.create_index("ix_tasks_status", "tasks", ["status"])

    op.create_table(
        "task_requirements",
        sa.Column("task_id", UUID, nullable=False),
        sa.Column("requirement_id", UUID, nullable=False),
        sa.Column("relation_type", sa.String(32), server_default="implements", nullable=False),
        sa.ForeignKeyConstraint(["requirement_id"], ["requirements.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("task_id", "requirement_id"),
    )
    op.create_index("ix_task_requirements_requirement_id", "task_requirements", ["requirement_id"])

    op.create_table(
        "task_assignees",
        sa.Column("task_id", UUID, nullable=False),
        sa.Column("user_id", UUID, nullable=False),
        sa.Column("role", sa.String(32), server_default="responsible", nullable=False),
        sa.Column(
            "assigned_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.Column("unassigned_at", TIMESTAMPTZ, nullable=True),
        sa.CheckConstraint("role IN ('responsible', 'reviewer')", name="ck_task_assignees_role"),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("task_id", "user_id"),
    )
    op.create_index("ix_task_assignees_user_id", "task_assignees", ["user_id"])

    op.create_table(
        "task_dependencies",
        sa.Column("task_id", UUID, nullable=False),
        sa.Column("depends_on_task_id", UUID, nullable=False),
        sa.Column("dependency_type", sa.String(32), server_default="blocks", nullable=False),
        sa.Column(
            "created_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.CheckConstraint("task_id <> depends_on_task_id", name="ck_task_dependencies_distinct"),
        sa.ForeignKeyConstraint(["depends_on_task_id"], ["tasks.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("task_id", "depends_on_task_id"),
    )
    op.create_index("ix_task_dependencies_depends_on", "task_dependencies", ["depends_on_task_id"])

    op.create_table(
        "acceptance_criteria",
        sa.Column("id", UUID, server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("task_id", UUID, nullable=False),
        sa.Column("criterion_key", sa.String(64), nullable=False),
        sa.Column("text", sa.Text, nullable=False),
        sa.Column("weight", sa.Numeric(8, 3), server_default=sa.text("1"), nullable=False),
        sa.Column("sort_order", sa.Integer, server_default=sa.text("0"), nullable=False),
        sa.Column(
            "created_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.Column(
            "updated_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.Column("lock_version", sa.Integer, server_default=sa.text("0"), nullable=False),
        sa.CheckConstraint("weight > 0", name="ck_acceptance_criteria_weight"),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("task_id", "criterion_key", name="uq_acceptance_criteria_task_key"),
    )
    op.create_index("ix_acceptance_criteria_task_id", "acceptance_criteria", ["task_id"])

    op.create_table(
        "task_milestones",
        sa.Column("task_id", UUID, nullable=False),
        sa.Column("milestone_id", UUID, nullable=False),
        sa.ForeignKeyConstraint(["milestone_id"], ["milestones.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("task_id", "milestone_id"),
    )
    op.create_index("ix_task_milestones_milestone_id", "task_milestones", ["milestone_id"])

    op.create_table(
        "progress_events",
        sa.Column("id", UUID, server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("project_id", UUID, nullable=False),
        sa.Column("task_id", UUID, nullable=False),
        sa.Column("actor_id", UUID, nullable=False),
        sa.Column("from_status", sa.String(32), nullable=True),
        sa.Column("to_status", sa.String(32), nullable=True),
        sa.Column("progress_before", sa.SmallInteger, nullable=True),
        sa.Column("progress_after", sa.SmallInteger, nullable=True),
        sa.Column("reason", sa.Text, nullable=True),
        sa.Column(
            "created_at", TIMESTAMPTZ, server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False
        ),
        sa.CheckConstraint(
            "progress_before IS NULL OR progress_before BETWEEN 0 AND 100",
            name="ck_progress_events_before",
        ),
        sa.CheckConstraint(
            "progress_after IS NULL OR progress_after BETWEEN 0 AND 100",
            name="ck_progress_events_after",
        ),
        sa.ForeignKeyConstraint(["actor_id"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_progress_events_project_id", "progress_events", ["project_id"])
    op.create_index("ix_progress_events_task_id", "progress_events", ["task_id"])


def downgrade() -> None:
    op.drop_index("ix_progress_events_task_id", table_name="progress_events")
    op.drop_index("ix_progress_events_project_id", table_name="progress_events")
    op.drop_table("progress_events")
    op.drop_index("ix_task_milestones_milestone_id", table_name="task_milestones")
    op.drop_table("task_milestones")
    op.drop_index("ix_acceptance_criteria_task_id", table_name="acceptance_criteria")
    op.drop_table("acceptance_criteria")
    op.drop_index("ix_task_dependencies_depends_on", table_name="task_dependencies")
    op.drop_table("task_dependencies")
    op.drop_index("ix_task_assignees_user_id", table_name="task_assignees")
    op.drop_table("task_assignees")
    op.drop_index("ix_task_requirements_requirement_id", table_name="task_requirements")
    op.drop_table("task_requirements")
    op.drop_index("ix_tasks_status", table_name="tasks")
    op.drop_index("ix_tasks_parent_task_id", table_name="tasks")
    op.drop_index("ix_tasks_module_id", table_name="tasks")
    op.drop_index("ix_tasks_project_id", table_name="tasks")
    op.drop_table("tasks")
