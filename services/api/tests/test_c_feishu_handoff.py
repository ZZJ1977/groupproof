"""Read A's real persisted Feishu projection through C's normal activity/evidence services."""

from contextlib import nullcontext
from uuid import UUID, uuid4

import pytest
import test_a_feishu as upstream
import test_c_activity as activity
import test_c_evidence as evidence
import test_c_evidence_postgres as postgres
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.api.errors import ApiError
from app.modules.a import feishu
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


def test_short_message_survives_exact_length_adoption_and_later_source_changes(db, scope, port):
    original = "2026-11-11（20261111）：editor@example.org，13812345678，+853 6123 4567。".ljust(
        200, "文"
    )
    sync(db, scope, upstream._raw_text("om_1", original, upstream.T1))
    actor, project = scope.users["author"], scope.project.id
    result = query_activities(db, actor, project, "feishu", port, group_id=upstream.CHAT)
    row = result["items"][0]
    source_id = UUID(row["source_id"])
    assert row["snapshot_complete"] and row["summary"].count("[已脱敏]") == 3
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
    assert candidate.source_changed and changed.content_json["source"]["preview_only"] is True
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


def test_excerpt_can_be_filtered_and_triaged_but_never_persisted_as_candidate(db, scope, port):
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
    with pytest.raises(ApiError) as denied, db.begin_nested():
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
    assert denied.value.code == "SOURCE_SNAPSHOT_INCOMPLETE"
    with pytest.raises(ApiError) as denied, db.begin_nested():
        create_evidence(
            db,
            actor,
            project,
            evidence.command(scope, source_type="feishu", source_id=source_id),
            str(uuid4()),
            WorkspaceEvidenceSources(db, UnavailableSourcePort(), port),
        )
    assert denied.value.code == "SOURCE_SNAPSHOT_INCOMPLETE"
    assert db.scalar(select(Evidence)) is None


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
