"""B-3: create a group's project (B3-01), overview (B3-02), basic info (B3-03)
and materials (B3-04).

* One project per group: checked under the group row lock and enforced by the
  ``uq_projects_group`` index, so concurrent creates make exactly one.
* A new project copies the current group members, the course project deadline
  and the course milestone template, all in one transaction.
* Overview progress uses C's ``progress_projection`` (root-weighted) so B and C
  never show two different numbers.
* File materials need a completed A4-04 receipt for this project; their text
  comes only from A4-05 (``MaterialTextPort``) and is never invented.
"""

from __future__ import annotations

from datetime import date, datetime, time
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import (
    Course,
    GroupMember,
    Milestone,
    Project,
    ProjectGroup,
    ProjectMember,
    Task,
    User,
)
from app.modules.a import permissions
from app.modules.a.audit import record_audit
from app.modules.a.inbox import notify
from app.modules.a.models import UploadReceipt
from app.modules.a.permissions import Target
from app.modules.b.common import now, require_version
from app.modules.b.courses_schemas import PersonDTO
from app.modules.b.models import (
    BCourseProjectTemplate,
    BProjectDraft,
    BProjectMaterial,
    BProjectSchedule,
)
from app.modules.b.ports import MaterialTextPort
from app.modules.b.projects_schemas import (
    AddMaterial,
    CreatedProjectDTO,
    CreateProject,
    DraftDTO,
    MaterialDTO,
    MilestoneBriefDTO,
    MilestoneTemplateItem,
    OverviewDTO,
    ProjectStatsDTO,
    ProjectTemplateDTO,
    SaveBasic,
    SaveDraft,
    SetProjectTemplate,
    SetupDTO,
)
from app.modules.c.task_execution import progress_projection

LOCAL_TZ = ZoneInfo("Asia/Shanghai")
EDITABLE_SETUP = {"not_initialized", "draft", "pending_confirmation"}


def _local_date(value: datetime | None) -> date | None:
    return value.astimezone(LOCAL_TZ).date() if value else None


def _person(session: Session, user_id: UUID | None) -> PersonDTO | None:
    if user_id is None:
        return None
    user = session.get(User, user_id)
    return PersonDTO(id=user.id, name=user.name) if user else None


# ---------------------------------------------------------------- course template


def get_template(session: Session, user: User, course_id: UUID) -> ProjectTemplateDTO:
    if session.get(Course, course_id) is None or not (
        permissions.is_course_member(session, user, course_id)
        or permissions.is_course_staff(session, user, course_id)
    ):
        raise ApiError(404, "COURSE_NOT_FOUND", "课程不存在或你不是该课程成员。")
    row = session.get(BCourseProjectTemplate, course_id)
    return ProjectTemplateDTO(
        course_id=course_id,
        milestones=[MilestoneTemplateItem(**m) for m in (row.milestones if row else [])],
        lock_version=row.lock_version if row else 0,
    )


def set_template(
    session: Session, user: User, course_id: UUID, command: SetProjectTemplate, request=None
) -> ProjectTemplateDTO:
    course = session.get(Course, course_id)
    if course is None:
        raise ApiError(404, "COURSE_NOT_FOUND", "课程不存在。")
    permissions.require_course_teacher(session, user, course_id)
    if course.status == "ended":
        raise ApiError(409, "COURSE_CLOSED", "课程已经结束。")
    row = session.scalar(
        select(BCourseProjectTemplate)
        .where(BCourseProjectTemplate.course_id == course_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    require_version(row.lock_version if row else 0, command.expected_version)
    items = [m.model_dump(mode="json") for m in command.milestones]
    if row is None:
        row = BCourseProjectTemplate(course_id=course_id, milestones=items, lock_version=1)
        session.add(row)
    else:
        row.milestones = items
        row.lock_version += 1
    row.updated_by = user.id
    row.updated_at = now()
    session.flush()
    record_audit(
        session,
        actor=user,
        action="course.project_template.updated",
        target=("course", course_id),
        course_id=course_id,
        after={"milestones": len(items)},
        request=request,
    )
    return ProjectTemplateDTO(
        course_id=course_id, milestones=command.milestones, lock_version=row.lock_version
    )


# ---------------------------------------------------------------- B3-01 draft + create


def _group_for_member(session: Session, user: User, group_id: UUID) -> ProjectGroup:
    group = session.get(ProjectGroup, group_id)
    if group is None or not permissions.is_group_member(session, user, group_id):
        raise ApiError(404, "GROUP_NOT_FOUND", "小组不存在或你不是该组成员。")
    return group


def _project_of_group(session: Session, group_id: UUID) -> Project | None:
    return session.scalar(select(Project).where(Project.group_id == group_id))


def get_draft(session: Session, user: User, group_id: UUID) -> DraftDTO:
    _group_for_member(session, user, group_id)
    row = session.get(BProjectDraft, group_id)
    project = _project_of_group(session, group_id)
    return DraftDTO(
        group_id=group_id,
        payload=row.payload if row else {},
        step=row.step if row else 0,
        lock_version=row.lock_version if row else 0,
        updated_at=row.updated_at if row else None,
        project_id=project.id if project else None,
    )


def save_draft(session: Session, user: User, group_id: UUID, command: SaveDraft) -> DraftDTO:
    _group_for_member(session, user, group_id)
    if _project_of_group(session, group_id) is not None:
        raise ApiError(409, "PROJECT_ALREADY_EXISTS", "本组已经创建了项目。")
    row = session.scalar(
        select(BProjectDraft)
        .where(BProjectDraft.group_id == group_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    require_version(row.lock_version if row else 0, command.expected_version)
    if row is None:
        row = BProjectDraft(group_id=group_id, payload=command.payload, step=command.step)
        row.lock_version = 1
        session.add(row)
    else:
        row.payload = command.payload
        row.step = command.step
        row.lock_version += 1
    row.updated_by = user.id
    row.updated_at = now()
    session.flush()
    return DraftDTO(
        group_id=group_id,
        payload=row.payload,
        step=row.step,
        lock_version=row.lock_version,
        updated_at=row.updated_at,
        project_id=None,
    )


def create_project(
    session: Session, user: User, group_id: UUID, command: CreateProject, request=None
) -> CreatedProjectDTO:
    group = session.get(ProjectGroup, group_id)
    if group is None or not permissions.is_group_member(session, user, group_id):
        raise ApiError(404, "GROUP_NOT_FOUND", "小组不存在或你不是该组成员。")
    permissions.require_action(session, user, "project.create", Target("group", group_id))
    group = session.scalar(
        select(ProjectGroup)
        .where(ProjectGroup.id == group_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    course = session.get(Course, group.course_id)
    if course.status != "active":
        raise ApiError(409, "COURSE_CLOSED", "课程已经结束。")
    if _project_of_group(session, group_id) is not None:
        raise ApiError(409, "PROJECT_ALREADY_EXISTS", "本组已经创建了项目。")
    name = command.name.strip()
    if not name:
        raise ApiError(422, "PROJECT_NAME_REQUIRED", "请填写项目名称。", details={"field": "name"})
    project = Project(
        course_id=course.id,
        group_id=group.id,
        name=name,
        description=(command.description or "").strip() or None,
        project_type=(command.project_type or "").strip() or None,
        visibility="members",
        setup_status="draft",
        setup_step=1,
        lifecycle="active",
        final_deadline=course.project_deadline,
    )
    session.add(project)
    session.flush()
    session.add(
        BProjectSchedule(project_id=project.id, start_date=now().astimezone(LOCAL_TZ).date())
    )
    members = session.scalars(
        select(GroupMember).where(GroupMember.group_id == group.id, GroupMember.left_at.is_(None))
    ).all()
    for member in members:
        session.add(
            ProjectMember(
                project_id=project.id,
                user_id=member.user_id,
                role="leader" if member.user_id == group.leader_id else "member",
            )
        )
    template = session.get(BCourseProjectTemplate, course.id)
    for index, item in enumerate(template.milestones if template else []):
        session.add(
            Milestone(
                project_id=project.id,
                title=item["title"],
                description=item.get("description"),
                deadline=datetime.fromisoformat(item["deadline"]) if item.get("deadline") else None,
                sort_order=index + 1,
            )
        )
    draft = session.get(BProjectDraft, group.id)
    if draft is not None:
        session.delete(draft)
    session.flush()
    for member in members:
        if member.user_id != user.id:
            notify(
                session,
                recipient=member.user_id,
                category="project",
                title=f"小组「{group.name}」创建了项目「{name}」",
                description="请进入项目完成初始化。",
                target={"kind": "project", "id": project.id, "project_id": project.id},
                dedupe_key=f"b:project-created:{project.id}",
            )
    record_audit(
        session,
        actor=user,
        action="project.created",
        target=("project", project.id),
        project_id=project.id,
        course_id=course.id,
        after={
            "name": name,
            "members": [m.user_id for m in members],
            "milestones": len(template.milestones) if template else 0,
        },
        request=request,
    )
    return CreatedProjectDTO(project_id=project.id, href=f"/projects/{project.id}/setup")


# ---------------------------------------------------------------- B3-02 overview


def _entry(project: Project) -> str:
    if project.lifecycle != "active":
        return "readonly"
    return "baseline" if project.setup_status == "frozen" else "setup"


def overview(session: Session, user: User, project_id: UUID) -> OverviewDTO:
    relation = permissions.require_project_read(session, user, project_id)
    project = relation.project
    tasks = list(
        session.scalars(
            select(Task)
            .where(Task.project_id == project.id)
            .execution_options(populate_existing=True)
        )
    )
    try:
        _, progress = progress_projection(tasks)
        progress_status = "available" if progress is not None else "no_weighted_tasks"
    except ApiError as error:
        if error.code != "INVALID_TASK_TREE":
            raise
        progress, progress_status = None, "invalid_task_tree"
    members = session.scalars(
        select(ProjectMember.user_id)
        .where(ProjectMember.project_id == project.id, ProjectMember.left_at.is_(None))
        .order_by(ProjectMember.joined_at)
    ).all()
    milestones = session.scalars(
        select(Milestone)
        .where(Milestone.project_id == project.id)
        .order_by(Milestone.sort_order, Milestone.deadline)
    ).all()
    upcoming = next((m for m in milestones if m.status != "completed"), None)
    return OverviewDTO(
        id=project.id,
        name=project.name,
        description=project.description,
        course_id=project.course_id,
        group_id=project.group_id,
        setup_status=project.setup_status,
        setup_step=project.setup_step,
        lifecycle=project.lifecycle,
        entry=_entry(project),  # type: ignore[arg-type]
        can_edit=relation.member and not relation.read_only,
        is_leader=relation.leader,
        final_deadline=project.final_deadline,
        stats=ProjectStatsDTO(
            task_count=len(tasks),
            completed_count=sum(1 for t in tasks if t.status == "completed"),
            progress=progress,
            progress_status=progress_status,  # type: ignore[arg-type]
            member_count=len(members),
            milestone_count=len(milestones),
        ),
        next_milestone=MilestoneBriefDTO(
            id=upcoming.id, title=upcoming.title, deadline=upcoming.deadline, status=upcoming.status
        )
        if upcoming
        else None,
        members=[p for p in (_person(session, uid) for uid in members) if p],
        lock_version=project.lock_version,
    )


# ---------------------------------------------------------------- B3-03 basic info


def _material_dto(session: Session, row: BProjectMaterial, *, full: bool) -> MaterialDTO:
    return MaterialDTO(
        id=row.id,
        kind=row.kind,  # type: ignore[arg-type]
        title=row.title,
        extract_status=row.extract_status,  # type: ignore[arg-type]
        extract_reason=row.extract_reason,
        text_length=len(row.text_content or ""),
        text=row.text_content if full else None,
        created_by=_person(session, row.created_by),
        created_at=row.created_at,
    )


def setup(session: Session, user: User, project_id: UUID) -> SetupDTO:
    relation = permissions.require_project_read(session, user, project_id)
    project = relation.project
    course = relation.course
    schedule = session.get(BProjectSchedule, project.id, populate_existing=True)
    materials = session.scalars(
        select(BProjectMaterial)
        .where(BProjectMaterial.project_id == project.id)
        .order_by(BProjectMaterial.created_at, BProjectMaterial.id)
    ).all()
    return SetupDTO(
        project_id=project.id,
        name=project.name,
        project_type=project.project_type,
        description=project.description,
        start_date=schedule.start_date if schedule else None,
        end_date=_local_date(project.final_deadline),
        course_deadline=_local_date(course.project_deadline) if course else None,
        setup_status=project.setup_status,
        setup_step=project.setup_step,
        can_edit=relation.member
        and not relation.read_only
        and project.setup_status in EDITABLE_SETUP,
        materials=[_material_dto(session, m, full=False) for m in materials],
        lock_version=project.lock_version,
    )


def _require_setup_writer(session: Session, user: User, project_id: UUID):
    relation = permissions.require_project_member(session, user, project_id)
    project = session.scalar(
        select(Project)
        .where(Project.id == project_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if project.setup_status not in EDITABLE_SETUP:
        raise ApiError(409, "BASELINE_FROZEN", "需求基线已冻结，初始化信息不能再修改。")
    return relation, project


def save_basic(
    session: Session, user: User, project_id: UUID, command: SaveBasic, request=None
) -> SetupDTO:
    relation, project = _require_setup_writer(session, user, project_id)
    require_version(project.lock_version, command.expected_version)
    name = command.name.strip()
    if not name:
        raise ApiError(422, "PROJECT_NAME_REQUIRED", "请填写项目名称。", details={"field": "name"})
    if command.end_date < command.start_date:
        raise ApiError(
            422, "END_BEFORE_START", "结束日期不能早于开始日期。", details={"field": "end_date"}
        )
    course_deadline = relation.course.project_deadline if relation.course is not None else None
    if course_deadline is not None and command.end_date > _local_date(course_deadline):
        raise ApiError(
            422,
            "END_AFTER_COURSE_DEADLINE",
            "结束日期不能晚于课程截止日期。",
            details={
                "field": "end_date",
                "course_deadline": _local_date(course_deadline).isoformat(),
            },
        )
    schedule = session.get(BProjectSchedule, project.id, with_for_update=True)
    before = {
        "name": project.name,
        "project_type": project.project_type,
        "start_date": schedule.start_date if schedule else None,
        "final_deadline": project.final_deadline,
    }
    end_of_day = datetime.combine(command.end_date, time(23, 59, 59), tzinfo=LOCAL_TZ)
    project.name = name
    project.project_type = (command.project_type or "").strip() or None
    project.description = (command.description or "").strip() or None
    if schedule is None:
        session.add(BProjectSchedule(project_id=project.id, start_date=command.start_date))
    else:
        schedule.start_date = command.start_date
        schedule.updated_at = now()
    project.final_deadline = min(end_of_day, course_deadline) if course_deadline else end_of_day
    project.setup_step = max(project.setup_step, 2)
    if project.setup_status == "not_initialized":
        project.setup_status = "draft"
    project.lock_version += 1
    session.flush()
    record_audit(
        session,
        actor=user,
        action="project.setup.basic_saved",
        target=("project", project.id),
        project_id=project.id,
        course_id=project.course_id,
        before=before,
        after={"name": name, "start_date": command.start_date, "end_date": command.end_date},
        request=request,
    )
    return setup(session, user, project_id)


# ---------------------------------------------------------------- B3-04 materials


def add_material(
    session: Session,
    user: User,
    project_id: UUID,
    command: AddMaterial,
    texts: MaterialTextPort,
    request=None,
) -> MaterialDTO:
    _, project = _require_setup_writer(session, user, project_id)
    if command.kind == "text":
        body = (command.text or "").strip()
        if not body:
            raise ApiError(
                422, "MATERIAL_TEXT_REQUIRED", "请粘贴资料正文。", details={"field": "text"}
            )
        title = (command.title or "").strip() or body.splitlines()[0][:80]
        row = BProjectMaterial(
            project_id=project.id,
            kind="text",
            title=title,
            text_content=body,
            extract_status="ready",
            created_by=user.id,
        )
    else:
        if command.receipt_id is None:
            raise ApiError(
                422, "UPLOAD_RECEIPT_REQUIRED", "请先上传文件。", details={"field": "receipt_id"}
            )
        receipt = session.scalar(
            select(UploadReceipt).where(
                UploadReceipt.id == command.receipt_id,
                UploadReceipt.scope == "project",
                UploadReceipt.scope_id == project.id,
                UploadReceipt.actor_id == user.id,
                UploadReceipt.status == "completed",
            )
        )
        if receipt is None:
            raise ApiError(409, "UPLOAD_RECEIPT_INVALID", "上传凭证无效或尚未完成。")
        if session.scalar(
            select(BProjectMaterial.id).where(
                BProjectMaterial.project_id == project.id,
                BProjectMaterial.receipt_id == receipt.id,
            )
        ):
            raise ApiError(409, "MATERIAL_ALREADY_ADDED", "这个文件已经添加过了。")
        extracted = texts.get_text(session, receipt_id=receipt.id, actor_id=user.id)
        row = BProjectMaterial(
            project_id=project.id,
            kind="file",
            title=(command.title or "").strip() or receipt.filename,
            receipt_id=receipt.id,
            text_content=extracted.text if extracted.status == "ready" else None,
            extract_status=extracted.status,
            extract_reason=extracted.reason,
            created_by=user.id,
        )
    session.add(row)
    project.setup_step = max(project.setup_step, 2)
    session.flush()
    record_audit(
        session,
        actor=user,
        action="project.material.added",
        target=("project_material", row.id),
        project_id=project.id,
        course_id=project.course_id,
        after={"kind": row.kind, "title": row.title, "extract_status": row.extract_status},
        request=request,
    )
    return _material_dto(session, row, full=True)


def material(session: Session, user: User, project_id: UUID, material_id: UUID) -> MaterialDTO:
    permissions.require_project_read(session, user, project_id)
    row = session.get(BProjectMaterial, material_id)
    if row is None or row.project_id != project_id:
        raise ApiError(404, "MATERIAL_NOT_FOUND", "资料不存在。")
    return _material_dto(session, row, full=True)


def material_count(session: Session, project_id: UUID) -> int:
    return (
        session.scalar(
            select(func.count())
            .select_from(BProjectMaterial)
            .where(BProjectMaterial.project_id == project_id)
        )
        or 0
    )
