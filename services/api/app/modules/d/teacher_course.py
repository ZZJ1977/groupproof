"""Teacher course settings, immutable rule versions, acknowledgements, and closure."""

from datetime import UTC, datetime
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.api.errors import ApiError
from app.api.responses import success
from app.db.models import Course, CourseMember, Project, ProjectGroup, ProjectMember, User
from app.db.session import get_session
from app.modules.a.models import Notification
from app.modules.c.governance_models import CourseLifecycleDecision
from app.modules.c.permissions import get_project_access
from app.modules.d.models import (
    CourseRuleConfirmation,
    CourseRuleVersion,
    CourseTemplateApplication,
    ProjectArchive,
)
from app.modules.d.teacher_workspace import allowed_project_ids, course_staff

router = APIRouter(prefix="/api/v1/courses", tags=["d-teacher-course"])
project_router = APIRouter(prefix="/api/v1/projects", tags=["d-teacher-course"])


@project_router.get("/{project_id}/applied-course-template")
def applied_template(
    project_id: UUID,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    get_project_access(session, user, project_id)
    row = session.scalar(
        select(CourseTemplateApplication).where(CourseTemplateApplication.project_id == project_id)
    )
    return success(
        {"version_id": str(row.version_id), "template": row.template} if row else None, request
    )


class CourseSettingsInput(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    project_deadline: datetime | None = None
    formation_deadline: datetime | None = None
    grouping_mode: str = Field(pattern="^(free|approval)$")
    min_group_size: int = Field(ge=1, le=100)
    max_group_size: int = Field(ge=1, le=100)
    reason: str = Field(min_length=1, max_length=2000)

    @model_validator(mode="after")
    def validate_range(self):
        if self.max_group_size < self.min_group_size:
            raise ValueError("Maximum group size is below minimum size.")
        if (
            self.formation_deadline
            and self.project_deadline
            and self.formation_deadline > self.project_deadline
        ):
            raise ValueError("Formation deadline follows project deadline.")
        return self


class MilestoneTemplate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    required_materials: list[str] = Field(default_factory=list)
    weight: float = Field(ge=0, le=100)


class TemplateInput(BaseModel):
    milestones: list[MilestoneTemplate] = Field(min_length=1)
    reason: str = Field(min_length=1, max_length=2000)

    @model_validator(mode="after")
    def validate_weights(self):
        if abs(sum(item.weight for item in self.milestones) - 100) > 0.0001:
            raise ValueError("Milestone weights must total 100.")
        return self


def require_teacher(session: Session, user: User, course_id: UUID, *, write=False) -> Course:
    course, teacher = course_staff(session, user, course_id)
    if not teacher:
        raise ApiError(403, "COURSE_TEACHER_DENIED", "Only a course teacher may change rules.")
    if write and course.status == "ended":
        raise ApiError(403, "COURSE_READ_ONLY", "The course has ended.")
    if write:
        course = session.scalar(select(Course).where(Course.id == course_id).with_for_update())
    return course


def latest_rule(session: Session, course_id: UUID) -> CourseRuleVersion | None:
    return session.scalar(
        select(CourseRuleVersion)
        .where(CourseRuleVersion.course_id == course_id)
        .order_by(CourseRuleVersion.version_no.desc())
        .limit(1)
    )


def rule_data(row: CourseRuleVersion) -> dict:
    return {
        "id": str(row.id),
        "version": row.version_no,
        "reason": row.reason,
        "rules": row.rules,
        "effective_at": row.effective_at.isoformat(),
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


def notify_leaders(session: Session, course_id: UUID, version: CourseRuleVersion) -> None:
    leader_ids = set(
        session.scalars(
            select(ProjectGroup.leader_id).where(
                ProjectGroup.course_id == course_id, ProjectGroup.leader_id.is_not(None)
            )
        )
    )
    leader_ids.update(
        session.scalars(
            select(ProjectMember.user_id)
            .join(Project, Project.id == ProjectMember.project_id)
            .where(
                Project.course_id == course_id,
                ProjectMember.role == "leader",
                ProjectMember.left_at.is_(None),
            )
        )
    )
    now = datetime.now(UTC)
    for recipient_id in leader_ids:
        session.add(
            Notification(
                id=uuid4(),
                recipient_id=recipient_id,
                category="course",
                title="课程规则已更新",
                description=version.reason,
                target_json={"kind": "course", "course_id": str(course_id)},
                dedupe_key=f"d-rule:{version.id}:{recipient_id}",
                created_at=now,
                email_status="none",
            )
        )


def save_rule(
    session: Session, course: Course, user: User, reason: str, rules: dict
) -> CourseRuleVersion:
    previous = latest_rule(session, course.id)
    row = CourseRuleVersion(
        course_id=course.id,
        version_no=previous.version_no + 1 if previous else 1,
        actor_id=user.id,
        reason=reason.strip(),
        rules=rules,
        effective_at=datetime.now(UTC),
    )
    session.add(row)
    session.flush()
    notify_leaders(session, course.id, row)
    return row


@router.get("/{course_id}/teacher-rules")
def read_rules(
    course_id: UUID,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    course = session.get(Course, course_id)
    if course is None:
        raise ApiError(404, "COURSE_NOT_FOUND", "Course not found.")
    staff_view = user.global_role in {"teacher", "ta"}
    if staff_view:
        _, teacher = course_staff(session, user, course_id)
    elif user.status != "active" or not session.scalar(
        select(CourseMember.user_id).where(
            CourseMember.course_id == course_id,
            CourseMember.user_id == user.id,
            CourseMember.status == "active",
        )
    ):
        raise ApiError(403, "COURSE_ACCESS_DENIED", "Course membership required.")
    versions = session.scalars(
        select(CourseRuleVersion)
        .where(CourseRuleVersion.course_id == course_id)
        .order_by(CourseRuleVersion.version_no.desc())
    ).all()
    project_query = select(Project).where(Project.course_id == course_id)
    if staff_view and not teacher:
        ids = allowed_project_ids(session, user, course_id, teacher=False)
        project_query = project_query.where(Project.id.in_(ids))
    elif not staff_view:
        project_query = project_query.join(
            ProjectMember, ProjectMember.project_id == Project.id
        ).where(ProjectMember.user_id == user.id, ProjectMember.left_at.is_(None))
    projects = session.scalars(project_query).all()
    confirmations = (
        session.scalars(
            select(CourseRuleConfirmation).where(
                CourseRuleConfirmation.version_id.in_([row.id for row in versions])
            )
        ).all()
        if versions
        else []
    )
    confirmed = {(row.version_id, row.project_id) for row in confirmations}
    return success(
        {
            "course": {
                "id": str(course.id),
                "name": course.name,
                "status": course.status,
                "project_deadline": course.project_deadline.isoformat()
                if course.project_deadline
                else None,
                "formation_deadline": course.formation_deadline.isoformat()
                if course.formation_deadline
                else None,
                "grouping_mode": course.grouping_mode,
                "min_group_size": course.min_group_size,
                "max_group_size": course.max_group_size,
            },
            "versions": [rule_data(row) for row in versions],
            "projects": [
                {
                    "id": str(project.id),
                    "name": project.name,
                    "lifecycle": project.lifecycle,
                    "confirmed": bool(versions and (versions[0].id, project.id) in confirmed),
                }
                for project in projects
            ],
        },
        request,
    )


@router.post("/{course_id}/teacher-settings")
def change_settings(
    course_id: UUID,
    payload: CourseSettingsInput,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    course = require_teacher(session, user, course_id, write=True)
    course.name = payload.name.strip()
    course.project_deadline = payload.project_deadline
    course.formation_deadline = payload.formation_deadline
    course.grouping_mode = payload.grouping_mode
    course.min_group_size = payload.min_group_size
    course.max_group_size = payload.max_group_size
    course.lock_version += 1
    previous = latest_rule(session, course_id)
    rules = dict(previous.rules) if previous else {}
    rules["settings"] = payload.model_dump(mode="json", exclude={"reason"})
    version = save_rule(session, course, user, payload.reason, rules)
    session.commit()
    return success(rule_data(version), request)


@router.post("/{course_id}/teacher-template")
def change_template(
    course_id: UUID,
    payload: TemplateInput,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    course = require_teacher(session, user, course_id, write=True)
    previous = latest_rule(session, course_id)
    rules = dict(previous.rules) if previous else {}
    rules["template"] = payload.model_dump(mode="json", exclude={"reason"})
    version = save_rule(session, course, user, payload.reason, rules)
    session.commit()
    return success(rule_data(version), request)


@router.post("/{course_id}/teacher-rules/{version_id}/projects/{project_id}/confirm")
def confirm_rules(
    course_id: UUID,
    version_id: UUID,
    project_id: UUID,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    access = get_project_access(session, user, project_id, lock=True)
    if access.project.course_id != course_id or not access.leader:
        raise ApiError(403, "RULE_CONFIRM_DENIED", "Project leader access required.")
    if access.project.lifecycle != "active" or access.course.status != "active":
        raise ApiError(409, "PROJECT_READ_ONLY", "Only active projects can confirm rules.")
    version = latest_rule(session, course_id)
    if version is None or version.id != version_id:
        raise ApiError(409, "RULE_VERSION_STALE", "Confirm the latest course rule version.")
    existing = session.scalar(
        select(CourseRuleConfirmation).where(
            CourseRuleConfirmation.version_id == version_id,
            CourseRuleConfirmation.project_id == project_id,
        )
    )
    if existing is None:
        session.add(
            CourseRuleConfirmation(version_id=version_id, project_id=project_id, actor_id=user.id)
        )
        session.commit()
    return success({"confirmed": True, "version": version.version_no}, request)


class EndInput(BaseModel):
    reason: str = Field(min_length=1, max_length=2000)


@router.post("/{course_id}/teacher-end")
def end_course(
    course_id: UUID,
    payload: EndInput,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    course = require_teacher(session, user, course_id, write=True)
    if course.status != "active":
        raise ApiError(409, "COURSE_STATE_CONFLICT", "Only active courses can be ended.")
    before = {"status": course.status, "lock_version": course.lock_version}
    projects = session.scalars(
        select(Project).where(Project.course_id == course_id).with_for_update()
    ).all()
    now = datetime.now(UTC)
    for project in projects:
        if project.lifecycle != "archived":
            session.add(
                ProjectArchive(
                    project_id=project.id,
                    actor_id=user.id,
                    snapshot={
                        "name": project.name,
                        "lifecycle": project.lifecycle,
                        "course_end_reason": payload.reason.strip(),
                    },
                )
            )
            project.lifecycle = "archived"
            project.archived_at = now
            project.lock_version += 1
    course.status = "ended"
    course.lock_version += 1
    session.add(
        CourseLifecycleDecision(
            course_id=course_id,
            actor_id=user.id,
            version_no=course.lock_version,
            action="end",
            reason=payload.reason.strip(),
            before_json=before,
            after_json={"status": "ended", "lock_version": course.lock_version},
        )
    )
    session.commit()
    return success({"status": "ended", "archived_projects": len(projects)}, request)
