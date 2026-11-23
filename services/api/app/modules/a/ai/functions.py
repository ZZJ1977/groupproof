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
    ImplementationAnalysisInput,
    ImplementationAnalysisResult,
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
) -> ResultT:
    try:
        provider = provider or get_provider()
        note_provider_call(provider)
        raw = call_with_retry(
            lambda: provider.generate(
                feature, payload.model_dump(mode="json"), timeout=DEFAULT_TIMEOUT_SECONDS
            )
        )
        note_provider_usage(provider)
        if feature == "summarize_activity":
            raw = _sanitize_summary_raw(raw)
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
