"""A7：OpenRouter 真实 AI 通道和“代码是否实现需求”的分析函数（不访问外网）。"""

from __future__ import annotations

import json
from uuid import uuid4

import httpx
import pytest

from app.api.errors import ApiError
from app.modules.a import ai
from app.modules.a.ai.openrouter import OpenRouterProvider
from app.modules.a.ai.provider import AIUnavailable, get_provider

REQ = uuid4()
CODE = "def export_report(rows):\n    return to_csv(rows)\n"


def analysis_input():
    return ai.ImplementationAnalysisInput(
        project_id=uuid4(),
        requirements=[{"id": REQ, "text": "可以导出周报"}],
        files=[{"path": "app/report.py", "text": CODE}],
    )


class Stub:
    name = "stub"
    is_placeholder = False

    def __init__(self, finding):
        self.finding = finding

    def generate(self, feature, payload, *, timeout):
        return {"findings": [self.finding]}


def finding(**over):
    base = {
        "requirement_id": str(REQ),
        "status": "implemented",
        "confidence": 0.8,
        "reasons": ["有导出函数"],
        "evidence": [{"path": "app/report.py", "quote": "return to_csv(rows)"}],
        "missing": [],
    }
    return {**base, **over}


def test_implementation_accepts_real_quote_ignoring_whitespace():
    result = ai.analyze_implementation(
        analysis_input(),
        provider=Stub(
            finding(evidence=[{"path": "app/report.py", "quote": "return   to_csv(rows)"}])
        ),
    )
    assert result.findings[0].status == "implemented" and result.needs_human_review


@pytest.mark.parametrize(
    "bad",
    [
        finding(evidence=[{"path": "app/report.py", "quote": "def not_there():"}]),
        finding(evidence=[{"path": "app/other.py", "quote": "return to_csv(rows)"}]),
        finding(evidence=[]),
        finding(requirement_id=str(uuid4())),
    ],
)
def test_implementation_rejects_fabricated_findings(bad):
    with pytest.raises(ApiError) as error:
        ai.analyze_implementation(analysis_input(), provider=Stub(bad))
    assert error.value.code == "AI_UNAVAILABLE"


def test_implementation_not_found_needs_no_evidence():
    result = ai.analyze_implementation(
        analysis_input(), provider=Stub(finding(status="not_found", evidence=[]))
    )
    assert result.findings[0].status == "not_found"


def test_fake_implementation_is_unclear(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "fake")
    monkeypatch.setenv("APP_ENV", "test")
    result = ai.analyze_implementation(analysis_input())
    assert result.is_placeholder and result.findings[0].status == "unclear"


def make_provider(handler):
    return OpenRouterProvider("sk-test", "some/model", transport=httpx.MockTransport(handler))


def test_openrouter_sends_key_and_parses_json():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers["authorization"]
        seen["body"] = json.loads(request.content)
        content = json.dumps({"findings": [finding()]})
        return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})

    result = ai.analyze_implementation(analysis_input(), provider=make_provider(handler))
    assert result.provider == "openrouter" and not result.is_placeholder
    assert seen["auth"] == "Bearer sk-test" and seen["body"]["model"] == "some/model"
    assert seen["body"]["response_format"] == {"type": "json_object"}
    schema_text = seen["body"]["messages"][0]["content"]
    assert "needs_human_review" not in schema_text and "is_placeholder" not in schema_text


def test_openrouter_bad_output_and_errors_become_unavailable():
    def not_json(request):
        return httpx.Response(200, json={"choices": [{"message": {"content": "sorry"}}]})

    def rejected(request):
        return httpx.Response(401, json={})

    for handler in (not_json, rejected):
        provider = make_provider(handler)
        with pytest.raises((ApiError, AIUnavailable, ValueError)):
            ai.analyze_implementation(analysis_input(), provider=provider)


def test_get_provider_openrouter(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "openrouter")
    monkeypatch.delenv("AI_API_KEY", raising=False)
    with pytest.raises(AIUnavailable):
        get_provider()
    monkeypatch.setenv("AI_API_KEY", "sk-x")
    monkeypatch.setenv("AI_MODEL", "a/b")
    provider = get_provider()
    assert provider.name == "openrouter" and provider._model == "a/b"
