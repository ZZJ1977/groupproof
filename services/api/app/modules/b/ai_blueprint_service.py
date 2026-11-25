"""B-4/B-6 AI 一键解析项目资料闭环：从分工计划/需求文档生成模块、需求、里程碑与任务草案。

AI 输出始终保留 ``origin="ai"`` 与来源引用，且不自动冻结基线或计划——必须由团队成员人工确认后生效。
"""

from __future__ import annotations

import hashlib
from datetime import UTC, date, datetime, time, timedelta
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import (
    FunctionalModule,
    Milestone,
    ProjectMember,
    Requirement,
    RequirementSourceReference,
    SourceReference,
    Task,
    User,
)
from app.modules.a import permissions
from app.modules.a.ai import (
    AIProvider,
    AIUsageContext,
    BlueprintMaterialDoc,
    BlueprintMemberBrief,
    ProjectBlueprintInput,
    generate_project_blueprint,
)
from app.modules.a.audit import record_audit
from app.modules.b import planning_service, requirement_history
from app.modules.b.common import lock_project_for_write, now
from app.modules.b.models import (
    BAnalysisRun,
    BBaselineScope,
    BMilestoneDeliverable,
    BModuleMeta,
    BProjectMaterial,
    BProjectSchedule,
    BRequirementMeta,
    BTaskSuggestion,
)
from app.modules.b.planning_schemas import CriterionInput, TaskInput
from app.modules.b.ports import VerificationPort
from app.modules.b.requirements_schemas import BlueprintResultDTO

MAX_DOCUMENTS = 10
MAX_DOC_CHARS = 28_000
DRAFT_SETUP = {"not_initialized", "draft"}
SEGMENT_SOURCE = "b_material_segment"


def _parse_deadline(raw: str | None, fallback_dt: datetime | None) -> datetime | None:
    text = (raw or "").strip()
    if text:
        try:
            d = date.fromisoformat(text[:10])
            return datetime.combine(d, time(23, 59, 0), tzinfo=UTC)
        except ValueError:
            pass
    return fallback_dt


def _ai_req_key(title: str, module_name: str, material_id: UUID | None) -> str:
    encoded = f"{module_name.strip().lower()}|{title.strip().lower()}|{material_id or ''}".encode()
    return hashlib.sha256(encoded).hexdigest()


def generate_and_apply_blueprint(
    session: Session,
    user: User,
    project_id: UUID,
    verification: VerificationPort,
    *,
    provider: AIProvider | None = None,
    request=None,
) -> BlueprintResultDTO:
    """读取项目已就绪的文字资料，由 AI 生成模块、需求、里程碑与任务分工草案。"""
    # 1) 只读读取项目、资料与成员（先不加写锁，避免 LLM 调用耗时占用行锁）
    relation = permissions.require_project_member(session, user, project_id, write=True)
    project = relation.project
    if project.lifecycle != "active" or (
        relation.course is not None and relation.course.status != "active"
    ):
        raise ApiError(403, "PROJECT_READ_ONLY", "当前项目或课程已只读。")

    if project.setup_status not in DRAFT_SETUP:
        raise ApiError(
            409,
            "BASELINE_FROZEN",
            "需求基线已进入确认或已冻结，请先保持在草稿状态后再使用 AI 全量解析。",
        )
    existing_plan = planning_service._latest_plan(session, project.id)
    if existing_plan is not None and existing_plan.status == planning_service.FROZEN:
        raise ApiError(
            409,
            "PLAN_FROZEN",
            "任务计划已冻结，组长解锁后再用 AI 重新生成。",
        )

    materials = list(
        session.scalars(
            select(BProjectMaterial)
            .where(
                BProjectMaterial.project_id == project.id,
                BProjectMaterial.extract_status == "ready",
                BProjectMaterial.text_content.is_not(None),
            )
            .order_by(BProjectMaterial.created_at, BProjectMaterial.id)
            .limit(MAX_DOCUMENTS)
        )
    )
    docs = [
        BlueprintMaterialDoc(
            material_id=m.id,
            title=m.title,
            text=(m.text_content or "").strip()[:MAX_DOC_CHARS],
        )
        for m in materials
        if (m.text_content or "").strip()
    ]
    if not docs:
        raise ApiError(
            409,
            "NO_ANALYZABLE_MATERIALS",
            "还没有提取出正文的资料，请先在需求或初始化中心上传分工计划/项目文档。",
        )

    member_rows = session.execute(
        select(User.id, User.name, User.github_username)
        .join(ProjectMember, ProjectMember.user_id == User.id)
        .where(ProjectMember.project_id == project.id, ProjectMember.left_at.is_(None))
        .order_by(ProjectMember.joined_at, User.id)
    ).all()
    members = [
        BlueprintMemberBrief(
            id=uid,
            name=name or "组员",
            github_username=gh,
        )
        for uid, name, gh in member_rows
    ]
    schedule = session.get(BProjectSchedule, project.id)
    payload = ProjectBlueprintInput(
        project_id=project.id,
        project_name=project.name,
        start_date=schedule.start_date.isoformat() if schedule else None,
        end_date=project.final_deadline.date().isoformat() if project.final_deadline else None,
        members=members,
        documents=docs,
    )

    run_id = uuid4()
    started_at = now()
    result = generate_project_blueprint(
        payload,
        provider=provider,
        usage=AIUsageContext(user_id=user.id, project_id=project.id),
    )

    # 重新加锁并二次确认状态未被他人冻结
    relation = lock_project_for_write(session, user, project_id)
    project = relation.project
    if project.lifecycle != "active" or (
        relation.course is not None and relation.course.status != "active"
    ):
        raise ApiError(403, "PROJECT_READ_ONLY", "当前项目或课程已只读。")
    if project.setup_status not in DRAFT_SETUP:
        raise ApiError(409, "BASELINE_FROZEN", "分析期间需求基线已被提交或冻结，未写入草案。")
    existing_plan = planning_service._latest_plan(session, project.id, lock=True)
    if existing_plan is not None and existing_plan.status == planning_service.FROZEN:
        raise ApiError(409, "PLAN_FROZEN", "分析期间任务计划已被冻结，未写入草案。")

    materials_by_id = {m.id: m for m in materials}
    run = BAnalysisRun(
        id=run_id,
        project_id=project.id,
        requested_by=user.id,
        status="processing",
        material_ids=[str(d.material_id) for d in docs],
        created_at=started_at,
    )
    session.add(run)
    session.flush()

    # 1) 模块
    existing_modules = {
        m.name.strip(): m
        for m in session.scalars(
            select(FunctionalModule).where(FunctionalModule.project_id == project.id)
        )
    }
    modules_added = 0

    def ensure_module(
        name: str, description: str = "", owner_id: UUID | None = None
    ) -> FunctionalModule:
        nonlocal modules_added
        clean = name.strip()[:200] or "核心模块"
        existing = existing_modules.get(clean)
        if existing is not None:
            if owner_id and existing.owner_id is None:
                existing.owner_id = owner_id
            return existing
        row = FunctionalModule(
            id=uuid4(),
            project_id=project.id,
            owner_id=owner_id,
            name=clean,
            description=description.strip()[:2000] or None,
            sort_order=len(existing_modules) + 1,
        )
        session.add(row)
        session.flush()
        session.add(BModuleMeta(module_id=row.id, project_id=project.id, origin="ai"))
        existing_modules[clean] = row
        modules_added += 1
        return row

    for m_item in result.modules:
        ensure_module(m_item.name, m_item.description, m_item.owner_id)

    # 2) 需求
    existing_reqs = {
        r.title.strip(): r
        for r in session.scalars(select(Requirement).where(Requirement.project_id == project.id))
    }
    requirements_added = 0
    reqs_by_title: dict[str, Requirement] = dict(existing_reqs)
    for r_item in result.requirements:
        title = r_item.title.strip()[:240]
        if not title:
            continue
        mod = ensure_module(r_item.module)
        if title in reqs_by_title:
            continue
        req = Requirement(
            id=uuid4(),
            project_id=project.id,
            module_id=mod.id,
            title=title,
            description=r_item.description.strip() or None,
            priority=r_item.priority,
            status="draft",
            source_summary=r_item.quote.strip()[:300] or None,
            created_by=user.id,
        )
        session.add(req)
        session.flush()
        requirement_history.register(session, req, user.id)
        session.add(
            BRequirementMeta(
                requirement_id=req.id,
                project_id=project.id,
                origin="ai",
                ai_key=_ai_req_key(title, mod.name, r_item.material_id),
                analysis_run_id=run.id,
            )
        )
        mat = materials_by_id.get(r_item.material_id) if r_item.material_id else None
        if mat is not None:
            ref = SourceReference(
                id=uuid4(),
                project_id=project.id,
                created_by=user.id,
                source_type=SEGMENT_SOURCE,
                external_id=f"{mat.id}:p1",
                title=mat.title,
                metadata_json={
                    "material_id": str(mat.id),
                    "segment_id": "p1",
                    "quote": (r_item.quote or mat.title)[:300],
                    "analysis_run_id": str(run.id),
                },
            )
            session.add(ref)
            session.flush()
            session.add(
                RequirementSourceReference(requirement_id=req.id, source_reference_id=ref.id)
            )
        reqs_by_title[title] = req
        requirements_added += 1
    session.flush()

    # 3) 范围说明（仅空时自动填充）
    scope_row = session.get(BBaselineScope, project.id)
    if result.in_scope:
        if scope_row is None:
            session.add(
                BBaselineScope(
                    project_id=project.id,
                    in_scope=result.in_scope,
                    out_of_scope=result.out_of_scope,
                    updated_by=user.id,
                )
            )
        elif not scope_row.in_scope.strip():
            scope_row.in_scope = result.in_scope
            if not scope_row.out_of_scope.strip() and result.out_of_scope:
                scope_row.out_of_scope = result.out_of_scope
            scope_row.updated_by = user.id
            scope_row.lock_version += 1

    # 4) 里程碑与交付物
    existing_milestones = {
        m.title.strip(): m
        for m in session.scalars(select(Milestone).where(Milestone.project_id == project.id))
    }
    milestones_added = 0
    ms_count_base = len(existing_milestones)
    base_start = (
        datetime.combine(schedule.start_date, time(23, 59, 0), tzinfo=UTC)
        if schedule
        else started_at
    )
    for idx, ms_item in enumerate(result.milestones, start=1):
        title = ms_item.title.strip()[:200]
        if not title or title in existing_milestones:
            continue
        fallback_dt = base_start + timedelta(days=7 * idx)
        ms = Milestone(
            id=uuid4(),
            project_id=project.id,
            title=title,
            description=ms_item.description.strip() or None,
            deadline=_parse_deadline(ms_item.deadline, fallback_dt),
            status="not_started",
            progress_percent=0,
            sort_order=ms_count_base + idx,
        )
        session.add(ms)
        session.flush()
        for d_idx, d_title in enumerate(ms_item.deliverables):
            clean_d = d_title.strip()[:200]
            if not clean_d:
                continue
            session.add(
                BMilestoneDeliverable(
                    id=uuid4(),
                    milestone_id=ms.id,
                    project_id=project.id,
                    title=clean_d,
                    sort_order=d_idx,
                    created_by=user.id,
                )
            )
        existing_milestones[title] = ms
        milestones_added += 1
    session.flush()

    # 5) 任务分工草案（独立项目直接写入任务计划草稿；课程项目基线未冻结前写入 AI 建议待采纳）
    tasks_added = 0
    suggestions_added = 0
    existing_task_titles = {
        t.title.strip() for t in session.scalars(select(Task).where(Task.project_id == project.id))
    }

    if project.course_id is None:
        plan = existing_plan or planning_service._new_draft(session, project, user, based_on=None)
        for t_item in result.tasks:
            t_title = t_item.title.strip()[:240]
            if not t_title or t_title in existing_task_titles:
                continue
            mod = ensure_module(t_item.module)
            linked_reqs = [
                reqs_by_title[rt].id for rt in t_item.requirement_titles if rt in reqs_by_title
            ]
            if not linked_reqs and reqs_by_title:
                first_in_mod = next(
                    (r.id for r in reqs_by_title.values() if r.module_id == mod.id), None
                )
                if first_in_mod:
                    linked_reqs = [first_in_mod]
            linked_ms = [
                existing_milestones[mt].id
                for mt in t_item.milestone_titles
                if mt in existing_milestones
            ]
            cmd = TaskInput(
                title=t_title,
                description=t_item.description.strip(),
                module_id=mod.id,
                parent_task_id=None,
                requirement_ids=linked_reqs,
                assignee_ids=t_item.assignee_ids,
                dependency_ids=[],
                milestone_ids=linked_ms,
                priority=t_item.priority,
                weight=t_item.weight,
                criteria=[CriterionInput(text=c) for c in t_item.acceptance_criteria],
            )
            planning_service._save(
                session,
                user,
                project,
                plan,
                None,
                cmd,
                verification,
                origin="ai",
                request=request,
            )
            existing_task_titles.add(t_title)
            tasks_added += 1
    else:
        for t_item in result.tasks:
            t_title = t_item.title.strip()[:240]
            if not t_title:
                continue
            req_id = next(
                (reqs_by_title[rt].id for rt in t_item.requirement_titles if rt in reqs_by_title),
                None,
            )
            if req_id is None and reqs_by_title:
                req_id = next(iter(reqs_by_title.values())).id
            if req_id is None:
                continue
            fp = hashlib.sha256(f"{req_id}|{t_title.lower()}".encode()).hexdigest()
            exists = session.scalar(
                select(BTaskSuggestion.id).where(
                    BTaskSuggestion.project_id == project.id, BTaskSuggestion.fingerprint == fp
                )
            )
            if exists is not None:
                continue
            session.add(
                BTaskSuggestion(
                    id=uuid4(),
                    project_id=project.id,
                    requirement_id=req_id,
                    fingerprint=fp,
                    title=t_title,
                    description=t_item.description.strip(),
                    acceptance_criteria=t_item.acceptance_criteria,
                    provider=result.provider,
                    is_placeholder=result.is_placeholder,
                    created_by=user.id,
                )
            )
            suggestions_added += 1

    run.status = "succeeded"
    run.is_placeholder = result.is_placeholder
    run.finished_at = now()
    run.summary = {
        "modules_added": modules_added,
        "requirements_added": requirements_added,
        "milestones_added": milestones_added,
        "tasks_added": tasks_added,
        "suggestions_added": suggestions_added,
        "requirements_kept": max(0, len(existing_reqs)),
        "conflicts_added": 0,
    }
    project.setup_step = max(project.setup_step, 3)
    record_audit(
        session,
        actor=user,
        action="project.ai_blueprint.generated",
        target=("b_analysis_run", run.id),
        project_id=project.id,
        course_id=project.course_id,
        after=run.summary,
        request=request,
    )
    session.flush()
    return BlueprintResultDTO(
        analysis_run_id=run.id,
        modules_added=modules_added,
        requirements_added=requirements_added,
        milestones_added=milestones_added,
        tasks_added=tasks_added,
        suggestions_added=suggestions_added,
        is_placeholder=result.is_placeholder,
        needs_human_review=True,
    )
