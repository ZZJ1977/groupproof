"""D acceptance storage and manual risk history.

Revision ID: 0014
Revises: 0013
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None
U = postgresql.UUID(as_uuid=True)
T = sa.DateTime(timezone=True)


def pk():
    return sa.Column("id", U, primary_key=True)


def fk(name, table, *, nullable=False):
    return sa.Column(name, U, sa.ForeignKey(f"{table}.id"), nullable=nullable)


def created(name="created_at"):
    return sa.Column(name, T, server_default=sa.func.now(), nullable=False)


def upgrade():
    op.create_table(
        "verification_runs",
        pk(),
        fk("project_id", "projects"),
        fk("task_id", "tasks"),
        fk("triggered_by", "users"),
        sa.Column("result", sa.String(32), nullable=False),
        sa.Column("confidence", sa.Numeric(5, 4)),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("engine_version", sa.String(80)),
        sa.Column("started_at", T, nullable=False),
        sa.Column("completed_at", T),
        created(),
    )
    op.create_index("ix_verification_runs_project_id", "verification_runs", ["project_id"])
    op.create_index("ix_verification_runs_task_id", "verification_runs", ["task_id"])
    op.create_table(
        "criterion_results",
        pk(),
        fk("verification_run_id", "verification_runs"),
        fk("criterion_id", "acceptance_criteria"),
        sa.Column("result", sa.String(32), nullable=False),
        sa.Column("confidence", sa.Numeric(5, 4)),
        sa.Column("reason", sa.Text, nullable=False),
        sa.Column("remediation", sa.Text),
        created(),
    )
    op.create_index(
        "ix_criterion_results_verification_run_id", "criterion_results", ["verification_run_id"]
    )
    op.create_table(
        "criterion_result_evidence",
        sa.Column(
            "criterion_result_id", U, sa.ForeignKey("criterion_results.id"), primary_key=True
        ),
        sa.Column("evidence_id", U, sa.ForeignKey("evidence.id"), primary_key=True),
    )
    op.create_table(
        "verification_confirmations",
        pk(),
        fk("criterion_result_id", "criterion_results"),
        fk("user_id", "users"),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("comment", sa.Text),
        created("confirmed_at"),
    )
    op.create_table(
        "verified_work",
        pk(),
        fk("project_id", "projects"),
        fk("task_id", "tasks"),
        fk("criterion_result_id", "criterion_results"),
        fk("user_id", "users"),
        fk("confirmation_id", "verification_confirmations"),
        sa.Column("accepted_weight", sa.Numeric(10, 3), nullable=False),
        created("accepted_at"),
    )
    op.create_table(
        "evidence_coverage_snapshots",
        pk(),
        fk("project_id", "projects"),
        fk("task_id", "tasks"),
        fk("checked_by", "users"),
        sa.Column("coverage_json", postgresql.JSONB, nullable=False),
        created("checked_at"),
    )
    op.create_table(
        "risks",
        pk(),
        fk("project_id", "projects"),
        fk("task_id", "tasks", nullable=True),
        fk("milestone_id", "milestones", nullable=True),
        fk("owner_id", "users"),
        sa.Column("title", sa.String(240), nullable=False),
        sa.Column("description", sa.Text, nullable=False),
        sa.Column("level", sa.String(16), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("due_at", T),
        created(),
        sa.Column("updated_at", T, server_default=sa.func.now(), nullable=False),
        sa.Column("lock_version", sa.Integer, server_default="0", nullable=False),
        sa.CheckConstraint("level IN ('low','medium','high')", name="ck_risks_level"),
        sa.CheckConstraint("status IN ('open','mitigating','closed')", name="ck_risks_status"),
        sa.CheckConstraint(
            "task_id IS NOT NULL OR milestone_id IS NOT NULL", name="ck_risks_target"
        ),
    )
    op.create_index("ix_risks_project_id", "risks", ["project_id"])
    op.create_table(
        "risk_events",
        pk(),
        fk("risk_id", "risks"),
        fk("actor_id", "users"),
        sa.Column("event_type", sa.String(16), nullable=False),
        sa.Column("note", sa.Text, nullable=False),
        created(),
    )
    op.create_index("ix_risk_events_risk_id", "risk_events", ["risk_id"])


def downgrade():
    for name in (
        "risk_events",
        "risks",
        "evidence_coverage_snapshots",
        "verified_work",
        "verification_confirmations",
        "criterion_result_evidence",
        "criterion_results",
        "verification_runs",
    ):
        op.drop_table(name)
