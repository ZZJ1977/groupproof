"""认证附属表模型（自独立 server/app/models.py 迁移）。

字段字典见 server/docs/DB_FIELD_DICTIONARY.md。

原则（保持不变）：
- 用户申报字段（姓名/学号/学院等）与验证事实（邮箱验证、实名核验、教师审核）分表保存；
- RegistrationFacts 由当前事实派生，不落可随意写的 isRegistered/active 布尔；
- 唯一性由数据库约束兜底：规范用户名、Google 身份键、已验证规范学校邮箱。

统一身份（PLAN 二、2）：
- 用户主表为团队 app.db.models.users（UUID 主键）；本模块所有 user_id 外键指向该表。
- 独立 server/ 的 users.id（字符串旧 ID）通过 auth_legacy_id_map 在导入时映射，不直接转换。
- Session 会话表使用 auth_sessions 表名，避免与团队 sessions（OAuth 连接）冲突。
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import (
    JSON,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import UUID as PostgreSQLUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.db.models import User

UUIDType = PostgreSQLUUID(as_uuid=True)


def utcnow() -> datetime:
    """团队库使用带时区时间戳；统一返回 UTC 感知时间。"""
    return datetime.now(UTC)


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
    user_id: Mapped[Any] = mapped_column(
        UUIDType, ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    google_email: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    last_authenticated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    user: Mapped[User] = relationship(back_populates="identities")


class SchoolEmailBinding(Base):
    __tablename__ = "school_email_bindings"
    __table_args__ = (
        # 已验证规范邮箱全局唯一；待验证地址（pending_*）不占用唯一名额
        UniqueConstraint("school_email_normalized", name="uq_school_email_verified"),
    )

    user_id: Mapped[Any] = mapped_column(
        UUIDType, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    school_email: Mapped[str | None] = mapped_column(String(255))
    school_email_normalized: Mapped[str | None] = mapped_column(String(255))
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    verification_method: Mapped[str | None] = mapped_column(String(32))  # email_code
    pending_school_email: Mapped[str | None] = mapped_column(String(255))
    pending_school_email_normalized: Mapped[str | None] = mapped_column(String(255))
    pending_requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    change_authorized_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    change_authorized_target: Mapped[str | None] = mapped_column(String(255))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False
    )

    user: Mapped[User] = relationship(back_populates="email_binding")


class AcademicIdentityCheck(Base):
    __tablename__ = "academic_identity_checks"
    __table_args__ = (Index("ix_academic_checks_user", "user_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[Any] = mapped_column(
        UUIDType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    checked_fields: Mapped[list[str]] = mapped_column(
        JSON, default=list, nullable=True
    )  # 核验字段范围
    snapshot: Mapped[dict[str, Any]] = mapped_column(
        JSON, default=dict, nullable=True
    )  # 对应快照/版本
    method: Mapped[str | None] = mapped_column(
        String(32)
    )  # school_sso|authorized_roster|documented_manual_review
    result: Mapped[str | None] = mapped_column(String(16))  # passed|failed
    evidence_ref: Mapped[str | None] = mapped_column(String(255))  # 受限证据引用，不含材料本体
    checked_by: Mapped[str | None] = mapped_column(String(64))
    checked_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    superseded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Session(Base):
    """服务端可撤销会话（表名 auth_sessions，避免与团队 sessions 表冲突）。"""

    __tablename__ = "auth_sessions"
    __table_args__ = (Index("ix_auth_sessions_user", "user_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    token_digest: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    csrf_token: Mapped[str] = mapped_column(String(128), nullable=False)
    user_id: Mapped[Any] = mapped_column(
        UUIDType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    scope: Mapped[str] = mapped_column(String(16), nullable=False)  # onboarding|full|status_only
    auth_method: Mapped[str | None] = mapped_column(String(16))  # password|google（会话层认证依据）
    credential_version: Mapped[int | None] = mapped_column(Integer)  # 密码会话绑定的凭据版本
    auth_version: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )  # 闲置期限（按 scope 滚动）
    absolute_expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
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
    user_id: Mapped[Any] = mapped_column(
        UUIDType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    email: Mapped[str] = mapped_column(String(255), nullable=False)
    email_normalized: Mapped[str] = mapped_column(String(255), nullable=False)
    purpose: Mapped[str] = mapped_column(String(32), nullable=False)
    code_hmac: Mapped[str] = mapped_column(
        String(128), nullable=False
    )  # HMAC-SHA256（验证码或恢复令牌摘要）
    credential_version: Mapped[int | None] = mapped_column(Integer)  # 恢复凭据绑定的凭据版本
    change_target_email_normalized: Mapped[str | None] = mapped_column(String(255))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    invalidated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    send_status: Mapped[str] = mapped_column(String(16), default="accepted")  # accepted|failed
    resend_available_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )


class TeacherApplication(Base):
    __tablename__ = "teacher_applications"
    __table_args__ = (Index("ix_teacher_applications_user", "user_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[Any] = mapped_column(
        UUIDType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    application_version: Mapped[int] = mapped_column(
        Integer, nullable=False
    )  # 提交时 users.lock_version
    snapshot: Mapped[dict[str, Any]] = mapped_column(
        JSON, default=dict, nullable=True
    )  # 审核所依据资料快照
    status: Mapped[str] = mapped_column(String(16), nullable=False)  # pending|approved|rejected
    reviewer_id: Mapped[Any] = mapped_column(UUIDType, nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )


class AuthAuditEvent(Base):
    __tablename__ = "auth_audit_events"
    __table_args__ = (Index("ix_auth_audit_target", "target_user_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    actor_id: Mapped[str | None] = mapped_column(String(64))
    target_user_id: Mapped[str | None] = mapped_column(String(64))
    request_id: Mapped[str | None] = mapped_column(String(64))
    result: Mapped[str] = mapped_column(String(16), nullable=False)  # success|failure
    changed_fields: Mapped[list[str]] = mapped_column(
        JSON, default=list, nullable=True
    )  # 只记录字段名
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )


class RateLimitCounter(Base):
    """跨进程一致的限流计数（数据库事务实现，暂不引入 Redis）。"""

    __tablename__ = "auth_rate_limits"
    __table_args__ = (UniqueConstraint("bucket_key", "window_start", name="uq_rate_bucket"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    bucket_key: Mapped[str] = mapped_column(String(255), nullable=False)
    window_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class OAuthTransaction(Base):
    """Google OIDC 事务：绑定浏览器的 state/nonce/PKCE，一次性 + 超时（§6.2）。"""

    __tablename__ = "oauth_transactions"

    state_digest: Mapped[str] = mapped_column(String(128), primary_key=True)
    nonce: Mapped[str] = mapped_column(String(128), nullable=False)
    code_verifier: Mapped[str] = mapped_column(String(128), nullable=False)
    return_to: Mapped[str | None] = mapped_column(String(512))
    # 事务用途：login=登录；link=已登录用户在账户安全中关联 Google（此时 user_id 必填）
    purpose: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'login'"), default="login"
    )
    user_id: Mapped[Any | None] = mapped_column(
        UUIDType, ForeignKey("users.id", ondelete="CASCADE"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PasswordCredential(Base):
    """账号密码凭据（与 Google 身份分开管理；只存密码哈希，不存明文）。

    登录标识：users.username_normalized（用户名）或本表 login_email_normalized（邮箱）。
    login_email_verified_at 为空表示历史/未验证登录邮箱
    （不得借此取得 full 业务会话，也不可用于找回密码）。
    """

    __tablename__ = "password_credentials"

    user_id: Mapped[Any] = mapped_column(
        UUIDType, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    login_email: Mapped[str] = mapped_column(String(255), nullable=False)
    login_email_normalized: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    login_email_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    verification_evidence_ref: Mapped[str | None] = mapped_column(String(255))
    credential_version: Mapped[int] = mapped_column(
        Integer, default=1, nullable=False
    )  # 恢复/改密绑定版本
    password_hash: Mapped[str] = mapped_column(
        String(255), nullable=False
    )  # argon2id/bcrypt；绝不存明文
    password_algo: Mapped[str] = mapped_column(String(32), default="argon2id", nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    password_changed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False
    )

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
    browser_token_digest: Mapped[str] = mapped_column(
        String(128), nullable=False
    )  # 浏览器绑定 Cookie 摘要
    code_hmac: Mapped[str | None] = mapped_column(String(128))
    generation: Mapped[int] = mapped_column(
        Integer, default=1, nullable=False
    )  # 重发递增，旧码失效
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    send_status: Mapped[str] = mapped_column(
        String(16), default="pending"
    )  # pending|accepted|failed|unknown
    resend_available_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    code_consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    creation_grant_digest: Mapped[str | None] = mapped_column(
        String(128)
    )  # 建档资格摘要（≥256 位随机，只存摘要）
    creation_grant_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    result_user_id: Mapped[Any] = mapped_column(UUIDType, nullable=True)
    invalidated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )


class EmailOutbox(Base):
    """邮件捕获（仅 APP_MODE != real 的隔离开发/测试环境使用）。

    capture 模式下保存投递请求内容供测试读取；smtp/resend 模式不写入本表，避免验证码进入日志/存储。
    """

    __tablename__ = "email_outbox"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    to_email: Mapped[str] = mapped_column(String(255), nullable=False)
    subject: Mapped[str] = mapped_column(String(255), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )


class AuthLegacyIdMap(Base):
    """本地旧 ID → 团队用户 UUID 的持久化映射（PLAN 二、2）。

    导入工具按映射幂等重跑；不得直接转换或覆盖团队用户。
    """

    __tablename__ = "auth_legacy_id_map"
    __table_args__ = (
        UniqueConstraint("source", "legacy_id", name="uq_auth_legacy_id"),
        Index("ix_auth_legacy_user", "user_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    source: Mapped[str] = mapped_column(
        String(64), nullable=False
    )  # 来源库标识（如 standalone-server）
    legacy_id: Mapped[str] = mapped_column(String(64), nullable=False)  # 旧 users.id（字符串）
    user_id: Mapped[Any] = mapped_column(
        UUIDType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
