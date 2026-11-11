"""A7-03 ~ A7-06：给 B、D 用的四个 AI 函数。

用法::

    from app.modules.a.ai import extract_requirements, RequirementExtractionInput

    result = extract_requirements(RequirementExtractionInput(...))

AI 不可用时抛 ``ApiError(503, "AI_UNAVAILABLE")``，页面应提示“AI 暂不可用”并改走人工流程。
结果只是建议（``needs_human_review=True``），必须让人确认后才写入正式数据。
"""

from __future__ import annotations

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


def ai_unavailable() -> ApiError:
    return ApiError(503, "AI_UNAVAILABLE", "AI 暂不可用，请改为人工处理。")


def _run[ResultT: BaseModel](
    feature: str,
    payload: BaseModel,
    result_model: type[ResultT],
    provider: AIProvider | None,
) -> ResultT:
    try:
        provider = provider or get_provider()
        raw = call_with_retry(
            lambda: provider.generate(
                feature, payload.model_dump(mode="json"), timeout=DEFAULT_TIMEOUT_SECONDS
            )
        )
        return result_model.model_validate(
            {**raw, "provider": provider.name, "is_placeholder": provider.is_placeholder}
        )
    except (AIUnavailable, ValidationError, TypeError, KeyError) as exc:
        raise ai_unavailable() from exc


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


def explain_risk(
    payload: RiskExplanationInput, *, provider: AIProvider | None = None
) -> RiskExplanationResult:
    return _run("explain_risk", payload, RiskExplanationResult, provider)


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


def _squash(value: str) -> str:
    """忽略空白差异后再比对引文，避免因缩进或换行不同误判。"""
    return "".join(value.split())
