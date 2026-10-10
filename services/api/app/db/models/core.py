from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy import (
    text as sa_text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PostgreSQLUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

UUIDType = PostgreSQLUUID(as_uuid=True)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class LockVersionMixin:
    lock_version: Mapped[int] = mapped_column(
        Integer, server_default=sa_text("0"), default=0, nullable=False
    )


class User(TimestampMixin, LockVersionMixin, Base):
    __tablename__ = "users"

    id: Mapped[UUID] = mapped_column(
        UUIDType, primary_key=True, server_default=sa_text("gen_random_uuid()")
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    username: Mapped[str] = mapped_column(String(80), nullable=False, unique=True)
    email: Mapped[str] = mapped_column(String(320), nullable=False, unique=True)
    student_id: Mapped[str | None] = mapped_column(String(80), unique=True)
    college: Mapped[str] = mapped_column(String(160), nullable=False)
    global_role: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=sa_text("'student'")
    )
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=sa_text("'pending'")
    )
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    avatar_color: Mapped[str | None] = mapped_column(String(32))

    __table_args__ = (
        CheckConstraint(
            "global_role IN ('student', 'teacher', 'ta', 'admin')", name="ck_users_global_role"
        ),
        CheckConstraint("status IN ('active', 'disabled', 'pending')", name="ck_users_status"),
    )


class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[UUID] = mapped_column(
        UUIDType, primary_key=True, server_default=sa_text("gen_random_uuid()")
    )
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    provider: Mapped[str] = mapped_column(String(32), nullable=False)
    refresh_token_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class EmailVerification(Base):
    __tablename__ = "email_verifications"

    id: Mapped[UUID] = mapped_column(
        UUIDType, primary_key=True, server_default=sa_text("gen_random_uuid()")
    )
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    email: Mapped[str] = mapped_column(String(320), nullable=False)
    purpose: Mapped[str] = mapped_column(String(32), nullable=False)
    code_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    attempts: Mapped[int] = mapped_column(Integer, server_default=sa_text("0"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class OAuthConnection(TimestampMixin, Base):
    __tablename__ = "oauth_connections"

    id: Mapped[UUID] = mapped_column(
        UUIDType, primary_key=True, server_default=sa_text("gen_random_uuid()")
    )
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    provider: Mapped[str] = mapped_column(String(32), nullable=False)
    provider_subject: Mapped[str] = mapped_column(String(255), nullable=False)
    access_token_encrypted: Mapped[str | None] = mapped_column(Text)
    refresh_token_encrypted: Mapped[str | None] = mapped_column(Text)
    scopes_json: Mapped[dict | list | None] = mapped_column(JSONB)
    token_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        UniqueConstraint(
            "provider", "provider_subject", name="uq_oauth_connections_provider_subject"
        ),
    )


class Course(TimestampMixin, LockVersionMixin, Base):
    __tablename__ = "courses"

    id: Mapped[UUID] = mapped_column(
        UUIDType, primary_key=True, server_default=sa_text("gen_random_uuid()")
    )
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    college: Mapped[str] = mapped_column(String(160), nullable=False)
    semester: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=sa_text("'draft'")
    )
    project_deadline: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    formation_deadline: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    grouping_mode: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=sa_text("'free'")
    )
    min_group_size: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, server_default=sa_text("1")
    )
    max_group_size: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, server_default=sa_text("8")
    )

    __table_args__ = (
        UniqueConstraint("code", "semester", name="uq_courses_code_semester"),
        CheckConstraint("status IN ('draft', 'active', 'ended')", name="ck_courses_status"),
        CheckConstraint("grouping_mode IN ('free', 'approval')", name="ck_courses_grouping_mode"),
        CheckConstraint(
            "min_group_size > 0 AND max_group_size >= min_group_size", name="ck_courses_group_size"
        ),
    )


class CourseStaff(Base):
    __tablename__ = "course_staff"

    course_id: Mapped[UUID] = mapped_column(
        ForeignKey("courses.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    role: Mapped[str] = mapped_column(String(32), nullable=False)
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    left_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (CheckConstraint("role IN ('teacher', 'ta')", name="ck_course_staff_role"),)


class CourseMember(TimestampMixin, LockVersionMixin, Base):
    __tablename__ = "course_members"

    id: Mapped[UUID] = mapped_column(
        UUIDType, primary_key=True, server_default=sa_text("gen_random_uuid()")
    )
    course_id: Mapped[UUID] = mapped_column(
        ForeignKey("courses.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    role: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=sa_text("'student'")
    )
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=sa_text("'active'")
    )
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    left_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint("role IN ('student', 'teacher', 'ta')", name="ck_course_members_role"),
        CheckConstraint("status IN ('active', 'pending', 'left')", name="ck_course_members_status"),
    )


class ProjectGroup(TimestampMixin, LockVersionMixin, Base):
    __tablename__ = "groups"

    id: Mapped[UUID] = mapped_column(
        UUIDType, primary_key=True, server_default=sa_text("gen_random_uuid()")
    )
    course_id: Mapped[UUID] = mapped_column(
        ForeignKey("courses.id", ondelete="CASCADE"), nullable=False
    )
    leader_id: Mapped[UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    direction: Mapped[str | None] = mapped_column(String(200))
    roster_frozen: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=sa_text("false")
    )

    __table_args__ = (UniqueConstraint("course_id", "name", name="uq_groups_course_name"),)


class GroupMember(Base):
    __tablename__ = "group_members"

    id: Mapped[UUID] = mapped_column(
        UUIDType, primary_key=True, server_default=sa_text("gen_random_uuid()")
    )
    group_id: Mapped[UUID] = mapped_column(
        ForeignKey("groups.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    role: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=sa_text("'member'")
    )
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    left_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        CheckConstraint("role IN ('leader', 'member')", name="ck_group_members_role"),
    )


class Project(TimestampMixin, LockVersionMixin, Base):
    __tablename__ = "projects"

    id: Mapped[UUID] = mapped_column(
        UUIDType, primary_key=True, server_default=sa_text("gen_random_uuid()")
    )
    course_id: Mapped[UUID | None] = mapped_column(ForeignKey("courses.id", ondelete="SET NULL"))
    group_id: Mapped[UUID | None] = mapped_column(ForeignKey("groups.id", ondelete="SET NULL"))
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    project_type: Mapped[str | None] = mapped_column(String(80))
    language: Mapped[str | None] = mapped_column(String(16))
    visibility: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=sa_text("'members'")
    )
    setup_status: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=sa_text("'not_initialized'")
    )
    setup_step: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, server_default=sa_text("0")
    )
    lifecycle: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=sa_text("'active'")
    )
    final_deadline: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint("visibility IN ('members', 'course')", name="ck_projects_visibility"),
        CheckConstraint(
            "setup_status IN ('not_initialized', 'draft', 'pending_confirmation', 'frozen')",
            name="ck_projects_setup_status",
        ),
        CheckConstraint(
            "lifecycle IN ('active', 'finalized', 'archived')", name="ck_projects_lifecycle"
        ),
        CheckConstraint("setup_step >= 0", name="ck_projects_setup_step"),
    )


class ProjectMember(Base):
    __tablename__ = "project_members"

    id: Mapped[UUID] = mapped_column(
        UUIDType, primary_key=True, server_default=sa_text("gen_random_uuid()")
    )
    project_id: Mapped[UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    role: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=sa_text("'member'")
    )
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    left_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        CheckConstraint("role IN ('leader', 'member')", name="ck_project_members_role"),
    )


class FunctionalModule(TimestampMixin, LockVersionMixin, Base):
    __tablename__ = "functional_modules"

    id: Mapped[UUID] = mapped_column(
        UUIDType, primary_key=True, server_default=sa_text("gen_random_uuid()")
    )
    project_id: Mapped[UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    owner_id: Mapped[UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    core: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=sa_text("false"))
    progress_percent: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, server_default=sa_text("0")
    )
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sa_text("0"))

    __table_args__ = (
        UniqueConstraint("project_id", "name", name="uq_functional_modules_project_name"),
        CheckConstraint(
            "progress_percent BETWEEN 0 AND 100", name="ck_functional_modules_progress"
        ),
    )


class Requirement(TimestampMixin, LockVersionMixin, Base):
    __tablename__ = "requirements"

    id: Mapped[UUID] = mapped_column(
        UUIDType, primary_key=True, server_default=sa_text("gen_random_uuid()")
    )
    project_id: Mapped[UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    module_id: Mapped[UUID] = mapped_column(
        ForeignKey("functional_modules.id", ondelete="RESTRICT"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(240), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    priority: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=sa_text("'medium'")
    )
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=sa_text("'draft'")
    )
    source_summary: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))

    __table_args__ = (
        CheckConstraint("priority IN ('high', 'medium', 'low')", name="ck_requirements_priority"),
        CheckConstraint(
            "status IN ('draft', 'confirmed', 'in_progress', 'implemented', 'verified')",
            name="ck_requirements_status",
        ),
    )


class SourceReference(Base):
    __tablename__ = "source_references"

    id: Mapped[UUID] = mapped_column(
        UUIDType, primary_key=True, server_default=sa_text("gen_random_uuid()")
    )
    project_id: Mapped[UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    created_by: Mapped[UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    source_type: Mapped[str] = mapped_column(String(32), nullable=False)
    external_id: Mapped[str | None] = mapped_column(String(255))
    source_uri: Mapped[str | None] = mapped_column(Text)
    title: Mapped[str | None] = mapped_column(String(240))
    content_hash: Mapped[str | None] = mapped_column(String(128))
    metadata_json: Mapped[dict | list | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class RequirementSourceReference(Base):
    __tablename__ = "requirement_source_references"

    requirement_id: Mapped[UUID] = mapped_column(
        ForeignKey("requirements.id", ondelete="CASCADE"), primary_key=True
    )
    source_reference_id: Mapped[UUID] = mapped_column(
        ForeignKey("source_references.id", ondelete="CASCADE"), primary_key=True
    )
    relation_type: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=sa_text("'supports'")
    )


class RequirementConflict(TimestampMixin, Base):
    __tablename__ = "requirement_conflicts"

    id: Mapped[UUID] = mapped_column(
        UUIDType, primary_key=True, server_default=sa_text("gen_random_uuid()")
    )
    project_id: Mapped[UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    left_requirement_id: Mapped[UUID] = mapped_column(
        ForeignKey("requirements.id", ondelete="CASCADE"), nullable=False
    )
    right_requirement_id: Mapped[UUID] = mapped_column(
        ForeignKey("requirements.id", ondelete="CASCADE"), nullable=False
    )
    conflict_type: Mapped[str] = mapped_column(String(32), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=sa_text("'open'")
    )

    __table_args__ = (
        CheckConstraint(
            "left_requirement_id <> right_requirement_id", name="ck_requirement_conflict_distinct"
        ),
        CheckConstraint(
            "status IN ('open', 'resolved', 'ignored')", name="ck_requirement_conflicts_status"
        ),
    )


class ConflictResolution(Base):
    __tablename__ = "conflict_resolutions"

    id: Mapped[UUID] = mapped_column(
        UUIDType, primary_key=True, server_default=sa_text("gen_random_uuid()")
    )
    conflict_id: Mapped[UUID] = mapped_column(
        ForeignKey("requirement_conflicts.id", ondelete="CASCADE"), nullable=False
    )
    resolved_by: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    decision: Mapped[str] = mapped_column(String(32), nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class Milestone(TimestampMixin, LockVersionMixin, Base):
    __tablename__ = "milestones"

    id: Mapped[UUID] = mapped_column(
        UUIDType, primary_key=True, server_default=sa_text("gen_random_uuid()")
    )
    project_id: Mapped[UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    deadline: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=sa_text("'not_started'")
    )
    progress_percent: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, server_default=sa_text("0")
    )
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sa_text("0"))

    __table_args__ = (
        CheckConstraint(
            "status IN ('not_started', 'in_progress', 'completed', 'at_risk')",
            name="ck_milestones_status",
        ),
        CheckConstraint("progress_percent BETWEEN 0 AND 100", name="ck_milestones_progress"),
    )


class BaselineVersion(TimestampMixin, Base):
    __tablename__ = "baseline_versions"

    id: Mapped[UUID] = mapped_column(
        UUIDType, primary_key=True, server_default=sa_text("gen_random_uuid()")
    )
    project_id: Mapped[UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    version_no: Mapped[int] = mapped_column(Integer, nullable=False)
    based_on_version_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("baseline_versions.id", ondelete="SET NULL")
    )
    created_by: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=sa_text("'draft'")
    )
    snapshot_json: Mapped[dict | list] = mapped_column(JSONB, nullable=False)
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    frozen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    lock_version: Mapped[int] = mapped_column(Integer, server_default=sa_text("0"), nullable=False)

    __table_args__ = (
        UniqueConstraint("project_id", "version_no", name="uq_baseline_versions_project_version"),
        CheckConstraint(
            "status IN ('draft', 'confirmed', 'frozen', 'archived')",
            name="ck_baseline_versions_status",
        ),
    )


class BaselineConfirmation(Base):
    __tablename__ = "baseline_confirmations"

    id: Mapped[UUID] = mapped_column(
        UUIDType, primary_key=True, server_default=sa_text("gen_random_uuid()")
    )
    baseline_version_id: Mapped[UUID] = mapped_column(
        ForeignKey("baseline_versions.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=sa_text("'pending'")
    )
    comment: Mapped[str | None] = mapped_column(Text)
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        UniqueConstraint("baseline_version_id", "user_id", name="uq_baseline_confirmations_member"),
        CheckConstraint(
            "status IN ('pending', 'confirmed', 'rejected')",
            name="ck_baseline_confirmations_status",
        ),
    )


class Task(TimestampMixin, LockVersionMixin, Base):
    __tablename__ = "tasks"

    id: Mapped[UUID] = mapped_column(
        UUIDType, primary_key=True, server_default=sa_text("gen_random_uuid()")
    )
    project_id: Mapped[UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    module_id: Mapped[UUID] = mapped_column(
        ForeignKey("functional_modules.id", ondelete="RESTRICT"), nullable=False
    )
    parent_task_id: Mapped[UUID | None] = mapped_column(ForeignKey("tasks.id", ondelete="SET NULL"))
    created_by: Mapped[UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    title: Mapped[str] = mapped_column(String(240), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    priority: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=sa_text("'medium'")
    )
    weight: Mapped[float] = mapped_column(
        Numeric(8, 3), nullable=False, server_default=sa_text("1")
    )
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=sa_text("'not_started'")
    )
    progress_percent: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, server_default=sa_text("0")
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint("priority IN ('high', 'medium', 'low')", name="ck_tasks_priority"),
        CheckConstraint(
            "status IN ('not_started', 'in_progress', 'pending_submission', "
            "'pending_verification', 'completed')",
            name="ck_tasks_status",
        ),
        CheckConstraint("weight > 0", name="ck_tasks_weight"),
        CheckConstraint("progress_percent BETWEEN 0 AND 100", name="ck_tasks_progress"),
    )


class TaskRequirement(Base):
    __tablename__ = "task_requirements"

    task_id: Mapped[UUID] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), primary_key=True
    )
    requirement_id: Mapped[UUID] = mapped_column(
        ForeignKey("requirements.id", ondelete="CASCADE"), primary_key=True
    )
    relation_type: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=sa_text("'implements'")
    )


class TaskAssignee(Base):
    __tablename__ = "task_assignees"

    task_id: Mapped[UUID] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    role: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=sa_text("'responsible'")
    )
    assigned_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    unassigned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint("role IN ('responsible', 'reviewer')", name="ck_task_assignees_role"),
    )


class TaskDependency(Base):
    __tablename__ = "task_dependencies"

    task_id: Mapped[UUID] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), primary_key=True
    )
    depends_on_task_id: Mapped[UUID] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), primary_key=True
    )
    dependency_type: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=sa_text("'blocks'")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class AcceptanceCriterion(TimestampMixin, LockVersionMixin, Base):
    __tablename__ = "acceptance_criteria"

    id: Mapped[UUID] = mapped_column(
        UUIDType, primary_key=True, server_default=sa_text("gen_random_uuid()")
    )
    task_id: Mapped[UUID] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False
    )
    criterion_key: Mapped[str] = mapped_column(String(64), nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    weight: Mapped[float] = mapped_column(
        Numeric(8, 3), nullable=False, server_default=sa_text("1")
    )
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sa_text("0"))

    __table_args__ = (
        UniqueConstraint("task_id", "criterion_key", name="uq_acceptance_criteria_task_key"),
        CheckConstraint("weight > 0", name="ck_acceptance_criteria_weight"),
    )


class TaskMilestone(Base):
    __tablename__ = "task_milestones"

    task_id: Mapped[UUID] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), primary_key=True
    )
    milestone_id: Mapped[UUID] = mapped_column(
        ForeignKey("milestones.id", ondelete="CASCADE"), primary_key=True
    )


class PlanVersion(TimestampMixin, Base):
    __tablename__ = "plan_versions"

    id: Mapped[UUID] = mapped_column(
        UUIDType, primary_key=True, server_default=sa_text("gen_random_uuid()")
    )
    project_id: Mapped[UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    version_no: Mapped[int] = mapped_column(Integer, nullable=False)
    based_on_version_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("plan_versions.id", ondelete="SET NULL")
    )
    created_by: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=sa_text("'draft'")
    )
    snapshot_json: Mapped[dict | list] = mapped_column(JSONB, nullable=False)
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    frozen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    lock_version: Mapped[int] = mapped_column(Integer, server_default=sa_text("0"), nullable=False)

    __table_args__ = (
        UniqueConstraint("project_id", "version_no", name="uq_plan_versions_project_version"),
        CheckConstraint(
            "status IN ('draft', 'confirmed', 'frozen', 'archived')",
            name="ck_plan_versions_status",
        ),
    )


class PlanConfirmation(Base):
    __tablename__ = "plan_confirmations"

    id: Mapped[UUID] = mapped_column(
        UUIDType, primary_key=True, server_default=sa_text("gen_random_uuid()")
    )
    plan_version_id: Mapped[UUID] = mapped_column(
        ForeignKey("plan_versions.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=sa_text("'pending'")
    )
    comment: Mapped[str | None] = mapped_column(Text)
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        UniqueConstraint("plan_version_id", "user_id", name="uq_plan_confirmations_member"),
        CheckConstraint(
            "status IN ('pending', 'confirmed', 'rejected')",
            name="ck_plan_confirmations_status",
        ),
    )


class ProgressEvent(Base):
    __tablename__ = "progress_events"

    id: Mapped[UUID] = mapped_column(
        UUIDType, primary_key=True, server_default=sa_text("gen_random_uuid()")
    )
    project_id: Mapped[UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    task_id: Mapped[UUID] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False
    )
    actor_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    from_status: Mapped[str | None] = mapped_column(String(32))
    to_status: Mapped[str | None] = mapped_column(String(32))
    progress_before: Mapped[int | None] = mapped_column(SmallInteger)
    progress_after: Mapped[int | None] = mapped_column(SmallInteger)
    reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        CheckConstraint(
            "progress_before IS NULL OR progress_before BETWEEN 0 AND 100",
            name="ck_progress_events_before",
        ),
        CheckConstraint(
            "progress_after IS NULL OR progress_after BETWEEN 0 AND 100",
            name="ck_progress_events_after",
        ),
    )


Index("ix_sessions_user_id", Session.__table__.c.user_id)
Index("ix_email_verifications_user_id", EmailVerification.__table__.c.user_id)
Index("ix_oauth_connections_user_id", OAuthConnection.__table__.c.user_id)
Index("ix_courses_owner_id", Course.__table__.c.owner_id)
Index("ix_course_staff_user_id", CourseStaff.__table__.c.user_id)
Index("ix_course_members_course_id", CourseMember.__table__.c.course_id)
Index("ix_course_members_user_id", CourseMember.__table__.c.user_id)
Index(
    "uq_course_members_active",
    CourseMember.__table__.c.course_id,
    CourseMember.__table__.c.user_id,
    unique=True,
    postgresql_where=sa_text("left_at IS NULL"),
)
Index("ix_groups_course_id", ProjectGroup.__table__.c.course_id)
Index("ix_groups_leader_id", ProjectGroup.__table__.c.leader_id)
Index("ix_group_members_group_id", GroupMember.__table__.c.group_id)
Index("ix_group_members_user_id", GroupMember.__table__.c.user_id)
Index(
    "uq_group_members_active",
    GroupMember.__table__.c.group_id,
    GroupMember.__table__.c.user_id,
    unique=True,
    postgresql_where=sa_text("left_at IS NULL"),
)
Index("ix_projects_course_id", Project.__table__.c.course_id)
Index("uq_projects_group_id", Project.__table__.c.group_id, unique=True)
Index("ix_project_members_project_id", ProjectMember.__table__.c.project_id)
Index("ix_project_members_user_id", ProjectMember.__table__.c.user_id)
Index(
    "uq_project_members_active",
    ProjectMember.__table__.c.project_id,
    ProjectMember.__table__.c.user_id,
    unique=True,
    postgresql_where=sa_text("left_at IS NULL"),
)
Index("ix_functional_modules_project_id", FunctionalModule.__table__.c.project_id)
Index("ix_functional_modules_owner_id", FunctionalModule.__table__.c.owner_id)
Index("ix_requirements_project_id", Requirement.__table__.c.project_id)
Index("ix_requirements_module_id", Requirement.__table__.c.module_id)
Index("ix_requirements_status", Requirement.__table__.c.status)
Index("ix_source_references_project_id", SourceReference.__table__.c.project_id)
Index("ix_source_references_type", SourceReference.__table__.c.source_type)
Index("ix_requirement_conflicts_project_id", RequirementConflict.__table__.c.project_id)
Index("ix_requirement_conflicts_status", RequirementConflict.__table__.c.status)
Index("ix_conflict_resolutions_conflict_id", ConflictResolution.__table__.c.conflict_id)
Index("ix_milestones_project_id", Milestone.__table__.c.project_id)
Index("ix_milestones_status", Milestone.__table__.c.status)
Index("ix_tasks_project_id", Task.__table__.c.project_id)
Index("ix_tasks_module_id", Task.__table__.c.module_id)
Index("ix_tasks_parent_task_id", Task.__table__.c.parent_task_id)
Index("ix_tasks_status", Task.__table__.c.status)
Index("ix_task_requirements_requirement_id", TaskRequirement.__table__.c.requirement_id)
Index("ix_task_assignees_user_id", TaskAssignee.__table__.c.user_id)
Index("ix_task_dependencies_depends_on", TaskDependency.__table__.c.depends_on_task_id)
Index("ix_acceptance_criteria_task_id", AcceptanceCriterion.__table__.c.task_id)
Index("ix_task_milestones_milestone_id", TaskMilestone.__table__.c.milestone_id)
Index("ix_progress_events_project_id", ProgressEvent.__table__.c.project_id)
Index("ix_progress_events_task_id", ProgressEvent.__table__.c.task_id)
Index("ix_baseline_versions_project_id", BaselineVersion.__table__.c.project_id)
Index("ix_baseline_versions_status", BaselineVersion.__table__.c.status)
Index("ix_baseline_confirmations_user_id", BaselineConfirmation.__table__.c.user_id)
Index("ix_plan_versions_project_id", PlanVersion.__table__.c.project_id)
Index("ix_plan_versions_status", PlanVersion.__table__.c.status)
Index("ix_plan_confirmations_user_id", PlanConfirmation.__table__.c.user_id)
