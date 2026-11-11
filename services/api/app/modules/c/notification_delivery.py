"""Call A4-01 inside the C command transaction when the inbox provider is installed."""

from __future__ import annotations

from collections.abc import Callable
from typing import Annotated
from uuid import UUID

from fastapi import Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import CourseMember, CourseStaff, ProjectMember, User


def get_notification_writer():
    try:
        from app.modules.a.inbox import notify
    except ModuleNotFoundError as exc:
        if exc.name != "app.modules.a.inbox":
            raise
        return None
    return notify


# Dependency injection keeps database migrations and isolated service tests independent of A.
NotificationWriter = Annotated[Callable | None, Depends(get_notification_writer)]


def notify_file_publication(
    session: Session,
    writer,
    *,
    actor_id: UUID,
    version_id: UUID,
    name: str,
    version_no: int,
    scope_id: UUID,
    kind: str,
) -> None:
    if writer is None:
        return
    if kind == "project":
        members = select(ProjectMember.user_id).where(
            ProjectMember.project_id == scope_id, ProjectMember.left_at.is_(None)
        )
        eligible = (User.global_role == "student") & User.id.in_(members)
    elif kind == "course":
        members = select(CourseMember.user_id).where(
            CourseMember.course_id == scope_id,
            CourseMember.role == "student",
            CourseMember.status == "active",
            CourseMember.left_at.is_(None),
        )
        staff = select(CourseStaff.user_id).where(
            CourseStaff.course_id == scope_id,
            CourseStaff.left_at.is_(None),
        )
        eligible = ((User.global_role == "student") & User.id.in_(members)) | (
            User.global_role.in_(["teacher", "ta"]) & User.id.in_(staff)
        )
    else:
        raise ValueError("Invalid publication scope")
    recipients = session.scalars(
        select(User.id)
        .where(eligible, User.status == "active", User.id != actor_id)
        .order_by(User.id)
    )
    for recipient in recipients:
        writer(
            session,
            recipient=recipient,
            category=kind,
            title=f"文件已发布：{name}",
            description=f"正式版本 v{version_no}",
            target={"kind": kind, "id": scope_id, f"{kind}_id": scope_id},
            dedupe_key=f"c:{kind}:file:{version_id}",
        )
