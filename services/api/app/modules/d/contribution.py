"""Contribution from current formal outcomes, responsibility shares, and cross-task code splits."""

from __future__ import annotations

import hashlib
import json
import math
import re
from datetime import UTC, datetime
from decimal import ROUND_DOWN, Decimal
from typing import Any
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.auth.models import VerifiedGithubIdentity
from app.db.models import FunctionalModule, ProjectMember, Task, User
from app.modules.a.github_activity import (
    _is_excluded_bot_author,
    _load_project_member_directory,
    _row_actor_account_id,
)
from app.modules.a.models import GithubActivity
from app.modules.b.code_progress_service import (
    _TASK_CODE_RE,
    _cjk_bigrams,
    _extract_profile,
    _score_profile,
)
from app.modules.b.models import BTaskMeta
from app.modules.c.activity_models import ActivityRecordState
from app.modules.c.models import Evidence, EvidenceSourceSnapshot
from app.modules.c.permissions import get_project_access
from app.modules.d.acceptance import stale_reason
from app.modules.d.models import (
    ContributionCalculation,
    ContributionItem,
    ContributionItemTask,
    ContributionSnapshot,
    FormalOutcome,
    IntegrityCheck,
    VerificationRun,
)

FORMULA = "formal-task-weight-cross-task-equal-split-v2"
DIRECT_LINK_MIN_LINES = 10
HEURISTIC_MATCH_MIN_LINES = 20
_HEURISTIC_MATCH_THRESHOLD = 8

_MERGE_TITLE_RE = re.compile(r"^(?:merge\s+|merge:)", re.IGNORECASE)
_ASCII_WORD_RE = re.compile(r"[a-z][a-z0-9_]{2,}", re.IGNORECASE)
_EXCLUDED_BASENAMES = frozenset(
    {
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "poetry.lock",
        "uv.lock",
        "composer.lock",
        "cargo.lock",
        "gemfile.lock",
        "pipfile.lock",
        "api.generated.ts",
    }
)


def _is_excluded_generated_path(path: str) -> bool:
    cleaned = path.strip().lower().replace("\\", "/")
    if not cleaned:
        return False
    basename = cleaned.rsplit("/", 1)[-1]
    if basename in _EXCLUDED_BASENAMES or basename.startswith("pnpm-lock."):
        return True
    if basename.endswith((".lock", ".min.js", ".min.css", ".generated.ts", ".generated.js")):
        return True
    return False


def _is_merge_commit(row: GithubActivity) -> bool:
    if row.kind != "commit":
        return False
    title = (row.title or "").strip()
    if _MERGE_TITLE_RE.match(title):
        return True
    detail = row.detail if isinstance(row.detail, dict) else {}
    parents = detail.get("parents")
    if isinstance(parents, list) and len(parents) > 1:
        return True
    parent_count = detail.get("parent_count")
    if isinstance(parent_count, int) and not isinstance(parent_count, bool) and parent_count > 1:
        return True
    if detail.get("is_merge") is True:
        return True
    return False


def _non_negative_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return max(0, value)
    if isinstance(value, float) and math.isfinite(value):
        return max(0, int(value))
    return None


def _effective_code_lines(detail: Any) -> tuple[int, list[str], bool]:
    """Return (effective_lines, non_excluded_paths, all_files_excluded).

    Counts ``additions + deletions`` across non-lockfile, non-generated, non-minified files.
    """
    if not isinstance(detail, dict):
        return 0, [], False

    raw_files = detail.get("files")
    if isinstance(raw_files, list) and len(raw_files) > 0:
        total_lines = 0
        non_excluded_paths: list[str] = []
        included_files = 0
        saw_file_line_counts = False
        for item in raw_files:
            if not isinstance(item, dict):
                continue
            path = str(item.get("path") or item.get("filename") or "").strip()
            if _is_excluded_generated_path(path):
                continue
            included_files += 1
            if path:
                non_excluded_paths.append(path.lower())
            adds = _non_negative_int(item.get("additions"))
            dels = _non_negative_int(item.get("deletions"))
            if adds is not None or dels is not None:
                saw_file_line_counts = True
                total_lines += (adds or 0) + (dels or 0)
            else:
                changes = _non_negative_int(item.get("changes"))
                if changes is not None:
                    saw_file_line_counts = True
                    total_lines += changes
        if included_files == 0:
            return 0, [], True
        if not saw_file_line_counts:
            return _commit_level_lines(detail), non_excluded_paths, False
        return total_lines, non_excluded_paths, False

    return _commit_level_lines(detail), [], False


def _commit_level_lines(detail: dict[str, Any]) -> int:
    stats = detail.get("stats") if isinstance(detail.get("stats"), dict) else {}
    adds = _non_negative_int(detail.get("additions"))
    dels = _non_negative_int(detail.get("deletions"))
    if adds is None:
        adds = _non_negative_int(stats.get("additions"))
    if dels is None:
        dels = _non_negative_int(stats.get("deletions"))
    if adds is not None or dels is not None:
        return (adds or 0) + (dels or 0)
    total_stat = _non_negative_int(stats.get("total"))
    return total_stat or 0


def _normalize_percentages(
    weights: dict[UUID, Decimal],
    *,
    quant: Decimal = Decimal("0.0001"),
) -> dict[UUID, Decimal]:
    """Normalize positive weights to sum to exact Decimal('100.0000') via largest remainder."""
    positive = {uid: val for uid, val in weights.items() if val > 0}
    total = sum(positive.values(), Decimal())
    if total <= 0:
        return {}
    exact = {uid: val * Decimal(100) / total for uid, val in positive.items()}
    rounded = {uid: val.quantize(quant, rounding=ROUND_DOWN) for uid, val in exact.items()}
    units = int((Decimal(100) - sum(rounded.values(), Decimal())) / quant)
    order = sorted(
        positive,
        key=lambda uid: (exact[uid] - rounded[uid], str(uid)),
        reverse=True,
    )
    for uid in order[:units]:
        rounded[uid] += quant
    return {uid: val for uid, val in rounded.items() if val > 0}


def _has_tables(session: Session, *table_names: str) -> bool:
    bind = session.get_bind()
    if bind is None:
        return False
    inspector = sa_inspect(bind)
    return all(inspector.has_table(name) for name in table_names)


def _find_qualified_code_contributors(
    session: Session,
    project_id: UUID,
    tasks_by_id: dict[UUID, Task],
) -> dict[UUID, set[UUID]]:
    """Find active members who contributed substantive non-merge/non-lockfile code per task.

    A member qualifies for task ``t`` via either:
      1. Formal GitHub ``Evidence`` on ``task.id`` (resolved to true code author, non-merge,
         non-lockfile-only) or direct task-linked ``GithubActivity`` totaling >= 10 effective lines;
      2. Cross-task functional match across project ``GithubActivity`` totaling >= 20 effective
         lines (``additions + deletions`` after excluding merge commits, lockfiles, and generated
         files).
    """
    if not tasks_by_id:
        return {}

    active_members = _active_project_members(session, project_id)
    active_member_ids = {m.id for m in active_members}
    if not active_member_ids:
        return {}

    if not _has_tables(session, GithubActivity.__tablename__):
        return {}

    activities = list(
        session.scalars(
            select(GithubActivity)
            .where(
                GithubActivity.project_id == project_id,
                GithubActivity.kind.in_(("commit", "pull_request")),
                GithubActivity.deleted.is_(False),
            )
            .order_by(GithubActivity.occurred_at, GithubActivity.id)
        ).all()
    )

    has_activity_records = _has_tables(session, ActivityRecordState.__tablename__)
    has_evidence = _has_tables(
        session, Evidence.__tablename__, EvidenceSourceSnapshot.__tablename__
    )

    formal_evidences: list[Evidence] = []
    if has_evidence:
        formal_evidences = list(
            session.scalars(
                select(Evidence).where(
                    Evidence.project_id == project_id,
                    Evidence.task_id.in_(tasks_by_id),
                    Evidence.source_type == "github",
                    Evidence.status == "formal",
                )
            ).all()
        )

    if not activities and not formal_evidences:
        return {}

    directory = _load_project_member_directory(session, project_id, active_only=True)
    verified_by_account_id: dict[int, UUID] = {}
    if _has_tables(session, VerifiedGithubIdentity.__tablename__):
        for gh_uid, uid in session.execute(
            select(VerifiedGithubIdentity.github_user_id, VerifiedGithubIdentity.user_id).where(
                VerifiedGithubIdentity.user_id.in_(active_member_ids)
            )
        ).all():
            verified_by_account_id[int(gh_uid)] = uid

    def resolve_activity_author(row: GithubActivity) -> UUID | None:
        if _is_excluded_bot_author(row.author_login, row.author_name, row.author_email):
            return None
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

    activity_by_id: dict[UUID, GithubActivity] = {row.id: row for row in activities}
    activity_by_identity: dict[str, GithubActivity] = {
        f"{row.kind}:{row.external_id}": row for row in activities
    }

    direct_tasks_by_activity: dict[UUID, set[UUID]] = {}
    record_by_evidence_id: dict[UUID, ActivityRecordState] = {}
    if has_activity_records:
        records = list(
            session.scalars(
                select(ActivityRecordState).where(
                    ActivityRecordState.project_id == project_id,
                    ActivityRecordState.source_type == "github",
                    ActivityRecordState.status != "ignored",
                )
            ).all()
        )
        for rec in records:
            if rec.evidence_id is not None:
                record_by_evidence_id[rec.evidence_id] = rec
            if rec.task_id in tasks_by_id and rec.source_id in activity_by_id:
                direct_tasks_by_activity.setdefault(rec.source_id, set()).add(rec.task_id)

    formal_gh_authors_by_task: dict[UUID, set[UUID]] = {tid: set() for tid in tasks_by_id}
    direct_lines_by_task: dict[UUID, dict[UUID, float]] = {tid: {} for tid in tasks_by_id}
    heuristic_lines_by_task: dict[UUID, dict[UUID, float]] = {tid: {} for tid in tasks_by_id}

    if formal_evidences:
        ev_ids = [ev.id for ev in formal_evidences]
        latest_snapshots: dict[UUID, EvidenceSourceSnapshot] = {}
        for snap in session.scalars(
            select(EvidenceSourceSnapshot)
            .where(EvidenceSourceSnapshot.evidence_id.in_(ev_ids))
            .order_by(EvidenceSourceSnapshot.version_no.desc())
        ).all():
            latest_snapshots.setdefault(snap.evidence_id, snap)

        for ev in formal_evidences:
            matched_row: GithubActivity | None = None
            rec = record_by_evidence_id.get(ev.id)
            if rec is not None and rec.source_id in activity_by_id:
                matched_row = activity_by_id[rec.source_id]
            snap = latest_snapshots.get(ev.id)
            if matched_row is None and snap is not None:
                matched_row = activity_by_identity.get(snap.source_identity)

            if matched_row is not None:
                if _is_merge_commit(matched_row):
                    continue
                _, _, all_excluded = _effective_code_lines(matched_row.detail)
                if all_excluded:
                    continue
                author_uid = resolve_activity_author(matched_row)
                if author_uid is not None:
                    formal_gh_authors_by_task[ev.task_id].add(author_uid)
                direct_tasks_by_activity.setdefault(matched_row.id, set()).add(ev.task_id)
                continue

            # Snapshot-only formal GitHub evidence fallback (resolve true code author from metadata)
            if snap is not None and isinstance(snap.content_json, dict):
                content = snap.content_json
                title_snap = str(content.get("title") or "").strip()
                if content.get("kind") == "commit" and _MERGE_TITLE_RE.match(title_snap):
                    continue
                _, _, all_excluded = _effective_code_lines(content)
                if all_excluded:
                    continue
                login = str(content.get("author_login") or "").strip() or None
                raw_name = str(content.get("author_name") or "").strip()
                email_norm = str(content.get("author_email") or "").strip().lower()
                if _is_excluded_bot_author(login, raw_name, email_norm):
                    continue
                snap_author: UUID | None = None
                raw_uid = content.get("author_user_id") or content.get("author_id")
                if raw_uid:
                    try:
                        cand_uid = UUID(str(raw_uid))
                        if cand_uid in active_member_ids:
                            snap_author = cand_uid
                    except ValueError:
                        pass
                if snap_author is None and (login or raw_name or email_norm):
                    cand = directory.resolve_member_uid(None, login, raw_name, email_norm)
                    if cand in active_member_ids:
                        snap_author = cand
                if snap_author is not None:
                    formal_gh_authors_by_task[ev.task_id].add(snap_author)

    # Prepare task profiles for cross-task functional matching
    module_ids = {t.module_id for t in tasks_by_id.values() if t.module_id is not None}
    modules_by_id: dict[UUID, str] = {}
    if module_ids and _has_tables(session, FunctionalModule.__tablename__):
        for mod in session.scalars(
            select(FunctionalModule).where(FunctionalModule.id.in_(module_ids))
        ).all():
            modules_by_id[mod.id] = mod.name or ""

    seq_by_task: dict[UUID, int] = {}
    if _has_tables(session, BTaskMeta.__tablename__):
        for meta in session.scalars(
            select(BTaskMeta).where(BTaskMeta.task_id.in_(tasks_by_id))
        ).all():
            seq_by_task[meta.task_id] = meta.seq

    task_profiles: dict[UUID, tuple[set[str], set[str], set[str]]] = {}
    for tid, task in tasks_by_id.items():
        mod_name = modules_by_id.get(task.module_id, "")
        task_profiles[tid] = _extract_profile(f"{mod_name} {task.title} {task.description or ''}")

    for row in activities:
        if _is_merge_commit(row):
            continue
        author_uid = resolve_activity_author(row)
        if author_uid is None:
            continue
        eff_lines, non_excluded_paths, all_excluded = _effective_code_lines(row.detail)
        if all_excluded or eff_lines <= 0:
            continue

        direct_tasks = direct_tasks_by_activity.get(row.id)
        if direct_tasks:
            split = len(direct_tasks)
            for tid in direct_tasks:
                bucket = direct_lines_by_task[tid]
                bucket[author_uid] = bucket.get(author_uid, 0.0) + (eff_lines / split)
            continue

        # Cross-task functional matching
        title_str = (row.title or "").strip()
        summary_str = (row.summary or "").strip()
        detail = row.detail if isinstance(row.detail, dict) else {}
        branch_parts = []
        for bkey in ("branch", "head", "base"):
            bval = detail.get(bkey)
            if isinstance(bval, str) and bval.strip():
                branch_parts.append(bval.strip())
        if isinstance(detail.get("branches"), list):
            branch_parts.extend(str(b).strip() for b in detail["branches"] if b)
        branch_text = " ".join(branch_parts)

        header_text = f"{title_str}\n{summary_str}\n{branch_text}"
        explicit_seqs = {int(m.group(1)) for m in _TASK_CODE_RE.finditer(header_text)}

        title_lower = title_str.lower()
        combined_lower = (f"{header_text}\n" + "\n".join(non_excluded_paths)).lower()
        path_tokens = {tok for p in non_excluded_paths for tok in _ASCII_WORD_RE.findall(p)}
        commit_tokens = (
            set(_ASCII_WORD_RE.findall(combined_lower)) | _cjk_bigrams(combined_lower) | path_tokens
        )

        matched_tasks: list[UUID] = []
        for tid in tasks_by_id:
            if tid in seq_by_task and seq_by_task[tid] in explicit_seqs:
                matched_tasks.append(tid)
                continue
            profile = task_profiles[tid]
            score = _score_profile(
                profile,
                text=combined_lower,
                title_lower=title_lower,
                paths=non_excluded_paths,
                commit_tokens=commit_tokens,
            )
            path_overlap = path_tokens & profile[2]
            if path_overlap:
                score += min(12, len(path_overlap) * 4)
            if score >= _HEURISTIC_MATCH_THRESHOLD:
                matched_tasks.append(tid)

        if matched_tasks:
            split = len(matched_tasks)
            for tid in matched_tasks:
                bucket = heuristic_lines_by_task[tid]
                bucket[author_uid] = bucket.get(author_uid, 0.0) + (eff_lines / split)

    qualified: dict[UUID, set[UUID]] = {}
    for tid in tasks_by_id:
        uids: set[UUID] = set(formal_gh_authors_by_task[tid])
        candidate_uids = set(direct_lines_by_task[tid]) | set(heuristic_lines_by_task[tid])
        for uid in candidate_uids:
            d_lines = direct_lines_by_task[tid].get(uid, 0.0)
            h_lines = heuristic_lines_by_task[tid].get(uid, 0.0)
            if d_lines >= DIRECT_LINK_MIN_LINES or (d_lines + h_lines) >= HEURISTIC_MATCH_MIN_LINES:
                uids.add(uid)
        if uids:
            qualified[tid] = uids
    return qualified


def _effective_task_shares(
    resp_shares: dict[UUID, Decimal],
    qualified_code_uids: set[UUID] | None,
) -> dict[UUID, Decimal]:
    """Keep responsibility_shares when no cross-task coder exists; else equal-split participants."""
    nominal = {uid: val for uid, val in resp_shares.items() if val > 0}
    if not qualified_code_uids:
        return nominal
    cross_uids = qualified_code_uids - set(nominal)
    if not cross_uids:
        return nominal
    participants = sorted(set(nominal) | cross_uids, key=str)
    return _normalize_percentages({uid: Decimal(1) for uid in participants})


def _compute_formal_basis(
    session: Session,
    project_id: UUID,
    active_outcomes: list[FormalOutcome],
) -> tuple[list[dict[str, Any]], dict[UUID, dict[UUID, Decimal]], dict[UUID, Task | None]]:
    """Shared deterministic basis builder used by both current_basis_hash() and calculate()."""
    tasks_raw: dict[UUID, Task | None] = {
        outcome.task_id: session.get(Task, outcome.task_id) for outcome in active_outcomes
    }
    valid_tasks: dict[UUID, Task] = {
        tid: task for tid, task in tasks_raw.items() if task is not None
    }
    qualified_by_task = _find_qualified_code_contributors(session, project_id, valid_tasks)

    basis: list[dict[str, Any]] = []
    effective_by_outcome: dict[UUID, dict[UUID, Decimal]] = {}
    for outcome in active_outcomes:
        weight = Decimal(str(outcome.basis_json["task_weight"]))
        resp_shares = {
            UUID(uid): Decimal(str(value))
            for uid, value in outcome.basis_json["responsibility_shares"].items()
        }
        effective = _effective_task_shares(resp_shares, qualified_by_task.get(outcome.task_id))
        effective_by_outcome[outcome.id] = effective
        basis.append(
            {
                "formula": FORMULA,
                "outcome": str(outcome.id),
                "task": str(outcome.task_id),
                "weight": str(weight),
                "shares": {
                    str(uid): str(value)
                    for uid, value in sorted(effective.items(), key=lambda row: str(row[0]))
                },
            }
        )
    return basis, effective_by_outcome, tasks_raw


def current_basis_hash(session: Session, project_id: UUID) -> str:
    """Read current formal + cross-task code inputs without changing historical calculations."""
    outcomes = session.scalars(
        select(FormalOutcome)
        .where(
            FormalOutcome.project_id == project_id,
            FormalOutcome.invalidated_at.is_(None),
        )
        .order_by(FormalOutcome.created_at, FormalOutcome.id)
    ).all()
    active = []
    for outcome in outcomes:
        run = session.get(VerificationRun, outcome.verification_run_id)
        if stale_reason(session, run, completed=True):
            continue
        active.append(outcome)
    basis, _, _ = _compute_formal_basis(session, project_id, active)
    return hashlib.sha256(json.dumps(basis, sort_keys=True).encode()).hexdigest()


def current_frozen_snapshot(session: Session, project_id: UUID) -> ContributionSnapshot | None:
    """A new report may reference only a frozen calculation of current outcomes."""
    snapshot = session.scalar(
        select(ContributionSnapshot)
        .where(
            ContributionSnapshot.project_id == project_id,
            ContributionSnapshot.status == "frozen",
        )
        .order_by(ContributionSnapshot.version_no.desc())
        .limit(1)
    )
    if snapshot is None:
        return None
    calculation = session.get(ContributionCalculation, snapshot.calculation_id)
    if calculation.input_hash != current_basis_hash(session, project_id):
        return None
    return snapshot


def _active_project_members(session: Session, project_id: UUID) -> list[User]:
    """Return all active project members (`left_at IS NULL`) for contribution reporting."""
    return list(
        session.scalars(
            select(User)
            .join(ProjectMember, ProjectMember.user_id == User.id)
            .where(
                ProjectMember.project_id == project_id,
                ProjectMember.left_at.is_(None),
            )
            .order_by(User.name, User.id)
        ).all()
    )


def latest_snapshot(session: Session, project_id: UUID, user: User) -> dict | None:
    get_project_access(session, user, project_id)
    snapshot = session.scalar(
        select(ContributionSnapshot)
        .where(ContributionSnapshot.project_id == project_id)
        .order_by(ContributionSnapshot.version_no.desc())
        .limit(1)
    )
    if snapshot is None:
        return None
    calculation = session.get(ContributionCalculation, snapshot.calculation_id)
    current_hash = current_basis_hash(session, project_id)
    items = session.execute(
        select(ContributionItem, User)
        .join(User, User.id == ContributionItem.user_id)
        .where(ContributionItem.snapshot_id == snapshot.id)
        .order_by(ContributionItem.share.desc(), ContributionItem.user_id)
    ).all()
    members = []
    for item, person in items:
        links = session.execute(
            select(ContributionItemTask, Task)
            .join(Task, Task.id == ContributionItemTask.task_id)
            .where(ContributionItemTask.contribution_item_id == item.id)
            .order_by(Task.title)
        ).all()
        tasks = []
        for link, task in links:
            outcome = (
                session.get(FormalOutcome, link.formal_outcome_id)
                if link.formal_outcome_id
                else None
            )
            run = session.get(VerificationRun, outcome.verification_run_id) if outcome else None
            check = session.get(IntegrityCheck, run.integrity_check_id) if run else None
            evidence = [
                {
                    "criterion_id": detail["criterion_id"],
                    "evidence_id": ref["id"],
                    "version": ref["version"],
                }
                for detail in ((check.details_json or []) if check else [])
                for ref in detail.get("evidence", [])
            ]
            tasks.append(
                {
                    "task_id": str(task.id),
                    "title": task.title,
                    "responsibility_share": float(link.ratio),
                    "weight": float(outcome.basis_json["task_weight"])
                    if outcome
                    else float(task.weight),
                    "formal_outcome_id": str(outcome.id) if outcome else None,
                    "evidence": evidence,
                    "evidence_url": f"/projects/{project_id}/tasks/{task.id}/verification",
                }
            )
        members.append(
            {
                "user_id": str(person.id),
                "name": person.name or person.username or person.email,
                "share": float(item.share),
                "task_credit": float(item.task_credit),
                "tasks": tasks,
            }
        )
    seen_user_ids = {person.id for _, person in items}
    for person in _active_project_members(session, project_id):
        if person.id in seen_user_ids:
            continue
        members.append(
            {
                "user_id": str(person.id),
                "name": person.name or person.username or person.email,
                "share": 0.0,
                "task_credit": 0.0,
                "tasks": [],
            }
        )
    return {
        "id": str(snapshot.id),
        "version": snapshot.version_no,
        "status": snapshot.status,
        "frozen_at": snapshot.frozen_at.isoformat() if snapshot.frozen_at else None,
        "formula_version": calculation.formula_version,
        "calculated_at": calculation.calculated_at.isoformat(),
        "input_hash": calculation.input_hash,
        "stale": calculation.input_hash != current_hash,
        "members": members,
    }


def freeze_snapshot(session: Session, project_id: UUID, user: User) -> dict:
    access = get_project_access(session, user, project_id, lock=True)
    if not (access.leader or access.teacher):
        raise ApiError(
            403,
            "CONTRIBUTION_FREEZE_DENIED",
            "Only the project leader or course teacher may freeze contribution.",
        )
    if access.project.lifecycle != "active" or (access.course and access.course.status != "active"):
        raise ApiError(409, "PROJECT_READ_ONLY", "Project or course is read-only.")
    snapshot = session.scalar(
        select(ContributionSnapshot)
        .where(ContributionSnapshot.project_id == project_id)
        .order_by(ContributionSnapshot.version_no.desc())
        .limit(1)
    )
    if snapshot is None:
        raise ApiError(
            409,
            "NO_CONTRIBUTION_SNAPSHOT",
            "Calculate contribution from formal outcomes before freezing.",
        )
    calculation = session.get(ContributionCalculation, snapshot.calculation_id)
    if calculation is None or calculation.input_hash != current_basis_hash(session, project_id):
        raise ApiError(
            409,
            "CONTRIBUTION_STALE",
            "Formal outcomes changed; recalculate contribution before freezing.",
        )
    if snapshot.status != "frozen":
        prior_frozen = session.scalars(
            select(ContributionSnapshot).where(
                ContributionSnapshot.project_id == project_id,
                ContributionSnapshot.status == "frozen",
                ContributionSnapshot.id != snapshot.id,
            )
        ).all()
        for old in prior_frozen:
            old.status = "superseded"
        snapshot.status = "frozen"
        snapshot.frozen_at = datetime.now(UTC)
        session.commit()
    return latest_snapshot(session, project_id, user)


def calculate(session: Session, project_id: UUID, user: User) -> dict:
    access = get_project_access(session, user, project_id, lock=True)
    if not (access.leader or access.teacher or access.staff):
        raise ApiError(
            403, "CONTRIBUTION_DENIED", "Only a project leader or course staff can calculate."
        )
    outcomes = session.scalars(
        select(FormalOutcome)
        .where(FormalOutcome.project_id == project_id, FormalOutcome.invalidated_at.is_(None))
        .order_by(FormalOutcome.created_at, FormalOutcome.id)
    ).all()
    active = []
    for outcome in outcomes:
        run = session.get(VerificationRun, outcome.verification_run_id)
        reason = stale_reason(session, run, completed=True)
        if reason:
            outcome.invalidated_at = datetime.now(UTC)
            outcome.invalidated_reason = reason
            continue
        active.append(outcome)
    if not active:
        session.commit()
        raise ApiError(409, "NO_FORMAL_OUTCOMES", "No current formal outcomes to calculate.")

    basis, effective_by_outcome, tasks_raw = _compute_formal_basis(session, project_id, active)
    credits: dict[UUID, Decimal] = {}
    task_links: dict[UUID, list[tuple[UUID, UUID, Decimal]]] = {}
    for outcome in active:
        task = tasks_raw.get(outcome.task_id)
        weight = Decimal(str(outcome.basis_json["task_weight"]))
        resp_shares = {
            UUID(uid): Decimal(str(value))
            for uid, value in outcome.basis_json["responsibility_shares"].items()
        }
        if (
            task is None
            or task.status != "completed"
            or weight <= 0
            or sum(resp_shares.values()) != 100
        ):
            raise ApiError(409, "INVALID_FORMAL_BASIS", "Formal outcome basis is incomplete.")
        effective_shares = effective_by_outcome[outcome.id]
        for uid, ratio in effective_shares.items():
            if ratio <= 0:
                continue
            credits[uid] = credits.get(uid, Decimal()) + weight * ratio / Decimal(100)
            task_links.setdefault(uid, []).append((task.id, outcome.id, ratio))
    total = sum(credits.values(), Decimal())
    if total <= 0:
        raise ApiError(409, "NO_CONTRIBUTION_CREDIT", "No positive responsibility share recorded.")
    for member_user in _active_project_members(session, project_id):
        credits.setdefault(member_user.id, Decimal())
        task_links.setdefault(member_user.id, [])
    digest = hashlib.sha256(json.dumps(basis, sort_keys=True).encode()).hexdigest()
    version = (
        session.scalar(
            select(func.max(ContributionSnapshot.version_no)).where(
                ContributionSnapshot.project_id == project_id
            )
        )
        or 0
    ) + 1
    calculation = ContributionCalculation(
        project_id=project_id,
        formula_version=FORMULA,
        status="completed",
        input_hash=digest,
        basis_version=digest,
        calculated_by=user.id,
        started_at=datetime.now(UTC),
        completed_at=datetime.now(UTC),
    )
    session.add(calculation)
    session.flush()
    snapshot = ContributionSnapshot(
        project_id=project_id,
        calculation_id=calculation.id,
        version_no=version,
        status="draft",
        created_by=user.id,
    )
    session.add(snapshot)
    session.flush()
    # Largest-remainder rounding keeps the persisted percentages exactly at 100.0000
    # across members with positive formal outcomes while keeping 0-outcome members at 0.
    rounded = _normalize_percentages(credits)
    for uid in sorted(credits, key=str):
        item = ContributionItem(
            snapshot_id=snapshot.id,
            user_id=uid,
            task_credit=credits[uid],
            collaboration_credit=0,
            share=rounded.get(uid, Decimal("0.0000")),
            acceptance_rate=100 if task_links[uid] else 0,
            status="formal",
            note=None,
        )
        session.add(item)
        session.flush()
        for task_id, outcome_id, ratio in task_links[uid]:
            session.add(
                ContributionItemTask(
                    contribution_item_id=item.id,
                    task_id=task_id,
                    formal_outcome_id=outcome_id,
                    ratio=ratio,
                )
            )
    session.commit()
    return latest_snapshot(session, project_id, user)
