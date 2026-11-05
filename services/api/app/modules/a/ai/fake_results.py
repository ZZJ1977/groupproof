"""固定假结果（AI_PROVIDER=fake）。只依赖输入内容，同样的输入得到同样的输出。"""

from __future__ import annotations

from typing import Any


def _quote(text: str) -> str:
    text = " ".join(text.split())
    return text[:120]


def extract_requirements(payload: dict[str, Any]) -> dict:
    requirements = []
    citations = []
    for document in payload["documents"]:
        segment = document["segments"][0]
        citation = {
            "source_id": document["source_id"],
            "segment_id": segment["segment_id"],
            "quote": _quote(segment["text"]),
        }
        citations.append(citation)
        requirements.append(
            {
                "title": f"【示例】{document['title']} 中的需求",
                "description": _quote(segment["text"]),
                "module": "示例模块",
                "sources": [citation],
            }
        )
    conflicts = []
    if len(citations) >= 2:
        conflicts.append(
            {"description": "【示例】两份资料对同一功能的描述可能不一致", "sources": citations[:2]}
        )
    return {
        "modules": [{"name": "示例模块", "description": "固定假结果，接入真实 AI 后替换"}],
        "requirements": requirements,
        "conflicts": conflicts,
    }


def suggest_tasks(payload: dict[str, Any]) -> dict:
    covered = {rid for task in payload.get("tasks", []) for rid in task["requirement_ids"]}
    uncovered = [r for r in payload["requirements"] if r["id"] not in covered]
    return {
        "uncovered_requirement_ids": [r["id"] for r in uncovered],
        "suggestions": [
            {
                "requirement_id": r["id"],
                "title": f"【示例】实现：{r['title']}",
                "description": "固定假结果，接入真实 AI 后替换",
                "acceptance_criteria": [f"{r['title']} 可以在页面上完成并通过演示"],
            }
            for r in uncovered
        ],
    }


def match_evidence(payload: dict[str, Any]) -> dict:
    evidence = payload["evidence"]
    return {
        "criterion_id": payload["criterion"]["id"],
        "verdict": "partial" if evidence else "insufficient",
        "confidence": 0.5 if evidence else 0.0,
        "matched_evidence_ids": [item["id"] for item in evidence[:3]],
        "reasons": ["【示例】固定假结果：证据与标准的匹配需要人工确认"],
        "missing": [] if evidence else ["没有提交任何证据"],
    }


def explain_risk(payload: dict[str, Any]) -> dict:
    overdue = [task for task in payload["tasks"] if task.get("overdue")]
    severities = {risk["severity"] for risk in payload["risks"]}
    level = (
        "high"
        if "high" in severities or len(overdue) >= 3
        else ("medium" if overdue or "medium" in severities else "low")
    )
    return {
        "level": level,
        "summary": f"【示例】{len(overdue)} 个任务逾期，{len(payload['risks'])} 条风险记录",
        "explanation": "固定假结果：根据逾期任务数量和风险等级粗略估计，接入真实 AI 后替换。",
        "suggestions": ["优先处理逾期任务", "在组会上确认负责人和截止时间"],
    }
