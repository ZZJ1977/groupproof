"""C course governance and scoped access approval intent.

Revision ID: 0012
Revises: 0011
The canonical course code/semester constraint and B snapshots are unchanged.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def document():
    return sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def created():
    return sa.Column(
        "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
    )


def upgrade() -> None:
    op.create_table(
        "c_course_code_registry",
        sa.Column("code_key", sa.String(64), primary_key=True),
        sa.Column("course_id", sa.Uuid(), sa.ForeignKey("courses.id"), nullable=False, unique=True),
    )
    op.create_table(
        "c_course_invites",
        sa.Column("course_id", sa.Uuid(), sa.ForeignKey("courses.id"), primary_key=True),
        sa.Column("code", sa.String(128), nullable=False, unique=True),
        sa.Column("created_by", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        created(),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
    )
    op.create_table(
        "c_course_lifecycle_decisions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("course_id", sa.Uuid(), sa.ForeignKey("courses.id"), nullable=False),
        sa.Column("actor_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("version_no", sa.Integer(), nullable=False),
        sa.Column("action", sa.String(16), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("before_json", document(), nullable=False),
        sa.Column("after_json", document(), nullable=False),
        created(),
        sa.UniqueConstraint("course_id", "version_no", name="uq_c_course_lifecycle_version"),
        sa.CheckConstraint("version_no >= 0", name="ck_c_course_lifecycle_version"),
        sa.CheckConstraint(
            "action IN ('create', 'publish', 'end')", name="ck_c_course_lifecycle_action"
        ),
        sa.CheckConstraint("length(trim(reason)) > 0", name="ck_c_course_lifecycle_reason"),
    )
    op.create_index(
        "ix_c_course_lifecycle_decisions_course_id", "c_course_lifecycle_decisions", ["course_id"]
    )
    op.create_table(
        "c_access_requests",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("applicant_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("project_id", sa.Uuid(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("scope_json", document(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("requested_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", sa.String(16), server_default="pending", nullable=False),
        sa.Column("approved_expires_at", sa.DateTime(timezone=True)),
        sa.Column("authorization_receipt", document()),
        sa.Column("lock_version", sa.Integer(), server_default=sa.text("0"), nullable=False),
        created(),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'approved', 'rejected')", name="ck_c_access_status"
        ),
        sa.CheckConstraint("length(trim(reason)) > 0", name="ck_c_access_reason"),
        sa.CheckConstraint("lock_version >= 0", name="ck_c_access_version"),
        sa.CheckConstraint(
            "(status = 'approved' AND approved_expires_at IS NOT NULL "
            "AND authorization_receipt IS NOT NULL) OR (status <> 'approved' "
            "AND approved_expires_at IS NULL AND authorization_receipt IS NULL)",
            name="ck_c_access_activation",
        ),
    )
    op.create_index("ix_c_access_requests_applicant_id", "c_access_requests", ["applicant_id"])
    op.create_index("ix_c_access_requests_project_id", "c_access_requests", ["project_id"])
    op.create_table(
        "c_access_decisions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("request_id", sa.Uuid(), sa.ForeignKey("c_access_requests.id"), nullable=False),
        sa.Column("actor_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("version_no", sa.Integer(), nullable=False),
        sa.Column("decision", sa.String(16), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("before_json", document(), nullable=False),
        sa.Column("after_json", document(), nullable=False),
        created(),
        sa.UniqueConstraint("request_id", "version_no", name="uq_c_access_decision_version"),
        sa.CheckConstraint("version_no > 0", name="ck_c_access_decision_version"),
        sa.CheckConstraint(
            "decision IN ('approved', 'rejected')", name="ck_c_access_decision_kind"
        ),
        sa.CheckConstraint("length(trim(reason)) > 0", name="ck_c_access_decision_reason"),
    )
    op.create_index("ix_c_access_decisions_request_id", "c_access_decisions", ["request_id"])
    op.create_table(
        "c_governance_idempotency",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("actor_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("operation", sa.String(100), nullable=False),
        sa.Column("key", sa.String(128), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("response_json", document(), nullable=False),
        created(),
        sa.UniqueConstraint("actor_id", "operation", "key", name="uq_c_governance_request"),
    )
    op.create_table(
        "c_governance_outbox",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("aggregate_id", sa.Uuid(), nullable=False),
        sa.Column("event_type", sa.String(80), nullable=False),
        sa.Column("payload_json", document(), nullable=False),
        created(),
        sa.Column("delivered_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_c_governance_outbox_aggregate_id", "c_governance_outbox", ["aggregate_id"])


def downgrade() -> None:
    tables = (
        "c_governance_outbox",
        "c_governance_idempotency",
        "c_access_decisions",
        "c_access_requests",
        "c_course_lifecycle_decisions",
        "c_course_invites",
        "c_course_code_registry",
    )
    connection = op.get_bind()
    for table in tables:
        if connection.execute(sa.text(f"SELECT 1 FROM {table} LIMIT 1")).first() is not None:
            raise RuntimeError(
                "Cannot downgrade: preserve C governance decisions and invitations first"
            )
    for table in tables:
        op.drop_table(table)
