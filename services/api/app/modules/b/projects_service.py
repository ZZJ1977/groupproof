"""B-3: create a group's project (B3-01), overview (B3-02), basic info (B3-03)
and materials (B3-04).

* One project per group: checked under the group row lock and enforced by the
  ``uq_projects_group_id`` index, so concurrent creates make exactly one.
* A new project copies the current group members, the course project deadline
  and the course milestone template, all in one transaction.
* Overview progress uses C's ``progress_projection`` (root-weighted) so B and C
  never show two different numbers.
* File materials need a completed A4-04 receipt for this project; their text
  comes only from A4-05 (``MaterialTextPort``) and is never invented.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
from datetime import date, datetime, time, timedelta
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import (
    Course,
    CourseMember,
    GroupMember,
    Milestone,
    Project,
    ProjectGroup,
    ProjectMember,
    Task,
    User,
)
from app.modules.a import permissions, storage, text_extraction
from app.modules.a.audit import record_audit
from app.modules.a.inbox import notify
from app.modules.a.models import UploadReceipt
from app.modules.a.permissions import Target
from app.modules.b.common import lock_project_for_write, now, require_version
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
    AttachCourseResultDTO,
    AttachProjectToCourse,
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
    UploadInlineMaterial,
)
from app.modules.c.task_execution import progress_projection
from app.modules.d.models import CourseTemplateApplication
from app.modules.d.teacher_course import apply_template, latest_rule

LOCAL_TZ = ZoneInfo("Asia/Shanghai")
# Setup can change only while the baseline is a draft (not in confirmation, not frozen).
EDITABLE_SETUP = {"not_initialized", "draft"}


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
    course = session.get(Course, course_id)
    row = session.get(BCourseProjectTemplate, course_id)
    rule = latest_rule(session, course_id)
    template = rule.rules.get("template") if rule else None
    if template:
        milestones = [
            MilestoneTemplateItem(
                title=item["name"],
                description="必交材料："
                + "、".join(item.get("required_materials", []))
                + f"；权重：{item['weight']}%",
            )
            for item in template.get("milestones", [])
        ]
    else:
        milestones = [MilestoneTemplateItem(**m) for m in (row.milestones if row else [])]
    return ProjectTemplateDTO(
        course_id=course_id,
        milestones=milestones,
        lock_version=row.lock_version if row else 0,
        course_rule_version_id=rule.id if rule else None,
        course_rule_version=rule.version_no if rule else None,
        min_group_size=course.min_group_size,
        max_group_size=course.max_group_size,
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
    return get_template(session, user, course_id)


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
    # Lock the course before its group, matching the teacher lifecycle write order.
    # This keeps settings/end changes out until the project and rule binding commit.
    course = session.scalar(
        select(Course)
        .where(Course.id == group.course_id)
        .with_for_update(read=True)
        .execution_options(populate_existing=True)
    )
    group = session.scalar(
        select(ProjectGroup)
        .where(ProjectGroup.id == group_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    # A leader change may have committed while this request waited for the lock.
    permissions.require_action(session, user, "project.create", Target("group", group_id))
    if course.status != "active":
        raise ApiError(409, "COURSE_CLOSED", "课程已经结束。")
    if _project_of_group(session, group_id) is not None:
        raise ApiError(409, "PROJECT_ALREADY_EXISTS", "本组已经创建了项目。")
    if command.expected_group_version is not None:
        require_version(group.lock_version, command.expected_group_version)
    rule = latest_rule(session, course.id)
    if rule is None:
        raise ApiError(409, "COURSE_RULES_NOT_PUBLISHED", "课程尚未发布规则，请联系老师。")
    if (
        command.expected_course_rule_version_id is not None
        and command.expected_course_rule_version_id != rule.id
    ):
        raise ApiError(
            409, "COURSE_RULE_VERSION_CONFLICT", "课程规则已更新，请刷新并确认后再创建。"
        )
    members = session.scalars(
        select(GroupMember).where(GroupMember.group_id == group.id, GroupMember.left_at.is_(None))
    ).all()
    if not course.min_group_size <= len(members) <= course.max_group_size:
        raise ApiError(
            409,
            "GROUP_SIZE_INVALID",
            f"小组人数需在 {course.min_group_size}–{course.max_group_size} 人之间。",
            details={
                "min": course.min_group_size,
                "max": course.max_group_size,
                "member_count": len(members),
            },
        )
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
    for member in members:
        session.add(
            ProjectMember(
                project_id=project.id,
                user_id=member.user_id,
                role="leader" if member.user_id == group.leader_id else "member",
            )
        )
    published_template = rule.rules.get("template")
    optional_template = session.get(BCourseProjectTemplate, course.id)
    optional_milestones = optional_template.milestones if optional_template else []
    if published_template:
        apply_template(session, project.id, rule, published_template)
        milestone_count = len(published_template.get("milestones", []))
    else:
        # Older B optional templates carry dates/titles, not grading weights.
        # Preserve their real snapshot without inventing D grading requirements.
        session.add(
            CourseTemplateApplication(
                project_id=project.id,
                version_id=rule.id,
                template={
                    "source": "optional_course_milestones",
                    "milestones": optional_milestones,
                },
            )
        )
        for index, item in enumerate(optional_milestones):
            session.add(
                Milestone(
                    project_id=project.id,
                    title=item["title"],
                    description=item.get("description"),
                    deadline=datetime.fromisoformat(item["deadline"])
                    if item.get("deadline")
                    else None,
                    sort_order=index + 1,
                )
            )
        milestone_count = len(optional_milestones)
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
                description="请进入项目完善设置并开始协作。",
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
            "milestones": milestone_count,
            "course_rule_version_id": rule.id,
        },
        request=request,
    )
    return CreatedProjectDTO(project_id=project.id, href=f"/projects/{project.id}")


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
    relation = lock_project_for_write(session, user, project_id)
    project = relation.project
    if project.setup_status == "frozen":
        raise ApiError(409, "BASELINE_FROZEN", "需求基线已冻结，初始化信息不能再修改。")
    if project.setup_status not in EDITABLE_SETUP:
        raise ApiError(
            409, "BASELINE_IN_CONFIRMATION", "基线正在等待组员确认，确认结束前不能修改。"
        )
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


MAX_INLINE_MATERIAL_BYTES = 15 * 1024 * 1024


def upload_inline_material(
    session: Session,
    user: User,
    project_id: UUID,
    command: UploadInlineMaterial,
    request=None,
) -> MaterialDTO:
    """Direct server-side material verification + extraction when object storage is unconfigured."""
    _, project = _require_setup_writer(session, user, project_id)
    try:
        raw_bytes = base64.b64decode(command.content_base64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ApiError(422, "INVALID_FILE_PAYLOAD", "文件编码无效，请重新选择文件上传。") from exc

    if not 0 < len(raw_bytes) <= MAX_INLINE_MATERIAL_BYTES:
        raise ApiError(413, "FILE_TOO_LARGE", "初始化资料单文件不能为空，且不能超过 15MB。")

    extension = storage.validate_file(command.filename, command.mime_type, len(raw_bytes))
    scan_reason = storage.BasicContentScanner().scan(raw_bytes, extension=extension)
    if scan_reason is not None:
        raise ApiError(
            422,
            "FILE_CONTENT_REJECTED",
            f"文件内容校验未通过（{scan_reason}），请检查文件格式是否真实有效。",
        )

    digest = hashlib.sha256(raw_bytes).hexdigest()
    ts = now()
    receipt_id = uuid4()
    safe_name = storage._FILENAME_SAFE.sub("_", command.filename)[-120:] or "material"
    receipt = UploadReceipt(
        id=receipt_id,
        scope="project",
        scope_id=project.id,
        actor_id=user.id,
        provider="inline",
        bucket="inline-materials",
        object_id=f"project/{project.id}/{receipt_id}/{safe_name}",
        filename=command.filename,
        declared_mime=command.mime_type,
        declared_size=len(raw_bytes),
        status="completed",
        content_hash=digest,
        size_bytes=len(raw_bytes),
        mime_type=command.mime_type,
        scan_status="clean",
        created_at=ts,
        upload_expires_at=ts + timedelta(hours=2),
        completed_at=ts,
    )
    session.add(receipt)
    session.flush()

    extract_status = "ready"
    extract_reason: str | None = None
    text_content: str | None = None
    try:
        extracted = text_extraction.extract_text(raw_bytes, extension)
        if not extracted.text.strip():
            extract_status = "failed"
            extract_reason = (
                "未检测到可提取的文字内容（可能为空白文件或扫描版 PDF），请粘贴文本资料。"
            )
        else:
            text_content = extracted.text
            if extracted.truncated:
                extract_reason = "文件正文较长，已按上限截断。"
    except ApiError as err:
        extract_status = "failed"
        extract_reason = err.message

    row = BProjectMaterial(
        project_id=project.id,
        kind="file",
        title=(command.title or "").strip() or command.filename,
        receipt_id=receipt.id,
        text_content=text_content,
        extract_status=extract_status,
        extract_reason=extract_reason,
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


# ---------------------------------------------------------------- attach project to course


def _unique_group_name(session: Session, course_id: UUID, base_name: str) -> str:
    clean = base_name.strip()[:120] or "项目小组"
    candidate = clean
    suffix = 2
    while (
        session.scalar(
            select(ProjectGroup.id).where(
                ProjectGroup.course_id == course_id,
                ProjectGroup.name == candidate,
            )
        )
        is not None
    ):
        tag = f" ({suffix})"
        candidate = f"{clean[: 120 - len(tag)]}{tag}"
        suffix += 1
    return candidate


def attach_project_to_course(
    session: Session,
    user: User,
    project_id: UUID,
    command: AttachProjectToCourse,
    request=None,
) -> AttachCourseResultDTO:
    project = session.scalar(
        select(Project)
        .where(Project.id == project_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if project is None:
        raise ApiError(404, "PROJECT_NOT_FOUND", "项目不存在。")

    caller_member = session.scalar(
        select(ProjectMember).where(
            ProjectMember.project_id == project.id,
            ProjectMember.user_id == user.id,
            ProjectMember.left_at.is_(None),
        )
    )
    if caller_member is None or caller_member.role != "leader":
        raise ApiError(403, "PROJECT_LEADER_REQUIRED", "只有项目组长可以将独立项目移入课程。")

    if project.lifecycle != "active":
        raise ApiError(409, "PROJECT_NOT_ACTIVE", "仅进行中的项目可以移入课程。")

    if project.course_id is not None:
        raise ApiError(409, "PROJECT_ALREADY_IN_COURSE", "该项目已关联课程，无需重复移入。")

    course = session.scalar(
        select(Course)
        .where(Course.id == command.course_id)
        .with_for_update(read=True)
        .execution_options(populate_existing=True)
    )
    if course is None:
        raise ApiError(404, "COURSE_NOT_FOUND", "课程不存在。")
    if course.status != "active":
        raise ApiError(409, "COURSE_CLOSED", "课程已经结束。")

    course_member = session.scalar(
        select(CourseMember).where(
            CourseMember.course_id == course.id,
            CourseMember.user_id == user.id,
            CourseMember.role == "student",
            CourseMember.status == "active",
            CourseMember.left_at.is_(None),
        )
    )
    if course_member is None:
        raise ApiError(403, "COURSE_MEMBER_REQUIRED", "只有本课程的学生可以将项目移入该课程。")

    if command.group_id is not None:
        group = session.scalar(
            select(ProjectGroup)
            .where(ProjectGroup.id == command.group_id, ProjectGroup.course_id == course.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if group is None:
            raise ApiError(404, "GROUP_NOT_FOUND", "小组不存在。")
        gm = session.scalar(
            select(GroupMember).where(
                GroupMember.group_id == group.id,
                GroupMember.user_id == user.id,
                GroupMember.left_at.is_(None),
            )
        )
        if gm is None or gm.role != "leader":
            raise ApiError(403, "GROUP_LEADER_REQUIRED", "只有该小组的组长可以将项目关联到此小组。")
        existing_proj = session.scalar(
            select(Project.id).where(
                Project.group_id == group.id,
                Project.archived_at.is_(None),
            )
        )
        if existing_proj is not None:
            raise ApiError(409, "GROUP_HAS_PROJECT", "该小组已有项目，无法再移入其他项目。")
    else:
        existing_group = session.scalar(
            select(ProjectGroup)
            .join(GroupMember, GroupMember.group_id == ProjectGroup.id)
            .where(
                ProjectGroup.course_id == course.id,
                GroupMember.user_id == user.id,
                GroupMember.left_at.is_(None),
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if existing_group is not None:
            gm = session.scalar(
                select(GroupMember).where(
                    GroupMember.group_id == existing_group.id,
                    GroupMember.user_id == user.id,
                    GroupMember.left_at.is_(None),
                )
            )
            if gm is None or gm.role != "leader":
                raise ApiError(
                    403, "GROUP_LEADER_REQUIRED", "只有该小组的组长可以将项目关联到此小组。"
                )
            existing_proj = session.scalar(
                select(Project.id).where(
                    Project.group_id == existing_group.id,
                    Project.archived_at.is_(None),
                )
            )
            if existing_proj is not None:
                raise ApiError(
                    409, "GROUP_HAS_PROJECT", "你在该课程所在的小组已有项目，无法再移入其他项目。"
                )
            group = existing_group
        else:
            group = ProjectGroup(
                course_id=course.id,
                name=_unique_group_name(session, course.id, project.name[:120]),
                leader_id=user.id,
            )
            session.add(group)
            session.flush()
            session.add(GroupMember(group_id=group.id, user_id=user.id, role="leader"))

    members_synced = 0
    if not group.roster_frozen:
        other_project_members = session.scalars(
            select(ProjectMember).where(
                ProjectMember.project_id == project.id,
                ProjectMember.user_id != user.id,
                ProjectMember.left_at.is_(None),
            )
        ).all()
        for pm in other_project_members:
            in_course = session.scalar(
                select(CourseMember.id).where(
                    CourseMember.course_id == course.id,
                    CourseMember.user_id == pm.user_id,
                    CourseMember.status == "active",
                    CourseMember.left_at.is_(None),
                )
            )
            if in_course is None:
                continue
            in_any_group = session.scalar(
                select(GroupMember.id)
                .join(ProjectGroup, ProjectGroup.id == GroupMember.group_id)
                .where(
                    ProjectGroup.course_id == course.id,
                    GroupMember.user_id == pm.user_id,
                    GroupMember.left_at.is_(None),
                )
            )
            if in_any_group is not None:
                continue
            session.add(GroupMember(group_id=group.id, user_id=pm.user_id, role="member"))
            members_synced += 1

    project.course_id = course.id
    project.group_id = group.id
    project.lock_version += 1
    session.flush()

    record_audit(
        session,
        actor=user,
        action="project.attached_to_course",
        target=("project", project.id),
        project_id=project.id,
        course_id=course.id,
        after={
            "course_id": str(course.id),
            "group_id": str(group.id),
            "group_name": group.name,
            "members_synced": members_synced,
        },
        request=request,
    )
    return AttachCourseResultDTO(
        project_id=project.id,
        course_id=course.id,
        group_id=group.id,
        group_name=group.name,
        members_synced=members_synced,
        already_attached=False,
    )
