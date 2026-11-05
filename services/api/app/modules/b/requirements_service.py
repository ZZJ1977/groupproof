"""B-4 page 08 steps 3–4: requirements analysis (B3-05) and conflicts (B3-06).

* Analysis sends the project's ready materials, split into paragraphs with a
  ``segment_id``, to A7-03 ``extract_requirements``. It runs after the HTTP
  response in the API process (``run_analysis``) and the page polls the run.
* Re-analysis replaces only AI items nobody touched (``BRequirementMeta``):
  manual items, edited AI items and items decided in a conflict all stay.
* When A7-03 answers ``AI_UNAVAILABLE`` the run ends as ``unavailable`` and the
  page switches to manual entry, which uses the same create/update endpoints.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import timedelta
from uuid import UUID, uuid4

from sqlalchemy import func, or_, select
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import (
    ConflictResolution,
    FunctionalModule,
    Project,
    ProjectMember,
    Requirement,
    RequirementConflict,
    RequirementSourceReference,
    SourceReference,
    Task,
    User,
)
from app.modules.a import permissions
from app.modules.a.ai import extract_requirements
from app.modules.a.ai.provider import AIProvider
from app.modules.a.ai.schemas import (
    DocumentSegment,
    RequirementExtractionInput,
    RequirementExtractionResult,
    SourceDocument,
)
from app.modules.a.audit import record_audit
from app.modules.b.common import now, require_reason, require_version
from app.modules.b.courses_schemas import PersonDTO
from app.modules.b.models import (
    BAnalysisRun,
    BModuleMeta,
    BProjectMaterial,
    BRequirementMeta,
)
from app.modules.b.requirements_schemas import (
    AdvanceSetup,
    AnalysisRunDTO,
    ConflictDTO,
    CreateModule,
    CreateRequirement,
    ModuleDTO,
    RequirementDTO,
    RequirementsBoardDTO,
    ResolutionDTO,
    ResolveConflict,
    SourceDTO,
    UpdateModule,
    UpdateRequirement,
)

DRAFT_SETUP = {"not_initialized", "draft"}
SEGMENT_SOURCE = "b_material_segment"
MAX_DOCUMENTS = 20
MAX_SEGMENTS = 500
MAX_SEGMENT_CHARS = 8000
STALE_RUN = timedelta(minutes=15)
UNSORTED_MODULE = "未分类"


# ---------------------------------------------------------------- guards


def require_draft_writer(session: Session, user: User, project_id: UUID):
    """Project member, project writable, and the baseline still a draft (row locked)."""
    relation = permissions.require_project_member(session, user, project_id)
    project = session.scalar(
        select(Project)
        .where(Project.id == project_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    check_draft(project)
    return relation, project


def check_draft(project: Project) -> None:
    if project.setup_status == "frozen":
        raise ApiError(409, "BASELINE_FROZEN", "需求基线已冻结，不能再修改需求和模块。")
    if project.setup_status not in DRAFT_SETUP:
        raise ApiError(
            409, "BASELINE_IN_CONFIRMATION", "基线正在等待组员确认，确认结束前不能修改。"
        )


def _members(session: Session, project_id: UUID) -> set[UUID]:
    return set(
        session.scalars(
            select(ProjectMember.user_id).where(
                ProjectMember.project_id == project_id, ProjectMember.left_at.is_(None)
            )
        )
    )


def _person(session: Session, user_id: UUID | None) -> PersonDTO | None:
    if user_id is None:
        return None
    user = session.get(User, user_id)
    return PersonDTO(id=user.id, name=user.name) if user else None


# ---------------------------------------------------------------- read model


def _run_dto(run: BAnalysisRun) -> AnalysisRunDTO:
    return AnalysisRunDTO(
        id=run.id,
        status=run.status,  # type: ignore[arg-type]
        error_code=run.error_code,
        error_message=run.error_message,
        summary=run.summary,
        is_placeholder=run.is_placeholder,
        created_at=run.created_at,
        finished_at=run.finished_at,
    )


def _sources(session: Session, requirement_ids: list[UUID]) -> dict[UUID, list[SourceDTO]]:
    rows = session.execute(
        select(RequirementSourceReference.requirement_id, SourceReference)
        .join(SourceReference, SourceReference.id == RequirementSourceReference.source_reference_id)
        .where(RequirementSourceReference.requirement_id.in_(requirement_ids))
        .order_by(SourceReference.created_at, SourceReference.id)
    ).all()
    found: dict[UUID, list[SourceDTO]] = {}
    for requirement_id, ref in rows:
        meta = ref.metadata_json if isinstance(ref.metadata_json, dict) else {}
        found.setdefault(requirement_id, []).append(
            SourceDTO(
                material_id=meta.get("material_id"),
                material_title=ref.title,
                segment_id=meta.get("segment_id"),
                quote=meta.get("quote"),
            )
        )
    return found


def requirement_dtos(session: Session, project_id: UUID) -> dict[UUID, RequirementDTO]:
    requirements = session.scalars(
        select(Requirement)
        .where(Requirement.project_id == project_id)
        .order_by(Requirement.created_at, Requirement.id)
        .execution_options(populate_existing=True)
    ).all()
    metas = {
        m.requirement_id: m
        for m in session.scalars(
            select(BRequirementMeta)
            .where(BRequirementMeta.project_id == project_id)
            .execution_options(populate_existing=True)
        )
    }
    sources = _sources(session, [r.id for r in requirements])
    result = {}
    for row in requirements:
        meta = metas.get(row.id)
        result[row.id] = RequirementDTO(
            id=row.id,
            module_id=row.module_id,
            title=row.title,
            description=row.description,
            priority=row.priority,  # type: ignore[arg-type]
            status=row.status,
            origin=meta.origin if meta else "manual",  # type: ignore[arg-type]
            edited_by_human=meta.edited_by_human if meta else True,
            excluded=meta.excluded if meta else False,
            sources=sources.get(row.id, []),
            lock_version=row.lock_version,
        )
    return result


def board(session: Session, user: User, project_id: UUID) -> RequirementsBoardDTO:
    relation = permissions.require_project_read(session, user, project_id)
    project = relation.project
    requirements = requirement_dtos(session, project_id)
    modules = session.scalars(
        select(FunctionalModule)
        .where(FunctionalModule.project_id == project_id)
        .order_by(FunctionalModule.sort_order, FunctionalModule.created_at)
        .execution_options(populate_existing=True)
    ).all()
    module_origin = dict(
        session.execute(
            select(BModuleMeta.module_id, BModuleMeta.origin).where(
                BModuleMeta.project_id == project_id
            )
        ).all()
    )
    counts: dict[UUID, int] = {}
    for item in requirements.values():
        if not item.excluded:
            counts[item.module_id] = counts.get(item.module_id, 0) + 1
    conflicts = session.scalars(
        select(RequirementConflict)
        .where(RequirementConflict.project_id == project_id)
        .order_by(RequirementConflict.created_at, RequirementConflict.id)
        .execution_options(populate_existing=True)
    ).all()
    resolutions = {
        r.conflict_id: r
        for r in session.scalars(
            select(ConflictResolution).where(
                ConflictResolution.conflict_id.in_([c.id for c in conflicts])
            )
        )
    }
    latest = session.scalar(
        select(BAnalysisRun)
        .where(BAnalysisRun.project_id == project_id)
        .order_by(BAnalysisRun.created_at.desc(), BAnalysisRun.id.desc())
        .limit(1)
        .execution_options(populate_existing=True)
    )
    conflict_rows = []
    for row in conflicts:
        resolution = resolutions.get(row.id)
        conflict_rows.append(
            ConflictDTO(
                id=row.id,
                left=requirements[row.left_requirement_id],
                right=requirements[row.right_requirement_id],
                description=row.description,
                status=row.status,  # type: ignore[arg-type]
                resolution=ResolutionDTO(
                    decision=resolution.decision,  # type: ignore[arg-type]
                    reason=resolution.reason,
                    resolved_by=_person(session, resolution.resolved_by),
                    created_at=resolution.created_at,
                )
                if resolution
                else None,
            )
        )
    return RequirementsBoardDTO(
        project_id=project.id,
        setup_status=project.setup_status,
        setup_step=project.setup_step,
        editable=relation.member and not relation.read_only and project.setup_status in DRAFT_SETUP,
        latest_run=_run_dto(latest) if latest else None,
        modules=[
            ModuleDTO(
                id=m.id,
                name=m.name,
                description=m.description,
                owner=_person(session, m.owner_id),
                origin=module_origin.get(m.id, "manual"),  # type: ignore[arg-type]
                requirement_count=counts.get(m.id, 0),
                lock_version=m.lock_version,
            )
            for m in modules
        ],
        requirements=list(requirements.values()),
        conflicts=conflict_rows,
        open_conflicts=sum(1 for c in conflicts if c.status == "open"),
    )


# ---------------------------------------------------------------- B3-05 analysis


def segments_of(text: str) -> list[DocumentSegment]:
    """Paragraphs (blank-line separated), long ones cut to A7-03's segment limit."""
    pieces = []
    for paragraph in re.split(r"\n\s*\n", text):
        paragraph = paragraph.strip()
        for start in range(0, len(paragraph), MAX_SEGMENT_CHARS):
            pieces.append(paragraph[start : start + MAX_SEGMENT_CHARS])
    return [
        DocumentSegment(segment_id=f"p{index}", text=piece)
        for index, piece in enumerate(pieces[:MAX_SEGMENTS], 1)
    ]


def _ready_materials(session: Session, project_id: UUID) -> list[BProjectMaterial]:
    return list(
        session.scalars(
            select(BProjectMaterial)
            .where(
                BProjectMaterial.project_id == project_id,
                BProjectMaterial.extract_status == "ready",
                BProjectMaterial.text_content.is_not(None),
            )
            .order_by(BProjectMaterial.created_at, BProjectMaterial.id)
            .limit(MAX_DOCUMENTS)
        )
    )


def start_analysis(session: Session, user: User, project_id: UUID, request=None) -> BAnalysisRun:
    _, project = require_draft_writer(session, user, project_id)
    materials = [m for m in _ready_materials(session, project_id) if segments_of(m.text_content)]
    if not materials:
        raise ApiError(
            409,
            "NO_ANALYZABLE_MATERIALS",
            "还没有可分析的资料正文，请先添加文本资料或手动录入需求。",
        )
    for stale in session.scalars(
        select(BAnalysisRun)
        .where(BAnalysisRun.project_id == project_id, BAnalysisRun.status == "processing")
        .with_for_update()
    ):
        if now() - stale.created_at < STALE_RUN:
            raise ApiError(409, "ANALYSIS_RUNNING", "分析正在进行中，请稍候。")
        stale.status, stale.finished_at = "failed", now()
        stale.error_code, stale.error_message = "ANALYSIS_TIMEOUT", "分析超时，已停止。"
    session.flush()
    run = BAnalysisRun(
        id=uuid4(),
        project_id=project.id,
        requested_by=user.id,
        status="processing",
        material_ids=[str(m.id) for m in materials],
        created_at=now(),
    )
    session.add(run)
    session.flush()
    record_audit(
        session,
        actor=user,
        action="project.analysis.started",
        target=("b_analysis_run", run.id),
        project_id=project.id,
        course_id=project.course_id,
        after={"materials": len(materials)},
        request=request,
    )
    return run


def analysis(session: Session, user: User, project_id: UUID, run_id: UUID) -> AnalysisRunDTO:
    permissions.require_project_read(session, user, project_id)
    run = session.get(BAnalysisRun, run_id, populate_existing=True)
    if run is None or run.project_id != project_id:
        raise ApiError(404, "ANALYSIS_NOT_FOUND", "分析记录不存在。")
    return _run_dto(run)


def run_analysis(bind: Engine | Connection, run_id: UUID, provider: AIProvider | None = None):
    """Run one analysis to the end in its own session (called after the response)."""
    with Session(bind) as session:
        run = session.get(BAnalysisRun, run_id)
        if run is None or run.status != "processing":
            return
        try:
            materials = [
                m
                for m in (
                    session.get(BProjectMaterial, UUID(material_id))
                    for material_id in run.material_ids
                )
                if m is not None and m.extract_status == "ready" and m.text_content
            ]
            payload = RequirementExtractionInput(
                project_id=run.project_id,
                documents=[
                    SourceDocument(
                        source_id=m.id, title=m.title, segments=segments_of(m.text_content)
                    )
                    for m in materials
                ],
            )
            # End the read transaction: the AI call may take a while.
            session.rollback()
            result = extract_requirements(payload, provider=provider)
        except ApiError as error:
            session.rollback()
            _finish(
                session,
                run_id,
                "unavailable" if error.code == "AI_UNAVAILABLE" else "failed",
                error.code,
                error.message,
            )
            return
        except Exception:  # noqa: BLE001 - any failure ends the run visibly
            session.rollback()
            _finish(
                session, run_id, "failed", "ANALYSIS_FAILED", "分析失败，请重试或手动录入需求。"
            )
            return
        run = session.get(BAnalysisRun, run_id, with_for_update=True, populate_existing=True)
        if run is None or run.status != "processing":
            return
        project = session.scalar(
            select(Project).where(Project.id == run.project_id).with_for_update()
        )
        if project is None or project.setup_status not in DRAFT_SETUP:
            session.rollback()
            _finish(
                session,
                run_id,
                "failed",
                "BASELINE_FROZEN",
                "基线已进入确认或冻结，分析结果未写入。",
            )
            return
        summary = merge_result(session, project, run, result, {m.id: m for m in materials})
        run.status, run.summary, run.finished_at = "succeeded", summary, now()
        run.is_placeholder = result.is_placeholder
        project.setup_step = max(project.setup_step, 3)
        record_audit(
            session,
            actor=run.requested_by,
            action="project.analysis.merged",
            target=("b_analysis_run", run.id),
            project_id=project.id,
            course_id=project.course_id,
            after=summary,
        )
        session.commit()


def _finish(session: Session, run_id: UUID, status: str, code: str, message: str) -> None:
    run = session.get(BAnalysisRun, run_id, populate_existing=True)
    run.status, run.error_code, run.error_message = status, code, message[:300]
    run.finished_at = now()
    session.commit()


def _ai_key(title: str, citations: list[tuple[str, str]]) -> str:
    return hashlib.sha256(json.dumps([title, sorted(citations)]).encode()).hexdigest()


def merge_result(
    session: Session,
    project: Project,
    run: BAnalysisRun,
    result: RequirementExtractionResult,
    materials: dict[UUID, BProjectMaterial],
) -> dict:
    """Replace untouched AI items with the new suggestions; keep everything people touched."""
    metas = {
        m.requirement_id: m
        for m in session.scalars(
            select(BRequirementMeta).where(BRequirementMeta.project_id == project.id)
        )
    }
    existing = session.scalars(
        select(Requirement).where(Requirement.project_id == project.id)
    ).all()
    replaceable = [
        r
        for r in existing
        if r.id in metas and metas[r.id].origin == "ai" and not metas[r.id].edited_by_human
    ]
    kept_by_key = {
        metas[r.id].ai_key: r.id
        for r in existing
        if r not in replaceable and r.id in metas and metas[r.id].ai_key
    }
    for row in replaceable:
        session.delete(metas[row.id])
        session.delete(row)
    session.flush()

    modules = {
        m.name: m
        for m in session.scalars(
            select(FunctionalModule).where(FunctionalModule.project_id == project.id)
        )
    }
    added_modules = 0

    def module_for(name: str | None, description: str | None = None) -> FunctionalModule:
        nonlocal added_modules
        name = (name or "").strip()[:200] or UNSORTED_MODULE
        if name not in modules:
            row = FunctionalModule(
                id=uuid4(),
                project_id=project.id,
                name=name,
                description=description,
                sort_order=len(modules) + 1,
            )
            session.add(row)
            session.flush()
            session.add(BModuleMeta(module_id=row.id, project_id=project.id, origin="ai"))
            modules[name] = row
            added_modules += 1
        return modules[name]

    for item in result.modules:
        module_for(item.name, item.description)

    by_citation: dict[tuple[str, str], list[UUID]] = {}
    added = skipped = 0
    for item in result.requirements:
        citations = [(str(s.source_id), s.segment_id) for s in item.sources]
        key = _ai_key(item.title, citations)
        if key in kept_by_key:
            skipped += 1
            for citation in citations:
                by_citation.setdefault(citation, []).append(kept_by_key[key])
            continue
        row = Requirement(
            id=uuid4(),
            project_id=project.id,
            module_id=module_for(item.module).id,
            title=item.title.strip()[:240] or "未命名需求",
            description=item.description,
            priority="medium",
            status="draft",
            source_summary=item.sources[0].quote if item.sources else None,
            created_by=run.requested_by,
        )
        session.add(row)
        session.flush()
        session.add(
            BRequirementMeta(
                requirement_id=row.id,
                project_id=project.id,
                origin="ai",
                ai_key=key,
                analysis_run_id=run.id,
            )
        )
        for source in item.sources:
            material = materials.get(source.source_id)
            ref = SourceReference(
                id=uuid4(),
                project_id=project.id,
                created_by=run.requested_by,
                source_type=SEGMENT_SOURCE,
                external_id=f"{source.source_id}:{source.segment_id}",
                title=material.title if material else None,
                metadata_json={
                    "material_id": str(source.source_id),
                    "segment_id": source.segment_id,
                    "quote": source.quote,
                    "analysis_run_id": str(run.id),
                },
            )
            session.add(ref)
            session.flush()
            session.add(
                RequirementSourceReference(requirement_id=row.id, source_reference_id=ref.id)
            )
            by_citation.setdefault((str(source.source_id), source.segment_id), []).append(row.id)
        added += 1
    session.flush()

    conflicts_added = conflicts_skipped = 0
    for item in result.conflicts:
        ids: list[UUID] = []
        for source in item.sources:
            for requirement_id in by_citation.get((str(source.source_id), source.segment_id), []):
                if requirement_id not in ids:
                    ids.append(requirement_id)
        if len(ids) < 2:
            conflicts_skipped += 1
            continue
        left, right = ids[0], ids[1]
        duplicate = session.scalar(
            select(RequirementConflict.id).where(
                or_(
                    (RequirementConflict.left_requirement_id == left)
                    & (RequirementConflict.right_requirement_id == right),
                    (RequirementConflict.left_requirement_id == right)
                    & (RequirementConflict.right_requirement_id == left),
                )
            )
        )
        if duplicate:
            conflicts_skipped += 1
            continue
        session.add(
            RequirementConflict(
                id=uuid4(),
                project_id=project.id,
                left_requirement_id=left,
                right_requirement_id=right,
                conflict_type="ai_detected",
                description=item.description,
                status="open",
            )
        )
        conflicts_added += 1
    session.flush()

    # Drop AI modules the new result no longer has, once nothing points at them.
    suggested = {(m.name or "").strip() for m in result.modules}
    removed_modules = 0
    for meta in session.scalars(
        select(BModuleMeta).where(
            BModuleMeta.project_id == project.id,
            BModuleMeta.origin == "ai",
            BModuleMeta.edited_by_human.is_(False),
        )
    ).all():
        module = session.get(FunctionalModule, meta.module_id)
        if module is None or module.name in suggested:
            continue
        used = session.scalar(
            select(func.count()).select_from(Requirement).where(Requirement.module_id == module.id)
        ) or session.scalar(
            select(func.count()).select_from(Task).where(Task.module_id == module.id)
        )
        if not used:
            session.delete(meta)
            session.delete(module)
            removed_modules += 1
    session.flush()
    return {
        "requirements_added": added,
        "requirements_replaced": len(replaceable),
        "requirements_kept": len(existing) - len(replaceable),
        "duplicates_skipped": skipped,
        "modules_added": added_modules,
        "modules_removed": removed_modules,
        "conflicts_added": conflicts_added,
        "conflicts_skipped": conflicts_skipped,
    }


# ---------------------------------------------------------------- manual entry


def _module(session: Session, project_id: UUID, module_id: UUID, *, lock: bool = False):
    statement = select(FunctionalModule).where(
        FunctionalModule.id == module_id, FunctionalModule.project_id == project_id
    )
    if lock:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    row = session.scalar(statement)
    if row is None:
        raise ApiError(404, "MODULE_NOT_FOUND", "模块不存在。")
    return row


def _check_owner(session: Session, project_id: UUID, owner_id: UUID | None) -> None:
    if owner_id is not None and owner_id not in _members(session, project_id):
        raise ApiError(
            422, "OWNER_NOT_MEMBER", "负责人必须是本项目成员。", details={"field": "owner_id"}
        )


def _check_module_name(session: Session, project_id: UUID, name: str, exclude: UUID | None):
    statement = select(FunctionalModule.id).where(
        FunctionalModule.project_id == project_id, FunctionalModule.name == name
    )
    if exclude is not None:
        statement = statement.where(FunctionalModule.id != exclude)
    if session.scalar(statement):
        raise ApiError(409, "MODULE_NAME_TAKEN", "已有同名模块。", details={"field": "name"})


def create_module(
    session: Session, user: User, project_id: UUID, command: CreateModule, request=None
) -> ModuleDTO:
    _, project = require_draft_writer(session, user, project_id)
    name = command.name.strip()
    if not name:
        raise ApiError(422, "MODULE_NAME_REQUIRED", "请填写模块名称。", details={"field": "name"})
    _check_module_name(session, project.id, name, None)
    _check_owner(session, project.id, command.owner_id)
    count = session.scalar(
        select(func.count())
        .select_from(FunctionalModule)
        .where(FunctionalModule.project_id == project.id)
    )
    row = FunctionalModule(
        id=uuid4(),
        project_id=project.id,
        name=name,
        description=(command.description or "").strip() or None,
        owner_id=command.owner_id,
        sort_order=(count or 0) + 1,
    )
    session.add(row)
    session.flush()
    session.add(
        BModuleMeta(module_id=row.id, project_id=project.id, origin="manual", edited_by_human=True)
    )
    record_audit(
        session,
        actor=user,
        action="project.module.created",
        target=("functional_module", row.id),
        project_id=project.id,
        course_id=project.course_id,
        after={"name": name, "owner_id": command.owner_id},
        request=request,
    )
    return _module_dto(session, row)


def _module_dto(session: Session, row: FunctionalModule) -> ModuleDTO:
    meta = session.get(BModuleMeta, row.id)
    count = session.scalar(
        select(func.count())
        .select_from(Requirement)
        .join(BRequirementMeta, BRequirementMeta.requirement_id == Requirement.id, isouter=True)
        .where(
            Requirement.module_id == row.id,
            func.coalesce(BRequirementMeta.excluded, False).is_(False),
        )
    )
    return ModuleDTO(
        id=row.id,
        name=row.name,
        description=row.description,
        owner=_person(session, row.owner_id),
        origin=meta.origin if meta else "manual",  # type: ignore[arg-type]
        requirement_count=count or 0,
        lock_version=row.lock_version,
    )


def update_module(
    session: Session,
    user: User,
    project_id: UUID,
    module_id: UUID,
    command: UpdateModule,
    request=None,
) -> ModuleDTO:
    _, project = require_draft_writer(session, user, project_id)
    row = _module(session, project.id, module_id, lock=True)
    require_version(row.lock_version, command.expected_version)
    name = command.name.strip()
    if not name:
        raise ApiError(422, "MODULE_NAME_REQUIRED", "请填写模块名称。", details={"field": "name"})
    _check_module_name(session, project.id, name, row.id)
    _check_owner(session, project.id, command.owner_id)
    before = {"name": row.name, "description": row.description, "owner_id": row.owner_id}
    row.name = name
    row.description = (command.description or "").strip() or None
    row.owner_id = command.owner_id
    row.lock_version += 1
    meta = session.get(BModuleMeta, row.id)
    if meta is None:
        session.add(
            BModuleMeta(
                module_id=row.id, project_id=project.id, origin="manual", edited_by_human=True
            )
        )
    else:
        meta.edited_by_human = True
    session.flush()
    record_audit(
        session,
        actor=user,
        action="project.module.updated",
        target=("functional_module", row.id),
        project_id=project.id,
        course_id=project.course_id,
        before=before,
        after={"name": name, "description": row.description, "owner_id": row.owner_id},
        request=request,
    )
    return _module_dto(session, row)


def delete_module(
    session: Session, user: User, project_id: UUID, module_id: UUID, request=None
) -> dict:
    _, project = require_draft_writer(session, user, project_id)
    row = _module(session, project.id, module_id, lock=True)
    used = session.scalar(
        select(func.count()).select_from(Requirement).where(Requirement.module_id == row.id)
    ) or session.scalar(select(func.count()).select_from(Task).where(Task.module_id == row.id))
    if used:
        raise ApiError(409, "MODULE_NOT_EMPTY", "模块下还有需求或任务，请先移走再删除。")
    meta = session.get(BModuleMeta, row.id)
    if meta is not None:
        session.delete(meta)
    session.delete(row)
    session.flush()
    record_audit(
        session,
        actor=user,
        action="project.module.deleted",
        target=("functional_module", module_id),
        project_id=project.id,
        course_id=project.course_id,
        before={"name": row.name},
        request=request,
    )
    return {"id": module_id, "deleted": True}


def create_requirement(
    session: Session, user: User, project_id: UUID, command: CreateRequirement, request=None
) -> RequirementDTO:
    _, project = require_draft_writer(session, user, project_id)
    _module(session, project.id, command.module_id)
    title = command.title.strip()
    if not title:
        raise ApiError(
            422, "REQUIREMENT_TITLE_REQUIRED", "请填写需求标题。", details={"field": "title"}
        )
    row = Requirement(
        id=uuid4(),
        project_id=project.id,
        module_id=command.module_id,
        title=title,
        description=(command.description or "").strip() or None,
        priority=command.priority,
        status="draft",
        created_by=user.id,
    )
    session.add(row)
    session.flush()
    session.add(
        BRequirementMeta(
            requirement_id=row.id, project_id=project.id, origin="manual", edited_by_human=True
        )
    )
    project.setup_step = max(project.setup_step, 3)
    session.flush()
    record_audit(
        session,
        actor=user,
        action="project.requirement.created",
        target=("requirement", row.id),
        project_id=project.id,
        course_id=project.course_id,
        after={"title": title, "module_id": command.module_id, "priority": command.priority},
        request=request,
    )
    return requirement_dtos(session, project.id)[row.id]


def update_requirement(
    session: Session,
    user: User,
    project_id: UUID,
    requirement_id: UUID,
    command: UpdateRequirement,
    request=None,
) -> RequirementDTO:
    _, project = require_draft_writer(session, user, project_id)
    row = session.scalar(
        select(Requirement)
        .where(Requirement.id == requirement_id, Requirement.project_id == project.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None:
        raise ApiError(404, "REQUIREMENT_NOT_FOUND", "需求不存在。")
    require_version(row.lock_version, command.expected_version)
    _module(session, project.id, command.module_id)
    title = command.title.strip()
    if not title:
        raise ApiError(
            422, "REQUIREMENT_TITLE_REQUIRED", "请填写需求标题。", details={"field": "title"}
        )
    before = {
        "title": row.title,
        "description": row.description,
        "priority": row.priority,
        "module_id": row.module_id,
    }
    row.title = title
    row.description = (command.description or "").strip() or None
    row.priority = command.priority
    row.module_id = command.module_id
    row.lock_version += 1
    _mark_requirement(session, row)
    session.flush()
    record_audit(
        session,
        actor=user,
        action="project.requirement.updated",
        target=("requirement", row.id),
        project_id=project.id,
        course_id=project.course_id,
        before=before,
        after={
            "title": title,
            "description": row.description,
            "priority": row.priority,
            "module_id": row.module_id,
        },
        request=request,
    )
    return requirement_dtos(session, project.id)[row.id]


def _mark_requirement(session: Session, row: Requirement, *, excluded: bool | None = None):
    meta = session.get(BRequirementMeta, row.id)
    if meta is None:
        meta = BRequirementMeta(requirement_id=row.id, project_id=row.project_id, origin="manual")
        session.add(meta)
    meta.edited_by_human = True
    if excluded is not None:
        meta.excluded = excluded
    return meta


# ---------------------------------------------------------------- B3-06 conflicts


def resolve_conflict(
    session: Session,
    user: User,
    project_id: UUID,
    conflict_id: UUID,
    command: ResolveConflict,
    request=None,
) -> ConflictDTO:
    _, project = require_draft_writer(session, user, project_id)
    conflict = session.scalar(
        select(RequirementConflict)
        .where(RequirementConflict.id == conflict_id, RequirementConflict.project_id == project.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if conflict is None:
        raise ApiError(404, "CONFLICT_NOT_FOUND", "冲突不存在。")
    if conflict.status != "open":
        raise ApiError(409, "CONFLICT_CLOSED", "这个冲突已经处理过了。")
    reason = require_reason(command.reason)
    left = session.get(Requirement, conflict.left_requirement_id, with_for_update=True)
    right = session.get(Requirement, conflict.right_requirement_id, with_for_update=True)
    if command.decision == "merge":
        merged_title = (command.merged_title or "").strip()
        if not merged_title:
            raise ApiError(
                422,
                "MERGED_TITLE_REQUIRED",
                "合并时请填写合并后的需求标题。",
                details={"field": "merged_title"},
            )
        left.title = merged_title
        left.description = (command.merged_description or "").strip() or None
        left.lock_version += 1
        kept, dropped = left, right
    elif command.decision == "keep_left":
        kept, dropped = left, right
    else:
        kept, dropped = right, left
    _mark_requirement(session, kept, excluded=False)
    _mark_requirement(session, dropped, excluded=True)
    conflict.status = "resolved"
    session.add(
        ConflictResolution(
            id=uuid4(),
            conflict_id=conflict.id,
            resolved_by=user.id,
            decision=command.decision,
            reason=reason,
            created_at=now(),
        )
    )
    session.flush()
    record_audit(
        session,
        actor=user,
        action="project.conflict.resolved",
        target=("requirement_conflict", conflict.id),
        project_id=project.id,
        course_id=project.course_id,
        after={"decision": command.decision, "kept": kept.id, "dropped": dropped.id},
        reason=reason,
        request=request,
    )
    return next(c for c in board(session, user, project.id).conflicts if c.id == conflict.id)


def open_conflict_count(session: Session, project_id: UUID) -> int:
    return (
        session.scalar(
            select(func.count())
            .select_from(RequirementConflict)
            .where(
                RequirementConflict.project_id == project_id, RequirementConflict.status == "open"
            )
        )
        or 0
    )


def included_requirement_count(session: Session, project_id: UUID) -> int:
    return (
        session.scalar(
            select(func.count())
            .select_from(Requirement)
            .join(BRequirementMeta, BRequirementMeta.requirement_id == Requirement.id, isouter=True)
            .where(
                Requirement.project_id == project_id,
                func.coalesce(BRequirementMeta.excluded, False).is_(False),
            )
        )
        or 0
    )


def advance(session: Session, user: User, project_id: UUID, command: AdvanceSetup) -> dict:
    """ "保存并继续": step 3 needs a requirement, step 4 needs every conflict decided."""
    _, project = require_draft_writer(session, user, project_id)
    if command.from_step == 3 and included_requirement_count(session, project.id) == 0:
        raise ApiError(409, "REQUIREMENTS_REQUIRED", "至少需要一条需求才能继续。")
    if command.from_step == 4:
        open_count = open_conflict_count(session, project.id)
        if open_count:
            raise ApiError(
                409,
                "CONFLICTS_UNRESOLVED",
                f"还有 {open_count} 个冲突没有处理。",
                details={"open": open_count},
            )
    project.setup_step = max(project.setup_step, command.from_step + 1)
    if project.setup_status == "not_initialized":
        project.setup_status = "draft"
    session.flush()
    return {"setup_step": project.setup_step}
