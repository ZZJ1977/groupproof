"""C-owned logical files and immutable versions; A owns stored bytes.

No rows in A's files table or B's frozen snapshots are rewritten. A version's
storage coordinates and byte metadata never change after registration.
"""

from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import (
    BigInteger,
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


class CourseFile(TimestampMixin, LockVersionMixin, Base):
    __tablename__ = "c_course_files"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    course_id: Mapped[UUID] = mapped_column(ForeignKey("courses.id"), index=True)
    name: Mapped[str] = mapped_column(String(255))
    name_key: Mapped[str] = mapped_column(String(255))
    category: Mapped[str] = mapped_column(String(32))
    latest_version_no: Mapped[int] = mapped_column(Integer)
    official_version_no: Mapped[int | None] = mapped_column(Integer)
    created_by: Mapped[UUID] = mapped_column(ForeignKey("users.id"))

    __table_args__ = (
        UniqueConstraint("course_id", "name_key", name="uq_c_course_file_course_name"),
        CheckConstraint("latest_version_no > 0", name="ck_c_course_file_latest"),
        CheckConstraint(
            "official_version_no IS NULL OR "
            "(official_version_no > 0 AND official_version_no <= latest_version_no)",
            name="ck_c_course_file_official",
        ),
        CheckConstraint(
            "category IN ('documents', 'images', 'exports')", name="ck_c_course_file_category"
        ),
    )


class CourseFileVersion(Base):
    __tablename__ = "c_course_file_versions"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    file_id: Mapped[UUID] = mapped_column(ForeignKey("c_course_files.id"), index=True)
    version_no: Mapped[int] = mapped_column(Integer)
    receipt_id: Mapped[UUID] = mapped_column(Uuid, unique=True)
    storage_provider: Mapped[str] = mapped_column(String(80))
    storage_object_id: Mapped[str] = mapped_column(String(255))
    storage_revision: Mapped[str] = mapped_column(String(255))
    content_hash: Mapped[str] = mapped_column(String(64))
    original_name: Mapped[str] = mapped_column(String(255))
    extension: Mapped[str] = mapped_column(String(16))
    mime_type: Mapped[str] = mapped_column(String(200))
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    uploaded_by: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("file_id", "version_no", name="uq_c_course_file_version"),
        CheckConstraint("version_no > 0", name="ck_c_course_file_version"),
        CheckConstraint("size_bytes BETWEEN 0 AND 52428800", name="ck_c_course_file_size"),
    )


class CourseFileDecision(Base):
    __tablename__ = "c_course_file_decisions"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    file_id: Mapped[UUID] = mapped_column(ForeignKey("c_course_files.id"), index=True)
    version_id: Mapped[UUID] = mapped_column(ForeignKey("c_course_file_versions.id"))
    actor_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    action: Mapped[str] = mapped_column(String(32))
    reason: Mapped[str] = mapped_column(Text)
    resulting_lock_version: Mapped[int] = mapped_column(Integer)
    previous_official_version_no: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint(
            "action IN ('created', 'appended', 'published')", name="ck_c_course_file_action"
        ),
        CheckConstraint("length(trim(reason)) > 0", name="ck_c_course_file_reason"),
    )


class CourseFileOutbox(Base):
    """Course-scoped pending facts; no project identifier is synthesized."""

    __tablename__ = "c_course_file_outbox"
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    course_id: Mapped[UUID] = mapped_column(ForeignKey("courses.id"), index=True)
    aggregate_id: Mapped[UUID] = mapped_column(Uuid, index=True)
    event_type: Mapped[str] = mapped_column(String(80))
    payload_json: Mapped[dict] = mapped_column(DocumentJSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)


class CourseFileRequest(Base):
    __tablename__ = "c_course_file_requests"
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    actor_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    course_id: Mapped[UUID] = mapped_column(ForeignKey("courses.id"))
    operation: Mapped[str] = mapped_column(String(100))
    idempotency_key: Mapped[str] = mapped_column(String(128))
    request_hash: Mapped[str] = mapped_column(String(64))
    response_json: Mapped[dict] = mapped_column(DocumentJSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint(
            "actor_id", "course_id", "operation", "idempotency_key", name="uq_c_course_file_request"
        ),
    )
