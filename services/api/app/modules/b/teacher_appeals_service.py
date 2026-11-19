"""Service logic for student course appeals and teacher adjudication + snapshot adjustment."""

from __future__ import annotations

from uuid import UUID, uuid4

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models.core import (
    Course,
    CourseMember,
    CourseStaff,
    Project,
    ProjectGroup,
    ProjectMember,
    Task,
    TaskAssignee,
    User,
)
from app.modules.a import permissions
from app.modules.a.audit import record_audit
from app.modules.a.inbox import create_action_item, notify
from app.modules.a.models import ActionItem, GithubActivity
from app.modules.b.common import now
from app.modules.b.models import BCourseAppeal, BCourseAppealDecision
from app.modules.b.teacher_appeals_schemas import (
    AppealContributionMemberDTO,
    AppealDecisionDTO,
    AppealDetailDTO,
    AppealListDTO,
    AppealSnapshotContextDTO,
    AppealSummaryDTO,
    AppealTaskRefDTO,
    HandleAppealRequest,
    SubmitAppealRequest,
    SupplementAppealRequest,
)
from app.modules.b.teacher_permissions import (
    effective_permissions,
    has_staff_permission,
    require_staff_permission,
)
from app.modules.d.models import (
    ContributionCalculation,
    ContributionItem,
    ContributionSnapshot,
)


def _load_course(session: Session, course_id: UUID) -> Course:
    course = session.get(Course, course_id)
    if course is None:
        raise ApiError(404, "COURSE_NOT_FOUND", "班级不存在。")
    return course


def _require_active_course(session: Session, course_id: UUID) -> Course:
    course = _load_course(session, course_id)
    if course.status != "active":
        raise ApiError(409, "COURSE_NOT_ACTIVE", "课程已结课或未激活，当前为只读状态。")
    return course


def _user_map(session: Session, ids: set[UUID]) -> dict[UUID, User]:
    if not ids:
        return {}
    return {u.id: u for u in session.scalars(select(User).where(User.id.in_(ids))).all()}


def _appeal_summary(
    appeal: BCourseAppeal,
    *,
    projects: dict[UUID, Project],
    groups: dict[UUID, ProjectGroup],
    users: dict[UUID, User],
) -> AppealSummaryDTO:
    proj = projects.get(appeal.project_id)
    grp = groups.get(proj.group_id) if proj and proj.group_id else None
    app_user = users.get(appeal.appellant_id)
    res_user = users.get(appeal.resolved_by) if appeal.resolved_by else None
    return AppealSummaryDTO(
        id=appeal.id,
        course_id=appeal.course_id,
        project_id=appeal.project_id,
        project_name=proj.name if proj else "",
        group_name=grp.name if grp else None,
        appellant_id=appeal.appellant_id,
        appellant_name=(app_user.name or app_user.email or "") if app_user else "",
        student_number=app_user.student_id if app_user else None,
        appeal_type=appeal.appeal_type,  # type: ignore[arg-type]
        title=appeal.title,
        content=appeal.content,
        supplement_text=appeal.supplement_text,
        evidence=list(appeal.evidence_json or []),
        status=appeal.status,  # type: ignore[arg-type]
        resolved_by=appeal.resolved_by,
        resolver_name=(res_user.name or res_user.email) if res_user else None,
        resolved_at=appeal.resolved_at,
        created_at=appeal.created_at,
        updated_at=appeal.updated_at,
    )


def _staff_reviewers(session: Session, course: Course) -> list[User]:
    staff_uids = {course.owner_id}
    rows = session.scalars(
        select(CourseStaff.user_id).where(
            CourseStaff.course_id == course.id, CourseStaff.left_at.is_(None)
        )
    ).all()
    staff_uids.update(rows)
    users = list(session.scalars(select(User).where(User.id.in_(staff_uids))).all())
    return [u for u in users if has_staff_permission(session, u, course.id, "approve_changes")]


def submit_appeal(
    session: Session,
    user: User,
    course_id: UUID,
    command: SubmitAppealRequest,
    request=None,
) -> AppealSummaryDTO:
    permissions.require_active(user)
    course = _require_active_course(session, course_id)

    member = session.scalar(
        select(CourseMember).where(
            CourseMember.course_id == course_id,
            CourseMember.user_id == user.id,
            CourseMember.role == "student",
            CourseMember.status == "active",
            CourseMember.left_at.is_(None),
        )
    )
    if member is None:
        raise ApiError(403, "COURSE_MEMBER_REQUIRED", "仅本班在籍学生可以发起申诉。")

    proj: Project | None = None
    if command.project_id is not None:
        proj = session.get(Project, command.project_id)
        if proj is None or proj.course_id != course_id or proj.archived_at is not None:
            raise ApiError(404, "PROJECT_NOT_FOUND", "项目不存在或不属于本班级。")
        in_proj = session.scalar(
            select(ProjectMember.user_id).where(
                ProjectMember.project_id == proj.id,
                ProjectMember.user_id == user.id,
                ProjectMember.left_at.is_(None),
            )
        )
        if in_proj is None:
            raise ApiError(403, "PROJECT_MEMBER_REQUIRED", "只能针对自己参与的项目发起申诉。")
    else:
        proj = session.scalar(
            select(Project)
            .join(ProjectMember, ProjectMember.project_id == Project.id)
            .where(
                Project.course_id == course_id,
                Project.archived_at.is_(None),
                ProjectMember.user_id == user.id,
                ProjectMember.left_at.is_(None),
            )
        )
        if proj is None:
            raise ApiError(409, "PROJECT_NOT_FOUND", "当前未加入本班已立项项目，无法发起申诉。")

    title = command.title.strip()
    content = command.content.strip()
    if not title or not content:
        raise ApiError(422, "INVALID_APPEAL", "申诉标题和正文不能为空。")

    appeal = BCourseAppeal(
        course_id=course_id,
        project_id=proj.id,
        appellant_id=user.id,
        appeal_type=command.appeal_type,
        title=title,
        content=content,
        evidence_json=[e.strip() for e in command.evidence if e.strip()],
        status="pending",
    )
    session.add(appeal)
    session.flush()

    for reviewer in _staff_reviewers(session, course):
        create_action_item(
            session,
            recipient=reviewer,
            category="appeal",
            title=f"新申诉待审核：{appeal.title}"[:200],
            description=f"{user.name or user.email} 针对项目「{proj.name}」提交了申诉。",
            priority="high",
            target={"kind": "appeal", "id": appeal.id, "course_id": course_id},
            source_key=f"course_appeal:{appeal.id}:{reviewer.id}",
        )

    record_audit(
        session,
        actor=user,
        action="course.appeal.submitted",
        target=("course_appeal", appeal.id),
        course_id=course_id,
        after={"appeal_type": appeal.appeal_type, "project_id": str(proj.id)},
        request=request,
    )
    groups = {proj.group_id: session.get(ProjectGroup, proj.group_id)} if proj.group_id else {}
    clean_groups = {gid: g for gid, g in groups.items() if g is not None}
    return _appeal_summary(
        appeal,
        projects={proj.id: proj},
        groups=clean_groups,
        users={user.id: user},
    )


def supplement_appeal(
    session: Session,
    user: User,
    course_id: UUID,
    appeal_id: UUID,
    command: SupplementAppealRequest,
    request=None,
) -> AppealSummaryDTO:
    permissions.require_active(user)
    course = _require_active_course(session, course_id)
    appeal = session.get(BCourseAppeal, appeal_id)
    if appeal is None or appeal.course_id != course_id:
        raise ApiError(404, "APPEAL_NOT_FOUND", "申诉记录不存在。")
    if appeal.appellant_id != user.id:
        raise ApiError(403, "APPEAL_OWNER_REQUIRED", "仅申诉发起人可以补充材料。")
    if appeal.status not in {"pending", "need_supplement"}:
        raise ApiError(409, "APPEAL_ALREADY_RESOLVED", "该申诉已办结，无法继续补充材料。")

    text_val = command.supplement_text.strip()
    if not text_val:
        raise ApiError(422, "INVALID_SUPPLEMENT", "补充说明不能为空。")

    appeal.supplement_text = (
        f"{appeal.supplement_text}\n\n{text_val}" if appeal.supplement_text else text_val
    )
    existing_ev = list(appeal.evidence_json or [])
    existing_ev.extend(e.strip() for e in command.evidence if e.strip())
    appeal.evidence_json = existing_ev
    appeal.status = "pending"

    session.add(
        BCourseAppealDecision(
            appeal_id=appeal.id,
            actor_id=user.id,
            action="supplement_submitted",
            reason=text_val,
        )
    )
    session.flush()

    for reviewer in _staff_reviewers(session, course):
        notify(
            session,
            recipient=reviewer,
            category="course",
            title=f"[申诉补充材料] {appeal.title}"[:290],
            description=f"{user.name or user.email} 已补充申诉说明与佐证。",
            target={"kind": "appeal", "id": appeal.id, "course_id": course_id},
        )

    record_audit(
        session,
        actor=user,
        action="course.appeal.supplemented",
        target=("course_appeal", appeal.id),
        course_id=course_id,
        after={"status": appeal.status},
        request=request,
    )
    proj = session.get(Project, appeal.project_id)
    grp = session.get(ProjectGroup, proj.group_id) if proj and proj.group_id else None
    return _appeal_summary(
        appeal,
        projects={proj.id: proj} if proj else {},
        groups={grp.id: grp} if grp else {},
        users={user.id: user},
    )


def list_my_appeals(session: Session, user: User, course_id: UUID) -> list[AppealSummaryDTO]:
    permissions.require_active(user)
    _load_course(session, course_id)
    rows = list(
        session.scalars(
            select(BCourseAppeal)
            .where(BCourseAppeal.course_id == course_id, BCourseAppeal.appellant_id == user.id)
            .order_by(BCourseAppeal.created_at.desc())
        ).all()
    )
    return _hydrate_summaries(session, course_id, rows)


def _hydrate_summaries(
    session: Session, course_id: UUID, rows: list[BCourseAppeal]
) -> list[AppealSummaryDTO]:
    if not rows:
        return []
    projects = {
        p.id: p
        for p in session.scalars(select(Project).where(Project.course_id == course_id)).all()
    }
    groups = {
        g.id: g
        for g in session.scalars(
            select(ProjectGroup).where(ProjectGroup.course_id == course_id)
        ).all()
    }
    uids = {r.appellant_id for r in rows} | {r.resolved_by for r in rows if r.resolved_by}
    users = _user_map(session, uids)
    return [_appeal_summary(r, projects=projects, groups=groups, users=users) for r in rows]


def list_teacher_appeals(
    session: Session, user: User, course_id: UUID, *, status: str = "all"
) -> AppealListDTO:
    _role, _is_owner, perms = effective_permissions(session, user, course_id)
    _load_course(session, course_id)
    all_rows = list(
        session.scalars(
            select(BCourseAppeal)
            .where(BCourseAppeal.course_id == course_id)
            .order_by(BCourseAppeal.created_at.desc())
        ).all()
    )
    counts = {
        "all": len(all_rows),
        "pending": sum(1 for r in all_rows if r.status == "pending"),
        "need_supplement": sum(1 for r in all_rows if r.status == "need_supplement"),
        "handled": sum(1 for r in all_rows if r.status in {"accepted", "rejected"}),
    }
    if status == "pending":
        filtered = [r for r in all_rows if r.status in {"pending", "need_supplement"}]
    elif status == "handled":
        filtered = [r for r in all_rows if r.status in {"accepted", "rejected"}]
    elif status in {"need_supplement", "accepted", "rejected"}:
        filtered = [r for r in all_rows if r.status == status]
    else:
        filtered = all_rows

    return AppealListDTO(
        course_id=course_id,
        can_handle=bool(perms.get("approve_changes", False)),
        counts=counts,
        items=_hydrate_summaries(session, course_id, filtered),
    )


def get_appeal_detail(
    session: Session, user: User, course_id: UUID, appeal_id: UUID
) -> AppealDetailDTO:
    _role, _is_owner, perms = effective_permissions(session, user, course_id)
    appeal = session.get(BCourseAppeal, appeal_id)
    if appeal is None or appeal.course_id != course_id:
        raise ApiError(404, "APPEAL_NOT_FOUND", "申诉记录不存在。")

    summary = _hydrate_summaries(session, course_id, [appeal])[0]
    decisions = list(
        session.scalars(
            select(BCourseAppealDecision)
            .where(BCourseAppealDecision.appeal_id == appeal.id)
            .order_by(BCourseAppealDecision.created_at.asc())
        ).all()
    )
    decision_uids = {d.actor_id for d in decisions}
    decision_users = _user_map(session, decision_uids)

    tasks = list(
        session.scalars(
            select(Task)
            .join(TaskAssignee, TaskAssignee.task_id == Task.id)
            .where(
                Task.project_id == appeal.project_id,
                TaskAssignee.user_id == appeal.appellant_id,
                TaskAssignee.unassigned_at.is_(None),
            )
            .order_by(Task.created_at.desc())
        ).all()
    )

    github_commits = int(
        session.scalar(
            select(func.count(GithubActivity.id)).where(
                GithubActivity.project_id == appeal.project_id,
                GithubActivity.author_user_id == appeal.appellant_id,
                GithubActivity.deleted.is_(False),
                GithubActivity.kind == "commit",
            )
        )
        or 0
    )

    snap = session.scalar(
        select(ContributionSnapshot)
        .where(ContributionSnapshot.project_id == appeal.project_id)
        .order_by(ContributionSnapshot.version_no.desc())
    )
    snap_items_dto: list[AppealContributionMemberDTO] = []
    if snap is not None:
        item_rows = session.execute(
            select(ContributionItem, User)
            .join(User, User.id == ContributionItem.user_id)
            .where(ContributionItem.snapshot_id == snap.id)
            .order_by(ContributionItem.share.desc())
        ).all()
        for ci, u in item_rows:
            snap_items_dto.append(
                AppealContributionMemberDTO(
                    user_id=u.id,
                    name=u.name or u.email or "",
                    student_number=u.student_id,
                    share=float(ci.share),
                    task_credit=float(ci.task_credit),
                    collaboration_credit=float(ci.collaboration_credit),
                    acceptance_rate=float(ci.acceptance_rate),
                    status=ci.status,
                    note=ci.note,
                )
            )
    else:
        member_users = list(
            session.scalars(
                select(User)
                .join(ProjectMember, ProjectMember.user_id == User.id)
                .where(
                    ProjectMember.project_id == appeal.project_id,
                    ProjectMember.left_at.is_(None),
                )
            ).all()
        )
        even = round(100.0 / len(member_users), 2) if member_users else 0.0
        for u in member_users:
            snap_items_dto.append(
                AppealContributionMemberDTO(
                    user_id=u.id,
                    name=u.name or u.email or "",
                    student_number=u.student_id,
                    share=even,
                    task_credit=0.0,
                    collaboration_credit=0.0,
                    acceptance_rate=100.0,
                    status="draft",
                    note=None,
                )
            )

    return AppealDetailDTO(
        appeal=summary,
        can_handle=bool(perms.get("approve_changes", False)),
        decisions=[
            AppealDecisionDTO(
                id=d.id,
                actor_id=d.actor_id,
                actor_name=(
                    (decision_users[d.actor_id].name or decision_users[d.actor_id].email or "")
                    if d.actor_id in decision_users
                    else ""
                ),
                action=d.action,
                reason=d.reason,
                snapshot_id=d.snapshot_id,
                adjustments=d.adjustments_json,
                created_at=d.created_at,
            )
            for d in decisions
        ],
        appellant_tasks=[
            AppealTaskRefDTO(
                id=t.id, title=t.title, status=t.status, progress_percent=t.progress_percent
            )
            for t in tasks
        ],
        github_commit_count=github_commits,
        snapshot=AppealSnapshotContextDTO(
            snapshot_id=snap.id if snap else None,
            version_no=snap.version_no if snap else None,
            status=snap.status if snap else None,
            frozen_at=snap.frozen_at if snap else None,
            items=snap_items_dto,
        ),
    )


def _create_adjusted_snapshot(
    session: Session,
    *,
    appeal: BCourseAppeal,
    actor: User,
    reason: str,
    adjustments: list,
    ts,
) -> UUID:
    prev_snap = session.scalar(
        select(ContributionSnapshot)
        .where(ContributionSnapshot.project_id == appeal.project_id)
        .order_by(ContributionSnapshot.version_no.desc())
    )
    prev_items: dict[UUID, ContributionItem] = {}
    if prev_snap is not None:
        for item in session.scalars(
            select(ContributionItem).where(ContributionItem.snapshot_id == prev_snap.id)
        ).all():
            prev_items[item.user_id] = item

    adj_map = {a.user_id: a for a in adjustments}
    member_ids = set(
        session.scalars(
            select(ProjectMember.user_id).where(
                ProjectMember.project_id == appeal.project_id,
                ProjectMember.left_at.is_(None),
            )
        ).all()
    )
    target_uids = list(dict.fromkeys([*prev_items.keys(), *adj_map.keys(), *member_ids]))

    calc = ContributionCalculation(
        id=uuid4(),
        project_id=appeal.project_id,
        formula_version="teacher_appeal_adjustment_v1",
        status="completed",
        basis_version=f"appeal:{appeal.id}",
        calculated_by=actor.id,
        completed_at=ts,
    )
    session.add(calc)
    session.flush()

    max_ver = (
        session.scalar(
            select(func.max(ContributionSnapshot.version_no)).where(
                ContributionSnapshot.project_id == appeal.project_id
            )
        )
        or 0
    )
    new_snap = ContributionSnapshot(
        id=uuid4(),
        project_id=appeal.project_id,
        calculation_id=calc.id,
        version_no=int(max_ver) + 1,
        status="frozen",
        created_by=actor.id,
        frozen_at=ts,
    )
    session.add(new_snap)
    session.flush()

    for uid in target_uids:
        old = prev_items.get(uid)
        adj = adj_map.get(uid)
        share = adj.share if adj else (float(old.share) if old else 0.0)
        task_c = (
            adj.task_credit
            if adj and adj.task_credit is not None
            else (float(old.task_credit) if old else 0.0)
        )
        collab_c = (
            adj.collaboration_credit
            if adj and adj.collaboration_credit is not None
            else (float(old.collaboration_credit) if old else 0.0)
        )
        acc = (
            adj.acceptance_rate
            if adj and adj.acceptance_rate is not None
            else (float(old.acceptance_rate) if old else 100.0)
        )
        note = (
            adj.note
            if adj and adj.note
            else (f"申诉调权：{reason}" if adj else (old.note if old else None))
        )
        session.add(
            ContributionItem(
                id=uuid4(),
                snapshot_id=new_snap.id,
                user_id=uid,
                task_credit=task_c,
                collaboration_credit=collab_c,
                share=share,
                acceptance_rate=acc,
                status="formal",
                note=note,
            )
        )
    session.flush()
    return new_snap.id


def handle_appeal(
    session: Session,
    user: User,
    course_id: UUID,
    appeal_id: UUID,
    command: HandleAppealRequest,
    request=None,
) -> AppealDetailDTO:
    require_staff_permission(session, user, course_id, "approve_changes")
    _require_active_course(session, course_id)
    appeal = session.get(BCourseAppeal, appeal_id)
    if appeal is None or appeal.course_id != course_id:
        raise ApiError(404, "APPEAL_NOT_FOUND", "申诉记录不存在。")
    if appeal.status in {"accepted", "rejected"}:
        raise ApiError(409, "APPEAL_ALREADY_RESOLVED", "该申诉已处理完成，不能重复裁决。")

    reason = command.reason.strip()
    if not reason:
        raise ApiError(422, "REASON_REQUIRED", "请填写处理结论或原因。")

    ts = now()
    new_snap_id: UUID | None = None
    adj_dump: list[dict] | None = None

    if command.action == "request_supplement":
        appeal.status = "need_supplement"
        notify_title = f"[申诉需补充材料] {appeal.title}"
    elif command.action == "reject":
        appeal.status = "rejected"
        appeal.resolved_by = user.id
        appeal.resolved_at = ts
        notify_title = f"[申诉已驳回] {appeal.title}"
    else:
        appeal.status = "accepted"
        appeal.resolved_by = user.id
        appeal.resolved_at = ts
        if command.contribution_adjustments:
            adj_dump = [a.model_dump(mode="json") for a in command.contribution_adjustments]
            new_snap_id = _create_adjusted_snapshot(
                session,
                appeal=appeal,
                actor=user,
                reason=reason,
                adjustments=command.contribution_adjustments,
                ts=ts,
            )
        notify_title = f"[申诉已受理] {appeal.title}"

    session.add(
        BCourseAppealDecision(
            appeal_id=appeal.id,
            actor_id=user.id,
            action=command.action,
            reason=reason,
            snapshot_id=new_snap_id,
            adjustments_json=adj_dump,
        )
    )

    if command.action in {"accept", "reject"}:
        pending_items = session.scalars(
            select(ActionItem).where(
                ActionItem.category == "appeal",
                ActionItem.status == "pending",
            )
        ).all()
        target_status = "completed" if command.action == "accept" else "rejected"
        for ai in pending_items:
            if (ai.target_json or {}).get("id") == str(appeal.id):
                ai.status = target_status
                ai.closed_at = ts
                ai.closed_by = user.id

    notify(
        session,
        recipient=appeal.appellant_id,
        category="course",
        title=notify_title[:290],
        description=reason,
        target={"kind": "appeal", "id": appeal.id, "course_id": course_id},
    )

    session.flush()
    record_audit(
        session,
        actor=user,
        action=f"course.appeal.{command.action}",
        target=("course_appeal", appeal.id),
        course_id=course_id,
        project_id=appeal.project_id,
        after={
            "status": appeal.status,
            "snapshot_id": str(new_snap_id) if new_snap_id else None,
        },
        reason=reason,
        request=request,
    )
    return get_appeal_detail(session, user, course_id, appeal_id)
