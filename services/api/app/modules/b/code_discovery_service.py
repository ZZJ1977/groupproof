"""Code-driven incremental task discovery & non-blocking frozen-plan supplemental amendments.

Allows teams to scan unmatched substantive GitHub commits, receive merge-first AI
suggestions (``merge_existing`` / ``new_subtask`` / ``new_top_level``), and adopt
them either directly (draft / solo / L1 merge) or via tiered peer/leader approval
on a frozen plan without unfreezing or touching existing tasks' ``lock_version``.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import ROUND_DOWN, Decimal
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import func, select
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.auth.models import VerifiedGithubIdentity
from app.db.models import (
    AcceptanceCriterion,
    FunctionalModule,
    PlanVersion,
    Project,
    ProjectMember,
    Task,
    TaskAssignee,
    User,
)
from app.modules.a import github_activity, permissions
from app.modules.a.ai import (
    AIUsageContext,
    CodeDiscoveryCommitBrief,
    CodeDiscoveryExistingTaskBrief,
    CodeDiscoveryMemberBrief,
    CodeDiscoveryModuleBrief,
    CodeTaskDiscoveryInput,
    discover_tasks_from_code,
)
from app.modules.a.ai.provider import AIProvider
from app.modules.a.audit import record_audit
from app.modules.a.github_activity import (
    _is_excluded_bot_author,
    _load_project_member_directory,
    _row_actor_account_id,
)
from app.modules.a.inbox import notify
from app.modules.a.models import GithubActivity
from app.modules.b.code_progress_service import (
    _extract_ai_summary_fields,
    _load_ai_summaries,
    _match_commits_to_tasks_and_criteria,
    _safe_github_url,
)
from app.modules.b.common import lock_project_for_write, now
from app.modules.b.models import (
    BModuleMeta,
    BProjectCounter,
    BTaskMeta,
    BTaskSuggestion,
    BTaskVersion,
)
from app.modules.b.planning_schemas import (
    AdoptCodeDiscoveryRequest,
    ApproveCodeDiscoveryRequest,
    CodeDiscoveryActionResultDTO,
    CodeDiscoveryDismissResultDTO,
    CodeDiscoveryItemDTO,
    CodeDiscoveryListDTO,
    CodeDiscoveryScanResultDTO,
    DiscoveryApprovalDTO,
    DiscoverySourceCommitDTO,
    DismissCodeDiscoveryRequest,
    ScanCodeDiscoveriesRequest,
    UnmatchedCommitDTO,
)
from app.modules.b.planning_service import (
    FROZEN,
    _facts,
    _latest_plan,
    _members,
    _task_snapshot,
    task_code,
)
from app.modules.c.activity_models import ActivityRecordState
from app.modules.c.integration_events import content_hash
from app.modules.c.models import (
    Evidence,
    EvidenceCriterion,
    EvidenceDecision,
    EvidenceSourceSnapshot,
)
from app.modules.d.contribution import _effective_code_lines, _is_merge_commit

_CODE_DISCOVERY_EVIDENCE_REASON = (
    "由代码演进增补任务自动挂接的来源代码提交候选证据，待人工复核确认。"
)


@dataclass
class _UnmatchedCommitRecord:
    activity: GithubActivity
    sha: str
    author_name: str
    author_user_id: UUID | None
    effective_lines: int
    files: list[str]
    ai_headline: str
    ai_implementation: str


def _has_tables(session: Session, *table_names: str) -> bool:
    bind = session.get_bind()
    if bind is None:
        return False
    inspector = sa_inspect(bind)
    return all(inspector.has_table(name) for name in table_names)


def _utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)


def _code_fingerprint(title: str) -> str:
    normalised = re.sub(r"[\W_]+", "", unicodedata.normalize("NFKC", title).casefold())
    return hashlib.sha256(f"github_code|{normalised}".encode()).hexdigest()


def _next_task_seq_portable(session: Session, project_id: UUID) -> int:
    max_existing = int(
        session.scalar(select(func.max(BTaskMeta.seq)).where(BTaskMeta.project_id == project_id))
        or 0
    )
    counter = session.get(BProjectCounter, project_id)
    if counter is None:
        next_val = max_existing + 1
        session.add(BProjectCounter(project_id=project_id, requirement_seq=0, task_seq=next_val))
        session.flush()
        return next_val
    next_val = max(int(counter.task_seq or 0), max_existing) + 1
    counter.task_seq = next_val
    session.flush()
    return next_val


def _equal_responsibility_shares(assignee_ids: list[UUID]) -> dict[str, str]:
    if not assignee_ids:
        return {}
    n = len(assignee_ids)
    quant = Decimal("0.01")
    base = (Decimal("100") / Decimal(n)).quantize(quant, rounding=ROUND_DOWN)
    remainder_units = int((Decimal("100") - base * n) / quant)
    shares: dict[str, str] = {}
    for idx, uid in enumerate(assignee_ids):
        val = base + (quant if idx < remainder_units else Decimal("0"))
        shares[str(uid)] = str(val)
    return shares


def _user_display_name(user: User | None, fallback: str = "项目成员") -> str:
    if user is None:
        return fallback
    return (user.name or user.username or user.email or fallback).strip()


def _leader_user_ids(session: Session, project: Project) -> set[UUID]:
    leaders = set(
        session.scalars(
            select(ProjectMember.user_id).where(
                ProjectMember.project_id == project.id,
                ProjectMember.role == "leader",
                ProjectMember.left_at.is_(None),
            )
        ).all()
    )
    if project.group_id is not None:
        from app.db.models import ProjectGroup

        group = session.get(ProjectGroup, project.group_id)
        if group is not None and group.leader_id is not None:
            leaders.add(group.leader_id)
    return leaders


def _find_unmatched_commit_records(
    session: Session,
    project_id: UUID,
    *,
    max_commits: int | None = None,
) -> list[_UnmatchedCommitRecord]:
    """Identify substantive non-bot/non-merge/non-lockfile commits not yet linked to any task."""
    if not _has_tables(session, GithubActivity.__tablename__):
        return []

    commits = list(
        session.scalars(
            select(GithubActivity)
            .where(
                GithubActivity.project_id == project_id,
                GithubActivity.kind == "commit",
                GithubActivity.deleted.is_(False),
            )
            .order_by(GithubActivity.occurred_at.desc(), GithubActivity.id.desc())
        ).all()
    )
    if not commits:
        return []

    facts = _facts(session, project_id)
    modules_by_id = {
        m.id: m.name
        for m in session.scalars(
            select(FunctionalModule).where(FunctionalModule.project_id == project_id)
        ).all()
    }
    stats_by_task, ai_summaries, _, _ = _match_commits_to_tasks_and_criteria(
        session, project_id, facts.tasks, facts.meta, modules_by_id, facts.criteria
    )
    if not ai_summaries:
        ai_summaries = _load_ai_summaries(session, project_id)

    matched_ids: set[UUID] = set()
    for stat in stats_by_task.values():
        matched_ids.update(stat.matched_activity_ids)

    # Exclude commits referenced in discovered_from_json of adopted ai_code tasks.
    for meta in facts.meta.values():
        discovered = (
            meta.discovered_from_json if isinstance(meta.discovered_from_json, dict) else {}
        )
        for raw_cid in discovered.get("commit_ids") or []:
            try:
                matched_ids.add(UUID(str(raw_cid)))
            except ValueError:
                pass

    # Exclude commits already attached to active/formal Evidence records.
    matched_identities: set[str] = set()
    if _has_tables(session, Evidence.__tablename__, EvidenceSourceSnapshot.__tablename__):
        ev_rows = session.execute(
            select(
                EvidenceSourceSnapshot.source_identity,
                EvidenceSourceSnapshot.content_json,
            )
            .join(Evidence, Evidence.id == EvidenceSourceSnapshot.evidence_id)
            .where(
                Evidence.project_id == project_id,
                Evidence.source_type == "github",
                Evidence.status.in_(("candidate", "pending_confirmation", "formal")),
                Evidence.source_changed.is_(False),
            )
        ).all()
        for identity, content_json in ev_rows:
            if identity:
                matched_identities.add(str(identity))
            if isinstance(content_json, dict) and content_json.get("source_id"):
                try:
                    matched_ids.add(UUID(str(content_json["source_id"])))
                except ValueError:
                    pass

    # Exclude commits already linked to a task or explicitly ignored in ActivityRecordState.
    if _has_tables(session, ActivityRecordState.__tablename__):
        for state_row in session.scalars(
            select(ActivityRecordState).where(
                ActivityRecordState.project_id == project_id,
                ActivityRecordState.source_type == "github",
            )
        ).all():
            if state_row.task_id is not None or state_row.status == "ignored":
                matched_ids.add(state_row.source_id)
                if state_row.source_identity:
                    matched_identities.add(state_row.source_identity)

    # Resolve member authorship consistently with Module D contribution.
    active_member_ids = set(_members(session, project_id))
    directory = _load_project_member_directory(session, project_id, active_only=True)
    verified_by_account_id: dict[int, UUID] = {}
    if active_member_ids and _has_tables(session, VerifiedGithubIdentity.__tablename__):
        for gh_uid, uid in session.execute(
            select(VerifiedGithubIdentity.github_user_id, VerifiedGithubIdentity.user_id).where(
                VerifiedGithubIdentity.user_id.in_(active_member_ids)
            )
        ).all():
            verified_by_account_id[int(gh_uid)] = uid

    def _resolve_author_uid(row: GithubActivity) -> UUID | None:
        actor_account_id = _row_actor_account_id(row)
        if actor_account_id is not None and actor_account_id in verified_by_account_id:
            return verified_by_account_id[actor_account_id]
        if row.author_user_id is not None and row.author_user_id in active_member_ids:
            return row.author_user_id
        resolved = directory.resolve_member_uid(
            None,
            (row.author_login or "").strip() or None,
            (row.author_name or "").strip(),
            (row.author_email or "").strip().lower(),
            actor_account_id=actor_account_id,
        )
        return resolved if resolved in active_member_ids else None

    unmatched: list[_UnmatchedCommitRecord] = []
    for row in commits:
        if row.id in matched_ids:
            continue
        identity = f"{row.kind}:{row.external_id}" if row.external_id else ""
        if identity and identity in matched_identities:
            continue
        if _is_excluded_bot_author(row.author_login, row.author_name, row.author_email):
            continue
        if _is_merge_commit(row):
            continue
        eff_lines, non_excluded_paths, all_excluded = _effective_code_lines(row.detail)
        if all_excluded or (eff_lines <= 0 and not non_excluded_paths):
            continue
        ai_headline, ai_impl, _, _ = _extract_ai_summary_fields(ai_summaries.get(row.id))
        sha = (row.external_id or row.revision or str(row.id))[:40]
        author_name = (row.author_name or row.author_login or "项目成员").strip()
        unmatched.append(
            _UnmatchedCommitRecord(
                activity=row,
                sha=sha,
                author_name=author_name,
                author_user_id=_resolve_author_uid(row),
                effective_lines=eff_lines,
                files=non_excluded_paths[:60],
                ai_headline=ai_headline,
                ai_implementation=ai_impl,
            )
        )
        if max_commits is not None and len(unmatched) >= max_commits:
            break
    return unmatched


def _required_approvals_for(
    action_type: str,
    *,
    is_frozen: bool,
    active_member_count: int,
) -> int:
    if action_type == "merge_existing" or not is_frozen or active_member_count <= 1:
        return 1
    if action_type == "new_subtask":
        return min(active_member_count, 2)
    return min(active_member_count, max(2, (active_member_count // 2) + 1))


def _parse_approvals(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, str]] = []
    for item in raw:
        if not isinstance(item, dict) or not item.get("user_id"):
            continue
        out.append(
            {
                "user_id": str(item["user_id"]),
                "name": str(item.get("name") or "项目成员"),
                "role": str(item.get("role") or "member"),
                "approved_at": str(item.get("approved_at") or now().isoformat()),
            }
        )
    return out


def _authority_satisfied(
    session: Session,
    project: Project,
    action_type: str,
    parent_task_id: UUID | None,
    approver_ids: set[UUID],
) -> bool:
    leaders = _leader_user_ids(session, project)
    if action_type == "new_top_level":
        return bool(approver_ids & leaders)
    if action_type == "new_subtask":
        if approver_ids & leaders:
            return True
        if parent_task_id is not None:
            parent_owners = set(
                session.scalars(
                    select(TaskAssignee.user_id).where(
                        TaskAssignee.task_id == parent_task_id,
                        TaskAssignee.role == "responsible",
                        TaskAssignee.unassigned_at.is_(None),
                    )
                ).all()
            )
            if approver_ids & parent_owners:
                return True
        return False
    return True


def _serialize_items(
    session: Session,
    project: Project,
    user: User,
    relation: permissions.ProjectRelation,
    plan: PlanVersion | None,
    rows: list[BTaskSuggestion],
) -> list[CodeDiscoveryItemDTO]:
    if not rows:
        return []
    active_members = _members(session, project.id)
    active_member_count = len(active_members)
    is_frozen = plan is not None and plan.status == FROZEN
    can_write = relation.member and not relation.read_only

    module_ids = {r.suggested_module_id for r in rows if r.suggested_module_id is not None}
    task_ids = {
        tid
        for r in rows
        for tid in (r.target_task_id, r.suggested_parent_task_id)
        if tid is not None
    }
    user_ids = {r.proposed_by for r in rows if r.proposed_by is not None}

    modules_by_id = (
        {
            m.id: m.name
            for m in session.scalars(
                select(FunctionalModule).where(FunctionalModule.id.in_(list(module_ids)))
            ).all()
        }
        if module_ids
        else {}
    )
    tasks_by_id = (
        {
            t.id: t.title
            for t in session.scalars(select(Task).where(Task.id.in_(list(task_ids)))).all()
        }
        if task_ids
        else {}
    )
    users_by_id = (
        {
            u.id: _user_display_name(u)
            for u in session.scalars(select(User).where(User.id.in_(list(user_ids)))).all()
        }
        if user_ids
        else {}
    )

    items: list[CodeDiscoveryItemDTO] = []
    for row in rows:
        refs = row.source_refs_json if isinstance(row.source_refs_json, dict) else {}
        raw_commits = refs.get("commits") if isinstance(refs.get("commits"), list) else []
        source_commits: list[DiscoverySourceCommitDTO] = []
        for c in raw_commits:
            if not isinstance(c, dict) or not c.get("id"):
                continue
            try:
                cid = UUID(str(c["id"]))
            except ValueError:
                continue
            source_commits.append(
                DiscoverySourceCommitDTO(
                    id=cid,
                    sha=str(c.get("sha") or "")[:40],
                    title=str(c.get("title") or "")[:240],
                    author_name=str(c.get("author_name") or "项目成员"),
                    effective_lines=int(c.get("effective_lines") or 0),
                )
            )

        raw_assignees = (
            row.suggested_assignee_ids_json
            if isinstance(row.suggested_assignee_ids_json, list)
            else []
        )
        assignee_ids: list[UUID] = []
        for raw_uid in raw_assignees:
            try:
                assignee_ids.append(UUID(str(raw_uid)))
            except ValueError:
                continue

        approvals_raw = _parse_approvals(row.approvals_json)
        approvals_dtos: list[DiscoveryApprovalDTO] = []
        approved_user_ids: set[UUID] = set()
        for ap in approvals_raw:
            try:
                uid = UUID(ap["user_id"])
                dt = datetime.fromisoformat(ap["approved_at"])
            except ValueError:
                continue
            approved_user_ids.add(uid)
            approvals_dtos.append(
                DiscoveryApprovalDTO(
                    user_id=uid,
                    name=ap["name"],
                    role=ap["role"],
                    approved_at=dt,
                )
            )

        req_approvals = _required_approvals_for(
            row.action_type,
            is_frozen=is_frozen,
            active_member_count=active_member_count,
        )
        can_approve = (
            can_write
            and row.status == "pending"
            and row.approval_status == "pending_approval"
            and row.proposed_by is not None
            and user.id != row.proposed_by
            and user.id not in approved_user_ids
        )

        items.append(
            CodeDiscoveryItemDTO(
                id=row.id,
                status=row.status,  # type: ignore[arg-type]
                approval_status=row.approval_status,  # type: ignore[arg-type]
                source_type="github_code",
                action_type=row.action_type,  # type: ignore[arg-type]
                title=row.title,
                description=row.description or "",
                acceptance_criteria=[str(c) for c in (row.acceptance_criteria or [])],
                suggested_module_id=row.suggested_module_id,
                suggested_module_name=(
                    modules_by_id.get(row.suggested_module_id)
                    if row.suggested_module_id is not None
                    else None
                ),
                suggested_parent_task_id=row.suggested_parent_task_id,
                suggested_parent_task_title=(
                    tasks_by_id.get(row.suggested_parent_task_id)
                    if row.suggested_parent_task_id is not None
                    else None
                ),
                target_task_id=row.target_task_id,
                target_task_title=(
                    tasks_by_id.get(row.target_task_id) if row.target_task_id is not None else None
                ),
                suggested_assignee_ids=assignee_ids,
                suggested_weight=int(row.suggested_weight or 3),
                rationale=str(refs.get("rationale") or ""),
                confidence=float(refs.get("confidence", 0.75)),
                source_commits=source_commits,
                adopted_task_id=row.adopted_task_id,
                proposed_by_id=row.proposed_by,
                proposed_by_name=(
                    users_by_id.get(row.proposed_by) if row.proposed_by is not None else None
                ),
                approvals=approvals_dtos,
                required_approvals=req_approvals,
                can_approve=can_approve,
                provider=row.provider,
                is_placeholder=bool(row.is_placeholder),
                created_at=row.created_at,
            )
        )
    return items


def _build_list_dto(
    session: Session,
    project: Project,
    user: User,
    relation: permissions.ProjectRelation,
    *,
    unmatched: list[_UnmatchedCommitRecord] | None = None,
) -> CodeDiscoveryListDTO:
    if unmatched is None:
        unmatched = _find_unmatched_commit_records(session, project.id)
    plan = _latest_plan(session, project.id)
    rows = list(
        session.scalars(
            select(BTaskSuggestion)
            .where(
                BTaskSuggestion.project_id == project.id,
                BTaskSuggestion.source_type == "github_code",
            )
            .order_by(BTaskSuggestion.created_at.desc(), BTaskSuggestion.id.desc())
        ).all()
    )
    items = _serialize_items(session, project, user, relation, plan, rows)
    pending_count = sum(
        1 for item in items if item.status == "pending" and item.approval_status == "none"
    )
    pending_approval_count = sum(
        1
        for item in items
        if item.status == "pending" and item.approval_status == "pending_approval"
    )
    unmatched_dtos = [
        UnmatchedCommitDTO(
            id=rec.activity.id,
            sha=rec.sha,
            title=rec.activity.title or "",
            author_name=rec.author_name,
            author_user_id=rec.author_user_id,
            occurred_at=_utc(rec.activity.occurred_at),
            effective_lines=rec.effective_lines,
            files_count=len(rec.files),
        )
        for rec in unmatched
    ]
    return CodeDiscoveryListDTO(
        unmatched_commits_count=len(unmatched_dtos),
        unmatched_commits=unmatched_dtos,
        pending_count=pending_count,
        pending_approval_count=pending_approval_count,
        items=items,
    )


def list_code_discoveries(session: Session, user: User, project_id: UUID) -> CodeDiscoveryListDTO:
    relation = permissions.require_project_read(session, user, project_id)
    project = relation.project
    return _build_list_dto(session, project, user, relation)


def scan_code_discoveries(
    session: Session,
    user: User,
    project_id: UUID,
    cmd: ScanCodeDiscoveriesRequest | None = None,
    *,
    provider: AIProvider | None = None,
    request=None,
) -> CodeDiscoveryScanResultDTO:
    relation = permissions.require_project_member(session, user, project_id)
    project = relation.project
    max_commits = cmd.max_commits if cmd is not None else 60
    unmatched = _find_unmatched_commit_records(session, project_id, max_commits=max_commits)
    if not unmatched:
        listing = _build_list_dto(session, project, user, relation, unmatched=[])
        return CodeDiscoveryScanResultDTO(**listing.model_dump(), created_count=0)

    facts = _facts(session, project_id)
    modules = list(
        session.scalars(
            select(FunctionalModule)
            .where(FunctionalModule.project_id == project_id)
            .order_by(FunctionalModule.sort_order, FunctionalModule.created_at)
        ).all()
    )
    modules_by_id = {m.id: m.name for m in modules}
    member_ids = _members(session, project_id)
    members = (
        list(session.scalars(select(User).where(User.id.in_(member_ids))).all())
        if member_ids
        else []
    )
    ai_input = CodeTaskDiscoveryInput(
        project_id=project_id,
        project_name=project.name,
        modules=[
            CodeDiscoveryModuleBrief(id=m.id, name=m.name, description=(m.description or "")[:600])
            for m in modules[:40]
        ],
        existing_tasks=[
            CodeDiscoveryExistingTaskBrief(
                id=t.id,
                code=facts.code(t.id),
                title=t.title,
                description=(t.description or "")[:1000],
                module_id=t.module_id,
                module_name=modules_by_id.get(t.module_id, ""),
                parent_task_id=t.parent_task_id,
                status=t.status,
                weight=int(t.weight),
            )
            for t in facts.tasks[:200]
        ],
        members=[
            CodeDiscoveryMemberBrief(
                id=m.id,
                name=_user_display_name(m),
                github_username=m.github_username,
            )
            for m in members[:30]
        ],
        unmatched_commits=[
            CodeDiscoveryCommitBrief(
                id=rec.activity.id,
                sha=rec.sha,
                title=(rec.activity.title or rec.sha)[:240],
                summary=(rec.activity.summary or "")[:2000],
                author_name=rec.author_name[:120],
                author_user_id=rec.author_user_id,
                occurred_at=_utc(rec.activity.occurred_at).isoformat()
                if rec.activity.occurred_at
                else None,
                effective_lines=rec.effective_lines,
                files=rec.files[:60],
                ai_headline=rec.ai_headline[:240],
                ai_implementation=rec.ai_implementation[:600],
            )
            for rec in unmatched
        ],
    )

    ai_result = discover_tasks_from_code(
        ai_input,
        provider=provider,
        usage=AIUsageContext(user_id=user.id, project_id=project_id),
    )

    relation = lock_project_for_write(session, user, project_id)
    project = relation.project
    unmatched_by_id = {rec.activity.id: rec for rec in unmatched}
    existing_fps = set(
        session.scalars(
            select(BTaskSuggestion.fingerprint).where(BTaskSuggestion.project_id == project_id)
        ).all()
    )

    created_count = 0
    for item in ai_result.suggestions:
        title = item.title.strip()[:240]
        criteria = [c.strip()[:500] for c in item.acceptance_criteria if c.strip()][:10]
        if not title or not criteria:
            continue
        fp = _code_fingerprint(title)
        if fp in existing_fps:
            continue

        commit_refs = []
        for cid in item.source_commit_ids:
            rec = unmatched_by_id.get(cid)
            if rec is None:
                continue
            commit_refs.append(
                {
                    "id": str(rec.activity.id),
                    "sha": rec.sha,
                    "title": (rec.activity.title or "")[:240],
                    "author_name": rec.author_name,
                    "effective_lines": rec.effective_lines,
                }
            )
        if not commit_refs:
            continue

        suggestion = BTaskSuggestion(
            id=uuid4(),
            project_id=project.id,
            requirement_id=None,
            source_type="github_code",
            action_type=item.action_type,
            target_task_id=item.target_task_id,
            suggested_module_id=item.suggested_module_id,
            suggested_parent_task_id=item.suggested_parent_task_id,
            suggested_assignee_ids_json=[str(uid) for uid in item.suggested_assignee_ids],
            suggested_weight=int(item.suggested_weight),
            source_refs_json={
                "commits": commit_refs,
                "rationale": item.rationale,
                "confidence": float(item.confidence),
            },
            approval_status="none",
            fingerprint=fp,
            title=title,
            description=item.description.strip()[:5000],
            acceptance_criteria=criteria,
            provider=ai_result.provider[:40],
            is_placeholder=bool(ai_result.is_placeholder),
            status="pending",
            created_by=user.id,
            created_at=now(),
        )
        try:
            with session.begin_nested():
                session.add(suggestion)
                session.flush()
            existing_fps.add(fp)
            created_count += 1
        except IntegrityError:
            continue

    record_audit(
        session,
        actor=user,
        action="plan.code_discovery.scanned",
        target=("project", project.id),
        project_id=project.id,
        course_id=project.course_id,
        after={
            "unmatched_commits": len(unmatched),
            "created_count": created_count,
            "provider": ai_result.provider,
        },
        request=request,
    )
    session.flush()
    listing = _build_list_dto(session, project, user, relation, unmatched=unmatched)
    return CodeDiscoveryScanResultDTO(**listing.model_dump(), created_count=created_count)


def _attach_commits_as_candidate_evidences(
    session: Session,
    project_id: UUID,
    task: Task,
    criteria: list[AcceptanceCriterion],
    commit_ids: list[UUID],
    *,
    assignee_ids: list[UUID],
    fallback_actor_id: UUID,
) -> int:
    """Attach source commits to ``task`` as candidate GitHub Evidence records idempotently."""
    if not commit_ids or not _has_tables(
        session, Evidence.__tablename__, EvidenceSourceSnapshot.__tablename__
    ):
        return 0

    activities = list(
        session.scalars(
            select(GithubActivity)
            .where(
                GithubActivity.project_id == project_id,
                GithubActivity.id.in_(commit_ids),
                GithubActivity.deleted.is_(False),
            )
            .order_by(GithubActivity.occurred_at.asc(), GithubActivity.id.asc())
        ).all()
    )
    if not activities:
        return 0

    ai_summaries = _load_ai_summaries(session, project_id)
    existing_keys: set[tuple[UUID, str]] = set()
    for ev_task_id, content_json in session.execute(
        select(Evidence.task_id, EvidenceSourceSnapshot.content_json)
        .join(EvidenceSourceSnapshot, EvidenceSourceSnapshot.evidence_id == Evidence.id)
        .where(
            Evidence.project_id == project_id,
            Evidence.task_id == task.id,
            Evidence.source_type == "github",
            EvidenceSourceSnapshot.version_no == 1,
        )
    ).all():
        if isinstance(content_json, dict) and content_json.get("source_id"):
            existing_keys.add((ev_task_id, str(content_json["source_id"])))

    has_states = _has_tables(session, ActivityRecordState.__tablename__)
    existing_states: dict[UUID, ActivityRecordState] = {}
    existing_identities: set[str] = set()
    if has_states:
        for st_row in session.scalars(
            select(ActivityRecordState).where(
                ActivityRecordState.project_id == project_id,
                ActivityRecordState.source_type == "github",
            )
        ).all():
            existing_states[st_row.source_id] = st_row
            if st_row.source_identity:
                existing_identities.add(st_row.source_identity)

    assignee_set = set(assignee_ids)
    created = 0
    for act in activities:
        if (task.id, str(act.id)) in existing_keys:
            continue
        sha = (act.external_id or act.revision or str(act.id))[:40]
        short_sha = sha[:7]
        ai_headline, ai_impl, ai_impact, ai_ver = _extract_ai_summary_fields(
            ai_summaries.get(act.id)
        )
        ev_title = f"[{short_sha}] {ai_headline or act.title or 'GitHub 代码提交'}"[:240]
        detail = act.detail if isinstance(act.detail, dict) else {}
        raw_files = detail.get("files") if isinstance(detail.get("files"), list) else []
        file_paths = [
            str(item.get("path"))
            for item in raw_files
            if isinstance(item, dict) and item.get("path")
        ]
        desc_lines = [f"实现内容：{ai_impl or act.summary or act.title or 'GitHub 代码提交'}"]
        if ai_impact:
            desc_lines.append(f"影响范围：{ai_impact}")
        if ai_ver:
            desc_lines.append(f"验证说明：{'；'.join(ai_ver[:2])}")
        if file_paths:
            preview = "、".join(file_paths[:8])
            suffix = f" 等 {len(file_paths)} 个文件" if len(file_paths) > 8 else ""
            desc_lines.append(f"改动文件：{preview}{suffix}")
        author_label = act.author_name or act.author_login or "项目成员"
        desc_lines.append(f"提交人：{author_label} · 提交编号：{short_sha}")
        ev_desc = "\n".join(desc_lines)

        if act.author_user_id and act.author_user_id in assignee_set:
            author_id = act.author_user_id
        elif assignee_ids:
            author_id = assignee_ids[0]
        else:
            author_id = act.author_user_id or fallback_actor_id

        canonical_source = github_activity._record(act, author_id).source
        ev_id = uuid4()
        session.add(
            Evidence(
                id=ev_id,
                project_id=project_id,
                task_id=task.id,
                author_id=author_id,
                title=ev_title,
                description=ev_desc,
                source_type="github",
                source_url=_safe_github_url(act.url),
                status="candidate",
                lock_version=0,
                source_changed=False,
            )
        )
        session.flush()
        for crit in criteria[:10]:
            session.add(EvidenceCriterion(evidence_id=ev_id, criterion_id=crit.id))
        session.add(
            EvidenceSourceSnapshot(
                evidence_id=ev_id,
                version_no=1,
                source_identity=canonical_source.identity,
                source_revision=canonical_source.revision,
                content_hash=content_hash(
                    {
                        "availability": canonical_source.availability,
                        "source": canonical_source.content,
                    }
                ),
                content_json={
                    "source_id": str(act.id),
                    "availability": canonical_source.availability,
                    "source": canonical_source.content,
                },
                captured_by=author_id,
            )
        )
        session.add(
            EvidenceDecision(
                evidence_id=ev_id,
                actor_id=author_id,
                decision="submitted",
                resulting_status="candidate",
                reason=_CODE_DISCOVERY_EVIDENCE_REASON,
            )
        )
        existing_keys.add((task.id, str(act.id)))
        created += 1

        if has_states:
            st = existing_states.get(act.id)
            if st is None and canonical_source.identity not in existing_identities:
                st = ActivityRecordState(
                    id=uuid4(),
                    project_id=project_id,
                    source_type="github",
                    source_id=act.id,
                    source_identity=canonical_source.identity,
                    status="candidate",
                    task_id=task.id,
                    evidence_id=None,
                )
                session.add(st)
                existing_states[act.id] = st
                existing_identities.add(canonical_source.identity)
            elif st is not None and st.task_id is None and st.status != "ignored":
                st.task_id = task.id

    session.flush()
    return created


def _ensure_module_id(
    session: Session,
    project: Project,
    preferred_module_id: UUID | None,
    *,
    owner_id: UUID,
) -> UUID:
    if preferred_module_id is not None:
        mod = session.get(FunctionalModule, preferred_module_id)
        if mod is not None and mod.project_id == project.id:
            return mod.id
    first = session.scalar(
        select(FunctionalModule)
        .where(FunctionalModule.project_id == project.id)
        .order_by(FunctionalModule.sort_order, FunctionalModule.created_at)
        .limit(1)
    )
    if first is not None:
        return first.id
    created = FunctionalModule(
        id=uuid4(),
        project_id=project.id,
        owner_id=owner_id,
        name="代码演进增补模块",
        description="由代码演进增补任务自动创建的默认模块。",
        core=False,
        sort_order=99,
    )
    session.add(created)
    session.flush()
    session.add(
        BModuleMeta(
            module_id=created.id,
            project_id=project.id,
            origin="ai",
            edited_by_human=False,
        )
    )
    session.flush()
    return created.id


def _load_code_suggestion(
    session: Session, project_id: UUID, suggestion_id: UUID
) -> BTaskSuggestion:
    row = session.scalar(
        select(BTaskSuggestion)
        .where(
            BTaskSuggestion.id == suggestion_id,
            BTaskSuggestion.project_id == project_id,
            BTaskSuggestion.source_type == "github_code",
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None:
        raise ApiError(404, "SUGGESTION_NOT_FOUND", "代码发现建议不存在。")
    return row


def _extract_source_commits(row: BTaskSuggestion) -> tuple[list[UUID], list[str]]:
    refs = row.source_refs_json if isinstance(row.source_refs_json, dict) else {}
    raw_commits = refs.get("commits") if isinstance(refs.get("commits"), list) else []
    commit_ids: list[UUID] = []
    shas: list[str] = []
    for item in raw_commits:
        if not isinstance(item, dict) or not item.get("id"):
            continue
        try:
            cid = UUID(str(item["id"]))
        except ValueError:
            continue
        commit_ids.append(cid)
        sha = str(item.get("sha") or "")[:40]
        if sha:
            shas.append(sha)
    return commit_ids, shas


def _materialize_supplemental_task(
    session: Session,
    project: Project,
    plan: PlanVersion | None,
    row: BTaskSuggestion,
    *,
    actor: User,
    proposer_id: UUID,
    action_type: str,
    title: str,
    description: str,
    module_id: UUID,
    parent_task_id: UUID | None,
    assignee_ids: list[UUID],
    weight: int,
    acceptance_criteria: list[str],
    reason: str,
    request=None,
) -> tuple[Task, int]:
    """Atomically append an ``ai_code`` task without unfreezing plan or touching existing tasks."""
    moment = now()
    is_frozen = plan is not None and plan.status == FROZEN
    commit_ids, shas = _extract_source_commits(row)
    shares = _equal_responsibility_shares(assignee_ids)

    new_task = Task(
        id=uuid4(),
        project_id=project.id,
        module_id=module_id,
        parent_task_id=parent_task_id,
        created_by=proposer_id,
        title=title[:240],
        description=description[:5000],
        priority="medium",
        weight=weight,
        status="not_started",
        progress_percent=0,
        lock_version=0,
    )
    session.add(new_task)
    session.flush()

    for uid in assignee_ids:
        session.add(
            TaskAssignee(
                task_id=new_task.id,
                user_id=uid,
                role="responsible",
                assigned_at=moment,
            )
        )

    created_criteria: list[AcceptanceCriterion] = []
    for idx, text_val in enumerate(acceptance_criteria):
        crit = AcceptanceCriterion(
            id=uuid4(),
            task_id=new_task.id,
            criterion_key=f"AC-{uuid4().hex[:8]}",
            text=text_val.strip()[:2000],
            sort_order=idx,
        )
        session.add(crit)
        created_criteria.append(crit)

    seq = _next_task_seq_portable(session, project.id)
    code = task_code(seq) or f"T-{seq:03d}"
    discovered_from = {
        "source_type": "github_code",
        "commit_ids": [str(cid) for cid in commit_ids],
        "shas": shas,
        "commit_count": len(commit_ids),
        "amendment_mode": "frozen_supplemental" if is_frozen else "draft_adoption",
        "action_type": action_type,
        "reason": reason,
        "proposed_by_id": str(proposer_id),
        "approved_by_id": str(actor.id),
        "approved_by_name": _user_display_name(actor),
        "approved_at": moment.isoformat(),
        "responsibility_shares": shares,
    }
    meta = BTaskMeta(
        task_id=new_task.id,
        project_id=project.id,
        seq=seq,
        content_version=1,
        origin="ai_code",
        suggestion_id=row.id,
        discovered_from_json=discovered_from,
    )
    session.add(meta)
    session.flush()

    facts = _facts(session, project.id)
    snapshot = _task_snapshot(facts, new_task)
    session.add(
        BTaskVersion(
            id=uuid4(),
            task_id=new_task.id,
            project_id=project.id,
            plan_version_id=plan.id if plan is not None else None,
            version_no=1,
            snapshot=snapshot,
            created_by=actor.id,
            created_at=moment,
        )
    )

    if is_frozen and plan is not None:
        # Append ONLY the new supplemental task to the frozen plan snapshot without unfreezing
        # and without bumping any existing task's lock_version.
        existing_snap = dict(plan.snapshot_json) if isinstance(plan.snapshot_json, dict) else {}
        snap_tasks = list(existing_snap.get("tasks") or [])
        snap_tasks.append(
            {
                "id": str(new_task.id),
                "code": code,
                "content_version": 1,
                "origin": "ai_code",
                **snapshot,
            }
        )
        existing_snap["tasks"] = snap_tasks
        plan.snapshot_json = existing_snap
        plan.lock_version += 1

    attached_count = _attach_commits_as_candidate_evidences(
        session,
        project.id,
        new_task,
        created_criteria,
        commit_ids,
        assignee_ids=assignee_ids,
        fallback_actor_id=actor.id,
    )

    row.status = "adopted"
    row.approval_status = "approved"
    row.adopted_task_id = new_task.id
    row.approved_by = actor.id
    row.approved_at = moment
    row.handled_by = actor.id
    row.handled_at = moment

    record_audit(
        session,
        actor=actor,
        action="plan.code_discovery.adopted",
        target=("task", new_task.id),
        project_id=project.id,
        course_id=project.course_id,
        after={
            "suggestion_id": str(row.id),
            "code": code,
            "origin": "ai_code",
            "action_type": action_type,
            "amendment_mode": discovered_from["amendment_mode"],
            "attached_evidence_count": attached_count,
        },
        reason=reason or None,
        request=request,
    )
    session.flush()
    return new_task, attached_count


def adopt_code_discovery(
    session: Session,
    user: User,
    project_id: UUID,
    suggestion_id: UUID,
    cmd: AdoptCodeDiscoveryRequest | None = None,
    *,
    request=None,
) -> CodeDiscoveryActionResultDTO:
    relation = lock_project_for_write(session, user, project_id)
    project = relation.project
    plan = _latest_plan(session, project.id, lock=True)
    row = _load_code_suggestion(session, project.id, suggestion_id)
    if row.status != "pending":
        raise ApiError(409, "SUGGESTION_HANDLED", "这条代码发现建议已经处理过了。")
    if row.approval_status == "pending_approval":
        raise ApiError(409, "ALREADY_PENDING_APPROVAL", "该建议已提交增补申请，请等待团队批准。")

    req = cmd or AdoptCodeDiscoveryRequest()
    action_type = req.action_type or row.action_type
    reason = (req.reason or "").strip()

    # L1: Merge into existing task (candidate evidences only; no unfreeze or lock bump).
    if action_type == "merge_existing":
        target_task_id = req.target_task_id or row.target_task_id
        if target_task_id is None:
            raise ApiError(422, "TARGET_TASK_REQUIRED", "归并到已有任务时必须指定目标任务。")
        target_task = session.scalar(
            select(Task).where(Task.id == target_task_id, Task.project_id == project.id)
        )
        if target_task is None:
            raise ApiError(404, "TASK_NOT_FOUND", "目标任务不存在。")

        target_criteria = list(
            session.scalars(
                select(AcceptanceCriterion)
                .where(AcceptanceCriterion.task_id == target_task.id)
                .order_by(AcceptanceCriterion.sort_order, AcceptanceCriterion.created_at)
            ).all()
        )
        target_assignees = list(
            session.scalars(
                select(TaskAssignee.user_id).where(
                    TaskAssignee.task_id == target_task.id,
                    TaskAssignee.role == "responsible",
                    TaskAssignee.unassigned_at.is_(None),
                )
            ).all()
        )
        commit_ids, _ = _extract_source_commits(row)
        attached = _attach_commits_as_candidate_evidences(
            session,
            project.id,
            target_task,
            target_criteria,
            commit_ids,
            assignee_ids=target_assignees or [user.id],
            fallback_actor_id=user.id,
        )
        moment = now()
        row.action_type = "merge_existing"
        row.target_task_id = target_task.id
        row.status = "adopted"
        row.approval_status = "approved"
        row.adopted_task_id = target_task.id
        row.proposed_by = user.id
        row.approved_by = user.id
        row.approved_at = moment
        row.handled_by = user.id
        row.handled_at = moment
        row.approvals_json = [
            {
                "user_id": str(user.id),
                "name": _user_display_name(user),
                "role": "leader" if relation.leader else "member",
                "approved_at": moment.isoformat(),
            }
        ]
        record_audit(
            session,
            actor=user,
            action="plan.code_discovery.adopted",
            target=("task", target_task.id),
            project_id=project.id,
            course_id=project.course_id,
            after={
                "suggestion_id": str(row.id),
                "action_type": "merge_existing",
                "attached_evidence_count": attached,
            },
            reason=reason or None,
            request=request,
        )
        session.flush()
        item_dto = _serialize_items(session, project, user, relation, plan, [row])[0]
        return CodeDiscoveryActionResultDTO(
            item=item_dto,
            task_id=target_task.id,
            adopted_immediately=True,
            attached_evidence_count=attached,
            message=f"已将 {attached} 条来源代码提交归并挂接为目标任务的候选证据。",
        )

    # L2 (new_subtask) & L3 (new_top_level)
    active_members = _members(session, project.id)
    active_member_set = set(active_members)
    title = (req.title if req.title is not None else row.title).strip()[:240]
    if not title:
        raise ApiError(422, "TITLE_REQUIRED", "任务标题不能为空。")
    description = (
        req.description if req.description is not None else (row.description or "")
    ).strip()[:5000]
    raw_criteria = (
        req.acceptance_criteria
        if req.acceptance_criteria is not None
        else [str(c) for c in (row.acceptance_criteria or [])]
    )
    criteria = [c.strip()[:2000] for c in raw_criteria if c and c.strip()][:30]
    if not criteria:
        criteria = [f"完成「{title[:60]}」核心实现并通过团队人工验收"]

    weight = int(req.weight if req.weight is not None else (row.suggested_weight or 3))
    if not 1 <= weight <= 100:
        raise ApiError(422, "INVALID_WEIGHT", "任务权重必须在 1 到 100 之间。")

    raw_assignees = (
        req.assignee_ids
        if req.assignee_ids is not None
        else [UUID(str(uid)) for uid in (row.suggested_assignee_ids_json or []) if uid]
    )
    assignee_ids = list(dict.fromkeys(uid for uid in raw_assignees if uid in active_member_set))
    if not assignee_ids:
        assignee_ids = [user.id]

    parent_task_id: UUID | None = None
    if action_type == "new_subtask":
        parent_task_id = req.parent_task_id or row.suggested_parent_task_id
        if parent_task_id is None:
            raise ApiError(422, "PARENT_TASK_REQUIRED", "拆分子任务时必须指定父任务。")
        parent_task = session.scalar(
            select(Task).where(Task.id == parent_task_id, Task.project_id == project.id)
        )
        if parent_task is None:
            raise ApiError(404, "PARENT_TASK_NOT_FOUND", "指定的父任务不存在。")
        module_id = _ensure_module_id(
            session, project, req.module_id or parent_task.module_id, owner_id=user.id
        )
    else:
        module_id = _ensure_module_id(
            session, project, req.module_id or row.suggested_module_id, owner_id=user.id
        )

    is_frozen = plan is not None and plan.status == FROZEN
    req_approvals = _required_approvals_for(
        action_type,
        is_frozen=is_frozen,
        active_member_count=len(active_members),
    )

    moment = now()
    first_approval = {
        "user_id": str(user.id),
        "name": _user_display_name(user),
        "role": "leader" if relation.leader else "member",
        "approved_at": moment.isoformat(),
    }
    row.action_type = action_type
    row.title = title
    row.description = description
    row.acceptance_criteria = criteria
    row.suggested_module_id = module_id
    row.suggested_parent_task_id = parent_task_id
    row.suggested_assignee_ids_json = [str(uid) for uid in assignee_ids]
    row.suggested_weight = weight
    row.proposed_by = user.id
    row.approvals_json = [first_approval]
    row.proposed_payload_json = {
        "action_type": action_type,
        "title": title,
        "description": description,
        "module_id": str(module_id),
        "parent_task_id": str(parent_task_id) if parent_task_id else None,
        "assignee_ids": [str(uid) for uid in assignee_ids],
        "weight": weight,
        "acceptance_criteria": criteria,
        "reason": reason,
    }

    if req_approvals <= 1:
        new_task, attached = _materialize_supplemental_task(
            session,
            project,
            plan,
            row,
            actor=user,
            proposer_id=user.id,
            action_type=action_type,
            title=title,
            description=description,
            module_id=module_id,
            parent_task_id=parent_task_id,
            assignee_ids=assignee_ids,
            weight=weight,
            acceptance_criteria=criteria,
            reason=reason,
            request=request,
        )
        item_dto = _serialize_items(session, project, user, relation, plan, [row])[0]
        return CodeDiscoveryActionResultDTO(
            item=item_dto,
            task_id=new_task.id,
            adopted_immediately=True,
            attached_evidence_count=attached,
            message="已创建代码演进增补任务，并自动挂接来源代码提交作为候选证据。",
        )

    row.approval_status = "pending_approval"
    for member_id in active_members:
        if member_id == user.id:
            continue
        notify(
            session,
            recipient=member_id,
            category="project",
            title=f"「{project.name}」有待确认的代码演进增补任务：{title[:80]}",
            description=(
                f"{_user_display_name(user)} 提交了冻结计划下的代码演进增补申请，需团队确认后生效。"
            ),
            target={"kind": "plan", "id": project.id, "project_id": project.id},
            dedupe_key=f"b:code-discovery-propose:{row.id}:{member_id}",
        )
    record_audit(
        session,
        actor=user,
        action="plan.code_discovery.proposed",
        target=("task_suggestion", row.id),
        project_id=project.id,
        course_id=project.course_id,
        after={
            "action_type": action_type,
            "required_approvals": req_approvals,
            "weight": weight,
        },
        reason=reason or None,
        request=request,
    )
    session.flush()
    item_dto = _serialize_items(session, project, user, relation, plan, [row])[0]
    return CodeDiscoveryActionResultDTO(
        item=item_dto,
        task_id=None,
        adopted_immediately=False,
        attached_evidence_count=0,
        message=f"已提交增补申请（1/{req_approvals}），等待团队确认后在不解冻计划的前提下自动生效。",
    )


def approve_code_discovery(
    session: Session,
    user: User,
    project_id: UUID,
    suggestion_id: UUID,
    cmd: ApproveCodeDiscoveryRequest | None = None,
    *,
    request=None,
) -> CodeDiscoveryActionResultDTO:
    relation = lock_project_for_write(session, user, project_id)
    project = relation.project
    plan = _latest_plan(session, project.id, lock=True)
    row = _load_code_suggestion(session, project.id, suggestion_id)
    if row.status != "pending" or row.approval_status != "pending_approval":
        raise ApiError(409, "SUGGESTION_NOT_PENDING_APPROVAL", "该建议当前不在待审批增补状态。")
    if row.proposed_by == user.id:
        raise ApiError(
            403, "PROPOSER_CANNOT_SELF_APPROVE", "发起人不能自行批准自己的代码演进增补申请。"
        )

    approvals = _parse_approvals(row.approvals_json)
    approved_ids = {UUID(item["user_id"]) for item in approvals}
    if user.id in approved_ids:
        raise ApiError(409, "ALREADY_APPROVED", "你已经确认过这条增补申请。")

    moment = now()
    approvals.append(
        {
            "user_id": str(user.id),
            "name": _user_display_name(user),
            "role": "leader" if relation.leader else "member",
            "approved_at": moment.isoformat(),
        }
    )
    approved_ids.add(user.id)
    row.approvals_json = list(approvals)

    payload = row.proposed_payload_json if isinstance(row.proposed_payload_json, dict) else {}
    action_type = str(payload.get("action_type") or row.action_type)
    title = str(payload.get("title") or row.title).strip()[:240]
    description = str(payload.get("description") or row.description or "").strip()[:5000]
    raw_parent = payload.get("parent_task_id")
    parent_task_id = UUID(str(raw_parent)) if raw_parent else row.suggested_parent_task_id
    raw_module = payload.get("module_id")
    preferred_mod = UUID(str(raw_module)) if raw_module else row.suggested_module_id
    module_id = _ensure_module_id(session, project, preferred_mod, owner_id=user.id)

    active_members = _members(session, project.id)
    active_member_set = set(active_members)
    raw_assignees = payload.get("assignee_ids") or row.suggested_assignee_ids_json or []
    assignee_ids = list(
        dict.fromkeys(
            UUID(str(uid)) for uid in raw_assignees if uid and UUID(str(uid)) in active_member_set
        )
    )
    if not assignee_ids:
        assignee_ids = [row.proposed_by or user.id]

    weight = int(payload.get("weight") or row.suggested_weight or 3)
    criteria = [
        str(c).strip()[:2000]
        for c in (payload.get("acceptance_criteria") or row.acceptance_criteria or [])
        if str(c).strip()
    ]
    if not criteria:
        criteria = [f"完成「{title[:60]}」核心实现并通过团队人工验收"]
    extra_reason = cmd.reason.strip() if cmd and cmd.reason else ""
    reason = extra_reason or str(payload.get("reason") or "")

    is_frozen = plan is not None and plan.status == FROZEN
    req_approvals = _required_approvals_for(
        action_type,
        is_frozen=is_frozen,
        active_member_count=len(active_members),
    )
    threshold_met = len(approved_ids) >= req_approvals and _authority_satisfied(
        session, project, action_type, parent_task_id, approved_ids
    )

    if not threshold_met:
        record_audit(
            session,
            actor=user,
            action="plan.code_discovery.approved_partial",
            target=("task_suggestion", row.id),
            project_id=project.id,
            course_id=project.course_id,
            after={"approvals": len(approved_ids), "required_approvals": req_approvals},
            reason=extra_reason or None,
            request=request,
        )
        session.flush()
        item_dto = _serialize_items(session, project, user, relation, plan, [row])[0]
        return CodeDiscoveryActionResultDTO(
            item=item_dto,
            task_id=None,
            adopted_immediately=False,
            attached_evidence_count=0,
            message=f"已记录确认（{len(approved_ids)}/{req_approvals}），待满足人数与组长确认条件后自动生效。",
        )

    new_task, attached = _materialize_supplemental_task(
        session,
        project,
        plan,
        row,
        actor=user,
        proposer_id=row.proposed_by or user.id,
        action_type=action_type,
        title=title,
        description=description,
        module_id=module_id,
        parent_task_id=parent_task_id,
        assignee_ids=assignee_ids,
        weight=weight,
        acceptance_criteria=criteria,
        reason=reason,
        request=request,
    )
    item_dto = _serialize_items(session, project, user, relation, plan, [row])[0]
    return CodeDiscoveryActionResultDTO(
        item=item_dto,
        task_id=new_task.id,
        adopted_immediately=True,
        attached_evidence_count=attached,
        message="增补任务已批准并原子生效，原冻结计划与已有任务版本不受影响。",
    )


def dismiss_code_discovery(
    session: Session,
    user: User,
    project_id: UUID,
    suggestion_id: UUID,
    cmd: DismissCodeDiscoveryRequest | None = None,
    *,
    request=None,
) -> CodeDiscoveryDismissResultDTO:
    relation = lock_project_for_write(session, user, project_id)
    project = relation.project
    plan = _latest_plan(session, project.id)
    row = _load_code_suggestion(session, project.id, suggestion_id)
    if row.status != "pending":
        raise ApiError(409, "SUGGESTION_HANDLED", "这条代码发现建议已经处理过了。")

    moment = now()
    row.status = "dismissed"
    row.approval_status = "rejected"
    row.handled_by = user.id
    row.handled_at = moment
    reason = cmd.reason.strip() if cmd and cmd.reason else None
    record_audit(
        session,
        actor=user,
        action="plan.code_discovery.dismissed",
        target=("task_suggestion", row.id),
        project_id=project.id,
        course_id=project.course_id,
        reason=reason,
        request=request,
    )
    session.flush()
    item_dto = _serialize_items(session, project, user, relation, plan, [row])[0]
    return CodeDiscoveryDismissResultDTO(item=item_dto)
