"""用户账户与注册审核模块：关联表模型（字段字典见 server/docs/DB_FIELD_DICTIONARY.md）。

原则：
- 用户申报字段（姓名/学号/学院等）与验证事实（邮箱验证、实名核验、教师审核）分表保存；
- RegistrationFacts 由当前事实派生，不落可随意写的 isRegistered/active 布尔；
- 唯一性由数据库约束兜底：规范用户名、Google 身份键、已验证规范学校邮箱。
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow() -> datetime:
    return datetime.utcnow()


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    # 申报字段（未提交注册可空；完整性由注册规则判断，不由 NOT NULL 保证）
    name: Mapped[str | None] = mapped_column(String(120))
    username: Mapped[str | None] = mapped_column(String(64))
    username_normalized: Mapped[str | None] = mapped_column(String(64), unique=True)
    student_id: Mapped[str | None] = mapped_column(String(64))
    college: Mapped[str | None] = mapped_column(String(120))
    requested_identity: Mapped[str | None] = mapped_column(String(16))  # student|teacher（申请意向，非正式角色）
    # 正式角色：服务端按流程授予（JSON 数组：student/teacher/ta/admin），禁止客户端写入
    roles: Mapped[list[str]] = mapped_column(JSON, default=list, server_default=text("'[]'::json"))
    account_status: Mapped[str] = mapped_column(String(16), default="enabled")  # enabled|disabled
    disabled_reason: Mapped[str | None] = mapped_column(Text)
    disabled_at: Mapped[datetime | None] = mapped_column(DateTime)
    preferred_locale: Mapped[str | None] = mapped_column(String(16))
    auth_version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)  # 乐观并发（expectedVersion）
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime)

    identities: Mapped[list["AuthIdentity"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    email_binding: Mapped["SchoolEmailBinding | None"] = relationship(back_populates="user", cascade="all, delete-orphan", uselist=False)


class AuthIdentity(Base):
    __tablename__ = "auth_identities"
    __table_args__ = (
        UniqueConstraint("provider", "issuer", "subject", name="uq_auth_identity_key"),
        Index("ix_auth_identities_user", "user_id"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    provider: Mapped[str] = mapped_column(String(32), nullable=False)  # google
    issuer: Mapped[str] = mapped_column(String(255), nullable=False)
    subject: Mapped[str] = mapped_column(String(255), nullable=False)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    google_email: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    last_authenticated_at: Mapped[datetime | None] = mapped_column(DateTime)

    user: Mapped[User] = relationship(back_populates="identities")


class SchoolEmailBinding(Base):
    __tablename__ = "school_email_bindings"
    __table_args__ = (
        # 已验证规范邮箱全局唯一；待验证地址（pending_*）不占用唯一名额
        UniqueConstraint("school_email_normalized", name="uq_school_email_verified"),
    )

    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    school_email: Mapped[str | None] = mapped_column(String(255))
    school_email_normalized: Mapped[str | None] = mapped_column(String(255))
    verified_at: Mapped[datetime | None] = mapped_column(DateTime)
    verification_method: Mapped[str | None] = mapped_column(String(32))  # email_code
    pending_school_email: Mapped[str | None] = mapped_column(String(255))
    pending_school_email_normalized: Mapped[str | None] = mapped_column(String(255))
    pending_requested_at: Mapped[datetime | None] = mapped_column(DateTime)
    change_authorized_until: Mapped[datetime | None] = mapped_column(DateTime)  # 旧邮箱确认签发的一次性换绑授权
    change_authorized_target: Mapped[str | None] = mapped_column(String(255))
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)

    user: Mapped[User] = relationship(back_populates="email_binding")


class AcademicIdentityCheck(Base):
    __tablename__ = "academic_identity_checks"
    __table_args__ = (Index("ix_academic_checks_user", "user_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    checked_fields: Mapped[list[str]] = mapped_column(JSON, default=list)  # 核验字段范围
    snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # 对应快照/版本
    method: Mapped[str] = mapped_column(String(32))  # school_sso|authorized_roster|documented_manual_review
    result: Mapped[str] = mapped_column(String(16))  # passed|failed
    evidence_ref: Mapped[str | None] = mapped_column(String(255))  # 受限证据引用，不含材料本体
    checked_by: Mapped[str | None] = mapped_column(String(64))
    checked_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    superseded_at: Mapped[datetime | None] = mapped_column(DateTime)  # 依赖字段变更后标记过时，保留历史


class Session(Base):
    __tablename__ = "sessions"
    __table_args__ = (Index("ix_sessions_user", "user_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    token_digest: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    csrf_token: Mapped[str] = mapped_column(String(128), nullable=False)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    scope: Mapped[str] = mapped_column(String(16), nullable=False)  # onboarding|full|status_only
    auth_method: Mapped[str | None] = mapped_column(String(16))  # password|google（会话层认证依据）
    credential_version: Mapped[int | None] = mapped_column(Integer)  # 密码会话绑定的凭据版本
    auth_version: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)  # 闲置期限（按 scope 滚动）
    absolute_expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime)
    revoke_reason: Mapped[str | None] = mapped_column(String(64))


class EmailChallenge(Base):
    __tablename__ = "email_challenges"
    __table_args__ = (
        Index("ix_email_challenges_user_purpose", "user_id", "purpose"),
        # 每个账户/用途最多一个可消费的当前挑战（部分唯一索引）
        Index(
            "uq_email_challenge_active",
            "user_id",
            "purpose",
            unique=True,
            postgresql_where=text("consumed_at IS NULL AND invalidated_at IS NULL"),
        ),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    email: Mapped[str] = mapped_column(String(255), nullable=False)
    email_normalized: Mapped[str] = mapped_column(String(255), nullable=False)
    purpose: Mapped[str] = mapped_column(String(32), nullable=False)  # school_email_verify|change_authorization|password_recovery|login_email_verification
    code_hmac: Mapped[str] = mapped_column(String(128), nullable=False)  # HMAC-SHA256（验证码或恢复令牌摘要）
    credential_version: Mapped[int | None] = mapped_column(Integer)  # 恢复凭据绑定的凭据版本
    change_target_email_normalized: Mapped[str | None] = mapped_column(String(255))  # 旧邮箱确认绑定的本次换绑目标
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime)
    invalidated_at: Mapped[datetime | None] = mapped_column(DateTime)
    send_status: Mapped[str] = mapped_column(String(16), default="accepted")  # accepted|failed
    resend_available_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class TeacherApplication(Base):
    __tablename__ = "teacher_applications"
    __table_args__ = (Index("ix_teacher_applications_user", "user_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    application_version: Mapped[int] = mapped_column(Integer, nullable=False)  # 提交时 users.version
    snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # 审核所依据资料快照
    status: Mapped[str] = mapped_column(String(16), nullable=False)  # pending|approved|rejected
    reviewer_id: Mapped[str | None] = mapped_column(String(64))
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime)
    reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class AuthAuditEvent(Base):
    __tablename__ = "auth_audit_events"
    __table_args__ = (Index("ix_auth_audit_target", "target_user_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    actor_id: Mapped[str | None] = mapped_column(String(64))
    target_user_id: Mapped[str | None] = mapped_column(String(64))
    request_id: Mapped[str | None] = mapped_column(String(64))
    result: Mapped[str] = mapped_column(String(16), nullable=False)  # success|failure
    changed_fields: Mapped[list[str]] = mapped_column(JSON, default=list)  # 只记录字段名
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class RateLimitCounter(Base):
    """跨进程一致的限流计数（数据库事务实现，暂不引入 Redis）。"""

    __tablename__ = "auth_rate_limits"
    __table_args__ = (UniqueConstraint("bucket_key", "window_start", name="uq_rate_bucket"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    bucket_key: Mapped[str] = mapped_column(String(255), nullable=False)
    window_start: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class OAuthTransaction(Base):
    """Google OIDC 事务：绑定浏览器的 state/nonce/PKCE，一次性 + 超时（§6.2）。"""

    __tablename__ = "oauth_transactions"

    state_digest: Mapped[str] = mapped_column(String(128), primary_key=True)
    nonce: Mapped[str] = mapped_column(String(128), nullable=False)
    code_verifier: Mapped[str] = mapped_column(String(128), nullable=False)
    return_to: Mapped[str | None] = mapped_column(String(512))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime)


class PasswordCredential(Base):
    """账号密码凭据（与 Google 身份分开管理；只存密码哈希，不存明文）。

    登录标识：users.username_normalized（用户名）或本表 login_email_normalized（邮箱）。
    login_email_verified_at 为空表示历史/未验证登录邮箱（不得借此取得 full 业务会话，也不可用于找回密码）。
    """

    __tablename__ = "password_credentials"

    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    login_email: Mapped[str] = mapped_column(String(255), nullable=False)
    login_email_normalized: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    login_email_verified_at: Mapped[datetime | None] = mapped_column(DateTime)  # 登录邮箱归属验证时间（历史行保持空）
    verification_evidence_ref: Mapped[str | None] = mapped_column(String(255))  # 验证依据引用（注册前事务 ID 等）
    credential_version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)  # 恢复/改密绑定版本
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)  # argon2id/bcrypt；绝不存明文
    password_algo: Mapped[str] = mapped_column(String(32), default="argon2id", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    password_changed_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)

    user: Mapped[User] = relationship()


class PreRegistrationRequest(Base):
    """注册前验证事务（§邮箱方案）：先证明登录邮箱归属，再一次性建档。

    验证码与建档资格均限时、一次性、绑定浏览器事务；不依赖 users 外键，
    验证前不创建永久密码账户、不占用用户名。"""

    __tablename__ = "pre_registration_requests"
    __table_args__ = (
        Index("ix_pre_registration_email", "email_normalized"),
        Index("uq_pre_registration_grant", "creation_grant_digest", unique=True),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # 高熵事务 ID
    email: Mapped[str] = mapped_column(String(255), nullable=False)
    email_normalized: Mapped[str] = mapped_column(String(255), nullable=False)
    locale: Mapped[str | None] = mapped_column(String(16))
    browser_token_digest: Mapped[str] = mapped_column(String(128), nullable=False)  # 浏览器绑定 Cookie 摘要
    code_hmac: Mapped[str | None] = mapped_column(String(128))
    generation: Mapped[int] = mapped_column(Integer, default=1, nullable=False)  # 重发递增，旧码失效
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    send_status: Mapped[str] = mapped_column(String(16), default="pending")  # pending|accepted|failed|unknown
    resend_available_at: Mapped[datetime | None] = mapped_column(DateTime)
    code_consumed_at: Mapped[datetime | None] = mapped_column(DateTime)
    creation_grant_digest: Mapped[str | None] = mapped_column(String(128))  # 建档资格摘要（≥256 位随机，只存摘要）
    creation_grant_expires_at: Mapped[datetime | None] = mapped_column(DateTime)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime)
    result_user_id: Mapped[str | None] = mapped_column(String(64))
    invalidated_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class EmailOutbox(Base):
    """邮件捕获（仅 APP_MODE != real 的隔离开发/测试环境使用）。

    capture 模式下保存投递请求内容供测试读取；smtp 模式不写入本表，避免验证码进入日志/存储。
    """

    __tablename__ = "email_outbox"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    to_email: Mapped[str] = mapped_column(String(255), nullable=False)
    subject: Mapped[str] = mapped_column(String(255), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
