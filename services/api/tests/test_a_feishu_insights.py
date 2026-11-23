"""A6×A7：飞书群聊 AI 协作结论分析、幻觉过滤、缓存与权限测试。"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import a_fixtures as fixtures
import pytest

from app.api.errors import ApiError
from app.db.models import FunctionalModule, Task
from app.modules.a import ai, feishu_insights
from app.modules.a.ai.provider import FakeProvider
from app.modules.a.models import FeishuAttachment, FeishuMessage

db = fixtures.db
scope = fixtures.scope


def _seed_messages(session, project_id):
    base = datetime(2026, 10, 8, 14, 0, tzinfo=UTC)
    sys_msg = FeishuMessage(
        id=uuid4(),
        project_id=project_id,
        chat_id="oc_collab_01",
        message_id="om_sys_0",
        sender_open_id=None,
        sender_type="app",
        msg_type="system",
        text="[system]",
        content_hash="h0",
        occurred_at=base,
    )
    m1 = FeishuMessage(
        id=uuid4(),
        project_id=project_id,
        chat_id="oc_collab_01",
        message_id="om_div_1",
        sender_open_id="ou_member_1",
        sender_type="user",
        msg_type="file",
        text="[file] GroupProof 四人分工计划（细化版）.pdf 大家看看这个分工可以吗",
        content_hash="h1",
        occurred_at=base + timedelta(minutes=1),
    )
    m2 = FeishuMessage(
        id=uuid4(),
        project_id=project_id,
        chat_id="oc_collab_01",
        message_id="om_div_2",
        sender_open_id="ou_member_2",
        sender_type="user",
        msg_type="text",
        text="收到，可以",
        content_hash="h2",
        occurred_at=base + timedelta(minutes=3),
    )
    m3 = FeishuMessage(
        id=uuid4(),
        project_id=project_id,
        chat_id="oc_collab_01",
        message_id="om_div_3",
        sender_open_id="ou_member_3",
        sender_type="user",
        msg_type="text",
        text="OK了，没问题",
        content_hash="h3",
        occurred_at=base + timedelta(minutes=5),
    )
    session.add_all([sys_msg, m1, m2, m3])
    session.flush()
    session.add(
        FeishuAttachment(
            id=uuid4(),
            message_row_id=m1.id,
            file_key="file_v3_div",
            kind="file",
            name="GroupProof 四人分工计划（细化版）.pdf",
        )
    )
    session.flush()
    return sys_msg, m1, m2, m3


def test_feishu_insights_analyzes_division_confirmation_and_hydrates_chat_messages(db, scope):
    _, m1, m2, m3 = _seed_messages(db, scope.project.id)
    mod = FunctionalModule(id=uuid4(), project_id=scope.project.id, name="模块 A")
    db.add(mod)
    db.flush()
    task = Task(
        id=uuid4(),
        project_id=scope.project.id,
        module_id=mod.id,
        title="完成项目分工规划",
        status="in_progress",
        priority="high",
        weight=10,
        progress_percent=30,
    )
    db.add(task)
    db.flush()

    leader = scope.users["leader"]
    member = scope.users["member"]

    before = feishu_insights.get_collaboration_insights(db, leader, scope.project.id)
    assert before["status"] == "not_generated"
    assert before["total_messages"] == 4
    assert before["analyzed_messages"] == 3  # 过滤了 [system]

    result = feishu_insights.analyze_collaboration_insights(
        db, leader, scope.project.id, provider=FakeProvider()
    )
    assert result["status"] == "ready"
    assert result["needs_human_review"] is True
    assert result["stale"] is False
    assert len(result["items"]) == 1

    item = result["items"][0]
    assert item["category"] == "division_confirm"
    assert item["status"] == "completed"
    assert item["confirmed_count"] >= 2
    assert [m["id"] for m in item["messages"]] == [m1.id, m2.id, m3.id]
    assert [m["sender_label"] for m in item["messages"]] == ["群成员 A", "群成员 B", "群成员 C"]
    assert item["messages"][0]["attachments"][0]["name"] == "GroupProof 四人分工计划（细化版）.pdf"
    assert [t["code"] for t in item["linked_tasks"]] == ["T-001"]

    # 读缓存应与分析结果一致
    cached = feishu_insights.get_collaboration_insights(db, member, scope.project.id)
    assert cached["status"] == "ready"
    assert cached["items"][0]["title"] == item["title"]


def test_feishu_insights_strips_hallucinated_ids_and_respects_cache_and_force(db, scope):
    _, m1, m2, _ = _seed_messages(db, scope.project.id)
    calls = 0

    class StubProvider:
        name = "stub"
        model = "stub-v1"
        is_placeholder = False
        last_usage = None

        def generate(self, feature, payload, *, timeout):
            nonlocal calls
            calls += 1
            return {
                "overview": "群内已完成分工确认。",
                "items": [
                    {
                        "title": "分工计划已确认",
                        "category": "division_confirm",
                        "status": "completed",
                        "summary": "分工 PDF 发出后成员回复确认。",
                        "judgment_basis": "成员 B 回复收到。",
                        "task_codes": ["T-999"],  # 不存在的任务编号，应被剔除
                        "confirmed_count": 2,
                        "message_ids": [str(m2.id), str(uuid4()), str(m1.id)],  # 含编造 ID 且乱序
                        "confidence": 0.92,
                    },
                    {
                        "title": "纯幻觉条目",
                        "category": "decision",
                        "status": "completed",
                        "summary": "没有真实消息支撑",
                        "judgment_basis": "无",
                        "task_codes": [],
                        "confirmed_count": 1,
                        "message_ids": [str(uuid4())],  # 全为编造 ID，整条必须丢弃
                        "confidence": 0.5,
                    },
                ],
            }

    leader = scope.users["leader"]
    provider = StubProvider()
    first = feishu_insights.analyze_collaboration_insights(
        db, leader, scope.project.id, provider=provider
    )
    assert calls == 1
    assert len(first["items"]) == 1
    assert first["items"][0]["linked_tasks"] == []
    # 按真实发送时间先后排序，且剔除了编造 ID
    assert [m["id"] for m in first["items"][0]["messages"]] == [m1.id, m2.id]

    # 相同输入且 force=False 直接命中缓存，不重复调用模型
    second = feishu_insights.analyze_collaboration_insights(
        db, leader, scope.project.id, force=False, provider=provider
    )
    assert calls == 1
    assert second["items"][0]["title"] == "分工计划已确认"

    # force=True 允许重新分析
    feishu_insights.analyze_collaboration_insights(
        db, leader, scope.project.id, force=True, provider=provider
    )
    assert calls == 2

    # 新消息到达后，缓存自动标记 stale=True
    db.add(
        FeishuMessage(
            id=uuid4(),
            project_id=scope.project.id,
            chat_id="oc_collab_01",
            message_id="om_new_4",
            sender_open_id="ou_member_4",
            sender_type="user",
            msg_type="text",
            text="前端接口已经联调完成",
            content_hash="h4",
            occurred_at=datetime(2026, 10, 9, 10, 0, tzinfo=UTC),
        )
    )
    db.flush()
    stale_view = feishu_insights.get_collaboration_insights(db, leader, scope.project.id)
    assert stale_view["stale"] is True


def test_feishu_insights_rejects_outsider(db, scope):
    _seed_messages(db, scope.project.id)
    outsider = scope.users["outsider"]
    with pytest.raises(ApiError) as err:
        feishu_insights.get_collaboration_insights(db, outsider, scope.project.id)
    assert err.value.status_code in (403, 404)

    with pytest.raises(ApiError) as err2:
        feishu_insights.analyze_collaboration_insights(
            db, outsider, scope.project.id, provider=FakeProvider()
        )
    assert err2.value.status_code in (403, 404)


def test_ai_function_analyze_feishu_collaboration_unit():
    msg_id = uuid4()
    payload = ai.FeishuCollaborationInput(
        project_id=uuid4(),
        project_name="GroupProof",
        member_count=4,
        tasks=[ai.CollabTaskBrief(code="T-001", title="分工规划", status="in_progress")],
        messages=[
            ai.CollabMessageBrief(
                id=msg_id,
                occurred_at="2026-10-08T14:00:00Z",
                sender_label="群成员 A",
                msg_type="text",
                text="大家确认一下分工文档",
            )
        ],
    )
    res = ai.analyze_feishu_collaboration(payload, provider=FakeProvider())
    assert res.needs_human_review is True
    assert res.items
    assert res.items[0].message_ids == [msg_id]
