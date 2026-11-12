"""A6 飞书完整消息：脱敏全文、版本、附件引用与核验、C 端口的详情读取。"""

from __future__ import annotations

import hashlib
import json
from contextlib import nullcontext

import a_fixtures as fixtures
import httpx
import pytest
from sqlalchemy import select

from app.api.errors import ApiError
from app.modules.a import feishu
from app.modules.a.models import FeishuAttachment, FeishuMessage, FeishuMessageVersion
from app.modules.a.redaction import redact_text
from app.modules.c.activity_ports import ActivitySourceQuery

db = fixtures.db
scope = fixtures.scope

CHAT = "oc_group1234"
T1 = 1767225600000
LONG = "第一行说明\n" + "很长的内容。" * 300  # 远超 200 字


def raw(message_id, msg_type, content, ms=T1):
    return {
        "message_id": message_id,
        "msg_type": msg_type,
        "create_time": str(ms),
        "sender": {"id": "ou_a", "sender_type": "user"},
        "body": {"content": json.dumps(content, ensure_ascii=False)},
        "deleted": False,
    }


class Reader:
    def __init__(self, *messages, files=None):
        self.messages = list(messages)
        self.files = files or {}
        self.downloads: list[tuple[str, str, str]] = []

    def list_chat_messages(self, chat_id, page_token):
        return [feishu._parse_item(m) for m in self.messages], None

    def download_resource(self, message_id, file_key, resource_type):
        self.downloads.append((message_id, file_key, resource_type))
        if file_key not in self.files:
            raise ApiError(503, "FEISHU_UNAVAILABLE", "gone")
        return self.files[file_key]


def sync(db, scope, reader):
    leader = scope.users["leader"]
    feishu.link_chat(db, leader, scope.project.id, CHAT)
    return feishu.sync_project(db, leader, scope.project.id, reader)


def message(db, scope, message_id):
    return db.scalar(
        select(FeishuMessage).where(
            FeishuMessage.project_id == scope.project.id, FeishuMessage.message_id == message_id
        )
    )


def port(db):
    return feishu.DatabaseFeishuActivityPort(lambda: nullcontext(db))


def test_redaction_masks_personal_data_and_secrets_only():
    text = redact_text(
        "电话 13812345678，邮箱 a.b@school.edu.mo，卡号 4111 1111 1111 1111，"
        "身份证 11010519491231002X，密码：hunter2，key sk-abcdefghijklmnopqrstuv"
    )
    for leaked in (
        "13812345678",
        "a.b@school.edu.mo",
        "4111",
        "11010519491231002X",
        "hunter2",
        "sk-abc",
    ):
        assert leaked not in text
    assert (
        redact_text("T-012 在 2026-11-12 完成，学号 12400254")
        == "T-012 在 2026-11-12 完成，学号 12400254"
    )


def test_long_message_is_stored_in_full_and_redacted(db, scope):
    sync(db, scope, Reader(raw("om_long", "text", {"text": LONG + " 手机 13812345678"})))
    row = message(db, scope, "om_long")
    assert len(row.text) > 1500 and "13812345678" not in row.text and "[手机号]" in row.text


def test_post_message_text_and_images_are_extracted(db, scope):
    body = {
        "zh_cn": {
            "title": "周报",
            "content": [
                [{"tag": "text", "text": "本周完成"}, {"tag": "at", "user_name": "小明"}],
                [{"tag": "img", "image_key": "img_v2_a"}],
            ],
        }
    }
    sync(db, scope, Reader(raw("om_post", "post", body)))
    row = message(db, scope, "om_post")
    assert row.text == "周报\n本周完成@小明\n"[:-1] or row.text.startswith("周报\n本周完成@小明")
    attachments = db.scalars(
        select(FeishuAttachment).where(FeishuAttachment.message_row_id == row.id)
    ).all()
    assert [(a.file_key, a.kind) for a in attachments] == [("img_v2_a", "image")]


def test_edit_creates_a_new_version_and_keeps_history(db, scope):
    reader = Reader(raw("om_1", "text", {"text": "初稿"}))
    sync(db, scope, reader)
    first = message(db, scope, "om_1").content_hash
    reader.messages = [raw("om_1", "text", {"text": "改稿"})]
    totals = feishu.sync_project(db, scope.users["leader"], scope.project.id, reader)
    assert totals["updated"] == 1
    row = message(db, scope, "om_1")
    assert row.version_no == 2 and row.content_hash != first
    versions = db.scalars(
        select(FeishuMessageVersion)
        .where(FeishuMessageVersion.message_row_id == row.id)
        .order_by(FeishuMessageVersion.version_no)
    ).all()
    assert [(v.version_no, v.text) for v in versions] == [(1, "初稿"), (2, "改稿")]
    feishu.sync_project(db, scope.users["leader"], scope.project.id, reader)  # 再同步不新增版本
    assert message(db, scope, "om_1").version_no == 2


def test_port_get_returns_full_text_and_attachments_but_list_stays_short(db, scope):
    reader = Reader(
        raw("om_long", "text", {"text": LONG}, T1),
        raw("om_file", "file", {"file_key": "file_v2_x", "file_name": "报告.pdf"}, T1 + 1000),
    )
    sync(db, scope, reader)
    member = scope.users["member"]
    base = dict(project_id=scope.project.id, actor_id=member.id, source_type="feishu")
    listed = port(db).query(**base, query=ActivitySourceQuery())
    assert all(
        len(i.summary) <= 200 and "attachments" not in i.source.content for i in listed.items
    )

    long_row = message(db, scope, "om_long")
    full = port(db).get(**base, source_id=long_row.id)
    assert full.summary == long_row.text and len(full.summary) > 200
    assert full.source.content["version_no"] == 1 and full.source.revision == long_row.content_hash

    file_row = message(db, scope, "om_file")
    with_file = port(db).get(**base, source_id=file_row.id)
    (item,) = with_file.source.content["attachments"]
    assert (item["file_key"], item["name"], item["verified"]) == ("file_v2_x", "报告.pdf", False)


def test_verify_attachment_records_a_sha256_and_never_rewrites_it(db, scope):
    data = b"hello attachment"
    reader = Reader(
        raw("om_file", "file", {"file_key": "file_v2_x", "file_name": "a.txt"}),
        files={"file_v2_x": data},
    )
    sync(db, scope, reader)
    member = scope.users["member"]
    attachment = db.scalar(select(FeishuAttachment))
    verified = feishu.verify_attachment(db, member, scope.project.id, attachment.id, reader)
    assert verified.content_sha256 == hashlib.sha256(
        data
    ).hexdigest() and verified.size_bytes == len(data)
    assert reader.downloads == [("om_file", "file_v2_x", "file")]
    reader.files["file_v2_x"] = b"replaced"
    again = feishu.verify_attachment(db, member, scope.project.id, attachment.id, reader)
    assert again.content_sha256 == hashlib.sha256(data).hexdigest() and len(reader.downloads) == 1


def test_verify_failure_is_503_and_leaves_attachment_unverified(db, scope):
    reader = Reader(raw("om_file", "file", {"file_key": "file_v2_x"}), files={})
    sync(db, scope, reader)
    attachment = db.scalar(select(FeishuAttachment))
    with pytest.raises(ApiError) as error:
        feishu.verify_attachment(db, scope.users["member"], scope.project.id, attachment.id, reader)
    assert error.value.status_code == 503
    assert attachment.verified_at is None and attachment.content_sha256 is None


def test_detail_and_verify_are_project_members_only(db, scope):
    reader = Reader(raw("om_file", "file", {"file_key": "file_v2_x"}), files={"file_v2_x": b"x"})
    sync(db, scope, reader)
    row = message(db, scope, "om_file")
    attachment = db.scalar(select(FeishuAttachment))
    detail = feishu.get_message_detail(db, scope.users["member"], scope.project.id, row.id)
    assert (
        detail.message.id == row.id and len(detail.versions) == 1 and len(detail.attachments) == 1
    )
    outsider = scope.users["outsider"]
    with pytest.raises(ApiError) as denied:
        feishu.get_message_detail(db, outsider, scope.project.id, row.id)
    assert denied.value.status_code in (403, 404)
    with pytest.raises(ApiError) as denied_verify:
        feishu.verify_attachment(db, outsider, scope.project.id, attachment.id, reader)
    assert denied_verify.value.status_code in (403, 404)
    with pytest.raises(ApiError) as other_project:
        feishu.get_message_detail(db, scope.users["member"], scope.other_project.id, row.id)
    assert other_project.value.status_code in (403, 404)


def test_client_downloads_resource_and_refuses_oversize_or_errors():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("tenant_access_token/internal"):
            return httpx.Response(200, json={"code": 0, "tenant_access_token": "t", "expire": 7200})
        assert request.url.params["type"] == "file"
        if request.url.path.endswith("/file_ok"):
            return httpx.Response(200, content=b"abc")
        return httpx.Response(404)

    client = feishu.FeishuClient(
        feishu.FeishuSettings("id", "secret"), transport=httpx.MockTransport(handler)
    )
    assert client.download_resource("om_1", "file_ok", "file") == b"abc"
    with pytest.raises(ApiError) as missing:
        client.download_resource("om_1", "file_gone", "file")
    assert missing.value.status_code == 503
