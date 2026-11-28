"""Support code-discovered supplemental tasks and tiered amendment approvals.

Revision ID: 0048
Revises: 0047
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0048"
down_revision: str | None = "0047"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def document() -> sa.types.TypeEngine:
    return sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    # 1. Extend b_task_meta with ai_code origin and discovery provenance metadata.
    op.drop_constraint("ck_b_task_meta_origin", "b_task_meta", type_="check")
    op.create_check_constraint(
        "ck_b_task_meta_origin",
        "b_task_meta",
        "origin IN ('manual', 'ai', 'ai_code')",
    )
    op.add_column("b_task_meta", sa.Column("discovered_from_json", document(), nullable=True))

    # 2. Extend b_task_suggestions for code-driven incremental discovery & approvals.
    op.alter_column(
        "b_task_suggestions",
        "requirement_id",
        existing_type=sa.Uuid(),
        nullable=True,
    )
    op.add_column(
        "b_task_suggestions",
        sa.Column(
            "source_type",
            sa.String(length=24),
            nullable=False,
            server_default=sa.text("'requirement'"),
        ),
    )
    op.add_column(
        "b_task_suggestions",
        sa.Column(
            "action_type",
            sa.String(length=24),
            nullable=False,
            server_default=sa.text("'new_top_level'"),
        ),
    )
    op.add_column(
        "b_task_suggestions",
        sa.Column("target_task_id", sa.Uuid(), nullable=True),
    )
    op.add_column(
        "b_task_suggestions",
        sa.Column("suggested_module_id", sa.Uuid(), nullable=True),
    )
    op.add_column(
        "b_task_suggestions",
        sa.Column("suggested_parent_task_id", sa.Uuid(), nullable=True),
    )
    op.add_column(
        "b_task_suggestions",
        sa.Column("suggested_assignee_ids_json", document(), nullable=True),
    )
    op.add_column(
        "b_task_suggestions",
        sa.Column("suggested_weight", sa.Integer(), nullable=True),
    )
    op.add_column(
        "b_task_suggestions",
        sa.Column("source_refs_json", document(), nullable=True),
    )
    op.add_column(
        "b_task_suggestions",
        sa.Column(
            "approval_status",
            sa.String(length=24),
            nullable=False,
            server_default=sa.text("'none'"),
        ),
    )
    op.add_column(
        "b_task_suggestions",
        sa.Column("proposed_by", sa.Uuid(), nullable=True),
    )
    op.add_column(
        "b_task_suggestions",
        sa.Column("proposed_payload_json", document(), nullable=True),
    )
    op.add_column(
        "b_task_suggestions",
        sa.Column("approvals_json", document(), nullable=True),
    )
    op.add_column(
        "b_task_suggestions",
        sa.Column("approved_by", sa.Uuid(), nullable=True),
    )
    op.add_column(
        "b_task_suggestions",
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
    )

    op.create_foreign_key(
        "fk_b_task_suggestions_target_task_id",
        "b_task_suggestions",
        "tasks",
        ["target_task_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        "fk_b_task_suggestions_suggested_module_id",
        "b_task_suggestions",
        "functional_modules",
        ["suggested_module_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        "fk_b_task_suggestions_suggested_parent_task_id",
        "b_task_suggestions",
        "tasks",
        ["suggested_parent_task_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        "fk_b_task_suggestions_proposed_by",
        "b_task_suggestions",
        "users",
        ["proposed_by"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        "fk_b_task_suggestions_approved_by",
        "b_task_suggestions",
        "users",
        ["approved_by"],
        ["id"],
        ondelete="SET NULL",
    )

    op.create_check_constraint(
        "ck_b_task_suggestions_source_type",
        "b_task_suggestions",
        "source_type IN ('requirement', 'github_code')",
    )
    op.create_check_constraint(
        "ck_b_task_suggestions_action_type",
        "b_task_suggestions",
        "action_type IN ('merge_existing', 'new_subtask', 'new_top_level')",
    )
    op.create_check_constraint(
        "ck_b_task_suggestions_approval_status",
        "b_task_suggestions",
        "approval_status IN ('none', 'pending_approval', 'approved', 'rejected')",
    )
    op.create_index(
        "ix_b_task_suggestions_project_source_status",
        "b_task_suggestions",
        ["project_id", "source_type", "status"],
    )


def downgrade() -> None:
    op.drop_index("ix_b_task_suggestions_project_source_status", table_name="b_task_suggestions")
    op.drop_constraint("ck_b_task_suggestions_approval_status", "b_task_suggestions", type_="check")
    op.drop_constraint("ck_b_task_suggestions_action_type", "b_task_suggestions", type_="check")
    op.drop_constraint("ck_b_task_suggestions_source_type", "b_task_suggestions", type_="check")

    op.drop_constraint(
        "fk_b_task_suggestions_approved_by", "b_task_suggestions", type_="foreignkey"
    )
    op.drop_constraint(
        "fk_b_task_suggestions_proposed_by", "b_task_suggestions", type_="foreignkey"
    )
    op.drop_constraint(
        "fk_b_task_suggestions_suggested_parent_task_id",
        "b_task_suggestions",
        type_="foreignkey",
    )
    op.drop_constraint(
        "fk_b_task_suggestions_suggested_module_id",
        "b_task_suggestions",
        type_="foreignkey",
    )
    op.drop_constraint(
        "fk_b_task_suggestions_target_task_id", "b_task_suggestions", type_="foreignkey"
    )

    op.drop_column("b_task_suggestions", "approved_at")
    op.drop_column("b_task_suggestions", "approved_by")
    op.drop_column("b_task_suggestions", "approvals_json")
    op.drop_column("b_task_suggestions", "proposed_payload_json")
    op.drop_column("b_task_suggestions", "proposed_by")
    op.drop_column("b_task_suggestions", "approval_status")
    op.drop_column("b_task_suggestions", "source_refs_json")
    op.drop_column("b_task_suggestions", "suggested_weight")
    op.drop_column("b_task_suggestions", "suggested_assignee_ids_json")
    op.drop_column("b_task_suggestions", "suggested_parent_task_id")
    op.drop_column("b_task_suggestions", "suggested_module_id")
    op.drop_column("b_task_suggestions", "target_task_id")
    op.drop_column("b_task_suggestions", "action_type")
    op.drop_column("b_task_suggestions", "source_type")

    op.execute(sa.text("DELETE FROM b_task_suggestions WHERE requirement_id IS NULL"))
    op.alter_column(
        "b_task_suggestions",
        "requirement_id",
        existing_type=sa.Uuid(),
        nullable=False,
    )

    op.drop_column("b_task_meta", "discovered_from_json")
    op.execute(sa.text("UPDATE b_task_meta SET origin = 'ai' WHERE origin = 'ai_code'"))
    op.drop_constraint("ck_b_task_meta_origin", "b_task_meta", type_="check")
    op.create_check_constraint(
        "ck_b_task_meta_origin",
        "b_task_meta",
        "origin IN ('manual', 'ai')",
    )
