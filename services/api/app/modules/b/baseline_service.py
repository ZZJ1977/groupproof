"""B-4 page 08 step 5: review checklist (B3-07) and baseline confirmation (B3-08).

* The checklist mixes rule items computed from the data on every read with two
  manual ticks; ``submit`` re-checks on the server, so a disabled button is not
  the only guard.
* Submitting writes ``baseline_versions.snapshot_json`` once. It is a copy, so
  later edits to requirements never change a frozen baseline.
* Each member confirms only their own row. The last confirmation freezes the
  baseline; the leader may force-freeze with a reason, and every member who had
  not confirmed is told.
"""

from __future__ import annotations

from uuid import UUID, uuid4

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import (
    BaselineConfirmation,
    BaselineVersion,
    ConflictResolution,
    FunctionalModule,
    Project,
    ProjectMember,
    Requirement,
    RequirementConflict,
    User,
)
from app.modules.a import permissions
from app.modules.a.audit import record_audit
from app.modules.a.inbox import close_action_items_by_source, create_action_item, notify
from app.modules.a.models import ActionItem
from app.modules.b.common import now, require_reason, require_version
from app.modules.b.courses_schemas import PersonDTO
from app.modules.b.models import BBaselineChecklistItem, BBaselineScope, BRequirementMeta
from app.modules.b.requirements_schemas import (
    BaselineDTO,
    CheckItem,
    ChecklistDTO,
    ChecklistItemDTO,
    ConfirmationDTO,
    ConfirmBaseline,
    ForceFreeze,
    SaveScope,
)
from app.modules.b.requirements_service import (
    check_draft,
    open_conflict_count,
    require_draft_writer,
    requirement_dtos,
)

MANUAL_ITEMS = {
    "requirements_reviewed": "组员已逐条看过需求清单",
    "sources_checked": "已核对每条需求的资料出处",
}


def confirm_source_key(baseline_id: UUID) -> str:
    return f"b:baseline-confirm:{baseline_id}"


def _person(session: Session, user_id: UUID | None) -> PersonDTO | None:
    if user_id is None:
        return None
    user = session.get(User, user_id)
    return PersonDTO(id=user.id, name=user.name) if user else None


def _members(session: Session, project_id: UUID) -> list[UUID]:
    return list(
        session.scalars(
            select(ProjectMember.user_id)
            .where(ProjectMember.project_id == project_id, ProjectMember.left_at.is_(None))
            .order_by(ProjectMember.joined_at, ProjectMember.user_id)
        )
    )


def _target(project_id: UUID) -> dict:
    return {"kind": "baseline", "id": project_id, "project_id": project_id}


def _included(session: Session, project_id: UUID) -> list[Requirement]:
    return list(
        session.scalars(
            select(Requirement)
            .join(BRequirementMeta, BRequirementMeta.requirement_id == Requirement.id, isouter=True)
            .where(
                Requirement.project_id == project_id,
                func.coalesce(BRequirementMeta.excluded, False).is_(False),
            )
            .order_by(Requirement.created_at, Requirement.id)
            .execution_options(populate_existing=True)
        )
    )


# ---------------------------------------------------------------- B3-07 scope + checklist


def _scope(session: Session, project_id: UUID) -> BBaselineScope | None:
    return session.get(BBaselineScope, project_id, populate_existing=True)


def checklist(session: Session, user: User, project_id: UUID) -> ChecklistDTO:
    permissions.require_project_read(session, user, project_id)
    return _checklist(session, project_id)


def _checklist(session: Session, project_id: UUID) -> ChecklistDTO:
    scope = _scope(session, project_id)
    members = set(_members(session, project_id))
    modules = session.scalars(
        select(FunctionalModule)
        .where(FunctionalModule.project_id == project_id)
        .order_by(FunctionalModule.sort_order, FunctionalModule.created_at)
        .execution_options(populate_existing=True)
    ).all()
    included = _included(session, project_id)
    used = {r.module_id for r in included}
    empty = [m.name for m in modules if m.id not in used]
    ownerless = [m.name for m in modules if m.owner_id not in members]
    open_count = open_conflict_count(session, project_id)
    ticks = {
        row.item_key: row
        for row in session.scalars(
            select(BBaselineChecklistItem).where(BBaselineChecklistItem.project_id == project_id)
        )
    }
    items = [
        ChecklistItemDTO(
            key="scope_filled",
            label="项目范围已填写",
            kind="rule",
            passed=bool(scope and scope.in_scope.strip()),
        ),
        ChecklistItemDTO(
            key="has_requirements",
            label="至少有一条需求",
            kind="rule",
            passed=bool(included),
        ),
        ChecklistItemDTO(
            key="modules_have_requirements",
            label="每个模块至少有一条需求",
            kind="rule",
            passed=bool(modules) and not empty,
            detail="、".join(empty) or None,
        ),
        ChecklistItemDTO(
            key="modules_have_owners",
            label="每个模块都有负责人",
            kind="rule",
            passed=bool(modules) and not ownerless,
            detail="、".join(ownerless) or None,
        ),
        ChecklistItemDTO(
            key="conflicts_resolved",
            label="冲突已全部处理",
            kind="rule",
            passed=open_count == 0,
            detail=f"还有 {open_count} 个" if open_count else None,
        ),
    ] + [
        ChecklistItemDTO(
            key=key,
            label=label,
            kind="manual",
            passed=key in ticks,
            checked_by=_person(session, ticks[key].checked_by) if key in ticks else None,
        )
        for key, label in MANUAL_ITEMS.items()
    ]
    return ChecklistDTO(
        project_id=project_id,
        items=items,
        ready=all(item.passed for item in items),
        in_scope=scope.in_scope if scope else "",
        out_of_scope=scope.out_of_scope if scope else "",
        scope_version=scope.lock_version if scope else 0,
    )


def save_scope(
    session: Session, user: User, project_id: UUID, command: SaveScope, request=None
) -> ChecklistDTO:
    _, project = require_draft_writer(session, user, project_id)
    row = session.get(BBaselineScope, project.id, with_for_update=True, populate_existing=True)
    require_version(row.lock_version if row else 0, command.expected_version)
    if row is None:
        row = BBaselineScope(project_id=project.id, lock_version=0)
        session.add(row)
    row.in_scope = command.in_scope.strip()
    row.out_of_scope = command.out_of_scope.strip()
    row.updated_by = user.id
    row.updated_at = now()
    row.lock_version += 1
    session.flush()
    record_audit(
        session,
        actor=user,
        action="project.baseline.scope_saved",
        target=("project", project.id),
        project_id=project.id,
        course_id=project.course_id,
        after={"in_scope": len(row.in_scope), "out_of_scope": len(row.out_of_scope)},
        request=request,
    )
    return _checklist(session, project.id)


def set_check(
    session: Session, user: User, project_id: UUID, key: str, command: CheckItem
) -> ChecklistDTO:
    if key not in MANUAL_ITEMS:
        raise ApiError(404, "CHECK_ITEM_NOT_FOUND", "没有这个检查项。")
    _, project = require_draft_writer(session, user, project_id)
    row = session.scalar(
        select(BBaselineChecklistItem).where(
            BBaselineChecklistItem.project_id == project.id,
            BBaselineChecklistItem.item_key == key,
        )
    )
    if command.checked and row is None:
        session.add(
            BBaselineChecklistItem(
                id=uuid4(),
                project_id=project.id,
                item_key=key,
                checked_by=user.id,
                checked_at=now(),
            )
        )
    elif not command.checked and row is not None:
        session.delete(row)
    session.flush()
    return _checklist(session, project.id)


# ---------------------------------------------------------------- B3-08 submit + confirm


def _snapshot(session: Session, project: Project, version_no: int) -> dict:
    scope = _scope(session, project.id)
    modules = session.scalars(
        select(FunctionalModule)
        .where(FunctionalModule.project_id == project.id)
        .order_by(FunctionalModule.sort_order, FunctionalModule.created_at)
    ).all()
    requirements = [r for r in requirement_dtos(session, project.id).values() if not r.excluded]
    conflicts = session.execute(
        select(RequirementConflict, ConflictResolution)
        .join(ConflictResolution, ConflictResolution.conflict_id == RequirementConflict.id)
        .where(RequirementConflict.project_id == project.id)
    ).all()
    return {
        "version_no": version_no,
        "taken_at": now().isoformat(),
        "project": {
            "id": str(project.id),
            "name": project.name,
            "project_type": project.project_type,
            "description": project.description,
            "final_deadline": project.final_deadline.isoformat()
            if project.final_deadline
            else None,
        },
        "scope": {
            "in_scope": scope.in_scope if scope else "",
            "out_of_scope": scope.out_of_scope if scope else "",
        },
        "modules": [
            {
                "id": str(m.id),
                "name": m.name,
                "description": m.description,
                "owner_id": str(m.owner_id) if m.owner_id else None,
            }
            for m in modules
        ],
        "requirements": [
            {
                "id": str(r.id),
                "module_id": str(r.module_id),
                "title": r.title,
                "description": r.description,
                "priority": r.priority,
                "origin": r.origin,
                "sources": [s.model_dump(mode="json") for s in r.sources],
            }
            for r in requirements
        ],
        "conflict_decisions": [
            {
                "conflict_id": str(c.id),
                "left_requirement_id": str(c.left_requirement_id),
                "right_requirement_id": str(c.right_requirement_id),
                "decision": res.decision,
                "reason": res.reason,
            }
            for c, res in conflicts
        ],
    }


def _lock_project(session: Session, project_id: UUID) -> Project:
    return session.scalar(
        select(Project)
        .where(Project.id == project_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )


def submit(session: Session, user: User, project_id: UUID, request=None) -> BaselineDTO:
    permissions.require_project_leader(session, user, project_id)
    project = _lock_project(session, project_id)
    check_draft(project)
    review = _checklist(session, project.id)
    if not review.ready:
        failed = [item.key for item in review.items if not item.passed]
        raise ApiError(
            409, "CHECKLIST_INCOMPLETE", "审核清单还有未满足的项。", details={"failed": failed}
        )
    version_no = (
        session.scalar(
            select(func.max(BaselineVersion.version_no)).where(
                BaselineVersion.project_id == project.id
            )
        )
        or 0
    ) + 1
    baseline = BaselineVersion(
        id=uuid4(),
        project_id=project.id,
        version_no=version_no,
        created_by=user.id,
        status="draft",
        snapshot_json=_snapshot(session, project, version_no),
    )
    session.add(baseline)
    session.flush()
    members = _members(session, project.id)
    for member_id in members:
        mine = member_id == user.id
        session.add(
            BaselineConfirmation(
                id=uuid4(),
                baseline_version_id=baseline.id,
                user_id=member_id,
                status="confirmed" if mine else "pending",
                confirmed_at=now() if mine else None,
            )
        )
    project.setup_status = "pending_confirmation"
    project.setup_step = max(project.setup_step, 5)
    project.lock_version += 1
    session.flush()
    for member_id in members:
        if member_id == user.id:
            continue
        create_action_item(
            session,
            recipient=member_id,
            category="task",
            title=f"请确认「{project.name}」的需求基线 v{version_no}",
            description="确认后基线冻结；有意见可以退回并写明原因。",
            target=_target(project.id),
            source_key=confirm_source_key(baseline.id),
        )
    record_audit(
        session,
        actor=user,
        action="project.baseline.submitted",
        target=("baseline_version", baseline.id),
        project_id=project.id,
        course_id=project.course_id,
        after={
            "version_no": version_no,
            "requirements": len(baseline.snapshot_json["requirements"]),
            "confirmers": [m for m in members if m != user.id],
        },
        request=request,
    )
    if all(m == user.id for m in members):
        _freeze(session, project, baseline, user, forced=False, request=request)
    return _baseline_dto(session, baseline)


def _baseline_for_update(session: Session, project_id: UUID, baseline_id: UUID) -> BaselineVersion:
    row = session.scalar(
        select(BaselineVersion)
        .where(BaselineVersion.id == baseline_id, BaselineVersion.project_id == project_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None:
        raise ApiError(404, "BASELINE_NOT_FOUND", "基线不存在。")
    if row.status != "draft":
        raise ApiError(409, "BASELINE_CLOSED", "这一版基线已经冻结或被退回。")
    return row


def confirm(
    session: Session,
    user: User,
    project_id: UUID,
    baseline_id: UUID,
    member_id: UUID,
    command: ConfirmBaseline,
    request=None,
) -> BaselineDTO:
    permissions.require_project_member(session, user, project_id)
    if member_id != user.id:
        raise ApiError(403, "NOT_YOUR_CONFIRMATION", "只能确认你自己的那一条。")
    project = _lock_project(session, project_id)
    baseline = _baseline_for_update(session, project_id, baseline_id)
    row = session.scalar(
        select(BaselineConfirmation)
        .where(
            BaselineConfirmation.baseline_version_id == baseline.id,
            BaselineConfirmation.user_id == user.id,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None:
        raise ApiError(403, "NOT_A_CONFIRMER", "你不在这一版基线的确认名单里。")
    if row.status != "pending":
        raise ApiError(409, "ALREADY_CONFIRMED", "你已经处理过这一版基线。")
    if command.decision == "reject":
        row.comment = require_reason(command.comment, field="comment")
        row.status, row.confirmed_at = "rejected", now()
        baseline.status = "archived"
        baseline.lock_version += 1
        project.setup_status = "draft"
        project.lock_version += 1
        close_action_items_by_source(
            session, confirm_source_key(baseline.id), status="rejected", actor=user
        )
        notify(
            session,
            recipient=baseline.created_by,
            category="project",
            title=f"需求基线 v{baseline.version_no} 被退回",
            description=f"{user.name or '组员'}：{row.comment}"[:2000],
            target=_target(project.id),
            dedupe_key=f"b:baseline-rejected:{baseline.id}",
        )
        record_audit(
            session,
            actor=user,
            action="project.baseline.rejected",
            target=("baseline_version", baseline.id),
            project_id=project.id,
            course_id=project.course_id,
            reason=row.comment,
            request=request,
        )
        session.flush()
        return _baseline_dto(session, baseline)
    row.status, row.confirmed_at = "confirmed", now()
    row.comment = (command.comment or "").strip() or None
    session.execute(
        update(ActionItem)
        .where(
            ActionItem.recipient_id == user.id,
            ActionItem.source_key == confirm_source_key(baseline.id),
            ActionItem.status == "pending",
        )
        .values(status="completed", closed_at=now(), closed_by=user.id)
    )
    session.flush()
    record_audit(
        session,
        actor=user,
        action="project.baseline.confirmed",
        target=("baseline_version", baseline.id),
        project_id=project.id,
        course_id=project.course_id,
        request=request,
    )
    pending = session.scalar(
        select(func.count())
        .select_from(BaselineConfirmation)
        .where(
            BaselineConfirmation.baseline_version_id == baseline.id,
            BaselineConfirmation.status == "pending",
        )
    )
    if not pending:
        _freeze(session, project, baseline, user, forced=False, request=request)
    return _baseline_dto(session, baseline)


def force_freeze(
    session: Session,
    user: User,
    project_id: UUID,
    baseline_id: UUID,
    command: ForceFreeze,
    request=None,
) -> BaselineDTO:
    permissions.require_project_leader(session, user, project_id)
    reason = require_reason(command.reason)
    project = _lock_project(session, project_id)
    baseline = _baseline_for_update(session, project_id, baseline_id)
    unconfirmed = list(
        session.scalars(
            select(BaselineConfirmation.user_id).where(
                BaselineConfirmation.baseline_version_id == baseline.id,
                BaselineConfirmation.status == "pending",
            )
        )
    )
    _freeze(session, project, baseline, user, forced=True, reason=reason, request=request)
    for member_id in unconfirmed:
        notify(
            session,
            recipient=member_id,
            category="project",
            title=f"组长强制冻结了「{project.name}」的需求基线 v{baseline.version_no}",
            description=f"你还没有确认。原因：{reason}"[:2000],
            target=_target(project.id),
            dedupe_key=f"b:baseline-forced:{baseline.id}:{member_id}",
        )
    record_audit(
        session,
        actor=user,
        action="project.baseline.force_frozen",
        target=("baseline_version", baseline.id),
        project_id=project.id,
        course_id=project.course_id,
        after={"version_no": baseline.version_no, "unconfirmed": unconfirmed},
        reason=reason,
        request=request,
    )
    return _baseline_dto(session, baseline)


def _freeze(
    session: Session,
    project: Project,
    baseline: BaselineVersion,
    actor: User,
    *,
    forced: bool,
    reason: str | None = None,
    request=None,
) -> None:
    moment = now()
    baseline.status, baseline.frozen_at, baseline.confirmed_at = "frozen", moment, moment
    baseline.lock_version += 1
    project.setup_status = "frozen"
    project.lock_version += 1
    ids = [UUID(r["id"]) for r in baseline.snapshot_json["requirements"]]
    if ids:
        session.execute(
            update(Requirement)
            .where(Requirement.id.in_(ids), Requirement.status == "draft")
            .values(status="confirmed", lock_version=Requirement.lock_version + 1)
        )
    close_action_items_by_source(
        session, confirm_source_key(baseline.id), status="completed", actor=actor
    )
    session.flush()
    for member_id in _members(session, project.id):
        notify(
            session,
            recipient=member_id,
            category="project",
            title=f"「{project.name}」的需求基线 v{baseline.version_no} 已冻结",
            description=f"组长强制冻结，原因：{reason}"[:2000] if forced else "全部组员已确认。",
            target=_target(project.id),
            dedupe_key=f"b:baseline-frozen:{baseline.id}",
        )
    if not forced:
        record_audit(
            session,
            actor=actor,
            action="project.baseline.frozen",
            target=("baseline_version", baseline.id),
            project_id=project.id,
            course_id=project.course_id,
            after={"version_no": baseline.version_no},
            request=request,
        )


def _baseline_dto(session: Session, baseline: BaselineVersion) -> BaselineDTO:
    rows = session.scalars(
        select(BaselineConfirmation)
        .where(BaselineConfirmation.baseline_version_id == baseline.id)
        .order_by(BaselineConfirmation.user_id)
        .execution_options(populate_existing=True)
    ).all()
    confirmations = [
        ConfirmationDTO(
            user=_person(session, r.user_id) or PersonDTO(id=r.user_id, name=None),
            status=r.status,  # type: ignore[arg-type]
            comment=r.comment,
            confirmed_at=r.confirmed_at,
        )
        for r in rows
    ]
    return BaselineDTO(
        id=baseline.id,
        version_no=baseline.version_no,
        status=baseline.status,  # type: ignore[arg-type]
        created_by=_person(session, baseline.created_by),
        created_at=baseline.created_at or now(),
        frozen_at=baseline.frozen_at,
        confirmations=confirmations,
        waiting_for=[c.user for c in confirmations if c.status == "pending"]
        if baseline.status == "draft"
        else [],
        snapshot=baseline.snapshot_json,
        lock_version=baseline.lock_version,
    )


def current(session: Session, user: User, project_id: UUID) -> BaselineDTO | None:
    permissions.require_project_read(session, user, project_id)
    row = session.scalar(
        select(BaselineVersion)
        .where(BaselineVersion.project_id == project_id)
        .order_by(BaselineVersion.version_no.desc())
        .limit(1)
        .execution_options(populate_existing=True)
    )
    return _baseline_dto(session, row) if row else None
