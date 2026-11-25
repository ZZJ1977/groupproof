"""A6 飞书只读同步：客户端分页与令牌、绑定与同步权限、快照幂等、失败不删除、C 活动端口。"""

from __future__ import annotations

import json
from contextlib import nullcontext
from datetime import UTC, datetime
from types import SimpleNamespace

import a_fixtures as fixtures
import httpx
import pytest
from sqlalchemy import select

from app.api.errors import ApiError
from app.modules.a import feishu
from app.modules.a.models import FeishuChatLink, FeishuMessage
from app.modules.a.router import BindFeishuChatRequest, bind_feishu_chat
from app.modules.c.activity_ports import ActivitySourceQuery

db = fixtures.db
scope = fixtures.scope

CHAT = "oc_group1234"
T1 = 1767225600000  # 2026-01-01T00:00:00Z，毫秒
SETTINGS = feishu.FeishuSettings(app_id="cli_test", app_secret="secret-not-real")


def _raw_text(message_id: str, text: str, ms: int, sender: str = "ou_a") -> dict:
    return {
        "message_id": message_id,
        "msg_type": "text",
        "create_time": str(ms),
        "sender": {"id": sender, "sender_type": "user"},
        "body": {"content": json.dumps({"text": text}, ensure_ascii=False)},
        "deleted": False,
    }


def _raw_image(message_id: str, ms: int) -> dict:
    return {
        "message_id": message_id,
        "msg_type": "image",
        "create_time": str(ms),
        "sender": {"id": "ou_b", "sender_type": "user"},
        "body": {"content": "{}"},
        "deleted": False,
    }


def _raw_deleted(message_id: str, ms: int) -> dict:
    return {
        "message_id": message_id,
        "msg_type": "text",
        "create_time": str(ms),
        "sender": {"id": "ou_a", "sender_type": "user"},
        "body": {"content": "{}"},
        "deleted": True,
    }


class FakeReader:
    """按页返回预设的消息；page_token 就是页下标。"""

    def __init__(self, pages):
        self.pages = pages
        self.tokens: list[str | None] = []

    def list_chat_messages(self, chat_id, page_token):
        self.tokens.append(page_token)
        index = int(page_token) if page_token else 0
        items, next_index = self.pages[index]
        return items, (str(next_index) if next_index is not None else None)


class VisibleChatReader:
    def __init__(self, *chat_ids):
        self.chat_ids = chat_ids
        self.calls = 0

    def list_bot_chats(self, page_token):
        assert page_token is None
        self.calls += 1
        return [feishu.FeishuChatItem(chat_id, "测试群") for chat_id in self.chat_ids], None


def link_visible_chat(session, actor, project_id, chat_id):
    return feishu.link_chat(session, actor, project_id, chat_id, VisibleChatReader(chat_id))


def test_binding_api_checks_bot_visibility_but_reuses_existing_link(db, scope, monkeypatch):
    reader = VisibleChatReader("oc_other1234")
    monkeypatch.setattr(feishu, "get_feishu_reader", lambda: reader)
    request = SimpleNamespace(state=SimpleNamespace(request_id="test-request"))

    def bind(actor):
        return bind_feishu_chat(
            scope.project.id, BindFeishuChatRequest(chat_id=CHAT), request, db, actor
        )

    with pytest.raises(ApiError) as denied:
        bind(scope.users["member"])
    assert denied.value.status_code == 403
    assert reader.calls == 0

    with pytest.raises(ApiError) as missing:
        bind(scope.users["leader"])
    assert missing.value.code == "FEISHU_CHAT_NOT_AVAILABLE"
    assert reader.calls == 1
    assert db.scalar(select(FeishuChatLink).where(FeishuChatLink.chat_id == CHAT)) is None

    monkeypatch.setattr(feishu, "get_feishu_reader", lambda: None)
    with pytest.raises(ApiError) as unconfigured:
        bind(scope.users["leader"])
    assert unconfigured.value.status_code == 503

    reader.chat_ids = (CHAT,)
    monkeypatch.setattr(feishu, "get_feishu_reader", lambda: reader)
    assert bind(scope.users["leader"]).data.chat_id == CHAT
    monkeypatch.setattr(feishu, "get_feishu_reader", lambda: None)
    assert bind(scope.users["leader"]).data.chat_id == CHAT
    assert reader.calls == 2


def _items(*raw):
    return [feishu._parse_item(r) for r in raw]


def _port(db_session):
    return feishu.DatabaseFeishuActivityPort(lambda: nullcontext(db_session))


# ------------------------------------------------------------------ 客户端


def _mock_transport(pages, *, token_code=0):
    seen = {"token_calls": 0, "auth": []}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/open-apis/auth/v3/tenant_access_token/internal":
            seen["token_calls"] += 1
            body = json.loads(request.content)
            assert body == {"app_id": "cli_test", "app_secret": "secret-not-real"}
            if token_code:
                return httpx.Response(200, json={"code": token_code, "msg": "bad"})
            return httpx.Response(
                200, json={"code": 0, "tenant_access_token": "t-1", "expire": 7200}
            )
        assert request.url.path == "/open-apis/im/v1/messages"
        seen["auth"].append(request.headers["Authorization"])
        assert request.url.params["container_id_type"] == "chat"
        assert request.url.params["container_id"] == CHAT
        index = int(request.url.params.get("page_token", "0"))
        items, next_index = pages[index]
        data = {"items": items, "has_more": next_index is not None}
        if next_index is not None:
            data["page_token"] = str(next_index)
        return httpx.Response(200, json={"code": 0, "data": data})

    return httpx.MockTransport(handler), seen


def test_client_reads_all_pages_with_one_token():
    raw_page_1 = [_raw_text("om_1", "第一条", T1)]
    raw_page_2 = [_raw_image("om_2", T1 + 1000)]
    transport, seen = _mock_transport([(raw_page_1, 1), (raw_page_2, None)])
    client = feishu.FeishuClient(SETTINGS, transport=transport)

    items, token = client.list_chat_messages(CHAT, None)
    assert [i.message_id for i in items] == ["om_1"] and token == "1"
    items, token = client.list_chat_messages(CHAT, token)
    assert [i.message_id for i in items] == ["om_2"] and token is None
    assert seen["token_calls"] == 1
    assert seen["auth"] == ["Bearer t-1", "Bearer t-1"]


def test_client_bad_credentials_is_503_not_empty_page():
    transport, _ = _mock_transport([([], None)], token_code=10003)
    client = feishu.FeishuClient(SETTINGS, transport=transport)
    with pytest.raises(ApiError) as exc:
        client.list_chat_messages(CHAT, None)
    assert exc.value.status_code == 503
    assert exc.value.code == "FEISHU_UNAVAILABLE"


def test_client_refuses_non_https_base_url():
    with pytest.raises(ValueError):
        feishu.FeishuClient(feishu.FeishuSettings("a", "b", base_url="http://x"))


def test_settings_missing_means_not_connected(monkeypatch):
    monkeypatch.setenv("FEISHU_APP_ID", "cli_x")
    monkeypatch.delenv("FEISHU_APP_SECRET", raising=False)
    assert feishu.feishu_settings() is None
    monkeypatch.setenv("FEISHU_APP_SECRET", "s")
    assert feishu.feishu_settings() is not None


def test_record_resolves_mapped_member_and_falls_back_when_unmapped():
    from uuid import uuid4

    user_id = uuid4()
    pid = uuid4()
    now = datetime(2026, 1, 1, tzinfo=UTC)
    member_map = {"ou_zhuo": (user_id, "卓子杰")}

    mapped_row = FeishuMessage(
        id=uuid4(),
        project_id=pid,
        chat_id=CHAT,
        message_id="om_mapped",
        sender_open_id=" ou_zhuo ",
        sender_type="user",
        msg_type="text",
        text="已完成接口联调",
        content_hash="h1",
        occurred_at=now,
        deleted=False,
        version_no=1,
    )
    mapped_rec = feishu._record(mapped_row, member_map=member_map)
    assert mapped_rec.author_id == user_id
    assert mapped_rec.author_name == "卓子杰"

    unmapped_row = FeishuMessage(
        id=uuid4(),
        project_id=pid,
        chat_id=CHAT,
        message_id="om_unmapped",
        sender_open_id="ou_unknown",
        sender_type="user",
        msg_type="text",
        text="未绑定成员消息",
        content_hash="h2",
        occurred_at=now,
        deleted=False,
        version_no=1,
    )
    unmapped_rec = feishu._record(unmapped_row, member_map=member_map)
    assert unmapped_rec.author_id is None
    assert unmapped_rec.author_name == "飞书成员"

    empty_sender_row = FeishuMessage(
        id=uuid4(),
        project_id=pid,
        chat_id=CHAT,
        message_id="om_empty",
        sender_open_id=None,
        sender_type="user",
        msg_type="text",
        text="无发送者",
        content_hash="h3",
        occurred_at=now,
        deleted=False,
        version_no=1,
    )
    empty_rec = feishu._record(empty_sender_row, member_map=member_map)
    assert empty_rec.author_id is None
    assert empty_rec.author_name == "未知发送者"


# ------------------------------------------------------------------ 绑定与同步


def test_only_project_leader_can_link_and_link_is_idempotent(db, scope):
    with pytest.raises(ApiError) as exc:
        link_visible_chat(db, scope.users["member"], scope.project.id, CHAT)
    assert exc.value.status_code == 403

    with pytest.raises(ApiError) as exc:
        link_visible_chat(db, scope.users["outsider"], scope.project.id, CHAT)
    assert exc.value.status_code == 404

    with pytest.raises(ApiError) as exc:
        link_visible_chat(db, scope.users["leader"], scope.project.id, "not a chat!")
    assert exc.value.status_code == 422

    first = link_visible_chat(db, scope.users["leader"], scope.project.id, CHAT)
    second = link_visible_chat(db, scope.users["leader"], scope.project.id, CHAT)
    assert first.id == second.id
    assert db.scalar(select(FeishuChatLink).where(FeishuChatLink.chat_id == CHAT)) is not None


def test_sync_stores_snapshot_and_is_idempotent(db, scope):
    leader = scope.users["leader"]
    link_visible_chat(db, leader, scope.project.id, CHAT)
    reader = FakeReader(
        [
            (
                _items(_raw_text("om_1", "完成了登录页", T1), _raw_image("om_2", T1 + 1000)),
                1,
            ),
            (_items(_raw_deleted("om_3", T1 + 2000)), None),
        ]
    )

    totals = feishu.sync_project(db, leader, scope.project.id, reader)
    assert totals == {"chats": 1, "created": 3, "updated": 0, "deleted": 1, "seen": 3}
    assert reader.tokens == [None, "1"]

    rows = {
        r.message_id: r
        for r in db.scalars(
            select(FeishuMessage).where(FeishuMessage.project_id == scope.project.id)
        )
    }
    assert rows["om_1"].text == "完成了登录页"
    assert rows["om_2"].text == "[image]"
    assert rows["om_3"].deleted is True and rows["om_3"].text == ""
    assert rows["om_1"].occurred_at == datetime(2026, 1, 1, tzinfo=UTC)

    again = feishu.sync_project(db, leader, scope.project.id, FakeReader(reader.pages))
    assert again["created"] == 0 and again["updated"] == 0


def test_sync_is_leader_only(db, scope):
    link_visible_chat(db, scope.users["leader"], scope.project.id, CHAT)
    reader = FakeReader([([], None)])
    with pytest.raises(ApiError) as exc:
        feishu.sync_project(db, scope.users["member"], scope.project.id, reader)
    assert exc.value.status_code == 403
    assert reader.tokens == []


def test_sync_without_credentials_is_503(db, scope):
    link_visible_chat(db, scope.users["leader"], scope.project.id, CHAT)
    with pytest.raises(ApiError) as exc:
        feishu.sync_project(db, scope.users["leader"], scope.project.id, None)
    assert exc.value.status_code == 503


def test_failed_page_never_marks_messages_deleted(db, scope):
    leader = scope.users["leader"]
    link_visible_chat(db, leader, scope.project.id, CHAT)
    feishu.sync_project(
        db, leader, scope.project.id, FakeReader([(_items(_raw_text("om_1", "原文", T1)), None)])
    )

    class Broken:
        def list_chat_messages(self, chat_id, page_token):
            raise ApiError(503, "FEISHU_UNAVAILABLE", "network")

    with pytest.raises(ApiError):
        feishu.sync_project(db, leader, scope.project.id, Broken())
    row = db.scalar(select(FeishuMessage).where(FeishuMessage.message_id == "om_1"))
    assert row.deleted is False and row.text == "原文"


def test_sync_refuses_to_partially_commit_past_page_cap(db, scope, monkeypatch):
    leader = scope.users["leader"]
    link_visible_chat(db, leader, scope.project.id, CHAT)
    monkeypatch.setattr(feishu, "MAX_PAGES_PER_CHAT", 2)

    endless = FakeReader([([], 1), ([], 2), ([], 3)])
    with pytest.raises(ApiError) as exc:
        feishu.sync_project(db, leader, scope.project.id, endless)
    assert exc.value.status_code == 503


# ------------------------------------------------------------------ C 活动端口


def _seed(db, scope, count=3):
    leader = scope.users["leader"]
    link_visible_chat(db, leader, scope.project.id, CHAT)
    raw = [_raw_text(f"om_{i}", f"消息 {i} 登录", T1 + i * 1000) for i in range(count)]
    feishu.sync_project(db, leader, scope.project.id, FakeReader([(_items(*raw), None)]))


def test_port_pages_newest_first_and_filters_text(db, scope):
    _seed(db, scope, count=3)
    port = _port(db)
    page = port.query(
        project_id=scope.project.id,
        actor_id=scope.users["member"].id,
        source_type="feishu",
        query=ActivitySourceQuery(page=1, page_size=2),
    )
    assert page.total == 3
    assert [r.title for r in page.items] == ["消息 2 登录", "消息 1 登录"]
    assert page.items[0].source.source_type == "feishu"
    assert page.items[0].group_id == CHAT

    hit = port.query(
        project_id=scope.project.id,
        actor_id=scope.users["member"].id,
        source_type="feishu",
        query=ActivitySourceQuery(q="消息 0"),
    )
    assert hit.total == 1


def test_port_outsider_and_other_project_see_nothing(db, scope):
    _seed(db, scope)
    port = _port(db)
    with pytest.raises(ApiError) as exc:
        port.query(
            project_id=scope.project.id,
            actor_id=scope.users["outsider"].id,
            source_type="feishu",
            query=ActivitySourceQuery(),
        )
    assert exc.value.status_code == 404


def test_port_rejects_github_and_returns_empty_for_unmapped_author(db, scope):
    _seed(db, scope)
    port = _port(db)
    actor = scope.users["member"].id
    with pytest.raises(ApiError) as exc:
        port.query(
            project_id=scope.project.id,
            actor_id=actor,
            source_type="github",
            query=ActivitySourceQuery(),
        )
    assert exc.value.status_code == 503

    empty = port.query(
        project_id=scope.project.id,
        actor_id=actor,
        source_type="feishu",
        query=ActivitySourceQuery(author_id=scope.users["member"].id),
    )
    assert empty.total == 0 and empty.items == ()


def test_port_resolves_member_author_and_filters_by_author_id(db, scope):
    leader = scope.users["leader"]
    member = scope.users["member"]
    outsider = scope.users["outsider"]

    leader.name = "卓子杰"
    leader.feishu_account = " ou_leader "
    member.name = "杨凯景"
    member.feishu_account = "ou_member"
    outsider.name = "外组成员"
    outsider.feishu_account = "ou_unmapped"
    db.flush()

    link_visible_chat(db, leader, scope.project.id, CHAT)
    feishu.sync_project(
        db,
        leader,
        scope.project.id,
        FakeReader(
            [
                (
                    _items(
                        _raw_text("om_l", "组长消息", T1, sender="ou_leader"),
                        _raw_text("om_m", "成员消息", T1 + 1000, sender="ou_member"),
                        _raw_text("om_u", "未映射消息", T1 + 2000, sender="ou_unmapped"),
                    ),
                    None,
                )
            ]
        ),
    )

    port = _port(db)
    all_page = port.query(
        project_id=scope.project.id,
        actor_id=member.id,
        source_type="feishu",
        query=ActivitySourceQuery(),
    )
    assert all_page.total == 3
    by_title = {r.title: r for r in all_page.items}
    assert (by_title["组长消息"].author_id, by_title["组长消息"].author_name) == (
        leader.id,
        "卓子杰",
    )
    assert (by_title["成员消息"].author_id, by_title["成员消息"].author_name) == (
        member.id,
        "杨凯景",
    )
    assert (by_title["未映射消息"].author_id, by_title["未映射消息"].author_name) == (
        None,
        "飞书成员",
    )

    leader_detail = port.get(
        project_id=scope.project.id,
        actor_id=member.id,
        source_type="feishu",
        source_id=by_title["组长消息"].id,
    )
    assert (leader_detail.author_id, leader_detail.author_name) == (leader.id, "卓子杰")

    unmapped_detail = port.get(
        project_id=scope.project.id,
        actor_id=member.id,
        source_type="feishu",
        source_id=by_title["未映射消息"].id,
    )
    assert (unmapped_detail.author_id, unmapped_detail.author_name) == (None, "飞书成员")

    leader_only = port.query(
        project_id=scope.project.id,
        actor_id=member.id,
        source_type="feishu",
        query=ActivitySourceQuery(author_id=leader.id),
    )
    assert leader_only.total == 1
    assert [r.title for r in leader_only.items] == ["组长消息"]
    assert leader_only.items[0].author_id == leader.id
    assert leader_only.items[0].author_name == "卓子杰"

    member_only = port.query(
        project_id=scope.project.id,
        actor_id=member.id,
        source_type="feishu",
        query=ActivitySourceQuery(author_id=member.id),
    )
    assert member_only.total == 1
    assert [r.title for r in member_only.items] == ["成员消息"]
    assert member_only.items[0].author_id == member.id
    assert member_only.items[0].author_name == "杨凯景"

    outsider_only = port.query(
        project_id=scope.project.id,
        actor_id=member.id,
        source_type="feishu",
        query=ActivitySourceQuery(author_id=outsider.id),
    )
    assert outsider_only.total == 0 and outsider_only.items == ()


def test_port_empty_include_ids_matches_nothing(db, scope):
    _seed(db, scope)
    page = _port(db).query(
        project_id=scope.project.id,
        actor_id=scope.users["member"].id,
        source_type="feishu",
        query=ActivitySourceQuery(include_ids=()),
    )
    assert page.total == 0 and page.items == ()


def test_port_deleted_message_has_no_content(db, scope):
    leader = scope.users["leader"]
    link_visible_chat(db, leader, scope.project.id, CHAT)
    feishu.sync_project(
        db,
        leader,
        scope.project.id,
        FakeReader(
            [(_items(_raw_text("om_9", "敏感内容", T1), _raw_deleted("om_10", T1 + 1)), None)]
        ),
    )
    port = _port(db)
    page = port.query(
        project_id=scope.project.id,
        actor_id=scope.users["member"].id,
        source_type="feishu",
        query=ActivitySourceQuery(),
    )
    deleted = [r for r in page.items if r.source.availability == "deleted"]
    assert len(deleted) == 1
    assert deleted[0].summary == "" and deleted[0].title == "[已删除的消息]"


# ------------------------------------------------------------------ 绑定时列出机器人所在的群


def _chats_transport(pages):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/open-apis/auth/v3/tenant_access_token/internal":
            return httpx.Response(
                200, json={"code": 0, "tenant_access_token": "t-1", "expire": 7200}
            )
        assert request.url.path == "/open-apis/im/v1/chats"
        assert request.headers["Authorization"] == "Bearer t-1"
        index = int(request.url.params.get("page_token", "0"))
        items, next_index = pages[index]
        data = {"items": items, "has_more": next_index is not None}
        if next_index is not None:
            data["page_token"] = str(next_index)
        return httpx.Response(200, json={"code": 0, "data": data})

    return httpx.MockTransport(handler)


def test_client_lists_bot_chats_across_pages():
    transport = _chats_transport(
        [
            ([{"chat_id": "oc_aaaa1111", "name": "组一"}], 1),
            ([{"chat_id": "oc_bbbb2222", "name": "组二"}, {"name": "无 ID"}], None),
        ]
    )
    client = feishu.FeishuClient(SETTINGS, transport=transport)
    items, token = client.list_bot_chats(None)
    assert [(i.chat_id, i.name) for i in items] == [("oc_aaaa1111", "组一")]
    items, token = client.list_bot_chats(token)
    assert [i.chat_id for i in items] == ["oc_bbbb2222"] and token is None


class _ChatsReader:
    def __init__(self, chats):
        self.chats = chats

    def list_bot_chats(self, page_token):
        return self.chats, None


def test_only_project_leader_can_list_available_chats(db, scope):
    reader = _ChatsReader([feishu.FeishuChatItem(chat_id=CHAT, name="组一")])
    with pytest.raises(ApiError) as exc:
        feishu.list_available_chats(db, scope.users["member"], scope.project.id, reader)
    assert exc.value.status_code == 403

    chats = feishu.list_available_chats(db, scope.users["leader"], scope.project.id, reader)
    assert [c.chat_id for c in chats] == [CHAT]


def test_list_available_chats_without_credentials_is_503(db, scope):
    with pytest.raises(ApiError) as exc:
        feishu.list_available_chats(db, scope.users["leader"], scope.project.id, None)
    assert exc.value.status_code == 503


def test_members_can_see_linked_chats_outsiders_cannot(db, scope):
    link_visible_chat(db, scope.users["leader"], scope.project.id, CHAT)
    links = feishu.list_linked_chats(db, scope.users["member"], scope.project.id)
    assert [link.chat_id for link in links] == [CHAT]
    with pytest.raises(ApiError) as exc:
        feishu.list_linked_chats(db, scope.users["outsider"], scope.project.id)
    assert exc.value.status_code == 404


def test_course_teacher_can_read_linked_chats_but_cannot_write(db, scope):
    link_visible_chat(db, scope.users["leader"], scope.project.id, CHAT)
    teacher = scope.users["teacher"]
    peer = scope.users["peer"]

    # 本课教师可只读查看项目绑定的飞书群元数据
    links = feishu.list_linked_chats(db, teacher, scope.project.id)
    assert [link.chat_id for link in links] == [CHAT]

    # 本课教师不能绑定/同步飞书群（403）
    with pytest.raises(ApiError) as link_err:
        feishu.link_chat(db, teacher, scope.project.id, "oc_other", None)
    assert link_err.value.status_code == 403
    with pytest.raises(ApiError) as sync_err:
        feishu.sync_project(db, teacher, scope.project.id, None)
    assert sync_err.value.status_code == 403

    # 未获授权的非项目成员（同课同学）仍不可读（404）
    with pytest.raises(ApiError) as peer_err:
        feishu.list_linked_chats(db, peer, scope.project.id)
    assert peer_err.value.status_code == 404
