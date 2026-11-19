"""D5 project settings, real integration state, archiving and version reopening."""

from datetime import UTC, datetime
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.api.errors import ApiError
from app.api.responses import success
from app.db.models import (
    AcceptanceCriterion,
    BaselineVersion,
    Course,
    CourseMember,
    CourseStaff,
    FunctionalModule,
    Milestone,
    PlanVersion,
    Project,
    ProjectMember,
    Requirement,
    Task,
    TaskAssignee,
    TaskDependency,
    TaskMilestone,
    TaskRequirement,
    User,
)
from app.db.session import get_session
from app.modules.a.models import FeishuChatLink, GithubRepoLink
from app.modules.c.permissions import get_project_access
from app.modules.d.models import (
    ContributionSnapshot,
    ProjectArchive,
    ProjectReopen,
    Report,
)

router = APIRouter(prefix="/api/v1/projects", tags=["d-project-lifecycle"])
course_router = APIRouter(prefix="/api/v1/courses", tags=["d-project-lifecycle"])


@course_router.get("/{course_id}/reopenable-projects")
def reopenable_projects(
    course_id: UUID,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    course = session.get(Course, course_id)
    if course is None:
        raise ApiError(404, "COURSE_NOT_FOUND", "Course not found.")
    staff = session.scalar(
        select(CourseStaff).where(
            CourseStaff.course_id == course_id,
            CourseStaff.user_id == user.id,
            CourseStaff.left_at.is_(None),
        )
    )
    member = session.scalar(
        select(CourseMember).where(
            CourseMember.course_id == course_id,
            CourseMember.user_id == user.id,
            CourseMember.status == "active",
        )
    )
    if user.status != "active" or not (course.owner_id == user.id or staff or member):
        raise ApiError(403, "COURSE_ACCESS_DENIED", "Course access is denied.")
    query = select(Project).where(Project.course_id == course_id, Project.lifecycle == "archived")
    if course.owner_id != user.id and staff is None:
        query = query.join(ProjectMember, ProjectMember.project_id == Project.id).where(
            ProjectMember.user_id == user.id,
            ProjectMember.role == "leader",
            ProjectMember.left_at.is_(None),
        )
    projects = session.scalars(query.order_by(Project.name)).all()
    return success(
        [
            {
                "id": str(row.id),
                "name": row.name,
                "archived_at": row.archived_at.isoformat() if row.archived_at else None,
            }
            for row in projects
        ],
        request,
    )


class SettingsInput(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    project_type: str | None = Field(default=None, max_length=80)
    language: str | None = Field(default=None, max_length=16)
    visibility: str = Field(pattern="^(members|course)$")


class ReopenInput(BaseModel):
    version_label: str = Field(min_length=1, max_length=80)
    reason: str = Field(min_length=1, max_length=2000)
    copy_scope: str = Field(pattern="^(full|baseline)$")


@router.get("/{project_id}/settings")
def read_settings(
    project_id: UUID,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    access = get_project_access(session, user, project_id)
    project = access.project
    github = session.scalars(
        select(GithubRepoLink).where(GithubRepoLink.project_id == project_id)
    ).all()
    feishu = session.scalars(
        select(FeishuChatLink).where(FeishuChatLink.project_id == project_id)
    ).all()
    archive = session.scalar(select(ProjectArchive).where(ProjectArchive.project_id == project_id))
    return success(
        {
            "name": project.name,
            "project_type": project.project_type,
            "language": project.language,
            "visibility": project.visibility,
            "lifecycle": project.lifecycle,
            "github": [f"{row.owner}/{row.repo}" for row in github],
            "feishu_chats": len(feishu),
            "archive": archive.snapshot if archive else None,
        },
        request,
    )


@router.put("/{project_id}/settings")
def save_settings(
    project_id: UUID,
    payload: SettingsInput,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    access = get_project_access(session, user, project_id, lock=True)
    if not access.leader:
        raise ApiError(403, "PROJECT_SETTINGS_DENIED", "Only the group leader may save settings.")
    if access.project.lifecycle != "active":
        raise ApiError(409, "PROJECT_READ_ONLY", "Archived projects cannot be changed.")
    project = access.project
    project.name = payload.name.strip()
    project.project_type = payload.project_type
    project.language = payload.language
    project.visibility = payload.visibility
    project.lock_version += 1
    session.commit()
    return read_settings(project_id, request, session, user)


def latest_frozen(session: Session, model, project_id: UUID):
    return session.scalar(
        select(model)
        .where(model.project_id == project_id, model.status == "frozen")
        .order_by(model.version_no.desc())
        .limit(1)
    )


@router.post("/{project_id}/archive")
def archive_project(
    project_id: UUID,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    access = get_project_access(session, user, project_id, lock=True)
    if not access.leader:
        raise ApiError(403, "PROJECT_ARCHIVE_DENIED", "Only the leader may archive.")
    project = access.project
    if project.lifecycle != "active":
        raise ApiError(409, "PROJECT_READ_ONLY", "Project is already read-only.")
    report = session.scalar(select(Report).where(Report.project_id == project_id))
    baseline = latest_frozen(session, BaselineVersion, project_id)
    plan = latest_frozen(session, PlanVersion, project_id)
    contribution = latest_frozen(session, ContributionSnapshot, project_id)
    tasks = session.scalars(select(Task).where(Task.project_id == project_id)).all()
    if (
        not report
        or report.status != "finalized"
        or not baseline
        or not plan
        or not contribution
        or (not tasks or any(task.status != "completed" for task in tasks))
    ):
        raise ApiError(
            409,
            "PROJECT_NOT_FINAL",
            "Finalize the report, baseline, plan, contribution and tasks first.",
        )
    snapshot = {
        "project": {
            "name": project.name,
            "project_type": project.project_type,
            "language": project.language,
            "visibility": project.visibility,
        },
        "baseline_version_id": str(baseline.id),
        "plan_version_id": str(plan.id),
        "contribution_snapshot_id": str(contribution.id),
        "report_id": str(report.id),
        "tasks": [
            {"id": str(task.id), "status": task.status, "title": task.title} for task in tasks
        ],
    }
    session.add(ProjectArchive(project_id=project_id, actor_id=user.id, snapshot=snapshot))
    project.lifecycle = "archived"
    project.archived_at = datetime.now(UTC)
    project.lock_version += 1
    session.commit()
    return success({"lifecycle": "archived", "snapshot": snapshot}, request)


def copy_structure(session: Session, old_id: UUID, new_id: UUID) -> None:
    modules = session.scalars(
        select(FunctionalModule).where(FunctionalModule.project_id == old_id)
    ).all()
    module_ids = {row.id: uuid4() for row in modules}
    for row in modules:
        session.add(
            FunctionalModule(
                id=module_ids[row.id],
                project_id=new_id,
                owner_id=row.owner_id,
                name=row.name,
                description=row.description,
                core=row.core,
                progress_percent=0,
                sort_order=row.sort_order,
            )
        )
    session.flush()
    requirements = session.scalars(
        select(Requirement).where(Requirement.project_id == old_id)
    ).all()
    requirement_ids = {row.id: uuid4() for row in requirements}
    for row in requirements:
        session.add(
            Requirement(
                id=requirement_ids[row.id],
                project_id=new_id,
                module_id=module_ids[row.module_id],
                title=row.title,
                description=row.description,
                priority=row.priority,
                status="draft",
                source_summary=row.source_summary,
                created_by=row.created_by,
            )
        )
    milestones = session.scalars(select(Milestone).where(Milestone.project_id == old_id)).all()
    milestone_ids = {row.id: uuid4() for row in milestones}
    for row in milestones:
        session.add(
            Milestone(
                id=milestone_ids[row.id],
                project_id=new_id,
                title=row.title,
                description=row.description,
                deadline=row.deadline,
                status="not_started",
                progress_percent=0,
                sort_order=row.sort_order,
            )
        )
    tasks = session.scalars(select(Task).where(Task.project_id == old_id)).all()
    task_ids = {row.id: uuid4() for row in tasks}
    for row in tasks:
        session.add(
            Task(
                id=task_ids[row.id],
                project_id=new_id,
                module_id=module_ids[row.module_id],
                parent_task_id=None,
                created_by=row.created_by,
                title=row.title,
                description=row.description,
                priority=row.priority,
                weight=row.weight,
                status="not_started",
                progress_percent=0,
            )
        )
    session.flush()
    for row in tasks:
        if row.parent_task_id:
            session.get(Task, task_ids[row.id]).parent_task_id = task_ids[row.parent_task_id]
    for row in session.scalars(
        select(AcceptanceCriterion).where(AcceptanceCriterion.task_id.in_(task_ids.keys()))
    ):
        session.add(
            AcceptanceCriterion(
                id=uuid4(),
                task_id=task_ids[row.task_id],
                criterion_key=row.criterion_key,
                text=row.text,
                weight=row.weight,
                sort_order=row.sort_order,
            )
        )
    for row in session.scalars(
        select(TaskRequirement).where(TaskRequirement.task_id.in_(task_ids.keys()))
    ):
        session.add(
            TaskRequirement(
                task_id=task_ids[row.task_id],
                requirement_id=requirement_ids[row.requirement_id],
                relation_type=row.relation_type,
            )
        )
    for row in session.scalars(
        select(TaskMilestone).where(TaskMilestone.task_id.in_(task_ids.keys()))
    ):
        session.add(
            TaskMilestone(
                task_id=task_ids[row.task_id], milestone_id=milestone_ids[row.milestone_id]
            )
        )
    for row in session.scalars(
        select(TaskDependency).where(TaskDependency.task_id.in_(task_ids.keys()))
    ):
        session.add(
            TaskDependency(
                task_id=task_ids[row.task_id],
                depends_on_task_id=task_ids[row.depends_on_task_id],
                dependency_type=row.dependency_type,
            )
        )
    for row in session.scalars(
        select(TaskAssignee).where(
            TaskAssignee.task_id.in_(task_ids.keys()), TaskAssignee.unassigned_at.is_(None)
        )
    ):
        session.add(TaskAssignee(task_id=task_ids[row.task_id], user_id=row.user_id, role=row.role))


@router.post("/{project_id}/reopen", status_code=201)
def reopen_project(
    project_id: UUID,
    payload: ReopenInput,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    access = get_project_access(session, user, project_id, lock=True, allow_readonly=True)
    if not (access.leader or access.teacher) or access.project.lifecycle != "archived":
        raise ApiError(
            403, "PROJECT_REOPEN_DENIED", "Only an archived project's leader or teacher may reopen."
        )
    old = access.project
    course = session.get(Course, old.course_id) if old.course_id else None
    if course and course.status != "active":
        raise ApiError(409, "COURSE_ENDED", "An ended course cannot reopen projects.")
    label = payload.version_label.strip()
    reason = payload.reason.strip()
    if not label or not reason:
        raise ApiError(422, "REOPEN_REASON_REQUIRED", "Version and reason are required.")
    prior = session.scalar(
        select(ProjectReopen).where(
            ProjectReopen.source_project_id == project_id, ProjectReopen.version_label == label
        )
    )
    if prior:
        raise ApiError(409, "REOPEN_VERSION_EXISTS", "This version label already exists.")
    new = Project(
        id=uuid4(),
        course_id=old.course_id,
        group_id=old.group_id,
        name=f"{old.name} ({label})",
        description=old.description,
        project_type=old.project_type,
        language=old.language,
        visibility=old.visibility,
        setup_status="draft",
        lifecycle="active",
        final_deadline=old.final_deadline,
    )
    session.add(new)
    session.flush()
    for row in session.scalars(
        select(ProjectMember).where(
            ProjectMember.project_id == old.id, ProjectMember.left_at.is_(None)
        )
    ):
        session.add(
            ProjectMember(id=uuid4(), project_id=new.id, user_id=row.user_id, role=row.role)
        )
    baseline = latest_frozen(session, BaselineVersion, old.id)
    if baseline:
        session.add(
            BaselineVersion(
                id=uuid4(),
                project_id=new.id,
                version_no=1,
                created_by=user.id,
                status="draft",
                snapshot_json=baseline.snapshot_json,
            )
        )
    if payload.copy_scope == "full":
        copy_structure(session, old.id, new.id)
        plan = latest_frozen(session, PlanVersion, old.id)
        if plan:
            session.add(
                PlanVersion(
                    id=uuid4(),
                    project_id=new.id,
                    version_no=1,
                    created_by=user.id,
                    status="draft",
                    snapshot_json=plan.snapshot_json,
                )
            )
    session.add(
        ProjectReopen(
            source_project_id=old.id,
            new_project_id=new.id,
            actor_id=user.id,
            version_label=label,
            copy_scope=payload.copy_scope,
            reason=reason,
        )
    )
    session.commit()
    return success(
        {
            "new_project_id": str(new.id),
            "copy_scope": payload.copy_scope,
            "reason": reason,
            "source_project_id": str(old.id),
        },
        request,
    )


@router.get("/{project_id}/reopens")
def read_reopens(
    project_id: UUID,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    get_project_access(session, user, project_id)
    rows = session.scalars(
        select(ProjectReopen)
        .where(ProjectReopen.source_project_id == project_id)
        .order_by(ProjectReopen.created_at.desc())
    ).all()
    return success(
        [
            {
                "new_project_id": str(row.new_project_id),
                "version_label": row.version_label,
                "copy_scope": row.copy_scope,
                "reason": row.reason,
                "created_at": row.created_at.isoformat(),
            }
            for row in rows
        ],
        request,
    )
