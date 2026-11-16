"""A5×A7 分析已同步的仓库代码是否实现了需求。

流程：项目成员提交要核对的需求 → 从仓库快照里挑出最相关的文件（受字数预算限制）
→ 交给 AI 判断 → 返回建议。结果只是建议，不写数据库，由人确认。
"""

from __future__ import annotations

import re
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import User
from app.modules.a import ai, permissions
from app.modules.a.models import GithubFile

MAX_CONTEXT_CHARS = 60_000
MAX_FILES = 40
PER_FILE_CHARS = 12_000


def _terms(text: str) -> set[str]:
    lowered = text.lower()
    words = set(re.findall(r"[a-z0-9_]{3,}", lowered))
    for run in re.findall(r"[一-鿿]+", lowered):
        words.update(run[i : i + 2] for i in range(len(run) - 1))
    return words


def select_files(requirements: list[str], files: list[GithubFile]) -> list[ai.CodeFile]:
    """按与需求文字的重合程度挑文件；没有任何重合的文件不送给 AI。"""
    terms: set[str] = set()
    for text in requirements:
        terms |= _terms(text)
    scored = []
    for file in files:
        haystack = f"{file.path}\n{file.text}".lower()
        score = sum(1 for term in terms if term in haystack)
        if score:
            scored.append((score, file))
    scored.sort(key=lambda item: (-item[0], item[1].path))
    chosen: list[ai.CodeFile] = []
    budget = MAX_CONTEXT_CHARS
    for _, file in scored[:MAX_FILES]:
        text = file.text[:PER_FILE_CHARS]
        if len(text) > budget:
            break
        budget -= len(text)
        chosen.append(ai.CodeFile(path=file.path, text=text))
    return chosen


def analyze_project_code(
    session: Session,
    actor: User,
    project_id: UUID,
    requirements: list[ai.ImplRequirement],
    *,
    provider: ai.AIProvider | None = None,
) -> ai.ImplementationAnalysisResult:
    permissions.require_project_member(session, actor, project_id, write=False)
    files = list(session.scalars(select(GithubFile).where(GithubFile.project_id == project_id)))
    if not files:
        raise ApiError(409, "GITHUB_NOT_SYNCED", "还没有读取到代码，请先绑定仓库并同步。")
    chosen = select_files([r.text for r in requirements], files)
    if not chosen:
        raise ApiError(409, "NO_RELEVANT_CODE", "没有找到与这些需求相关的代码文件。")
    return ai.analyze_implementation(
        ai.ImplementationAnalysisInput(
            project_id=project_id, requirements=requirements, files=chosen
        ),
        provider=provider,
        usage=ai.AIUsageContext(user_id=actor.id, project_id=project_id),
    )
