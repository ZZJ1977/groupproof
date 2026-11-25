# ruff: noqa: E501  (提示词是中文长句，不强行折行)
"""OpenRouter 接入：用 OpenAI 兼容的聊天接口生成结构化结果。

变量（Railway）：
- ``AI_API_KEY``：OpenRouter 密钥（只放后端变量）；
- ``AI_MODEL``：模型名，默认 ``openrouter/auto``；
- 每个功能的输出都要符合 ``schemas.py`` 里的结果模型，字段由函数层再校验一遍。
"""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx

from app.modules.a.ai import schemas
from app.modules.a.ai.prompts import CODE_COMMIT_ANALYSIS_SYSTEM_PROMPT
from app.modules.a.ai.provider import AIUnavailable

logger = logging.getLogger("groupproof.a.ai.openrouter")

OPENROUTER_BASE = "https://openrouter.ai"
DEFAULT_MODEL = "openrouter/auto"
MODEL_ALIASES = {
    "deepseek": "deepseek/deepseek-v3.2",
    "deepseek-chat": "deepseek/deepseek-v3.2",
}
META_FIELDS = ("provider", "is_placeholder", "needs_human_review")

RESULT_MODELS = {
    "extract_requirements": schemas.RequirementExtractionResult,
    "suggest_tasks": schemas.TaskSuggestionResult,
    "match_evidence": schemas.EvidenceMatchResult,
    "explain_risk": schemas.RiskExplanationResult,
    "analyze_implementation": schemas.ImplementationAnalysisResult,
    "summarize_activity": schemas.ActivitySummaryResult,
    "generate_project_blueprint": schemas.ProjectBlueprintResult,
    "analyze_feishu_collaboration": schemas.FeishuCollaborationResult,
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
    "summarize_activity": (
        "这是一个跨项目、跨代码托管平台的通用变更摘要任务。优先阅读 files 中的路径、变更统计和 patch，"
        "再结合 title、body 与 metadata，总结实际实现而不是播报 PR 元数据。headline 是简短标题；"
        "implementation 必须说明做了什么；impact、verification、risks 只有输入有依据时才填写；"
        "evidence 的 quote 必须逐字来自 title/body/metadata/files，无法判断的内容列入 insufficient_context。"
    ),
    "generate_project_blueprint": (
        "仔细阅读上传的项目分工计划/需求文档（documents）以及团队成员列表（members），"
        "一次性结构化输出整个项目的完整规划蓝图：\n"
        "1) modules：提炼功能模块（若有明确负责人，必须填写 members 中真实存在的 owner_id）；\n"
        "2) requirements：提炼核心需求条目，关联所属模块名（module）、优先级与原始资料摘录 quote；\n"
        "3) milestones：按周或阶段提炼里程碑（含标题、说明、YYYY-MM-DD 截止日期与可核验交付物 deliverables）；\n"
        "4) tasks：将需求与分工拆解为可执行的模块级任务（建议 8~32 个，避免上百个过碎卡片），"
        "填写 assignee_ids（必须使用 members 中真实 id）、关联 requirement_titles 与 milestone_titles、"
        "可检查的 acceptance_criteria（每条任务至少 1 条），并让所有任务的 weight 合计严格等于 100。"
    ),
    "analyze_feishu_collaboration": (
        "仔细阅读项目飞书群按时间顺序排列的聊天记录（messages）与项目任务列表（tasks），"
        "过滤掉无实质意义的闲聊、吐槽、系统通知和孤立的口头语，把相关的多条对话聚合提炼为清晰的「协作进展与结论」（items，建议 3~15 条，按最新时间倒序排列）：\n"
        "1) 分工与方案确认（category='division_confirm'）：当有人发送分工文档、计划表或设计方案并征求意见，随后多名不同群成员（sender_label 不同）回复「收到」「可以」「OK」「OK了」「没问题」「那就按照这个来吧」等同义确认词时，"
        "判断该分工/方案已达成一致（status='completed'；若仅少数人回复或仍有分歧则为 'in_progress'），标题要直白明了（如「四人分工计划已确认」「多维表格设计方案已达成一致」），confirmed_count 填参与确认的不同成员人数；\n"
        "2) 任务推进与阶段交付（category='task_progress'）：成员同步某模块/文档/周报/ER图/接口/功能已完成、已提交或正在推进；能明确对应 tasks 中任务时，在 task_codes 中填入真实任务编号（如 ['T-003']），不确定则留空数组；\n"
        "3) 文档与规范同步（category='doc_review'）：发送飞书云文档、Wiki、开发规范、提交规范等资料供团队查阅执行；\n"
        "4) 团队决策（category='decision'）：就技术栈、数据库、排期、演示分工等达成的明确共识；\n"
        "5) 阻塞或待跟进事项（category='blocker'）：群内反映的故障、权限卡点、进度风险或待确认问题（status='needs_followup'）。\n"
        "严格约束：每条结论的 message_ids 必须且只能引用输入 messages 中真实存在的 UUID，并包含支撑该结论的完整上下文消息（如发起消息 + 成员讨论 + 收到/OK 确认回复），"
        "以便用户点击详情查看真实聊天记录；严禁编造消息 id 或未发生过的讨论。overview 用 1~2 句话概括群聊整体协作态势。"
    ),
}


def _schema_for(feature: str) -> dict[str, Any]:
    schema = RESULT_MODELS[feature].model_json_schema()
    for name in META_FIELDS:
        schema.get("properties", {}).pop(name, None)
        if name in schema.get("required", []):
            schema["required"].remove(name)
    return schema


def _parse_json_object(content: str) -> dict:
    """容错解析模型输出的 JSON 对象（兼容偶发 Markdown ```json 围栏）。"""
    text = (content or "").strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    result = json.loads(text)
    if not isinstance(result, dict):
        raise ValueError("model did not return a JSON object")
    return result


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
        normalized = (model or "").strip() or DEFAULT_MODEL
        self._model = MODEL_ALIASES.get(normalized.lower(), normalized)
        self._transport = transport
        self.last_usage: dict | None = None

    @property
    def model(self) -> str:
        return self._model

    def generate(self, feature: str, payload: dict[str, Any], *, timeout: float) -> dict:
        if feature not in RESULT_MODELS:
            raise AIUnavailable(f"openrouter provider has no feature {feature}")
        schema_json = json.dumps(_schema_for(feature), ensure_ascii=False)
        if feature == "summarize_activity":
            system = (
                f"{CODE_COMMIT_ANALYSIS_SYSTEM_PROMPT.strip()}\n\n"
                f"输出必须严格符合以下 JSON Schema：{schema_json}"
            )
        else:
            system = (
                "你是软件工程课程项目的助手。只输出一个 JSON 对象，不要输出任何其他文字。"
                "使用中文写理由和说明。你的结果只是建议，会由人确认。\n"
                f"任务：{INSTRUCTIONS[feature]}\n"
                f"输出必须符合这个 JSON Schema：{schema_json}"
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
        if response.status_code == 400:
            err_msg = ""
            try:
                err_msg = str(response.json().get("error", {}).get("message", ""))[:300]
            except Exception:  # noqa: BLE001
                err_msg = response.text[:300]
            logger.warning("OpenRouter 400 for model=%s: %s", self._model, err_msg)
            if "response_format" in err_msg.lower() and "response_format" in body:
                fallback_body = {k: v for k, v in body.items() if k != "response_format"}
                with httpx.Client(
                    base_url=OPENROUTER_BASE, timeout=timeout, transport=self._transport
                ) as client:
                    response = client.post(
                        "/api/v1/chat/completions",
                        json=fallback_body,
                        headers={
                            "Authorization": f"Bearer {self._api_key}",
                            "X-Title": "GroupProof",
                        },
                    )
        response.raise_for_status()
        self.last_usage = self._read_usage(response.json())
        content = response.json()["choices"][0]["message"]["content"]
        return _parse_json_object(content)

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
