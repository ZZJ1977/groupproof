"""A7 AI 用量记录，以及共享日志的操作人角色与结果。"""

from __future__ import annotations

from decimal import Decimal
from uuid import uuid4

import a_fixtures as fixtures
import httpx
import pytest

from app.api.errors import ApiError
from app.modules.a import ai
from app.modules.a.ai import usage as ai_usage
from app.modules.a.ai.openrouter import OpenRouterProvider
from app.modules.a.audit import list_audit_events, record_audit

db = fixtures.db
scope = fixtures.scope

REQ = uuid4()


class Shared:
    """让用量记录写进测试事务（真实代码用独立会话单独提交）。"""

    def __init__(self, session):
        self.session = session

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def add(self, row):
        self.session.add(row)

    def commit(self):
        self.session.flush()


def ctx(db, **kwargs):
    return ai.AIUsageContext(session_factory=lambda: Shared(db), **kwargs)


def requirement_input():
    return ai.RiskExplanationInput(
        project_id=uuid4(),
        tasks=[
            {
                "id": uuid4(),
                "title": "导出",
                "status": "doing",
                "progress_percent": 20,
                "overdue": True,
            }
        ],
        risks=[{"kind": "deadline", "description": "临近截止", "severity": "medium"}],
    )


class Metered:
    name = "stub"
    is_placeholder = False
    model = "stub-model-1"

    def __init__(self, *, fail=False):
        self.fail = fail
        self.last_usage = None

    def generate(self, feature, payload, *, timeout):
        if self.fail:
            raise ai.AIUnavailable("boom")
        self.last_usage = {
            "input_tokens": 120,
            "output_tokens": 45,
            "cost": 0.0021,
            "currency": "USD",
        }
        return {
            "level": "medium",
            "summary": "有逾期风险",
            "explanation": "原因是任务逾期",
            "suggestions": ["拆小任务"],
        }


def test_success_call_records_user_feature_model_tokens_and_cost(db, scope):
    user = scope.users["leader"]
    result = ai.explain_risk(
        requirement_input(),
        provider=Metered(),
        usage=ctx(db, user_id=None, project_id=scope.project.id),
    )
    assert result.needs_human_review
    page = ai_usage.list_ai_usage(db, project_id=scope.project.id)
    assert page.total == 1
    row = page.items[0]
    assert (row.feature, row.provider, row.model, row.success) == (
        "explain_risk",
        "stub",
        "stub-model-1",
        True,
    )
    assert (row.input_tokens, row.output_tokens, row.currency) == (120, 45, "USD")
    assert row.cost == Decimal("0.002100") and row.error_code is None
    assert row.latency_ms is not None and user is not None


def test_failed_call_is_recorded_with_error_code(db, scope):
    with pytest.raises(ApiError) as error:
        ai.explain_risk(
            requirement_input(),
            provider=Metered(fail=True),
            usage=ctx(db, project_id=scope.project.id),
        )
    assert error.value.code == "AI_UNAVAILABLE"
    row = ai_usage.list_ai_usage(db, project_id=scope.project.id).items[0]
    assert row.success is False and row.error_code == "AI_UNAVAILABLE"
    assert row.input_tokens is None and row.cost is None


def test_no_usage_context_records_nothing(db, scope):
    ai.explain_risk(requirement_input(), provider=Metered())
    assert ai_usage.list_ai_usage(db, project_id=scope.project.id).total == 0


def test_recording_failure_never_breaks_the_ai_call():
    def broken():
        raise RuntimeError("database down")

    result = ai.explain_risk(
        requirement_input(),
        provider=Metered(),
        usage=ai.AIUsageContext(session_factory=broken),
    )
    assert result.explanation


def test_summary_groups_by_feature_and_model(db, scope):
    project = scope.project.id
    for fail in (False, False, True):
        try:
            ai.explain_risk(
                requirement_input(),
                provider=Metered(fail=fail),
                usage=ctx(db, project_id=project),
            )
        except ApiError:
            pass
    rows = ai_usage.summarize_ai_usage(db, project_id=project)
    assert len(rows) == 1
    row = rows[0]
    assert (row["feature"], row["model"], row["calls"], row["failures"]) == (
        "explain_risk",
        "stub-model-1",
        3,
        1,
    )
    assert row["input_tokens"] == 240 and row["output_tokens"] == 90
    assert row["cost"] == Decimal("0.004200")


def test_openrouter_reports_tokens_and_cost_from_the_response():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.read() and b'"include":true' in request.content
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": '{"explanation": "x", "suggestions": []}'}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 4, "cost": 0.0005},
            },
        )

    provider = OpenRouterProvider("key", "deepseek/test", transport=httpx.MockTransport(handler))
    provider.generate("explain_risk", {"facts": []}, timeout=5)
    assert provider.model == "deepseek/test"
    assert provider.last_usage == {
        "input_tokens": 10,
        "output_tokens": 4,
        "cost": 0.0005,
        "currency": "USD",
    }


def test_audit_records_actor_role_at_the_time_and_result(db, scope):
    teacher = scope.users["teacher"]
    event = record_audit(
        db, actor=teacher, action="course.updated", target=("course", "C-1"), result="success"
    )
    assert event.actor_role == teacher.global_role and event.result == "success"
    teacher.global_role = "student"  # 之后角色变了，历史不变
    record_audit(
        db,
        actor=teacher.id,
        action="course.update.denied",
        target=("course", "C-1"),
        result="denied",
    )
    system = record_audit(db, actor=None, action="sync.github", target=("project", "P-1"))
    assert system.actor_role is None and system.result == "success"
    assert event.actor_role == "teacher"
    denied = list_audit_events(db, result="denied")
    assert denied.total >= 1 and denied.items[0].actor_role == "student"
    assert list_audit_events(db, actor_role="teacher", action_prefix="course.updated").total == 1
    with pytest.raises(ValueError):
        record_audit(db, actor=None, action="x", target=("a", "b"), result="maybe")
