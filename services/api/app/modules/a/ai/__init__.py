"""A7 AI 接入：中间层 + 四个 AI 函数。字段说明见 docs/A_SHARED_SERVICES.md。"""

from app.modules.a.ai.functions import (
    ai_unavailable,
    analyze_implementation,
    explain_risk,
    extract_requirements,
    match_evidence,
    suggest_tasks,
)
from app.modules.a.ai.provider import AIProvider, AIUnavailable, FakeProvider, get_provider
from app.modules.a.ai.schemas import (
    CodeFile,
    EvidenceMatchInput,
    EvidenceMatchResult,
    ImplementationAnalysisInput,
    ImplementationAnalysisResult,
    ImplRequirement,
    RequirementExtractionInput,
    RequirementExtractionResult,
    RiskExplanationInput,
    RiskExplanationResult,
    TaskSuggestionInput,
    TaskSuggestionResult,
)
from app.modules.a.ai.usage import AIUsageContext

__all__ = [
    "AIProvider",
    "AIUsageContext",
    "AIUnavailable",
    "CodeFile",
    "EvidenceMatchInput",
    "EvidenceMatchResult",
    "FakeProvider",
    "ImplRequirement",
    "ImplementationAnalysisInput",
    "ImplementationAnalysisResult",
    "RequirementExtractionInput",
    "RequirementExtractionResult",
    "RiskExplanationInput",
    "RiskExplanationResult",
    "TaskSuggestionInput",
    "TaskSuggestionResult",
    "ai_unavailable",
    "analyze_implementation",
    "explain_risk",
    "extract_requirements",
    "get_provider",
    "match_evidence",
    "suggest_tasks",
]
