"""Read A's real persisted Feishu projection through C's normal activity/evidence services."""

import hashlib
import json
from contextlib import nullcontext
from uuid import UUID, uuid4

import pytest
import test_a_feishu as upstream
import test_a_feishu_full as full
import test_c_activity as activity
import test_c_evidence as evidence
import test_c_evidence_postgres as postgres
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.api.errors import ApiError
from app.modules.a import feishu
from app.modules.a.models import FeishuAttachment, FeishuMessage
from app.modules.c.activity_ports import get_activity_source_port
from app.modules.c.activity_schemas import DecideActivity
from app.modules.c.activity_service import change_activity, get_activity, query_activities
from app.modules.c.evidence_schemas import CheckEvidenceSource
from app.modules.c.evidence_service import check_source, create_evidence
from app.modules.c.evidence_sources import WorkspaceEvidenceSources
from app.modules.c.models import Evidence, EvidenceSourceSnapshot
from app.modules.c.source_ports import UnavailableSourcePort

db = activity.db
scope = activity.scope
pg_scope = postgres.pg_scope


@pytest.fixture
def port(db, scope, monkeypatch):
    from app.db import session as sessions

    monkeypatch.setattr(sessions, "SessionLocal", lambda: nullcontext(db))
    feishu.link_chat(db, scope.users["leader"], scope.project.id, upstream.CHAT)
    return get_activity_source_port()


def sync(db, scope, *messages):
    reader = upstream.FakeReader([(upstream._items(*messages), None)])
    feishu.sync_project(db, scope.users["leader"], scope.project.id, reader)


def test_legacy_text_still_matches_the_saved_snapshot_before_upstream_resync(db, scope, port):
    text = "发布者 editor@example.org"
    sync(db, scope, upstream._raw_text("om_legacy", text, upstream.T1))
    row = db.scalar(select(FeishuMessage))
    # Migration 0023 adds a version number without changing the stored text/digest.
    fields = {"text": text, "msg_type": "text", "deleted": False}
    row.text = text
    row.content_hash = hashlib.sha256(
        json.dumps(fields, ensure_ascii=False, sort_keys=True).encode()
    ).hexdigest()
    db.flush()
    record = port.get(
        project_id=scope.project.id,
        actor_id=scope.users["member"].id,
        source_type="feishu",
        source_id=row.id,
    )
    assert record.source.snapshot_complete
    assert record.source.content == {**fields, "text": "发布者 [已脱敏]", "chat_id": upstream.CHAT}


def test_short_message_survives_exact_length_adoption_and_later_source_changes(db, scope, port):
    original = "2026-11-11（20261111）：editor@example.org，13812345678，+853 6123 4567。".ljust(
        200, "文"
    )
    sync(db, scope, upstream._raw_text("om_1", original, upstream.T1))
    actor, project = scope.users["author"], scope.project.id
    result = query_activities(db, actor, project, "feishu", port, group_id=upstream.CHAT)
    row = result["items"][0]
    source_id = UUID(row["source_id"])
    assert row["snapshot_complete"]
    assert all(marker in row["summary"] for marker in ("[邮箱]", "[手机号]", "[已脱敏]"))
    assert "2026-11-11（20261111）" in row["summary"]
    assert row == get_activity(db, actor, project, "feishu", source_id, port)
    assert "13812345678" not in row["title"] and "editor@example.org" not in row["summary"]
    with pytest.raises(ApiError) as hidden_contact:
        query_activities(db, actor, project, "feishu", port, q="13812345678")
    assert hidden_contact.value.code == "INVALID_ACTIVITY_QUERY"
    with pytest.raises(ApiError) as denied:
        query_activities(db, scope.users["outsider"], project, "feishu", port)
    assert denied.value.status_code in {403, 404}

    key = str(uuid4())
    adopted = change_activity(
        db, actor, project, "feishu", source_id, activity.adopt_command(scope), key, port
    )
    assert (
        change_activity(
            db, actor, project, "feishu", source_id, activity.adopt_command(scope), key, port
        )
        == adopted
    )
    candidate = db.get(Evidence, UUID(adopted["evidence_id"]))
    assert candidate.status == "candidate" and candidate.source_reference_id is None
    original_snapshot = db.scalar(select(EvidenceSourceSnapshot))
    assert original_snapshot.content_json["source"]["text"] == row["summary"]

    sync(db, scope, upstream._raw_text("om_1", "会" * 300, upstream.T1))
    sources = WorkspaceEvidenceSources(db, UnavailableSourcePort(), port)
    check_source(
        db,
        actor,
        project,
        candidate.id,
        CheckEvidenceSource(source_id=source_id, expected_version=0, reason="消息已编辑"),
        str(uuid4()),
        sources,
    )
    changed = db.scalar(
        select(EvidenceSourceSnapshot).where(EvidenceSourceSnapshot.version_no == 2)
    )
    assert candidate.source_changed and changed.content_json["source"]["text"] == "会" * 300
    assert changed.content_json["source"]["version_no"] == 2
    assert original_snapshot.content_json["source"]["text"] == row["summary"]
    sync(db, scope, upstream._raw_deleted("om_1", upstream.T1))
    assert get_activity(db, actor, project, "feishu", source_id, port)["availability"] == "deleted"
    check_source(
        db,
        actor,
        project,
        candidate.id,
        CheckEvidenceSource(
            source_id=source_id, expected_version=candidate.lock_version, reason="消息已删除"
        ),
        str(uuid4()),
        sources,
    )
    deleted = db.scalar(
        select(EvidenceSourceSnapshot).where(EvidenceSourceSnapshot.version_no == 3)
    )
    assert deleted.content_json["availability"] == "deleted"


def test_excerpt_search_opens_full_detail_and_both_capture_paths_save_full_text(db, scope, port):
    actor, project = scope.users["author"], scope.project.id
    sync(db, scope, upstream._raw_text("om_long", "工" * 300 + "检查尾部", upstream.T1))
    result = query_activities(db, actor, project, "feishu", port, q="检查尾部")
    assert result["total"] == 1
    row = result["items"][0]
    source_id = UUID(row["source_id"])
    assert row["snapshot_complete"] is False
    assert "检查尾部" not in row["summary"]
    for version, action in enumerate(["ignore", "restore"]):
        change_activity(
            db,
            actor,
            project,
            "feishu",
            source_id,
            DecideActivity(action=action, expected_version=version, reason="核对记录"),
            str(uuid4()),
            port,
        )
    assert not query_activities(db, actor, project, "feishu", port)["items"][0]["source_changed"]
    detail = get_activity(db, actor, project, "feishu", source_id, port)
    assert detail["snapshot_complete"] and detail["summary"].endswith("检查尾部")
    change_activity(
        db,
        actor,
        project,
        "feishu",
        source_id,
        activity.adopt_command(scope, expected_version=2),
        str(uuid4()),
        port,
    )
    create_evidence(
        db,
        actor,
        project,
        evidence.command(scope, source_type="feishu", source_id=source_id),
        str(uuid4()),
        WorkspaceEvidenceSources(db, UnavailableSourcePort(), port),
    )
    snapshots = db.scalars(select(EvidenceSourceSnapshot)).all()
    assert snapshots and all(
        s.content_json["source"]["text"] == detail["summary"] for s in snapshots
    )


def test_attachment_adoption_requires_current_verified_bytes_and_retains_initial_fingerprint(
    db, scope, port
):
    actor, project = scope.users["author"], scope.project.id
    message = full.raw(
        "om_file", "file", {"file_key": "file_one", "file_name": "editor@example.org.pdf"}
    )
    sync(db, scope, message)
    source_id = UUID(query_activities(db, actor, project, "feishu", port)["items"][0]["source_id"])

    def detail():
        return get_activity(db, actor, project, "feishu", source_id, port)

    first = detail()
    assert not first["snapshot_complete"] and first["feishu_attachments"][0]["name"] == "[邮箱]"
    with pytest.raises(ApiError) as denied, db.begin_nested():
        change_activity(
            db,
            actor,
            project,
            "feishu",
            source_id,
            activity.adopt_command(scope),
            str(uuid4()),
            port,
        )
    assert denied.value.code == "SOURCE_SNAPSHOT_INCOMPLETE"
    attachment = db.scalar(select(FeishuAttachment))
    reader = full.Reader(message, files={"file_one": b"first content"})
    feishu.verify_attachment(db, actor, project, attachment.id, reader)
    assert detail()["snapshot_complete"]
    key = str(uuid4())
    adopted = change_activity(
        db, actor, project, "feishu", source_id, activity.adopt_command(scope), key, port
    )
    assert (
        change_activity(
            db, actor, project, "feishu", source_id, activity.adopt_command(scope), key, port
        )
        == adopted
    )
    stored = db.scalar(select(EvidenceSourceSnapshot)).content_json["source"]
    digest = hashlib.sha256(b"first content").hexdigest()
    assert stored["attachments"][0]["sha256"] == digest and stored["attachments"][0]["verified"]
    assert "file_key" not in stored["attachments"][0]
    sync(
        db, scope, full.raw("om_file", "file", {"file_key": "file_two", "file_name": "second.pdf"})
    )
    updated = detail()
    assert updated["source_changed"] and not updated["snapshot_complete"]
    assert [a["name"] for a in updated["feishu_attachments"]] == ["second.pdf"]
    assert stored["attachments"][0]["sha256"] == digest


def test_bound_group_and_local_triage_filter_before_pagination(db, scope, port):
    second_chat = "oc_secondgroup"
    actor, project = scope.users["author"], scope.project.id
    feishu.link_chat(db, scope.users["leader"], project, second_chat)
    assert {chat.chat_id for chat in feishu.list_linked_chats(db, actor, project)} == {
        upstream.CHAT,
        second_chat,
    }

    class GroupReader:
        def list_chat_messages(self, chat_id, page_token):
            assert page_token is None
            return upstream._items(
                *[
                    upstream._raw_text(f"{chat_id}_{n}", f"讨论 {n}", upstream.T1 + n * 1000)
                    for n in range(3)
                ]
            ), None

    feishu.sync_project(db, scope.users["leader"], project, GroupReader())

    def filtered(group, status, **pagination):
        return query_activities(
            db, actor, project, "feishu", port, group_id=group, status=status, **pagination
        )

    group_rows = filtered(upstream.CHAT, "candidate")["items"]
    adopted_id, ignored_id, untouched_id = (UUID(row["source_id"]) for row in group_rows)
    change_activity(
        db, actor, project, "feishu", adopted_id, activity.adopt_command(scope), "adopt-one", port
    )
    change_activity(
        db,
        actor,
        project,
        "feishu",
        ignored_id,
        DecideActivity(action="ignore", expected_version=0, reason="略过"),
        "ignore-one",
        port,
    )
    for status, target in [
        ("candidate", untouched_id),
        ("adopted", adopted_id),
        ("ignored", ignored_id),
    ]:
        page = filtered(upstream.CHAT, status)
        assert page["total"] == 1 and [entry["source_id"] for entry in page["items"]] == [
            str(target)
        ]
    assert filtered(second_chat, "adopted")["total"] == 0
    assert filtered(second_chat, "ignored")["total"] == 0
    page = filtered(second_chat, "candidate", page=2, page_size=2)
    assert page["total"] == 3 and [entry["source_identity"] for entry in page["items"]] == [
        f"{second_chat}_0"
    ]
    change_activity(
        db,
        actor,
        project,
        "feishu",
        ignored_id,
        DecideActivity(action="restore", expected_version=1, reason="继续核对"),
        "restore-one",
        port,
    )
    assert filtered(upstream.CHAT, "ignored")["total"] == 0
    page = filtered(upstream.CHAT, "candidate", page=1, page_size=1)
    assert page["total"] == 2 and page["items"][0]["source_id"] == str(ignored_id)


def test_empty_text_and_attachment_placeholders_are_visible_but_not_evidence(db, scope, port):
    sync(
        db,
        scope,
        upstream._raw_text("om_blank", "  ", upstream.T1),
        upstream._raw_image("om_photo", upstream.T1),
    )
    page = query_activities(db, scope.users["author"], scope.project.id, "feishu", port)
    assert page["total"] == 2
    assert all(not row["snapshot_complete"] for row in page["items"])


def test_postgres_committed_sync_reaches_authorized_member_in_independent_session(
    pg_scope, monkeypatch
):
    from app.db import session as sessions

    engine, scope = pg_scope
    factory = sessionmaker(bind=engine)
    monkeypatch.setattr(sessions, "SessionLocal", factory)
    port = get_activity_source_port()
    with factory.begin() as writer:
        feishu.link_chat(writer, scope.users["leader"], scope.project.id, upstream.CHAT)
        sync(writer, scope, upstream._raw_text("om_pg", "接口验证完成", upstream.T1))
    with factory() as reader:
        page = query_activities(reader, scope.users["member"], scope.project.id, "feishu", port)
        assert page["total"] == 1
        row = page["items"][0]
        assert row["snapshot_complete"] and row["source_identity"] == "om_pg"
        assert row["occurred_at"] == "2026-01-01T00:00:00+00:00"
        with pytest.raises(ApiError) as denied:
            get_activity(
                reader,
                scope.users["outsider"],
                scope.project.id,
                "feishu",
                UUID(row["source_id"]),
                port,
            )
        assert denied.value.status_code in {403, 404}
