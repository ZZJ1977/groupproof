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
