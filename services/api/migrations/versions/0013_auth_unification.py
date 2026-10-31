"""Unify authentication onto the team API (PLAN: unified auth backend + Resend).

Revision ID: 0013
Revises: 0012

- users 摄取认证资料字段（申报字段在注册完成前可空，完整性由注册规则判断）。
- 认证附属表（原独立 server/ 迁移 0001–0004 的结构）进入团队迁移链，user_id 统一引用 users(id)。
- 会话表使用 auth_sessions，避免与团队 sessions（OAuth 连接）冲突。
- auth_legacy_id_map 保存本地旧 ID → 团队 UUID 的持久化映射（导入工具使用）。
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None

UUID = postgresql.UUID(as_uuid=True)
TIMESTAMPTZ = sa.DateTime(timezone=True)


def created():
    return sa.Column(
        "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
    )


def upgrade() -> None:
    # --- users：认证资料字段（申报字段可空；完整性由注册规则判断，不由 NOT NULL 保证）---
    op.add_column("users", sa.Column("username_normalized", sa.String(80), nullable=True))
    op.create_unique_constraint("uq_users_username_normalized", "users", ["username_normalized"])
    op.add_column("users", sa.Column("requested_identity", sa.String(16), nullable=True))
    op.add_column("users", sa.Column("preferred_locale", sa.String(16), nullable=True))
    op.add_column(
        "users",
        sa.Column("auth_version", sa.Integer, server_default=sa.text("1"), nullable=False),
    )
    op.add_column("users", sa.Column("last_login_at", TIMESTAMPTZ, nullable=True))
    op.add_column("users", sa.Column("disabled_reason", sa.Text, nullable=True))
    op.add_column("users", sa.Column("disabled_at", TIMESTAMPTZ, nullable=True))
    op.alter_column("users", "name", nullable=True)
    op.alter_column("users", "username", nullable=True)
    op.alter_column("users", "email", nullable=True)
    op.alter_column("users", "college", nullable=True)

    # --- Google 身份（历史数据保留；本轮 Google 登录关闭）---
    op.create_table(
        "auth_identities",
        sa.Column("id", sa.String(64), nullable=False),
        sa.Column("provider", sa.String(32), nullable=False),
        sa.Column("issuer", sa.String(255), nullable=False),
        sa.Column("subject", sa.String(255), nullable=False),
        sa.Column("user_id", UUID, nullable=False),
        sa.Column("google_email", sa.String(255), nullable=True),
        created(),
        sa.Column("last_authenticated_at", TIMESTAMPTZ, nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("provider", "issuer", "subject", name="uq_auth_identity_key"),
    )
    op.create_index("ix_auth_identities_user", "auth_identities", ["user_id"])

    # --- 学校邮箱绑定（登录邮箱与学校邮箱分别保存和验证）---
    op.create_table(
        "school_email_bindings",
        sa.Column("user_id", UUID, nullable=False),
        sa.Column("school_email", sa.String(255), nullable=True),
        sa.Column("school_email_normalized", sa.String(255), nullable=True),
        sa.Column("verified_at", TIMESTAMPTZ, nullable=True),
        sa.Column("verification_method", sa.String(32), nullable=True),
        sa.Column("pending_school_email", sa.String(255), nullable=True),
        sa.Column("pending_school_email_normalized", sa.String(255), nullable=True),
        sa.Column("pending_requested_at", TIMESTAMPTZ, nullable=True),
        sa.Column("change_authorized_until", TIMESTAMPTZ, nullable=True),
        sa.Column("change_authorized_target", sa.String(255), nullable=True),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id"),
        sa.UniqueConstraint("school_email_normalized", name="uq_school_email_verified"),
    )

    # --- 学籍核验记录（保留审核历史）---
    op.create_table(
        "academic_identity_checks",
        sa.Column("id", sa.String(64), nullable=False),
        sa.Column("user_id", UUID, nullable=False),
        sa.Column("checked_fields", sa.JSON, nullable=True),
        sa.Column("snapshot", sa.JSON, nullable=True),
        sa.Column("method", sa.String(32), nullable=True),
        sa.Column("result", sa.String(16), nullable=True),
        sa.Column("evidence_ref", sa.String(255), nullable=True),
        sa.Column("checked_by", sa.String(64), nullable=True),
        sa.Column(
            "checked_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("superseded_at", TIMESTAMPTZ, nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_academic_checks_user", "academic_identity_checks", ["user_id"])

    # --- 可撤销会话 ---
    op.create_table(
        "auth_sessions",
        sa.Column("id", sa.String(64), nullable=False),
        sa.Column("token_digest", sa.String(128), nullable=False),
        sa.Column("csrf_token", sa.String(128), nullable=False),
        sa.Column("user_id", UUID, nullable=False),
        sa.Column("scope", sa.String(16), nullable=False),
        sa.Column("auth_method", sa.String(16), nullable=True),
        sa.Column("credential_version", sa.Integer, nullable=True),
        sa.Column("auth_version", sa.Integer, nullable=False),
        created(),
        sa.Column(
            "last_seen_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("expires_at", TIMESTAMPTZ, nullable=False),
        sa.Column("absolute_expires_at", TIMESTAMPTZ, nullable=False),
        sa.Column("revoked_at", TIMESTAMPTZ, nullable=True),
        sa.Column("revoke_reason", sa.String(64), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token_digest", name="uq_auth_sessions_token_digest"),
    )
    op.create_index("ix_auth_sessions_user", "auth_sessions", ["user_id"])

    # --- 邮箱验证码挑战 ---
    op.create_table(
        "email_challenges",
        sa.Column("id", sa.String(64), nullable=False),
        sa.Column("user_id", UUID, nullable=False),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("email_normalized", sa.String(255), nullable=False),
        sa.Column("purpose", sa.String(32), nullable=False),
        sa.Column("code_hmac", sa.String(128), nullable=False),
        sa.Column("credential_version", sa.Integer, nullable=True),
        sa.Column("change_target_email_normalized", sa.String(255), nullable=True),
        sa.Column("expires_at", TIMESTAMPTZ, nullable=False),
        sa.Column("attempts", sa.Integer, server_default=sa.text("0"), nullable=False),
        sa.Column("consumed_at", TIMESTAMPTZ, nullable=True),
        sa.Column("invalidated_at", TIMESTAMPTZ, nullable=True),
        sa.Column(
            "send_status", sa.String(16), server_default=sa.text("'accepted'"), nullable=False
        ),
        sa.Column("resend_available_at", TIMESTAMPTZ, nullable=False),
        created(),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_email_challenges_user_purpose", "email_challenges", ["user_id", "purpose"])
    op.create_index(
        "uq_email_challenge_active",
        "email_challenges",
        ["user_id", "purpose"],
        unique=True,
        postgresql_where=sa.text("consumed_at IS NULL AND invalidated_at IS NULL"),
    )

    # --- 教师审核（保留审核历史）---
    op.create_table(
        "teacher_applications",
        sa.Column("id", sa.String(64), nullable=False),
        sa.Column("user_id", UUID, nullable=False),
        sa.Column("application_version", sa.Integer, nullable=False),
        sa.Column("snapshot", sa.JSON, nullable=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("reviewer_id", UUID, nullable=True),
        sa.Column("reviewed_at", TIMESTAMPTZ, nullable=True),
        sa.Column("reason", sa.Text, nullable=True),
        created(),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_teacher_applications_user", "teacher_applications", ["user_id", "created_at"]
    )

    # --- 认证审计（只记录字段名，不记录验证码/令牌）---
    op.create_table(
        "auth_audit_events",
        sa.Column("id", sa.String(64), nullable=False),
        sa.Column("event_type", sa.String(64), nullable=False),
        sa.Column("actor_id", sa.String(64), nullable=True),
        sa.Column("target_user_id", sa.String(64), nullable=True),
        sa.Column("request_id", sa.String(64), nullable=True),
        sa.Column("result", sa.String(16), nullable=False),
        sa.Column("changed_fields", sa.JSON, nullable=True),
        created(),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_auth_audit_target", "auth_audit_events", ["target_user_id", "created_at"])

    # --- 限流计数 ---
    op.create_table(
        "auth_rate_limits",
        sa.Column("id", sa.Integer, autoincrement=True, nullable=False),
        sa.Column("bucket_key", sa.String(255), nullable=False),
        sa.Column("window_start", TIMESTAMPTZ, nullable=False),
        sa.Column("count", sa.Integer, server_default=sa.text("0"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("bucket_key", "window_start", name="uq_rate_bucket"),
    )

    # --- OAuth 事务（本轮 Google 登录关闭，结构保留）---
    op.create_table(
        "oauth_transactions",
        sa.Column("state_digest", sa.String(128), nullable=False),
        sa.Column("nonce", sa.String(128), nullable=False),
        sa.Column("code_verifier", sa.String(128), nullable=False),
        sa.Column("return_to", sa.String(512), nullable=True),
        created(),
        sa.Column("expires_at", TIMESTAMPTZ, nullable=False),
        sa.Column("consumed_at", TIMESTAMPTZ, nullable=True),
        sa.PrimaryKeyConstraint("state_digest"),
    )

    # --- 密码凭据（只存哈希；登录邮箱与学校邮箱分开验证）---
    op.create_table(
        "password_credentials",
        sa.Column("user_id", UUID, nullable=False),
        sa.Column("login_email", sa.String(255), nullable=False),
        sa.Column("login_email_normalized", sa.String(255), nullable=False),
        sa.Column("login_email_verified_at", TIMESTAMPTZ, nullable=True),
        sa.Column("verification_evidence_ref", sa.String(255), nullable=True),
        sa.Column("credential_version", sa.Integer, server_default=sa.text("1"), nullable=False),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column(
            "password_algo", sa.String(32), server_default=sa.text("'argon2id'"), nullable=False
        ),
        created(),
        sa.Column(
            "password_changed_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id"),
        sa.UniqueConstraint("login_email_normalized", name="uq_password_credentials_login_email"),
    )

    # --- 注册前验证事务 ---
    op.create_table(
        "pre_registration_requests",
        sa.Column("id", sa.String(64), nullable=False),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("email_normalized", sa.String(255), nullable=False),
        sa.Column("locale", sa.String(16), nullable=True),
        sa.Column("browser_token_digest", sa.String(128), nullable=False),
        sa.Column("code_hmac", sa.String(128), nullable=True),
        sa.Column("generation", sa.Integer, server_default=sa.text("1"), nullable=False),
        sa.Column("expires_at", TIMESTAMPTZ, nullable=False),
        sa.Column("attempts", sa.Integer, server_default=sa.text("0"), nullable=False),
        sa.Column(
            "send_status", sa.String(16), server_default=sa.text("'pending'"), nullable=False
        ),
        sa.Column("resend_available_at", TIMESTAMPTZ, nullable=True),
        sa.Column("code_consumed_at", TIMESTAMPTZ, nullable=True),
        sa.Column("creation_grant_digest", sa.String(128), nullable=True),
        sa.Column("creation_grant_expires_at", TIMESTAMPTZ, nullable=True),
        sa.Column("completed_at", TIMESTAMPTZ, nullable=True),
        sa.Column("result_user_id", UUID, nullable=True),
        sa.Column("invalidated_at", TIMESTAMPTZ, nullable=True),
        created(),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_pre_registration_email", "pre_registration_requests", ["email_normalized"])
    op.create_index(
        "uq_pre_registration_grant",
        "pre_registration_requests",
        ["creation_grant_digest"],
        unique=True,
    )

    # --- 邮件捕获（仅隔离开发/测试环境）---
    op.create_table(
        "email_outbox",
        sa.Column("id", sa.Integer, autoincrement=True, nullable=False),
        sa.Column("to_email", sa.String(255), nullable=False),
        sa.Column("subject", sa.String(255), nullable=False),
        sa.Column("body", sa.Text, nullable=False),
        created(),
        sa.PrimaryKeyConstraint("id"),
    )

    # --- 本地旧 ID → 团队 UUID 持久化映射（导入工具幂等重跑）---
    op.create_table(
        "auth_legacy_id_map",
        sa.Column("id", sa.Integer, autoincrement=True, nullable=False),
        sa.Column("source", sa.String(64), nullable=False),
        sa.Column("legacy_id", sa.String(64), nullable=False),
        sa.Column("user_id", UUID, nullable=False),
        created(),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("source", "legacy_id", name="uq_auth_legacy_id"),
    )
    op.create_index("ix_auth_legacy_user", "auth_legacy_id_map", ["user_id"])


def downgrade() -> None:
    op.drop_table("auth_legacy_id_map")
    op.drop_table("email_outbox")
    op.drop_table("pre_registration_requests")
    op.drop_table("password_credentials")
    op.drop_table("oauth_transactions")
    op.drop_table("auth_rate_limits")
    op.drop_table("auth_audit_events")
    op.drop_table("teacher_applications")
    op.drop_table("email_challenges")
    op.drop_table("auth_sessions")
    op.drop_table("academic_identity_checks")
    op.drop_table("school_email_bindings")
    op.drop_table("auth_identities")
    op.drop_column("users", "disabled_at")
    op.drop_column("users", "disabled_reason")
    op.drop_column("users", "last_login_at")
    op.drop_column("users", "auth_version")
    op.drop_column("users", "preferred_locale")
    op.drop_column("users", "requested_identity")
    op.drop_constraint("uq_users_username_normalized", "users", type_="unique")
    op.drop_column("users", "username_normalized")
    op.alter_column("users", "college", nullable=False)
    op.alter_column("users", "email", nullable=False)
    op.alter_column("users", "username", nullable=False)
    op.alter_column("users", "name", nullable=False)
