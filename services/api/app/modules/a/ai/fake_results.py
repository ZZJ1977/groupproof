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


def analyze_implementation(payload: dict[str, Any]) -> dict:
    return {
        "findings": [
            {
                "requirement_id": requirement["id"],
                "status": "unclear",
                "confidence": 0.0,
                "reasons": ["【示例】固定假结果：接入真实 AI 后才会分析代码"],
                "evidence": [],
                "missing": [],
            }
            for requirement in payload["requirements"]
        ]
    }


def summarize_activity(payload: dict[str, Any]) -> dict:
    title = str(payload.get("title") or "这次提交")
    body = " ".join(str(payload.get("body") or "").split())
    files = payload.get("files") or []
    file_names = ", ".join(str(item.get("path")) for item in files[:4] if item.get("path"))
    implementation = body[:560] or (
        f"修改了 {file_names}。" if file_names else "提交说明没有提供足够的实现细节。"
    )
    file_path = next(
        (str(item.get("path")) for item in files if isinstance(item, dict) and item.get("path")),
        "",
    )
    if not body and file_path:
        evidence = {"source": "files", "quote": file_path[:120]}
    elif body:
        evidence = {"source": "body", "quote": body[:120]}
    else:
        evidence = {"source": "title", "quote": title[:120]}
    return {
        "headline": title[:240],
        "implementation": implementation,
        "impact": None,
        "verification": [],
        "risks": [],
        "evidence": [evidence],
        "confidence": 0.5 if body else 0.2,
        "insufficient_context": [] if body else ["提交正文没有说明影响范围或验证结果"],
    }


def generate_project_blueprint(payload: dict[str, Any]) -> dict:
    docs = payload.get("documents") or []
    members = payload.get("members") or []
    first_doc = docs[0] if docs else {}
    first_member_id = members[0]["id"] if members else None
    quote = _quote(str(first_doc.get("text") or "示例分工计划文档"))
    mod_name = "核心功能模块"
    req_title = f"【示例】{first_doc.get('title') or '项目资料'} 核心功能实现"
    ms_title = "第 1 阶段：核心功能交付"
    return {
        "modules": [
            {
                "name": mod_name,
                "description": "根据项目资料自动归纳的功能模块（示例结果，接入真实 AI 后替换）。",
                "owner_id": first_member_id,
            }
        ],
        "requirements": [
            {
                "title": req_title[:240],
                "description": quote,
                "module": mod_name,
                "priority": "high",
                "material_id": first_doc.get("material_id"),
                "quote": quote,
            }
        ],
        "milestones": [
            {
                "title": ms_title,
                "description": "完成阶段需求实现、代码提交与验收准备。",
                "deadline": payload.get("end_date") or "2026-12-03",
                "deliverables": ["核心功能代码提交并关联任务", "完成阶段验收标准核验"],
            }
        ],
        "tasks": [
            {
                "title": f"实现：{req_title}"[:240],
                "description": quote,
                "module": mod_name,
                "requirement_titles": [req_title[:240]],
                "milestone_titles": [ms_title],
                "assignee_ids": [first_member_id] if first_member_id else [],
                "priority": "high",
                "weight": 100,
                "acceptance_criteria": ["核心页面与后端接口联调通过并有真实代码提交记录"],
            }
        ],
        "in_scope": "覆盖上传资料中的全部核心模块与交付需求。",
        "out_of_scope": "未在资料中约定的扩展能力。",
    }


def analyze_feishu_collaboration(payload: dict[str, Any]) -> dict:
    messages = payload.get("messages") or []
    tasks = payload.get("tasks") or []
    if not messages:
        return {
            "overview": "当前暂无可分析的飞书群聊消息。",
            "items": [],
        }

    confirm_tokens = ("收到", "ok", "可以", "没问题", "同意", "确认", "行", "好的")
    division_tokens = ("分工", "计划", "方案", "安排", "排期")

    items: list[dict[str, Any]] = []
    used_ids: set[str] = set()

    for idx, msg in enumerate(messages):
        text_lower = str(msg.get("text") or "").lower()
        if any(tok in text_lower for tok in division_tokens):
            thread_msgs = [msg]
            senders = {msg.get("sender_label")}
            for follow in messages[idx + 1 : idx + 12]:
                ftext = str(follow.get("text") or "").lower()
                if any(tok in ftext for tok in confirm_tokens):
                    thread_msgs.append(follow)
                    senders.add(follow.get("sender_label"))
            ids = [m["id"] for m in thread_msgs]
            used_ids.update(ids)
            confirmed_n = len(senders)
            member_count = int(payload.get("member_count") or 1)
            done = confirmed_n >= min(member_count, 2) and len(thread_msgs) >= 2
            items.append(
                {
                    "title": "团队分工方案已完成确认" if done else "团队分工方案讨论推进中",
                    "category": "division_confirm",
                    "status": "completed" if done else "in_progress",
                    "summary": (
                        f"群内发送分工相关内容「{_quote(msg.get('text', ''))}」后，"
                        f"共有 {confirmed_n} 位成员参与确认。"
                    ),
                    "judgment_basis": (
                        f"发起消息后共检测到 {len(thread_msgs) - 1} 条确认回复（收到/OK/可以等）。"
                    ),
                    "task_codes": [tasks[0]["code"]] if tasks else [],
                    "confirmed_count": confirmed_n,
                    "message_ids": ids,
                    "confidence": 0.9 if done else 0.72,
                }
            )
            break

    remaining = [m for m in messages if m["id"] not in used_ids]
    if remaining and not items:
        sample = remaining[: min(5, len(remaining))]
        senders = {m.get("sender_label") for m in sample}
        items.append(
            {
                "title": f"【示例】群聊协作进展汇总：{payload.get('project_name') or '项目'}",
                "category": "task_progress",
                "status": "in_progress",
                "summary": (
                    f"汇总 {len(sample)} 条群内讨论，"
                    f"首条内容为「{_quote(sample[0].get('text', ''))}」。"
                ),
                "judgment_basis": "固定假结果，接入真实 AI 后按语义自动提炼。",
                "task_codes": [tasks[0]["code"]] if tasks else [],
                "confirmed_count": len(senders),
                "message_ids": [m["id"] for m in sample],
                "confidence": 0.75,
            }
        )

    return {
        "overview": (
            f"共分析 {len(messages)} 条有效群聊消息，识别出 {len(items)} 条协作结论（需人工确认）。"
        ),
        "items": items,
    }


_TRIVIAL_PREFIXES = ("style:", "style(", "format:", "format(", "chore: format", "chore: lint")


def _commit_domain_key(commit: dict[str, Any]) -> str:
    files = commit.get("files") or []
    for raw_path in files:
        path = str(raw_path or "").strip().strip("/")
        if not path:
            continue
        parts = [p for p in path.split("/") if p]
        dir_parts = parts[:-1] if len(parts) > 1 else parts
        if len(dir_parts) >= 3 and dir_parts[0] in {"services", "apps", "packages", "src"}:
            return "/".join(dir_parts[:3])
        if len(dir_parts) >= 2:
            return "/".join(dir_parts[:2])
        return dir_parts[0]
    title = str(commit.get("title") or "").strip().lower()
    if ":" in title:
        prefix = title.split(":", 1)[0].strip()
        if prefix:
            return prefix[:40]
    return "general"


def discover_tasks_from_code(payload: dict[str, Any]) -> dict:
    commits = payload.get("unmatched_commits") or []
    modules = payload.get("modules") or []
    existing_tasks = payload.get("existing_tasks") or []
    members = payload.get("members") or []
    member_ids = {str(m["id"]) for m in members if m.get("id")}
    default_module_id = str(modules[0]["id"]) if modules else None

    grouped: dict[str, list[dict[str, Any]]] = {}
    for commit in commits:
        title = str(commit.get("title") or "").strip()
        title_lower = title.lower()
        eff_lines = int(commit.get("effective_lines") or 0)
        files = commit.get("files") or []
        if any(title_lower.startswith(p) for p in _TRIVIAL_PREFIXES) and eff_lines < 30:
            continue
        if eff_lines < 5 and not files:
            continue
        key = _commit_domain_key(commit)
        grouped.setdefault(key, []).append(commit)

    suggestions: list[dict[str, Any]] = []
    for domain, items in list(grouped.items())[:6]:
        commit_ids = [str(c["id"]) for c in items if c.get("id")]
        if not commit_ids:
            continue
        total_lines = sum(int(c.get("effective_lines") or 0) for c in items)
        assignees: list[str] = []
        for c in items:
            uid = str(c.get("author_user_id") or "")
            if uid and uid in member_ids and uid not in assignees:
                assignees.append(uid)
        if not assignees and members:
            assignees = [str(members[0]["id"])]

        first_title = str(items[0].get("ai_headline") or items[0].get("title") or domain).strip()
        for prefix in ("feat:", "fix:", "chore:", "refactor:"):
            if first_title.lower().startswith(prefix):
                first_title = first_title[len(prefix) :].strip()
        if first_title.lower().startswith("feat(") and "):" in first_title:
            first_title = first_title.split("):", 1)[1].strip()

        # Check whether domain tokens overlap strongly with an existing task for merge/subtask.
        domain_tokens = {
            tok
            for tok in domain.lower().replace("/", " ").replace("_", " ").split()
            if len(tok) > 2
        }
        matched_parent: dict[str, Any] | None = None
        for task in existing_tasks:
            t_blob = f"{task.get('title') or ''} {task.get('description') or ''}".lower()
            if domain_tokens and any(tok in t_blob for tok in domain_tokens):
                matched_parent = task
                break

        action_type = "new_top_level"
        suggested_parent_id = None
        suggested_module_id = default_module_id
        if matched_parent is not None and matched_parent.get("parent_task_id") is None:
            action_type = "new_subtask"
            suggested_parent_id = str(matched_parent["id"])
            suggested_module_id = (
                str(matched_parent.get("module_id") or default_module_id or "") or None
            )

        weight = (
            2 if total_lines < 80 else (3 if total_lines < 220 else (4 if total_lines < 500 else 5))
        )
        sample_files = []
        for c in items:
            for f in c.get("files") or []:
                if f not in sample_files:
                    sample_files.append(str(f))
        files_desc = "、".join(sample_files[:5]) or domain
        title = (first_title or f"补录 {domain} 功能实现")[:180]
        suggestions.append(
            {
                "action_type": action_type,
                "title": title,
                "description": (
                    f"基于 {len(items)} 条未归属代码提交（共约 {total_lines} 行有效变更，"
                    f"涉及 {files_desc}）归纳的演进增补任务草案。"
                )[:2800],
                "acceptance_criteria": [
                    f"「{title[:60]}」核心代码逻辑完整落地并与现有流程兼容",
                    f"补充对应单元测试或运行验证记录并经团队人工验收确认（参考文件：{files_desc[:120]}）",
                ],
                "target_task_id": None,
                "suggested_parent_task_id": suggested_parent_id,
                "suggested_module_id": suggested_module_id,
                "suggested_assignee_ids": assignees[:5],
                "suggested_weight": weight,
                "source_commit_ids": commit_ids[:40],
                "rationale": (
                    f"检测到 {len(items)} 条集中在 `{domain}` 目录的实质代码提交未归属任务，"
                    + (
                        "建议拆分为子任务补录。"
                        if action_type == "new_subtask"
                        else "建议新增顶层增补任务。"
                    )
                ),
                "confidence": 0.78 if len(items) >= 2 else 0.72,
            }
        )
    return {"suggestions": suggestions}
