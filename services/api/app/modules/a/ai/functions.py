"""A7-03 ~ A7-06：给 B、D 用的四个 AI 函数。

用法::

    from app.modules.a.ai import extract_requirements, RequirementExtractionInput

    result = extract_requirements(RequirementExtractionInput(...))

AI 不可用时抛 ``ApiError(503, "AI_UNAVAILABLE")``，页面应提示“AI 暂不可用”并改走人工流程。
结果只是建议（``needs_human_review=True``），必须让人确认后才写入正式数据。
"""

from __future__ import annotations

import logging
from typing import Any

from pydantic import BaseModel, ValidationError

from app.api.errors import ApiError
from app.modules.a.ai.provider import (
    DEFAULT_TIMEOUT_SECONDS,
    AIProvider,
    AIUnavailable,
    call_with_retry,
    get_provider,
)
from app.modules.a.ai.schemas import (
    ActivitySummaryInput,
    ActivitySummaryResult,
    EvidenceMatchInput,
    EvidenceMatchResult,
    FeishuCollaborationInput,
    FeishuCollaborationResult,
    ImplementationAnalysisInput,
    ImplementationAnalysisResult,
    ProjectBlueprintInput,
    ProjectBlueprintResult,
    RequirementExtractionInput,
    RequirementExtractionResult,
    RiskExplanationInput,
    RiskExplanationResult,
    TaskSuggestionInput,
    TaskSuggestionResult,
)
from app.modules.a.ai.usage import metered, note_provider_call, note_provider_usage

logger = logging.getLogger("groupproof.a.ai")


def ai_unavailable() -> ApiError:
    return ApiError(503, "AI_UNAVAILABLE", "AI 暂不可用，请改为人工处理。")


def _sanitize_summary_raw(raw: dict[str, Any]) -> dict[str, Any]:
    """容错规范化模型输出的摘要字段，避免轻微超长或多余字段导致整条有效分析被丢弃。"""
    if not isinstance(raw, dict):
        return raw
    allowed = {
        "headline",
        "implementation",
        "impact",
        "verification",
        "risks",
        "evidence",
        "confidence",
        "insufficient_context",
    }
    cleaned = {k: v for k, v in raw.items() if k in allowed}
    if isinstance(cleaned.get("headline"), str):
        cleaned["headline"] = cleaned["headline"].strip()[:240]
    if isinstance(cleaned.get("implementation"), str):
        cleaned["implementation"] = cleaned["implementation"].strip()[:600]
    if isinstance(cleaned.get("impact"), str):
        text = cleaned["impact"].strip()
        cleaned["impact"] = text[:600] if text else None
    for list_key in ("verification", "risks", "insufficient_context"):
        items = cleaned.get(list_key)
        if isinstance(items, list):
            cleaned[list_key] = [str(item).strip()[:300] for item in items if str(item).strip()][:8]
        elif items is None:
            cleaned[list_key] = []
    if isinstance(cleaned.get("evidence"), list):
        ev_out = []
        for item in cleaned["evidence"][:8]:
            if not isinstance(item, dict):
                continue
            source = str(item.get("source") or "").strip().lower()
            quote = str(item.get("quote") or "").strip()[:300]
            if source in {"title", "body", "metadata", "files"} and quote:
                ev_out.append({"source": source, "quote": quote})
        cleaned["evidence"] = ev_out
    conf = cleaned.get("confidence")
    if isinstance(conf, int | float):
        cleaned["confidence"] = max(0.0, min(1.0, float(conf)))
    return cleaned


def _run[ResultT: BaseModel](
    feature: str,
    payload: BaseModel,
    result_model: type[ResultT],
    provider: AIProvider | None,
    *,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> ResultT:
    try:
        provider = provider or get_provider()
        note_provider_call(provider)
        raw = call_with_retry(
            lambda: provider.generate(feature, payload.model_dump(mode="json"), timeout=timeout)
        )
        note_provider_usage(provider)
        if feature == "summarize_activity":
            raw = _sanitize_summary_raw(raw)
        elif feature == "generate_project_blueprint" and isinstance(payload, ProjectBlueprintInput):
            raw = _sanitize_blueprint_raw(raw, payload)
        elif feature == "analyze_feishu_collaboration" and isinstance(
            payload, FeishuCollaborationInput
        ):
            raw = _sanitize_feishu_collaboration_raw(raw, payload)
        return result_model.model_validate(
            {**raw, "provider": provider.name, "is_placeholder": provider.is_placeholder}
        )
    except (AIUnavailable, ValidationError, TypeError, KeyError) as exc:
        logger.warning("AI feature %s failed validation/call: %s", feature, exc)
        raise ai_unavailable() from exc


@metered("extract_requirements")
def extract_requirements(
    payload: RequirementExtractionInput, *, provider: AIProvider | None = None
) -> RequirementExtractionResult:
    result = _run("extract_requirements", payload, RequirementExtractionResult, provider)
    known = {
        (str(doc.source_id), seg.segment_id) for doc in payload.documents for seg in doc.segments
    }
    citations = [s for r in result.requirements for s in r.sources] + [
        s for c in result.conflicts for s in c.sources
    ]
    if any((str(c.source_id), c.segment_id) not in known for c in citations):
        # AI 编造了不存在的出处：整份结果不可信。
        raise ai_unavailable()
    return result


@metered("suggest_tasks")
def suggest_tasks(
    payload: TaskSuggestionInput, *, provider: AIProvider | None = None
) -> TaskSuggestionResult:
    result = _run("suggest_tasks", payload, TaskSuggestionResult, provider)
    known = {r.id for r in payload.requirements}
    if any(rid not in known for rid in result.uncovered_requirement_ids) or any(
        s.requirement_id not in known for s in result.suggestions
    ):
        raise ai_unavailable()
    return result


@metered("match_evidence")
def match_evidence(
    payload: EvidenceMatchInput, *, provider: AIProvider | None = None
) -> EvidenceMatchResult:
    result = _run("match_evidence", payload, EvidenceMatchResult, provider)
    known = {e.id for e in payload.evidence}
    if result.criterion_id != payload.criterion.id or any(
        eid not in known for eid in result.matched_evidence_ids
    ):
        raise ai_unavailable()
    return result


@metered("explain_risk")
def explain_risk(
    payload: RiskExplanationInput, *, provider: AIProvider | None = None
) -> RiskExplanationResult:
    return _run("explain_risk", payload, RiskExplanationResult, provider)


@metered("analyze_implementation")
def analyze_implementation(
    payload: ImplementationAnalysisInput, *, provider: AIProvider | None = None
) -> ImplementationAnalysisResult:
    result = _run("analyze_implementation", payload, ImplementationAnalysisResult, provider)
    known_requirements = {r.id for r in payload.requirements}
    texts = {f.path: f.text for f in payload.files}
    seen: set = set()
    for finding in result.findings:
        if finding.requirement_id not in known_requirements or finding.requirement_id in seen:
            raise ai_unavailable()
        seen.add(finding.requirement_id)
        # 声称已实现或部分实现，必须给出出处；出处必须是真实存在的文件和原文。
        if finding.status in ("implemented", "partial") and not finding.evidence:
            raise ai_unavailable()
        for item in finding.evidence:
            text = texts.get(item.path)
            if text is None or _squash(item.quote) not in _squash(text):
                raise ai_unavailable()
    return result


def _strip_diff_prefixes(patch: str) -> str:
    """去掉 unified diff 每行开头的 +/-/空格 前缀，避免模型引用真实代码行时因不含 + 被误判。"""
    lines = []
    for line in (patch or "").splitlines():
        if line.startswith(("+++", "---", "@@")):
            lines.append(line)
        elif line.startswith(("+", "-", " ")):
            lines.append(line[1:])
        else:
            lines.append(line)
    return "\n".join(lines)


@metered("summarize_activity")
def summarize_activity(
    payload: ActivitySummaryInput, *, provider: AIProvider | None = None
) -> ActivitySummaryResult:
    """为来源活动生成可追溯的两层摘要；不得凭空生成文件、测试或功能。"""
    result = _run("summarize_activity", payload, ActivitySummaryResult, provider)
    files_raw = "\n".join(
        f"{item.path} ({item.status}, +{item.additions}/-{item.deletions})\n{item.patch or ''}"
        for item in payload.files
    )
    files_stripped = "\n".join(
        f"{item.path}\n{_strip_diff_prefixes(item.patch or '')}" for item in payload.files
    )
    source_text = {
        "title": payload.title,
        "body": payload.body,
        "metadata": " ".join(
            f"{key}: {value}"
            for key, value in sorted(payload.metadata.items())
            if value is not None
        ),
        "files": f"{files_raw}\n{files_stripped}",
    }
    squashed_sources = {key: _squash(val) for key, val in source_text.items()}
    verified_evidence = []
    for evidence in result.evidence:
        candidates = [_squash(evidence.quote), _squash(_strip_diff_prefixes(evidence.quote))]
        candidates = [c for c in candidates if c]
        if not candidates:
            continue
        if any(c in squashed_sources[evidence.source] for c in candidates):
            verified_evidence.append(evidence)
            continue
        matched_source = next(
            (key for key, text in squashed_sources.items() if any(c in text for c in candidates)),
            None,
        )
        if matched_source is not None:
            evidence.source = matched_source  # type: ignore[assignment]
            verified_evidence.append(evidence)
            continue
        logger.info(
            "summarize_activity dropped unverified quote source=%s len=%d",
            evidence.source,
            len(evidence.quote),
        )
    if not verified_evidence:
        logger.warning("summarize_activity rejected result with zero verified evidence quotes")
        raise ai_unavailable()
    result.evidence = verified_evidence
    return result


def _squash(value: str) -> str:
    """忽略空白差异后再比对引文，避免因缩进或换行不同误判。"""
    return "".join(value.split())


def _normalize_weights_to_100(weights: list[int]) -> list[int]:
    """把任意正整数权重列表归一化为总和严格等于 100（且每项至少为 1）。"""
    n = len(weights)
    if n == 0:
        return []
    if n == 1:
        return [100]
    if n > 100:
        return [1] * n
    safe = [max(1, int(w)) for w in weights]
    total = sum(safe)
    if total == 100:
        return safe
    scaled = [w * 100 / total for w in safe]
    floored = [max(1, int(val)) for val in scaled]
    remainder = 100 - sum(floored)
    if remainder > 0:
        order = sorted(range(n), key=lambda i: scaled[i] - int(scaled[i]), reverse=True)
        for idx in order[:remainder]:
            floored[idx] += 1
    elif remainder < 0:
        order = sorted(range(n), key=lambda i: floored[i], reverse=True)
        need = -remainder
        while need > 0:
            moved = False
            for idx in order:
                if floored[idx] > 1 and need > 0:
                    floored[idx] -= 1
                    need -= 1
                    moved = True
            if not moved:
                break
    return floored


def _sanitize_blueprint_raw(raw: dict[str, Any], payload: ProjectBlueprintInput) -> dict[str, Any]:
    """容错规范化模型生成的项目规划蓝图：约束字段长度并把任务权重归一化为 100。"""
    if not isinstance(raw, dict):
        return raw
    member_ids = {str(m.id) for m in payload.members}
    material_ids = {str(d.material_id) for d in payload.documents}
    default_material_id = str(payload.documents[0].material_id) if payload.documents else None
    default_member_id = str(payload.members[0].id) if payload.members else None

    def _valid_uid(val: Any, allowed: set[str], fallback: str | None = None) -> str | None:
        s = str(val).strip() if val else ""
        return s if s in allowed else fallback

    modules_out: list[dict[str, Any]] = []
    module_names: list[str] = []
    for item in (raw.get("modules") or [])[:20]:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()[:200]
        if not name or name in module_names:
            continue
        module_names.append(name)
        modules_out.append(
            {
                "name": name,
                "description": str(item.get("description") or "").strip()[:2000],
                "owner_id": _valid_uid(item.get("owner_id"), member_ids, default_member_id),
            }
        )
    if not modules_out:
        modules_out.append({"name": "核心模块", "description": "", "owner_id": default_member_id})
        module_names.append("核心模块")
    first_module = module_names[0]

    reqs_out: list[dict[str, Any]] = []
    for item in (raw.get("requirements") or [])[:80]:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()[:240]
        if not title:
            continue
        mod = str(item.get("module") or "").strip()[:200]
        if mod not in module_names:
            mod = first_module
        prio = str(item.get("priority") or "medium").strip().lower()
        if prio not in {"high", "medium", "low"}:
            prio = "medium"
        reqs_out.append(
            {
                "title": title,
                "description": str(item.get("description") or "").strip()[:3000],
                "module": mod,
                "priority": prio,
                "material_id": _valid_uid(
                    item.get("material_id"), material_ids, default_material_id
                ),
                "quote": str(item.get("quote") or "").strip()[:300],
            }
        )
    if not reqs_out:
        reqs_out.append(
            {
                "title": f"{payload.project_name} 核心需求",
                "description": "",
                "module": first_module,
                "priority": "high",
                "material_id": default_material_id,
                "quote": "",
            }
        )

    milestones_out: list[dict[str, Any]] = []
    for item in (raw.get("milestones") or [])[:20]:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()[:200]
        if not title:
            continue
        delivs = [str(d).strip()[:180] for d in (item.get("deliverables") or []) if str(d).strip()][
            :8
        ]
        deadline_raw = str(item.get("deadline") or "").strip()[:32] or None
        milestones_out.append(
            {
                "title": title,
                "description": str(item.get("description") or "").strip()[:2000],
                "deadline": deadline_raw,
                "deliverables": delivs,
            }
        )

    tasks_out: list[dict[str, Any]] = []
    raw_weights: list[int] = []
    for item in (raw.get("tasks") or [])[:80]:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()[:240]
        if not title:
            continue
        mod = str(item.get("module") or "").strip()[:200]
        if mod not in module_names:
            mod = first_module
        prio = str(item.get("priority") or "medium").strip().lower()
        if prio not in {"high", "medium", "low"}:
            prio = "medium"
        assignees = [
            uid
            for raw_id in (item.get("assignee_ids") or [])
            if (uid := _valid_uid(raw_id, member_ids)) is not None
        ]
        if not assignees and default_member_id:
            assignees = [default_member_id]
        criteria = [
            str(c).strip()[:500] for c in (item.get("acceptance_criteria") or []) if str(c).strip()
        ][:10]
        if not criteria:
            criteria = [f"完成「{title[:60]}」核心实现并通过团队人工验收"]
        try:
            w = int(item.get("weight") or 5)
        except (TypeError, ValueError):
            w = 5
        raw_weights.append(max(1, min(w, 100)))
        tasks_out.append(
            {
                "title": title,
                "description": str(item.get("description") or "").strip()[:3000],
                "module": mod,
                "requirement_titles": [
                    str(r).strip()[:240]
                    for r in (item.get("requirement_titles") or [])
                    if str(r).strip()
                ][:10],
                "milestone_titles": [
                    str(m).strip()[:200]
                    for m in (item.get("milestone_titles") or [])
                    if str(m).strip()
                ][:10],
                "assignee_ids": list(dict.fromkeys(assignees))[:10],
                "priority": prio,
                "weight": 1,
                "acceptance_criteria": criteria,
            }
        )
    if not tasks_out:
        tasks_out.append(
            {
                "title": reqs_out[0]["title"],
                "description": reqs_out[0]["description"],
                "module": first_module,
                "requirement_titles": [reqs_out[0]["title"]],
                "milestone_titles": [milestones_out[0]["title"]] if milestones_out else [],
                "assignee_ids": [default_member_id] if default_member_id else [],
                "priority": "high",
                "weight": 100,
                "acceptance_criteria": ["核心功能交付并通过验收"],
            }
        )
        raw_weights = [100]

    normalized_weights = _normalize_weights_to_100(raw_weights)
    for task_item, weight in zip(tasks_out, normalized_weights, strict=True):
        task_item["weight"] = weight

    return {
        "modules": modules_out,
        "requirements": reqs_out,
        "milestones": milestones_out,
        "tasks": tasks_out,
        "in_scope": str(raw.get("in_scope") or "").strip()[:2000],
        "out_of_scope": str(raw.get("out_of_scope") or "").strip()[:2000],
    }


@metered("generate_project_blueprint")
def generate_project_blueprint(
    payload: ProjectBlueprintInput, *, provider: AIProvider | None = None
) -> ProjectBlueprintResult:
    """从上传的分工/需求文档一次性解析项目模块、需求基线、里程碑与任务分工蓝图。"""
    return _run(
        "generate_project_blueprint",
        payload,
        ProjectBlueprintResult,
        provider,
        timeout=90.0,
    )


def _sanitize_feishu_collaboration_raw(
    raw: dict[str, Any], payload: FeishuCollaborationInput
) -> dict[str, Any]:
    """严格校验模型输出的飞书协作结论：丢弃幻觉消息 ID 与无效任务编号，确保每条结论可追溯。"""
    if not isinstance(raw, dict):
        return raw
    msg_order = {str(m.id): idx for idx, m in enumerate(payload.messages)}
    msg_sender = {str(m.id): m.sender_label for m in payload.messages}
    valid_task_codes = {t.code.upper(): t.code for t in payload.tasks}
    valid_categories = {"division_confirm", "task_progress", "doc_review", "decision", "blocker"}
    valid_statuses = {"completed", "in_progress", "needs_followup"}

    items_out: list[dict[str, Any]] = []
    for item in (raw.get("items") or [])[:24]:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()[:120]
        summary = str(item.get("summary") or "").strip()[:600]
        if not title or not summary:
            continue
        raw_ids = item.get("message_ids") or []
        valid_ids = [str(mid).strip() for mid in raw_ids if str(mid).strip() in msg_order]
        # 去重并按真实聊天时间先后排列
        unique_ids = sorted(dict.fromkeys(valid_ids), key=lambda mid: msg_order[mid])[:40]
        if not unique_ids:
            continue
        cat = str(item.get("category") or "decision").strip().lower()
        if cat not in valid_categories:
            cat = "decision"
        st = str(item.get("status") or "in_progress").strip().lower()
        if st not in valid_statuses:
            st = "in_progress"
        basis = str(item.get("judgment_basis") or summary).strip()[:600]
        codes: list[str] = []
        for raw_code in item.get("task_codes") or []:
            matched = valid_task_codes.get(str(raw_code).strip().upper())
            if matched and matched not in codes:
                codes.append(matched)
        distinct_senders = len({msg_sender[mid] for mid in unique_ids if msg_sender.get(mid)})
        try:
            confirmed = int(item.get("confirmed_count") or 0)
        except (TypeError, ValueError):
            confirmed = distinct_senders
        confirmed = max(0, min(50, confirmed or distinct_senders))
        try:
            conf = float(item.get("confidence", 0.8))
        except (TypeError, ValueError):
            conf = 0.8
        conf = max(0.0, min(1.0, conf))
        items_out.append(
            {
                "title": title,
                "category": cat,
                "status": st,
                "summary": summary,
                "judgment_basis": basis,
                "task_codes": codes[:10],
                "confirmed_count": confirmed,
                "message_ids": unique_ids,
                "confidence": conf,
            }
        )

    overview = str(raw.get("overview") or "").strip()[:600]
    if not overview:
        if items_out:
            overview = (
                f"共分析 {len(payload.messages)} 条有效群聊消息，"
                f"提炼出 {len(items_out)} 条团队协作结论。"
            )
        else:
            overview = (
                f"共分析 {len(payload.messages)} 条群聊消息，"
                "暂未识别出明确的分工确认或任务进展结论。"
            )
    return {"overview": overview, "items": items_out}


@metered("analyze_feishu_collaboration")
def analyze_feishu_collaboration(
    payload: FeishuCollaborationInput, *, provider: AIProvider | None = None
) -> FeishuCollaborationResult:
    """分析飞书群聊上下文，聚合提炼分工确认、任务推进、决策与待跟进事项。"""
    return _run(
        "analyze_feishu_collaboration",
        payload,
        FeishuCollaborationResult,
        provider,
        timeout=75.0,
    )
