"""A6/A7 飞书群聊 AI 协作进展分析与缓存服务。

原始群聊消息（``a_feishu_messages``）始终作为事实来源保留；本模块按时间串联群内讨论、
分工文档发送与成员确认回复（如「收到」「OK」「可以」），由 AI 提炼为结构化协作结论，
并把每条结论严格绑定到真实的消息 ID，点击详情即可回看完整上下文聊天记录。
结果缓存在 ``a_activity_summaries``（``source_type="feishu_collab"``），无需新增表迁移。
"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import Project, ProjectMember, Task, User
from app.modules.a import ai, permissions
from app.modules.a.ai.provider import AIUnavailable, get_provider
from app.modules.a.ai.usage import AIUsageContext
from app.modules.a.models import ActivitySummary, FeishuAttachment, FeishuMessage

logger = logging.getLogger("groupproof.a.feishu_insights")

SOURCE_TYPE = "feishu_collab"
PROMPT_VERSION = "feishu-collab-v1"
MAX_MESSAGES_FOR_AI = 240
_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def _iso_utc(dt: datetime) -> str:
    aware = dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)
    return aware.astimezone(UTC).isoformat()


def _sender_label_map(
    messages: list[FeishuMessage],
    known_names: dict[str, str] | None = None,
) -> dict[str, str]:
    """优先用项目成员真实姓名标识 sender_open_id，未绑定者退回脱敏标签（群成员 A/B/C…）。"""
    resolved_known: dict[str, str] = {}
    for raw_key, raw_name in (known_names or {}).items():
        key = (raw_key or "").strip()
        name = (raw_name or "").strip()
        if key and name and key not in resolved_known:
            resolved_known[key] = name

    mapping: dict[str, str] = {}
    fallback_idx = 0
    for msg in messages:
        if msg.sender_type == "app":
            continue
        key = (msg.sender_open_id or "").strip()
        if not key or key in mapping:
            continue
        if key in resolved_known:
            mapping[key] = resolved_known[key]
        else:
            suffix = (
                _LETTERS[fallback_idx] if fallback_idx < len(_LETTERS) else str(fallback_idx + 1)
            )
            fallback_idx += 1
            mapping[key] = f"群成员 {suffix}"
    return mapping


def _label_for(msg: FeishuMessage, labels: dict[str, str]) -> str:
    if msg.sender_type == "app":
        return "群机器人"
    key = (msg.sender_open_id or "").strip()
    if key and key in labels:
        return labels[key]
    return "飞书成员"


def _is_substantive(msg: FeishuMessage, attachments: list[FeishuAttachment]) -> bool:
    if msg.deleted:
        return False
    if msg.msg_type == "system":
        return False
    text = (msg.text or "").strip()
    if attachments:
        return True
    if not text or text == "[system]":
        return False
    return True


def _message_text_for_ai(msg: FeishuMessage, attachments: list[FeishuAttachment]) -> str:
    base = (msg.text or "").strip()
    extras: list[str] = []
    for att in attachments:
        name = (att.name or "").strip()
        if name and name not in base:
            extras.append(f"[附件:{att.kind}] {name}")
        elif not name and not base:
            extras.append(f"[附件:{att.kind}]")
    combined = " ".join(part for part in [base, *extras] if part).strip()
    if not combined:
        combined = f"[{msg.msg_type}]"
    return combined[:1100]


def _load_project_context(session: Session, project_id: UUID) -> dict[str, Any]:
    project = session.get(Project, project_id)
    if project is None:
        raise ApiError(404, "PROJECT_NOT_FOUND", "项目不存在。")

    all_messages = list(
        session.scalars(
            select(FeishuMessage)
            .where(FeishuMessage.project_id == project_id, FeishuMessage.deleted.is_(False))
            .order_by(FeishuMessage.occurred_at.asc(), FeishuMessage.id.asc())
        ).all()
    )
    msg_ids = [m.id for m in all_messages]
    attachments_by_msg: dict[UUID, list[FeishuAttachment]] = {}
    if msg_ids:
        for att in session.scalars(
            select(FeishuAttachment).where(FeishuAttachment.message_row_id.in_(msg_ids))
        ).all():
            attachments_by_msg.setdefault(att.message_row_id, []).append(att)

    member_rows = session.execute(
        select(ProjectMember.user_id, User.feishu_account, User.name)
        .join(User, User.id == ProjectMember.user_id)
        .where(ProjectMember.project_id == project_id, ProjectMember.left_at.is_(None))
        .order_by(ProjectMember.joined_at.asc(), User.id.asc())
    ).all()
    known_names: dict[str, str] = {}
    for _, feishu_account, name in member_rows:
        key = (feishu_account or "").strip()
        display_name = (name or "").strip()
        if key and display_name and key not in known_names:
            known_names[key] = display_name

    labels = _sender_label_map(all_messages, known_names=known_names)
    substantive = [m for m in all_messages if _is_substantive(m, attachments_by_msg.get(m.id, []))]
    # 若群聊超过窗口上限，优先保留最新的有效对话记录
    selected = substantive[-MAX_MESSAGES_FOR_AI:]

    tasks = list(
        session.scalars(
            select(Task)
            .where(Task.project_id == project_id)
            .order_by(Task.created_at.asc(), Task.id.asc())
        ).all()
    )
    numbered_tasks = [(f"T-{idx:03d}", t) for idx, t in enumerate(tasks, start=1)]
    member_count = len(member_rows) or 1

    payload: ai.FeishuCollaborationInput | None = None
    digest = ""
    revision = "empty"
    if selected:
        payload = ai.FeishuCollaborationInput(
            project_id=project_id,
            project_name=project.name[:200],
            member_count=max(1, min(50, member_count)),
            tasks=[
                ai.CollabTaskBrief(code=code, title=t.title[:240], status=t.status[:32])
                for code, t in numbered_tasks[:80]
            ],
            messages=[
                ai.CollabMessageBrief(
                    id=m.id,
                    occurred_at=_iso_utc(m.occurred_at),
                    sender_label=_label_for(m, labels)[:80],
                    msg_type=(m.msg_type or "text")[:40],
                    text=_message_text_for_ai(m, attachments_by_msg.get(m.id, [])),
                )
                for m in selected
            ],
        )
        encoded = json.dumps(
            payload.model_dump(mode="json"), ensure_ascii=False, sort_keys=True
        ).encode()
        digest = hashlib.sha256(encoded).hexdigest()
        revision = f"msgs:{len(substantive)}:{selected[-1].id}"

    return {
        "project": project,
        "all_messages": all_messages,
        "substantive": substantive,
        "selected": selected,
        "messages_by_id": {str(m.id): m for m in all_messages},
        "attachments_by_msg": attachments_by_msg,
        "labels": labels,
        "tasks_by_code": {code.upper(): (code, t) for code, t in numbered_tasks},
        "payload": payload,
        "input_hash": digest,
        "source_revision": revision,
    }


def _hydrate_response(ctx: dict[str, Any], cached: ActivitySummary | None) -> dict[str, Any]:
    total_messages = len(ctx["all_messages"])
    analyzed_messages = len(ctx["selected"])
    current_hash = ctx["input_hash"]

    base: dict[str, Any] = {
        "status": "empty" if analyzed_messages == 0 else "not_generated",
        "overview": None,
        "items": [],
        "total_messages": total_messages,
        "analyzed_messages": analyzed_messages,
        "stale": False,
        "provider": None,
        "model": None,
        "is_placeholder": False,
        "needs_human_review": True,
        "error_code": None,
        "generated_at": None,
    }
    if cached is None:
        return base

    base["status"] = cached.status
    base["provider"] = cached.provider
    base["model"] = cached.model
    base["is_placeholder"] = cached.is_placeholder
    base["needs_human_review"] = cached.needs_human_review
    base["error_code"] = cached.error_code
    base["generated_at"] = cached.generated_at
    base["stale"] = bool(current_hash and cached.input_hash != current_hash)

    result_json = cached.result_json if isinstance(cached.result_json, dict) else {}
    base["overview"] = result_json.get("overview")

    messages_by_id: dict[str, FeishuMessage] = ctx["messages_by_id"]
    attachments_by_msg: dict[UUID, list[FeishuAttachment]] = ctx["attachments_by_msg"]
    labels: dict[str, str] = ctx["labels"]
    tasks_by_code: dict[str, tuple[str, Task]] = ctx["tasks_by_code"]

    hydrated_items: list[dict[str, Any]] = []
    for idx, raw_item in enumerate(result_json.get("items") or [], start=1):
        if not isinstance(raw_item, dict):
            continue
        matched_msgs: list[FeishuMessage] = []
        seen_msg_ids: set[str] = set()
        for raw_mid in raw_item.get("message_ids") or []:
            mid = str(raw_mid).strip()
            if mid in seen_msg_ids:
                continue
            row = messages_by_id.get(mid)
            if row is not None:
                seen_msg_ids.add(mid)
                matched_msgs.append(row)
        if not matched_msgs:
            continue
        matched_msgs.sort(key=lambda m: (m.occurred_at, str(m.id)))

        linked_tasks = []
        for code in raw_item.get("task_codes") or []:
            pair = tasks_by_code.get(str(code).strip().upper())
            if pair is not None:
                task_code, task = pair
                linked_tasks.append(
                    {
                        "id": task.id,
                        "code": task_code,
                        "title": task.title,
                        "status": task.status,
                    }
                )

        hydrated_msgs = []
        for msg in matched_msgs:
            atts = attachments_by_msg.get(msg.id, [])
            hydrated_msgs.append(
                {
                    "id": msg.id,
                    "chat_id": msg.chat_id,
                    "occurred_at": msg.occurred_at,
                    "sender_label": _label_for(msg, labels),
                    "msg_type": msg.msg_type,
                    "text": msg.text or _message_text_for_ai(msg, atts),
                    "attachments": [
                        {
                            "id": a.id,
                            "kind": a.kind,
                            "name": a.name,
                            "verified": a.verified_at is not None,
                        }
                        for a in atts
                    ],
                }
            )

        hydrated_items.append(
            {
                "id": f"insight-{idx}",
                "title": str(raw_item.get("title") or "").strip(),
                "category": raw_item.get("category") or "decision",
                "status": raw_item.get("status") or "in_progress",
                "summary": str(raw_item.get("summary") or "").strip(),
                "judgment_basis": str(raw_item.get("judgment_basis") or "").strip(),
                "confirmed_count": int(raw_item.get("confirmed_count") or 0),
                "confidence": float(raw_item.get("confidence", 0.8)),
                "linked_tasks": linked_tasks,
                "started_at": matched_msgs[0].occurred_at,
                "ended_at": matched_msgs[-1].occurred_at,
                "message_count": len(hydrated_msgs),
                "messages": hydrated_msgs,
            }
        )

    # 按最后一条关联消息时间倒序排列，最新达成的协作结论排在最前面
    hydrated_items.sort(
        key=lambda item: item["ended_at"] or datetime.min.replace(tzinfo=UTC),
        reverse=True,
    )
    base["items"] = hydrated_items
    return base


def _latest_summary(session: Session, project_id: UUID) -> ActivitySummary | None:
    return session.scalar(
        select(ActivitySummary)
        .where(
            ActivitySummary.project_id == project_id,
            ActivitySummary.source_type == SOURCE_TYPE,
            ActivitySummary.source_id == project_id,
            ActivitySummary.prompt_version == PROMPT_VERSION,
        )
        .order_by(ActivitySummary.generated_at.desc(), ActivitySummary.updated_at.desc())
        .limit(1)
    )


def get_collaboration_insights(session: Session, actor: User, project_id: UUID) -> dict[str, Any]:
    """读取项目最新缓存的飞书协作 AI 结论，并实时关联真实聊天消息详情。"""
    permissions.require_project_read(session, actor, project_id)
    ctx = _load_project_context(session, project_id)
    cached = _latest_summary(session, project_id)
    return _hydrate_response(ctx, cached)


def analyze_collaboration_insights(
    session: Session,
    actor: User,
    project_id: UUID,
    *,
    force: bool = False,
    provider: ai.AIProvider | None = None,
) -> dict[str, Any]:
    """用 AI 分析项目飞书群聊上下文，提炼分工确认、任务进展与决策结论并缓存。"""
    permissions.require_project_member(session, actor, project_id, write=True)
    ctx = _load_project_context(session, project_id)
    payload: ai.FeishuCollaborationInput | None = ctx["payload"]
    if payload is None:
        return _hydrate_response(ctx, None)

    digest: str = ctx["input_hash"]
    revision: str = ctx["source_revision"]

    exact = session.scalar(
        select(ActivitySummary).where(
            ActivitySummary.source_type == SOURCE_TYPE,
            ActivitySummary.source_id == project_id,
            ActivitySummary.source_revision == revision,
            ActivitySummary.prompt_version == PROMPT_VERSION,
            ActivitySummary.input_hash == digest,
        )
    )
    if not force and exact is not None and exact.status == "ready":
        return _hydrate_response(ctx, exact)

    target = exact
    if target is None:
        target = ActivitySummary(
            id=uuid4(),
            project_id=project_id,
            source_type=SOURCE_TYPE,
            source_id=project_id,
            source_revision=revision,
            prompt_version=PROMPT_VERSION,
            input_hash=digest,
        )
        session.add(target)

    target.status = "pending"
    target.error_code = None
    session.flush()

    try:
        resolved_provider = provider or get_provider()
    except AIUnavailable:
        target.status = "failed"
        target.error_code = "AI_UNAVAILABLE"
        session.flush()
        raise ai.ai_unavailable()

    try:
        result = ai.analyze_feishu_collaboration(
            payload,
            provider=resolved_provider,
            usage=AIUsageContext(user_id=actor.id, project_id=project_id),
        )
    except ApiError as error:
        target.status = "failed"
        target.error_code = error.code
        session.flush()
        raise

    target.status = "ready"
    target.result_json = result.model_dump(mode="json")
    target.provider = result.provider
    target.model = getattr(resolved_provider, "model", None)
    target.is_placeholder = result.is_placeholder
    target.needs_human_review = result.needs_human_review
    target.generated_at = datetime.now(UTC)
    target.error_code = None
    session.flush()
    return _hydrate_response(ctx, target)


def run_auto_analysis(
    project_id: UUID,
    actor_id: UUID,
    *,
    session_factory=None,
    provider: ai.AIProvider | None = None,
) -> bool:
    """飞书同步后在后台静默刷新 AI 协作结论，失败不阻断同步主流程。"""
    if provider is None:
        try:
            get_provider()
        except AIUnavailable:
            return False

    if session_factory is None:
        from app.db.session import SessionLocal

        session_factory = SessionLocal

    session = session_factory()
    try:
        actor = session.get(User, actor_id)
        if actor is None:
            return False
        res = analyze_collaboration_insights(
            session, actor, project_id, force=False, provider=provider
        )
        session.commit()
        return res.get("status") == "ready"
    except Exception as exc:  # noqa: BLE001
        session.rollback()
        logger.warning("auto feishu collaboration analysis failed for %s: %s", project_id, exc)
        return False
    finally:
        session.close()
