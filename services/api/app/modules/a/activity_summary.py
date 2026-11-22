"""Evidence-grounded, cacheable summaries for source activities.

The source row remains canonical.  A summary is an optional projection: a failed
or stale model call never removes or changes the original GitHub activity.
"""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import User
from app.modules.a import ai, github, github_activity, permissions
from app.modules.a.ai.usage import AIUsageContext
from app.modules.a.models import ActivitySummary, GithubActivity, GithubRepoLink

PROMPT_VERSION = "activity-summary-v2"
SUMMARY_STATUSES = ("not_generated", "pending", "ready", "failed", "unsupported")


def _hydrate_commit_detail(session: Session, row: GithubActivity) -> None:
    """若该提交入库时未拉取文件差异，在 AI 分析前按需补拉一次（只读、失败不阻断）。"""
    if row.kind != "commit" or row.deleted:
        return
    if isinstance(row.detail, dict) and row.detail.get("files_fetched") is True:
        return
    settings = github.github_settings()
    if settings is None:
        return
    link = session.get(GithubRepoLink, row.link_id)
    if link is None:
        return
    client = github.GithubClient(settings)
    try:
        commit_detail = client.commit_detail(
            link.owner, link.repo, row.external_id, link.installation_id
        )
        if not isinstance(commit_detail, dict):
            return
        files, files_truncated, stats = github_activity._commit_detail(commit_detail)
        merged = dict(row.detail) if isinstance(row.detail, dict) else {"sha": row.external_id}
        merged.update({"files_fetched": True, "files": files, "files_truncated": files_truncated})
        merged.update(stats)
        row.detail = merged
        session.flush()
    except Exception:  # noqa: BLE001 - 按需补拉失败时退回现有提交信息，绝不阻断摘要生成
        return
    finally:
        client.close()


def _metadata(row: GithubActivity) -> dict[str, str | int | float | bool | None]:
    source = row.detail if isinstance(row.detail, dict) else {}
    return {
        str(key): value
        for key, value in source.items()
        if key != "_github_actor_account_id"
        and isinstance(value, str | int | float | bool | type(None))
    }


def _files(row: GithubActivity) -> list[ai.ActivityFileChange]:
    source = row.detail if isinstance(row.detail, dict) else {}
    raw_files = source.get("files")
    if not isinstance(raw_files, list):
        return []
    files: list[ai.ActivityFileChange] = []
    for item in raw_files:
        if not isinstance(item, dict):
            continue
        try:
            files.append(ai.ActivityFileChange.model_validate(item))
        except Exception:  # noqa: BLE001 - malformed provider detail is not a reason to block the source
            continue
    return files


def build_input(row: GithubActivity) -> ai.ActivitySummaryInput:
    """Map a source row to the generic prompt contract, without project-specific prose."""
    return ai.ActivitySummaryInput(
        project_id=row.project_id,
        platform="github",
        record_kind=row.kind,
        source_revision=row.revision,
        actor_name=row.author_name or row.author_login or "未知作者",
        actor_login=row.author_login,
        occurred_at=(
            row.occurred_at if row.occurred_at.tzinfo else row.occurred_at.replace(tzinfo=UTC)
        ).isoformat(),
        title=row.title,
        body="" if row.deleted else row.summary,
        metadata=_metadata(row),
        files=_files(row),
        diff_truncated=bool((row.detail or {}).get("files_truncated"))
        if isinstance(row.detail, dict)
        else False,
    )


def input_hash(payload: ai.ActivitySummaryInput) -> str:
    encoded = json.dumps(
        payload.model_dump(mode="json"), ensure_ascii=False, sort_keys=True
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def _base(source_id: UUID, payload: ai.ActivitySummaryInput, *, status: str) -> dict[str, Any]:
    return {
        "source_id": str(source_id),
        "status": status,
        "source_revision": payload.source_revision,
        "prompt_version": PROMPT_VERSION,
        "input_hash": input_hash(payload),
        "headline": None,
        "implementation": None,
        "impact": None,
        "verification": [],
        "risks": [],
        "evidence": [],
        "confidence": None,
        "insufficient_context": [],
        "provider": None,
        "model": None,
        "is_placeholder": False,
        "needs_human_review": True,
        "error_code": None,
        "generated_at": None,
    }


def _apply_row(data: dict[str, Any], row: ActivitySummary | None) -> dict[str, Any]:
    if row is None:
        return data
    data["status"] = row.status
    data["provider"] = row.provider
    data["model"] = row.model
    data["is_placeholder"] = row.is_placeholder
    data["needs_human_review"] = row.needs_human_review
    data["error_code"] = row.error_code
    data["generated_at"] = row.generated_at.isoformat() if row.generated_at else None
    if isinstance(row.result_json, dict):
        for key in (
            "headline",
            "implementation",
            "impact",
            "verification",
            "risks",
            "evidence",
            "confidence",
            "insufficient_context",
        ):
            if key in row.result_json:
                data[key] = row.result_json[key]
    return data


def _source(session: Session, actor: User, project_id: UUID, source_id: UUID) -> GithubActivity:
    permissions.require_project_member(session, actor, project_id, write=False)
    row = session.scalar(
        select(GithubActivity).where(
            GithubActivity.id == source_id, GithubActivity.project_id == project_id
        )
    )
    if row is None:
        raise ApiError(404, "ACTIVITY_NOT_FOUND", "记录不存在。")
    return row


def _status_for_row(session: Session, row: GithubActivity) -> dict[str, Any]:
    payload = build_input(row)
    data = _base(row.id, payload, status="not_generated")
    if row.kind != "commit" or row.deleted:
        data["status"] = "unsupported"
        data["insufficient_context"] = ["首期只对仍可读取的 GitHub commit 生成摘要"]
        return data
    cached = session.scalar(
        select(ActivitySummary).where(
            ActivitySummary.source_type == "github",
            ActivitySummary.source_id == row.id,
            ActivitySummary.source_revision == payload.source_revision,
            ActivitySummary.prompt_version == PROMPT_VERSION,
            ActivitySummary.input_hash == data["input_hash"],
        )
    )
    return _apply_row(data, cached)


def get_summary(session: Session, actor: User, project_id: UUID, source_id: UUID) -> dict[str, Any]:
    return _status_for_row(session, _source(session, actor, project_id, source_id))


def list_summaries(
    session: Session, actor: User, project_id: UUID, source_ids: list[UUID]
) -> list[dict[str, Any]]:
    permissions.require_project_member(session, actor, project_id, write=False)
    if len(source_ids) > 100:
        raise ApiError(422, "TOO_MANY_ACTIVITY_SUMMARIES", "一次最多读取 100 条摘要。")
    rows = session.scalars(
        select(GithubActivity).where(
            GithubActivity.project_id == project_id, GithubActivity.id.in_(source_ids)
        )
    ).all()
    by_id = {row.id: row for row in rows}
    missing = set(source_ids) - set(by_id)
    if missing:
        raise ApiError(404, "ACTIVITY_NOT_FOUND", "部分活动记录不存在。")
    return [_status_for_row(session, by_id[source_id]) for source_id in source_ids]


def generate_summary(
    session: Session,
    actor: User,
    project_id: UUID,
    source_id: UUID,
    *,
    provider: ai.AIProvider | None = None,
) -> dict[str, Any]:
    row = _source(session, actor, project_id, source_id)
    _hydrate_commit_detail(session, row)
    payload = build_input(row)
    data = _base(row.id, payload, status="not_generated")
    if row.kind != "commit" or row.deleted:
        data["status"] = "unsupported"
        data["insufficient_context"] = ["首期只对仍可读取的 GitHub commit 生成摘要"]
        return data
    digest = data["input_hash"]
    cached = session.scalar(
        select(ActivitySummary).where(
            ActivitySummary.source_type == "github",
            ActivitySummary.source_id == row.id,
            ActivitySummary.source_revision == payload.source_revision,
            ActivitySummary.prompt_version == PROMPT_VERSION,
            ActivitySummary.input_hash == digest,
        )
    )
    if cached is not None and cached.status == "ready":
        return _apply_row(data, cached)
    if cached is None:
        cached = ActivitySummary(
            id=uuid4(),
            project_id=project_id,
            source_type="github",
            source_id=row.id,
            source_revision=payload.source_revision,
            prompt_version=PROMPT_VERSION,
            input_hash=digest,
        )
        session.add(cached)
    cached.status = "pending"
    cached.error_code = None
    session.flush()
    try:
        result = ai.summarize_activity(
            payload,
            provider=provider,
            usage=AIUsageContext(user_id=actor.id, project_id=project_id),
        )
    except ApiError as error:
        cached.status = "failed"
        cached.error_code = error.code
        cached.result_json = None
        session.flush()
        return _apply_row(data, cached)
    cached.status = "ready"
    cached.result_json = result.model_dump(mode="json")
    cached.provider = result.provider
    cached.model = getattr(provider, "model", None) if provider is not None else None
    cached.is_placeholder = result.is_placeholder
    cached.needs_human_review = result.needs_human_review
    cached.generated_at = datetime.now(UTC)
    cached.error_code = None
    session.flush()
    return _apply_row(data, cached)
