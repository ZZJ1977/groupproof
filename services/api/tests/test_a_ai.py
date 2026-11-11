"""A7：AI 中间层与四个 AI 函数（固定假结果版）。"""

from __future__ import annotations

from uuid import uuid4

import pytest

from app.api.errors import ApiError
from app.modules.a import ai
from app.modules.a.ai.provider import AIUnavailable, call_with_retry

PROJECT = uuid4()


def docs_input():
    return ai.RequirementExtractionInput(
        project_id=PROJECT,
        documents=[
            {
                "source_id": uuid4(),
                "title": "需求说明",
                "segments": [{"segment_id": "p1", "text": "学生可以提交周报。"}],
            },
            {
                "source_id": uuid4(),
                "title": "会议记录",
                "segments": [{"segment_id": "p3", "text": "周报改为每两周一次。"}],
            },
        ],
    )


@pytest.fixture()
def fake(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "fake")
    monkeypatch.setenv("APP_ENV", "test")


def test_extract_requirements_cites_sources(fake):
    payload = docs_input()
    result = ai.extract_requirements(payload)
    assert result.is_placeholder and result.provider == "fake" and result.needs_human_review
    assert len(result.requirements) == 2 and len(result.conflicts) == 1
    assert result.requirements[0].sources[0].source_id == payload.documents[0].source_id


def test_suggest_tasks_for_uncovered_requirements(fake):
    covered, missing = uuid4(), uuid4()
    result = ai.suggest_tasks(
        ai.TaskSuggestionInput(
            project_id=PROJECT,
            requirements=[{"id": covered, "title": "登录"}, {"id": missing, "title": "导出"}],
            tasks=[{"id": uuid4(), "title": "做登录", "requirement_ids": [covered]}],
        )
    )
    assert result.uncovered_requirement_ids == [missing]
    assert result.suggestions[0].acceptance_criteria


def test_match_evidence_and_explain_risk(fake):
    criterion = uuid4()
    evidence = uuid4()
    match = ai.match_evidence(
        ai.EvidenceMatchInput(
            project_id=PROJECT,
            criterion={"id": criterion, "text": "可以导出 PDF"},
            evidence=[{"id": evidence, "kind": "pr", "text": "Add PDF export"}],
        )
    )
    assert match.criterion_id == criterion and match.matched_evidence_ids == [evidence]
    risk = ai.explain_risk(
        ai.RiskExplanationInput(
            project_id=PROJECT,
            tasks=[
                {"id": uuid4(), "title": "导出", "status": "doing", "progress_percent": 20,
                 "overdue": True}
            ],
            risks=[{"kind": "deadline", "description": "临近截止", "severity": "medium"}],
        )
    )  # fmt: skip
    assert risk.level == "medium" and risk.suggestions


@pytest.mark.parametrize(
    "provider,env",
    [("", "test"), ("none", "test"), ("openai", "test"), ("fake", "production")],
)
def test_missing_or_disallowed_provider_is_unavailable(monkeypatch, provider, env):
    monkeypatch.setenv("AI_PROVIDER", provider)
    monkeypatch.setenv("APP_ENV", env)
    with pytest.raises(ApiError) as error:
        ai.extract_requirements(docs_input())
    assert (error.value.status_code, error.value.code) == (503, "AI_UNAVAILABLE")


class BadProvider:
    name = "bad"
    is_placeholder = False

    def __init__(self, result):
        self.result = result

    def generate(self, feature, payload, *, timeout):
        return self.result


def test_invented_citations_or_bad_shape_are_rejected():
    invented = {
        "modules": [],
        "requirements": [
            {
                "title": "x",
                "description": "y",
                "module": None,
                "sources": [{"source_id": str(uuid4()), "segment_id": "p9", "quote": "z"}],
            }
        ],
        "conflicts": [],
    }
    for result in (invented, {"unexpected": True}):
        with pytest.raises(ApiError):
            ai.extract_requirements(docs_input(), provider=BadProvider(result))


def test_retry_then_give_up():
    calls = []

    def flaky():
        calls.append(1)
        if len(calls) < 3:
            raise TimeoutError("slow")
        return {"ok": True}

    assert call_with_retry(flaky, sleep=lambda _: None) == {"ok": True}
    calls.clear()
    with pytest.raises(AIUnavailable):
        call_with_retry(lambda: (_ for _ in ()).throw(TimeoutError()), sleep=lambda _: None)
