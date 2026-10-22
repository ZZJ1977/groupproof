"""C-owned governance history, invitations and approval intent; not A authorization."""

from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.models.core import LockVersionMixin, TimestampMixin
from app.modules.c.models import DocumentJSON


class CourseCodeRegistry(Base):
    __tablename__ = "c_course_code_registry"
    code_key: Mapped[str] = mapped_column(String(64), primary_key=True)
    course_id: Mapped[UUID] = mapped_column(ForeignKey("courses.id"), unique=True)


class CourseInvite(Base):
    __tablename__ = "c_course_invites"
    course_id: Mapped[UUID] = mapped_column(ForeignKey("courses.id"), primary_key=True)
    code: Mapped[str] = mapped_column(String(128), unique=True)
    created_by: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class CourseLifecycleDecision(Base):
    __tablename__ = "c_course_lifecycle_decisions"
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    course_id: Mapped[UUID] = mapped_column(ForeignKey("courses.id"), index=True)
    actor_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    version_no: Mapped[int] = mapped_column(Integer)
    action: Mapped[str] = mapped_column(String(16))
    reason: Mapped[str] = mapped_column(Text)
    before_json: Mapped[dict] = mapped_column(DocumentJSON)
    after_json: Mapped[dict] = mapped_column(DocumentJSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (
        UniqueConstraint("course_id", "version_no", name="uq_c_course_lifecycle_version"),
        CheckConstraint("version_no >= 0", name="ck_c_course_lifecycle_version"),
        CheckConstraint(
            "action IN ('create', 'publish', 'end')", name="ck_c_course_lifecycle_action"
        ),
        CheckConstraint("length(trim(reason)) > 0", name="ck_c_course_lifecycle_reason"),
    )


class AccessRequest(TimestampMixin, LockVersionMixin, Base):
    __tablename__ = "c_access_requests"
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    applicant_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), index=True)
    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id"), index=True)
    scope_json: Mapped[dict] = mapped_column(DocumentJSON)
    reason: Mapped[str] = mapped_column(Text)
    requested_expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(16), default="pending", server_default="pending")
    approved_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    authorization_receipt: Mapped[dict | None] = mapped_column(DocumentJSON)
    __table_args__ = (
        CheckConstraint("status IN ('pending', 'approved', 'rejected')", name="ck_c_access_status"),
        CheckConstraint("length(trim(reason)) > 0", name="ck_c_access_reason"),
        CheckConstraint("lock_version >= 0", name="ck_c_access_version"),
        CheckConstraint(
            "(status = 'approved' AND approved_expires_at IS NOT NULL "
            "AND authorization_receipt IS NOT NULL) OR (status <> 'approved' "
            "AND approved_expires_at IS NULL AND authorization_receipt IS NULL)",
            name="ck_c_access_activation",
        ),
    )


class AccessDecision(Base):
    __tablename__ = "c_access_decisions"
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    request_id: Mapped[UUID] = mapped_column(ForeignKey("c_access_requests.id"), index=True)
    actor_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    version_no: Mapped[int] = mapped_column(Integer)
    decision: Mapped[str] = mapped_column(String(16))
    reason: Mapped[str] = mapped_column(Text)
    before_json: Mapped[dict] = mapped_column(DocumentJSON)
    after_json: Mapped[dict] = mapped_column(DocumentJSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (
        UniqueConstraint("request_id", "version_no", name="uq_c_access_decision_version"),
        CheckConstraint("version_no > 0", name="ck_c_access_decision_version"),
        CheckConstraint("decision IN ('approved', 'rejected')", name="ck_c_access_decision_kind"),
        CheckConstraint("length(trim(reason)) > 0", name="ck_c_access_decision_reason"),
    )


class GovernanceIdempotency(Base):
    __tablename__ = "c_governance_idempotency"
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    actor_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    operation: Mapped[str] = mapped_column(String(100))
    key: Mapped[str] = mapped_column(String(128))
    request_hash: Mapped[str] = mapped_column(String(64))
    response_json: Mapped[dict] = mapped_column(DocumentJSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (
        UniqueConstraint("actor_id", "operation", "key", name="uq_c_governance_request"),
    )


class GovernanceOutbox(Base):
    __tablename__ = "c_governance_outbox"
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    aggregate_id: Mapped[UUID] = mapped_column(Uuid, index=True)
    event_type: Mapped[str] = mapped_column(String(80))
    payload_json: Mapped[dict] = mapped_column(DocumentJSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
