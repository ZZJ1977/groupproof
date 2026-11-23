"""A5×A7：通用活动摘要契约，先验证提示词输出边界再接入页面。"""

from uuid import uuid4

import pytest

from app.api.errors import ApiError
from app.modules.a import ai

PROJECT = uuid4()


@pytest.fixture()
def fake(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "fake")
    monkeypatch.setenv("APP_ENV", "test")


def payload():
    return ai.ActivitySummaryInput(
        project_id=PROJECT,
        platform="github",
        record_kind="commit",
        source_revision="r1",
        actor_name="Zijie",
        actor_login="zzj1977",
        occurred_at="2026-11-22T08:00:00Z",
        title="feat: add project overview",
        body="Add a project overview page and connect the project navigation.",
        metadata={"branch": "develop", "sha": "a" * 40},
    )


def test_activity_summary_is_generic_and_keeps_author_context(fake):
    result = ai.summarize_activity(payload())
    assert result.provider == "fake"
    assert result.needs_human_review
    assert result.headline and result.implementation
    assert result.evidence
    assert result.evidence[0].quote in payload().body or result.evidence[0].quote in payload().title


def test_activity_summary_rejects_fabricated_evidence():
    class BadProvider:
        name = "bad"
        model = "bad"
        is_placeholder = False
        last_usage = None

        def generate(self, feature, payload, *, timeout):
            return {
                "headline": "改造完成",
                "implementation": "完成了没有依据的功能",
                "impact": None,
                "verification": [],
                "risks": [],
                "evidence": [{"source": "body", "quote": "这段内容不存在"}],
                "confidence": 0.9,
                "insufficient_context": [],
            }

    with pytest.raises(ApiError) as error:
        ai.summarize_activity(payload(), provider=BadProvider())
    assert error.value.code == "AI_UNAVAILABLE"


def test_activity_summary_accepts_file_evidence_without_project_terms(fake):
    value = payload().model_copy(
        update={
            "body": "",
            "files": [
                ai.ActivityFileChange(
                    path="src/project/overview.tsx",
                    status="added",
                    additions=42,
                    patch="+export function ProjectOverview() {}",
                )
            ],
        }
    )
    result = ai.summarize_activity(value)
    assert result.implementation
    assert result.evidence[0].source in {"files", "title"}


def test_openrouter_uses_code_commit_analysis_system_prompt_and_unwraps_fenced_json():
    import json

    import httpx

    from app.modules.a.ai.openrouter import OpenRouterProvider
    from app.modules.a.ai.prompts import CODE_COMMIT_ANALYSIS_SYSTEM_PROMPT

    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        fenced = (
            "```json\n"
            + json.dumps(
                {
                    "headline": "新增项目总览页面并接入导航",
                    "implementation": "新增了项目总览展示组件并将侧边栏项目导航连接到总览路由。",
                    "impact": "影响学生端项目工作区入口。",
                    "verification": [],
                    "risks": [],
                    "evidence": [
                        {
                            "source": "body",
                            "quote": (
                                "Add a project overview page and connect the project navigation."
                            ),
                        }
                    ],
                    "confidence": 0.85,
                    "insufficient_context": [],
                },
                ensure_ascii=False,
            )
            + "\n```"
        )
        return httpx.Response(200, json={"choices": [{"message": {"content": fenced}}]})

    provider = OpenRouterProvider(
        "sk-test", "openai/gpt-4o-mini", transport=httpx.MockTransport(handler)
    )
    result = ai.summarize_activity(payload(), provider=provider)
    assert result.headline == "新增项目总览页面并接入导航"
    system_msg = seen["body"]["messages"][0]["content"]
    assert "资深软件工程代码评审与功能分析专家" in system_msg
    assert "固定字段输出规范" in system_msg
    assert CODE_COMMIT_ANALYSIS_SYSTEM_PROMPT.strip() in system_msg


def test_activity_summary_tolerates_extra_keys_and_diff_prefix_stripped_quotes():
    class DiffQuotingProvider:
        name = "stub"
        model = "deepseek/deepseek-v3.2"
        is_placeholder = False
        last_usage = None

        def generate(self, feature, payload, *, timeout):
            return {
                "headline": "新增项目总览导出函数",
                "implementation": "在项目总览模块中新增了 ProjectOverview 组件导出。",
                "impact": "",
                "verification": [],
                "risks": [],
                "evidence": [
                    {"source": "files", "quote": "export function ProjectOverview() {}"},
                ],
                "confidence": 0.9,
                "insufficient_context": [],
                "extra_model_note": "ignored harmless field",
            }

    value = payload().model_copy(
        update={
            "files": [
                ai.ActivityFileChange(
                    path="src/project/overview.tsx",
                    status="added",
                    additions=42,
                    patch="+export function ProjectOverview() {}\n",
                )
            ]
        }
    )
    result = ai.summarize_activity(value, provider=DiffQuotingProvider())
    assert result.headline == "新增项目总览导出函数"
    assert result.impact is None
    assert result.evidence[0].source == "files"
