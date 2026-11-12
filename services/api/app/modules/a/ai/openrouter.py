# ruff: noqa: E501  (提示词是中文长句，不强行折行)
"""OpenRouter 接入：用 OpenAI 兼容的聊天接口生成结构化结果。

变量（Railway）：
- ``AI_API_KEY``：OpenRouter 密钥（只放后端变量）；
- ``AI_MODEL``：模型名，默认 ``openrouter/auto``；
- 每个功能的输出都要符合 ``schemas.py`` 里的结果模型，字段由函数层再校验一遍。
"""

from __future__ import annotations

import json
from typing import Any

import httpx

from app.modules.a.ai import schemas
from app.modules.a.ai.provider import AIUnavailable

OPENROUTER_BASE = "https://openrouter.ai"
DEFAULT_MODEL = "openrouter/auto"
META_FIELDS = ("provider", "is_placeholder", "needs_human_review")

RESULT_MODELS = {
    "extract_requirements": schemas.RequirementExtractionResult,
    "suggest_tasks": schemas.TaskSuggestionResult,
    "match_evidence": schemas.EvidenceMatchResult,
    "explain_risk": schemas.RiskExplanationResult,
    "analyze_implementation": schemas.ImplementationAnalysisResult,
}

INSTRUCTIONS = {
    "extract_requirements": "从给定的资料片段中提取需求和模块，并指出互相矛盾的地方。每一条都必须引用输入里真实存在的 source_id 和 segment_id，并摘录原文。",
    "suggest_tasks": "找出没有被任何任务覆盖的需求，并为它们建议任务和验收标准。只能使用输入里出现过的需求 id。",
    "match_evidence": "判断给定的证据是否满足这条验收标准。只能引用输入里出现过的证据 id；证据不足时给出 insufficient 并说明缺少什么。",
    "explain_risk": "根据任务进度和风险记录，给出风险等级、一句话总结、大白话解释和建议。",
    "analyze_implementation": (
        "判断每条需求是否已经在给定的代码文件中实现。status 只能是 implemented、partial、not_found、unclear。"
        "声称 implemented 或 partial 时，必须在 evidence 里给出真实文件路径和该文件里逐字存在的短引文（不超过 300 字）；"
        "找不到依据时用 not_found 或 unclear，不要猜测。只能使用输入里出现过的需求 id 和文件路径。"
    ),
}


def _schema_for(feature: str) -> dict[str, Any]:
    schema = RESULT_MODELS[feature].model_json_schema()
    for name in META_FIELDS:
        schema.get("properties", {}).pop(name, None)
        if name in schema.get("required", []):
            schema["required"].remove(name)
    return schema


class OpenRouterProvider:
    name = "openrouter"
    is_placeholder = False

    def __init__(
        self,
        api_key: str,
        model: str = DEFAULT_MODEL,
        *,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._api_key = api_key
        self._model = model
        self._transport = transport
        self.last_usage: dict | None = None

    @property
    def model(self) -> str:
        return self._model

    def generate(self, feature: str, payload: dict[str, Any], *, timeout: float) -> dict:
        if feature not in RESULT_MODELS:
            raise AIUnavailable(f"openrouter provider has no feature {feature}")
        system = (
            "你是软件工程课程项目的助手。只输出一个 JSON 对象，不要输出任何其他文字。"
            "使用中文写理由和说明。你的结果只是建议，会由人确认。\n"
            f"任务：{INSTRUCTIONS[feature]}\n"
            f"输出必须符合这个 JSON Schema：{json.dumps(_schema_for(feature), ensure_ascii=False)}"
        )
        body = {
            "model": self._model,
            "temperature": 0,
            "response_format": {"type": "json_object"},
            "usage": {"include": True},  # 让 OpenRouter 在结果里带上 token 和费用
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
            ],
        }
        with httpx.Client(
            base_url=OPENROUTER_BASE, timeout=timeout, transport=self._transport
        ) as client:
            response = client.post(
                "/api/v1/chat/completions",
                json=body,
                headers={"Authorization": f"Bearer {self._api_key}", "X-Title": "GroupProof"},
            )
        if response.status_code in (401, 403):
            raise AIUnavailable("openrouter key rejected")  # 配置问题，不重试
        response.raise_for_status()
        self.last_usage = self._read_usage(response.json())
        content = response.json()["choices"][0]["message"]["content"]
        result = json.loads(content)
        if not isinstance(result, dict):
            raise ValueError("model did not return a JSON object")
        return result

    @staticmethod
    def _read_usage(body: dict) -> dict | None:
        usage = body.get("usage")
        if not isinstance(usage, dict):
            return None
        return {
            "input_tokens": usage.get("prompt_tokens"),
            "output_tokens": usage.get("completion_tokens"),
            "cost": usage.get("cost"),
            "currency": "USD" if usage.get("cost") is not None else None,
        }
