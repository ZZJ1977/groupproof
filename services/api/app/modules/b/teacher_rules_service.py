"""Course rules versioning and milestone template management for teachers."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import Course, CourseMember, CourseStaff, User
from app.modules.a import permissions
from app.modules.a.audit import record_audit
from app.modules.a.inbox import notify
from app.modules.b.common import now, require_reason
from app.modules.b.models import BCourseProjectTemplate, BCourseRuleVersion
from app.modules.b.teacher_rules_schemas import (
    CourseRulesDTO,
    CourseRulesOverviewDTO,
    MilestoneTemplateOverviewDTO,
    PublishRules,
    RuleMilestoneItem,
    RuleVersionBriefDTO,
    RuleVersionDTO,
    SaveRulesDraft,
)
from app.modules.d.models import CourseRuleVersion


def _load_course(session: Session, course_id: UUID, *, lock: bool = False) -> Course:
    stmt = select(Course).where(Course.id == course_id)
    if lock:
        stmt = stmt.with_for_update()
    course = session.scalar(stmt)
    if course is None:
        raise ApiError(404, "COURSE_NOT_FOUND", "班级不存在。")
    return course


def _require_active(course: Course) -> None:
    if course.status != "active":
        raise ApiError(409, "COURSE_NOT_ACTIVE", "只有进行中的班级可以修改并发布课程规则。")


def _base_rules_from_course(session: Session, course: Course) -> CourseRulesDTO:
    tpl = session.get(BCourseProjectTemplate, course.id)
    raw_items = (tpl.milestones if tpl else None) or []
    milestone_items: list[RuleMilestoneItem] = []
    for item in raw_items:
        milestone_items.append(
            RuleMilestoneItem(
                title=item.get("title") or "未命名里程碑",
                description=item.get("description") or "",
                deadline=item.get("deadline"),
            )
        )
    return CourseRulesDTO(
        grouping_mode="approval" if course.grouping_mode == "approval" else "free",
        min_group_size=course.min_group_size,
        max_group_size=course.max_group_size,
        formation_deadline=course.formation_deadline,
        project_deadline=course.project_deadline,
        milestone_template=milestone_items,
    )


def _publisher_names(session: Session, rows: list[BCourseRuleVersion]) -> dict[UUID, str]:
    ids = {r.published_by for r in rows if r.published_by is not None}
    if not ids:
        return {}
    users = session.scalars(select(User).where(User.id.in_(ids))).all()
    return {u.id: (u.name or u.email or "教师") for u in users}


def _to_dto(row: BCourseRuleVersion, names: dict[UUID, str]) -> RuleVersionDTO:
    return RuleVersionDTO(
        version_no=row.version_no,
        status=row.status,  # type: ignore[arg-type]
        rules=CourseRulesDTO(**(row.rules_json or {})),
        change_summary=row.change_summary or "",
        published_by=names.get(row.published_by) if row.published_by else None,
        published_at=row.published_at,
        created_at=row.created_at,
    )


def _to_brief(row: BCourseRuleVersion, names: dict[UUID, str]) -> RuleVersionBriefDTO:
    return RuleVersionBriefDTO(
        version_no=row.version_no,
        status=row.status,  # type: ignore[arg-type]
        change_summary=row.change_summary or "",
        published_by=names.get(row.published_by) if row.published_by else None,
        published_at=row.published_at,
        created_at=row.created_at,
    )


def get_rules_overview(session: Session, user: User, course_id: UUID) -> CourseRulesOverviewDTO:
    course = _load_course(session, course_id)
    permissions.require_course_staff(session, user, course_id)
    rows = list(
        session.scalars(
            select(BCourseRuleVersion)
            .where(BCourseRuleVersion.course_id == course_id)
            .order_by(BCourseRuleVersion.version_no.desc())
        ).all()
    )
    names = _publisher_names(session, rows)
    published_row = next((r for r in rows if r.status == "published"), None)
    draft_row = next((r for r in rows if r.status == "draft"), None)

    published_dto = _to_dto(published_row, names) if published_row else None
    draft_dto = _to_dto(draft_row, names) if draft_row else None
    effective = published_dto.rules if published_dto else _base_rules_from_course(session, course)
    return CourseRulesOverviewDTO(
        course_id=course_id,
        course_status=course.status,
        can_edit=permissions.is_course_teacher(session, user, course_id)
        and course.status == "active",
        current_published=published_dto,
        draft=draft_dto,
        effective_rules=effective,
        versions=[_to_brief(r, names) for r in rows],
    )


def get_rule_version(
    session: Session, user: User, course_id: UUID, version_no: int
) -> RuleVersionDTO:
    _load_course(session, course_id)
    permissions.require_course_staff(session, user, course_id)
    row = session.scalar(
        select(BCourseRuleVersion).where(
            BCourseRuleVersion.course_id == course_id,
            BCourseRuleVersion.version_no == version_no,
        )
    )
    if row is None:
        raise ApiError(404, "RULE_VERSION_NOT_FOUND", "未找到对应的规则版本。")
    names = _publisher_names(session, [row])
    return _to_dto(row, names)


def get_milestone_template(
    session: Session, user: User, course_id: UUID
) -> MilestoneTemplateOverviewDTO:
    overview = get_rules_overview(session, user, course_id)
    return MilestoneTemplateOverviewDTO(
        course_id=course_id,
        items=overview.effective_rules.milestone_template,
        version_no=overview.current_published.version_no if overview.current_published else None,
    )


def save_rules_draft(
    session: Session, user: User, course_id: UUID, command: SaveRulesDraft, request=None
) -> RuleVersionDTO:
    course = _load_course(session, course_id, lock=True)
    permissions.require_course_teacher(session, user, course_id)
    _require_active(course)

    draft = session.scalar(
        select(BCourseRuleVersion).where(
            BCourseRuleVersion.course_id == course_id,
            BCourseRuleVersion.status == "draft",
        )
    )
    payload = command.rules.model_dump(mode="json")
    summary = command.change_summary.strip() or "更新课程规则草稿"
    if draft is None:
        max_ver = (
            session.scalar(
                select(func.max(BCourseRuleVersion.version_no)).where(
                    BCourseRuleVersion.course_id == course_id
                )
            )
            or 0
        )
        draft = BCourseRuleVersion(
            course_id=course_id,
            version_no=max_ver + 1,
            status="draft",
            rules_json=payload,
            change_summary=summary,
        )
        session.add(draft)
    else:
        draft.rules_json = payload
        draft.change_summary = summary
    session.flush()
    record_audit(
        session,
        actor=user,
        action="course.rules_draft_saved",
        target=("course", course_id),
        course_id=course_id,
        after={"version_no": draft.version_no, "summary": summary},
        request=request,
    )
    names = _publisher_names(session, [draft])
    return _to_dto(draft, names)


def _sync_course_and_template(
    session: Session, course: Course, user: User, rules: CourseRulesDTO, ts: datetime
) -> None:
    course.grouping_mode = rules.grouping_mode
    course.min_group_size = rules.min_group_size
    course.max_group_size = rules.max_group_size
    if rules.formation_deadline is not None:
        course.formation_deadline = rules.formation_deadline
    if rules.project_deadline is not None:
        course.project_deadline = rules.project_deadline
    course.lock_version += 1
    course.updated_at = ts

    # Keep BCourseProjectTemplate aligned using strictly {title, description, deadline}
    # so existing B3/B8 student project creation continues to pass strict validation.
    tpl_items = [
        {
            "title": item.title,
            "description": item.description.strip() or None,
            "deadline": item.deadline.isoformat() if item.deadline is not None else None,
        }
        for item in rules.milestone_template
    ]
    tpl = session.get(BCourseProjectTemplate, course.id)
    if tpl is None:
        tpl = BCourseProjectTemplate(
            course_id=course.id,
            milestones=tpl_items,
            updated_by=user.id,
            updated_at=ts,
            lock_version=1,
        )
        session.add(tpl)
    else:
        tpl.milestones = tpl_items
        tpl.updated_by = user.id
        tpl.updated_at = ts
        tpl.lock_version += 1


def publish_rules(
    session: Session, user: User, course_id: UUID, command: PublishRules, request=None
) -> RuleVersionDTO:
    course = _load_course(session, course_id, lock=True)
    permissions.require_course_teacher(session, user, course_id)
    _require_active(course)
    summary = require_reason(command.change_summary, field="change_summary")
    ts = now()

    existing_published = session.scalars(
        select(BCourseRuleVersion).where(
            BCourseRuleVersion.course_id == course_id,
            BCourseRuleVersion.status == "published",
        )
    ).all()
    draft = session.scalar(
        select(BCourseRuleVersion).where(
            BCourseRuleVersion.course_id == course_id,
            BCourseRuleVersion.status == "draft",
        )
    )

    if command.rules is not None:
        rules_obj = command.rules
    elif draft is not None:
        rules_obj = CourseRulesDTO(**(draft.rules_json or {}))
    else:
        rules_obj = _base_rules_from_course(session, course)

    for prev in existing_published:
        prev.status = "archived"

    payload = rules_obj.model_dump(mode="json")
    if draft is not None:
        draft.status = "published"
        draft.rules_json = payload
        draft.change_summary = summary
        draft.published_by = user.id
        draft.published_at = ts
        published = draft
    else:
        max_ver = (
            session.scalar(
                select(func.max(BCourseRuleVersion.version_no)).where(
                    BCourseRuleVersion.course_id == course_id
                )
            )
            or 0
        )
        published = BCourseRuleVersion(
            course_id=course_id,
            version_no=max_ver + 1,
            status="published",
            rules_json=payload,
            change_summary=summary,
            published_by=user.id,
            published_at=ts,
        )
        session.add(published)

    _sync_course_and_template(session, course, user, rules_obj, ts)
    d_max_ver = (
        session.scalar(
            select(func.max(CourseRuleVersion.version_no)).where(
                CourseRuleVersion.course_id == course_id
            )
        )
        or 0
    )
    session.add(
        CourseRuleVersion(
            course_id=course_id,
            version_no=d_max_ver + 1,
            actor_id=user.id,
            reason=summary,
            rules={
                "settings": {
                    "name": course.name,
                    "grouping_mode": course.grouping_mode,
                    "min_group_size": course.min_group_size,
                    "max_group_size": course.max_group_size,
                    "formation_deadline": course.formation_deadline.isoformat()
                    if course.formation_deadline
                    else None,
                    "project_deadline": course.project_deadline.isoformat()
                    if course.project_deadline
                    else None,
                },
                "b_rule_version_no": published.version_no,
            },
            effective_at=ts,
        )
    )
    session.flush()

    staff_uids = set(
        session.scalars(
            select(CourseStaff.user_id).where(
                CourseStaff.course_id == course_id, CourseStaff.left_at.is_(None)
            )
        ).all()
    )
    student_uids = set(
        session.scalars(
            select(CourseMember.user_id).where(
                CourseMember.course_id == course_id,
                CourseMember.status == "active",
                CourseMember.left_at.is_(None),
            )
        ).all()
    )
    for uid in (staff_uids | student_uids) - {user.id}:
        notify(
            session,
            recipient=uid,
            category="course",
            title=f"「{course.name}」发布了课程规则 v{published.version_no}",
            description=summary,
            target={"kind": "course", "id": course_id, "course_id": course_id},
            dedupe_key=f"course_rule:{course_id}:{published.version_no}",
        )

    record_audit(
        session,
        actor=user,
        action="course.rules_published",
        target=("course", course_id),
        course_id=course_id,
        after={"version_no": published.version_no, "summary": summary},
        reason=summary,
        request=request,
    )
    names = _publisher_names(session, [published])
    return _to_dto(published, names)
