"""B-5 page 09: requirement list (B4-01), versions and impact (B4-02), trace (B4-03).

Evidence comes from C's ``list_evidence`` and verification state from D's
``VerificationPort``; a layer that is not available says so instead of
showing invented data.
"""

from __future__ import annotations

import re
from uuid import UUID

from sqlalchemy import Select, func, or_, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import (
    FunctionalModule,
    Requirement,
    RequirementSourceReference,
    SourceReference,
    TaskRequirement,
    User,
)
from app.modules.a import permissions
from app.modules.b import requirement_history as history
from app.modules.b.courses_schemas import PersonDTO
from app.modules.b.manage_schemas import (
    CriterionImpactDTO,
    FieldChangeDTO,
    ImpactDTO,
    ModuleBriefDTO,
    RecheckDTO,
    RequirementDetailDTO,
    RequirementListItemDTO,
    RequirementPageDTO,
    TaskImpactDTO,
    TraceCriterionDTO,
    TraceDTO,
    TraceEvidenceDTO,
    TraceTaskDTO,
    TraceVerificationDTO,
    VersionDTO,
    VersionsDTO,
)
from app.modules.b.models import (
    BCriterionRecheck,
    BRequirementCode,
    BRequirementMeta,
    BRequirementVersion,
)
from app.modules.b.ports import VerificationPort
from app.modules.b.requirements_service import (
    DRAFT_SETUP,
    SEGMENT_SOURCE,
    linked_criteria,
    requirement_dtos,
)
from app.modules.c.evidence_service import list_evidence

STATUSES = {"draft", "confirmed", "in_progress", "implemented", "verified"}
CODE = re.compile(r"^R-?(\d{1,6})$", re.IGNORECASE)


def _like(value: str) -> str:
    return "%" + value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _person(session: Session, user_id: UUID | None) -> PersonDTO | None:
    if user_id is None:
        return None
    user = session.get(User, user_id)
    return PersonDTO(id=user.id, name=user.name) if user else None


def _requirement(session: Session, project_id: UUID, requirement_id: UUID) -> Requirement:
    row = session.get(Requirement, requirement_id, populate_existing=True)
    if row is None or row.project_id != project_id:
        raise ApiError(404, "REQUIREMENT_NOT_FOUND", "需求不存在。")
    return row


# ---------------------------------------------------------------- B4-01 list


def list_requirements(
    session: Session,
    user: User,
    project_id: UUID,
    *,
    code: str | None,
    q: str | None,
    source: str | None,
    module: UUID | None,
    status: str | None,
    include_excluded: bool,
    page: int,
    page_size: int,
) -> RequirementPageDTO:
    permissions.require_project_read(session, user, project_id)
    if status and status not in STATUSES:
        raise ApiError(422, "INVALID_FILTER", "状态筛选值无效。", details={"field": "status"})
    statement: Select = (
        select(Requirement, BRequirementCode.seq, BRequirementMeta)
        .join(BRequirementCode, BRequirementCode.requirement_id == Requirement.id, isouter=True)
        .join(BRequirementMeta, BRequirementMeta.requirement_id == Requirement.id, isouter=True)
        .where(Requirement.project_id == project_id)
    )
    if code and code.strip():
        match = CODE.match(code.strip())
        if match is None:
            raise ApiError(422, "INVALID_FILTER", "编号格式应为 R-001。", details={"field": "code"})
        statement = statement.where(BRequirementCode.seq == int(match.group(1)))
    if q and q.strip():
        pattern = _like(q.strip())
        statement = statement.where(
            or_(
                Requirement.title.ilike(pattern, escape="\\"),
                Requirement.description.ilike(pattern, escape="\\"),
            )
        )
    if source:
        if source in {"ai", "manual"}:
            origin = func.coalesce(BRequirementMeta.origin, "manual")
            statement = statement.where(origin == source)
        else:
            try:
                material_id = UUID(source)
            except ValueError as exc:
                raise ApiError(
                    422, "INVALID_FILTER", "来源筛选值无效。", details={"field": "source"}
                ) from exc
            statement = statement.where(
                Requirement.id.in_(
                    select(RequirementSourceReference.requirement_id)
                    .join(
                        SourceReference,
                        SourceReference.id == RequirementSourceReference.source_reference_id,
                    )
                    .where(
                        SourceReference.source_type == SEGMENT_SOURCE,
                        SourceReference.external_id.like(f"{material_id}:%"),
                    )
                )
            )
    if module is not None:
        statement = statement.where(Requirement.module_id == module)
    if status:
        statement = statement.where(Requirement.status == status)
    if not include_excluded:
        statement = statement.where(func.coalesce(BRequirementMeta.excluded, False).is_(False))
    total = session.scalar(select(func.count()).select_from(statement.subquery())) or 0
    rows = session.execute(
        statement.order_by(
            BRequirementCode.seq.nulls_last(), Requirement.created_at, Requirement.id
        )
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    ids = [r.id for r, _, _ in rows]
    modules = {
        m.id: m
        for m in session.scalars(
            select(FunctionalModule)
            .where(FunctionalModule.project_id == project_id)
            .order_by(FunctionalModule.sort_order, FunctionalModule.created_at)
        )
    }
    versions = dict(
        session.execute(
            select(BRequirementVersion.requirement_id, func.max(BRequirementVersion.version_no))
            .where(BRequirementVersion.requirement_id.in_(ids))
            .group_by(BRequirementVersion.requirement_id)
        ).all()
    )
    tasks = dict(
        session.execute(
            select(TaskRequirement.requirement_id, func.count())
            .where(TaskRequirement.requirement_id.in_(ids))
            .group_by(TaskRequirement.requirement_id)
        ).all()
    )
    return RequirementPageDTO(
        items=[
            RequirementListItemDTO(
                id=row.id,
                code=history.code_of(seq),
                title=row.title,
                module=ModuleBriefDTO(id=row.module_id, name=modules[row.module_id].name),
                origin=meta.origin if meta else "manual",  # type: ignore[arg-type]
                status=row.status,
                priority=row.priority,
                excluded=bool(meta and meta.excluded),
                version_no=versions.get(row.id, 1),
                task_count=tasks.get(row.id, 0),
                updated_at=row.updated_at,
            )
            for row, seq, meta in rows
        ],
        total=total,
        page=page,
        page_size=page_size,
        modules=[ModuleBriefDTO(id=m.id, name=m.name) for m in modules.values()],
    )


def detail(session: Session, user: User, project_id: UUID, requirement_id: UUID):
    relation = permissions.require_project_read(session, user, project_id)
    row = _requirement(session, project_id, requirement_id)
    project = relation.project
    frozen = project.setup_status == "frozen"
    writable = relation.member and not relation.read_only
    module = session.get(FunctionalModule, row.module_id)
    return RequirementDetailDTO(
        requirement=requirement_dtos(session, project_id)[row.id],
        module=ModuleBriefDTO(id=module.id, name=module.name),
        version_no=history.latest_version(session, row.id) or 1,
        baseline_frozen=frozen,
        can_edit=writable and (frozen or project.setup_status in DRAFT_SETUP),
        reason_required=frozen,
    )


# ---------------------------------------------------------------- B4-02 impact + versions


def _recheck_ids(session: Session, criterion_ids: list[UUID]) -> set[UUID]:
    if not criterion_ids:
        return set()
    return set(
        session.scalars(
            select(BCriterionRecheck.criterion_id).where(
                BCriterionRecheck.criterion_id.in_(criterion_ids),
                BCriterionRecheck.cleared_at.is_(None),
            )
        )
    )


def _task_href(project_id: UUID, task_id: UUID) -> str:
    return f"/projects/{project_id}/tasks/{task_id}"


def impact(session: Session, user: User, project_id: UUID, requirement_id: UUID) -> ImpactDTO:
    permissions.require_project_read(session, user, project_id)
    row = _requirement(session, project_id, requirement_id)
    linked = linked_criteria(session, row.id)
    flagged = _recheck_ids(session, [c.id for _, criteria in linked for c in criteria])
    return ImpactDTO(
        requirement_id=row.id,
        tasks=[
            TaskImpactDTO(
                id=task.id,
                title=task.title,
                status=task.status,
                href=_task_href(project_id, task.id),
                criteria=[
                    CriterionImpactDTO(
                        id=c.id, key=c.criterion_key, text=c.text, needs_recheck=c.id in flagged
                    )
                    for c in criteria
                ],
            )
            for task, criteria in linked
        ],
        criteria_count=sum(len(criteria) for _, criteria in linked),
    )


def _text(value) -> str | None:
    return None if value is None else str(value)


def versions(
    session: Session,
    user: User,
    project_id: UUID,
    requirement_id: UUID,
    *,
    from_no: int | None,
    to_no: int | None,
) -> VersionsDTO:
    permissions.require_project_read(session, user, project_id)
    row = _requirement(session, project_id, requirement_id)
    rows = session.scalars(
        select(BRequirementVersion)
        .where(BRequirementVersion.requirement_id == row.id)
        .order_by(BRequirementVersion.version_no)
    ).all()
    compare = None
    if from_no is not None or to_no is not None:
        by_no = {v.version_no: v for v in rows}
        if from_no not in by_no or to_no not in by_no:
            raise ApiError(404, "VERSION_NOT_FOUND", "要对比的版本不存在。")
        modules = {
            str(m.id): m.name
            for m in session.scalars(
                select(FunctionalModule).where(FunctionalModule.project_id == project_id)
            )
        }

        def readable(snapshot: dict) -> dict:
            module_id = snapshot.get("module_id")
            return {**snapshot, "module_id": modules.get(module_id, module_id)}

        changes = history.diff(readable(by_no[from_no].snapshot), readable(by_no[to_no].snapshot))
        compare = {
            "from": from_no,
            "to": to_no,
            "changes": [
                FieldChangeDTO(
                    field=c["field"],
                    label=c["label"],
                    before=_text(c["before"]),
                    after=_text(c["after"]),
                ).model_dump()
                for c in changes
            ],
        }
    return VersionsDTO(
        requirement_id=row.id,
        versions=[
            VersionDTO(
                version_no=v.version_no,
                snapshot=v.snapshot,
                reason=v.reason,
                after_freeze=v.after_freeze,
                created_by=_person(session, v.created_by),
                created_at=v.created_at,
            )
            for v in rows
        ],
        compare=compare,
    )


def rechecks(session: Session, user: User, project_id: UUID, task_id: UUID | None):
    permissions.require_project_read(session, user, project_id)
    statement = select(BCriterionRecheck).where(
        BCriterionRecheck.project_id == project_id, BCriterionRecheck.cleared_at.is_(None)
    )
    if task_id is not None:
        statement = statement.where(BCriterionRecheck.task_id == task_id)
    return [
        RecheckDTO(
            criterion_id=r.criterion_id,
            task_id=r.task_id,
            requirement_id=r.requirement_id,
            requirement_version_no=r.requirement_version_no,
            reason=r.reason,
            flagged_at=r.flagged_at,
            verification_notified=r.verification_notified,
        )
        for r in session.scalars(statement.order_by(BCriterionRecheck.flagged_at))
    ]


# ---------------------------------------------------------------- B4-03 trace


def trace(
    session: Session,
    user: User,
    project_id: UUID,
    requirement_id: UUID,
    verification: VerificationPort,
) -> TraceDTO:
    permissions.require_project_read(session, user, project_id)
    row = _requirement(session, project_id, requirement_id)
    module = session.get(FunctionalModule, row.module_id)
    linked = linked_criteria(session, row.id)
    flagged = _recheck_ids(session, [c.id for _, criteria in linked for c in criteria])

    evidence_status, evidence_reason = "available", None
    evidence_by_task: dict[UUID, list[dict]] = {}
    for task, _ in linked:
        try:
            page = list_evidence(session, user, project_id, task_id=task.id, page_size=100)
        except ApiError as error:
            evidence_status, evidence_reason = "unavailable", error.message
            evidence_by_task = {}
            break
        evidence_by_task[task.id] = page["items"]

    states: dict[UUID, str] = {}
    verification_status = "available"
    if linked:
        try:
            result = verification.task_verification_status(
                session, task_ids=[task.id for task, _ in linked]
            )
            states = {task_id: status.state for task_id, status in result.items()}
        except ApiError:
            verification_status = "unavailable"

    def evidence_for(task_id: UUID, criterion_id: UUID) -> list[TraceEvidenceDTO]:
        items = []
        for item in evidence_by_task.get(task_id, []):
            criteria = {str(c) for c in item.get("criterion_ids", item.get("criteria", []))}
            if str(criterion_id) in criteria:
                items.append(
                    TraceEvidenceDTO(
                        id=item["id"],
                        title=item.get("title", ""),
                        status=item.get("status", ""),
                        href=f"/projects/{project_id}/evidence?evidence={item['id']}",
                    )
                )
        return items

    return TraceDTO(
        requirement=requirement_dtos(session, project_id)[row.id],
        module=ModuleBriefDTO(id=module.id, name=module.name),
        module_href=f"/projects/{project_id}/requirements?module={module.id}",
        tasks=[
            TraceTaskDTO(
                id=task.id,
                title=task.title,
                status=task.status,
                href=_task_href(project_id, task.id),
                criteria=[
                    TraceCriterionDTO(
                        id=c.id,
                        key=c.criterion_key,
                        text=c.text,
                        needs_recheck=c.id in flagged,
                        evidence=evidence_for(task.id, c.id),
                    )
                    for c in criteria
                ],
                verification=TraceVerificationDTO(
                    status=verification_status,  # type: ignore[arg-type]
                    state=states.get(task.id),
                    href=f"{_task_href(project_id, task.id)}/verification",
                ),
            )
            for task, criteria in linked
        ],
        evidence_status=evidence_status,  # type: ignore[arg-type]
        evidence_reason=evidence_reason,
        verification_status=verification_status,  # type: ignore[arg-type]
    )
