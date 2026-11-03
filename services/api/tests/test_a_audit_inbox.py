"""A4-01 通知、A4-02 操作记录、A4-03 待办，以及 C 收件箱接口的 A 实现。"""

from __future__ import annotations

from uuid import uuid4

import a_fixtures as fixtures
import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from app.api.errors import ApiError
from app.modules.a.audit import list_audit_events, record_audit
from app.modules.a.inbox import (
    DatabaseInboxPort,
    close_action_item,
    close_action_items_by_source,
    create_action_item,
    deliver_pending_emails,
    notify,
)
from app.modules.c import inbox_service
from app.modules.c.inbox_ports import get_inbox_port
from app.modules.c.inbox_schemas import (
    ActionItemFilters,
    MarkAllNotificationsRead,
    MarkNotificationRead,
    NotificationFilters,
)

db = fixtures.db
scope = fixtures.scope


def task_target(scope):
    return {"kind": "task", "id": str(uuid4()), "project_id": str(scope.project.id)}


# ---------------------------------------------------------------- A4-02


def test_record_audit_and_query(db, scope):
    leader = scope.users["leader"]
    event = record_audit(
        db,
        actor=leader,
        action="task.status.changed",
        target=("task", "T-1"),
        project_id=scope.project.id,
        before={"status": "todo"},
        after={"status": "done", "password": "x"},
        reason="完成",
    )
    record_audit(db, actor=None, action="sync.github", target=("project", scope.project.id))
    assert event.after_json == {"status": "done", "password": "[redacted]"}
    page = list_audit_events(db, project_id=scope.project.id)
    assert page.total == 1 and page.items[0].reason == "完成"
    assert list_audit_events(db, action_prefix="sync.").total >= 1
    assert list_audit_events(db, actor_id=leader.id, target=("task", "T-1")).total == 1


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE a_audit_events SET reason = 'x' WHERE id = :id",
        "DELETE FROM a_audit_events WHERE id = :id",
    ],
)
def test_audit_log_is_append_only(db, scope, statement):
    event = record_audit(db, actor=scope.users["leader"], action="x.y", target=("t", "1"))
    savepoint = db.begin_nested()
    with pytest.raises(DBAPIError, match="append-only"):
        db.execute(text(statement), {"id": event.id})
    savepoint.rollback()


def test_record_audit_rejects_bad_input(db, scope):
    with pytest.raises(ValueError):
        record_audit(db, actor=None, action=" ", target=("t", "1"))
    with pytest.raises(ValueError):
        record_audit(db, actor=None, action="a", target=("t", "1"), after={"x": "y" * 30_000})


# ---------------------------------------------------------------- A4-01 / C inbox


def page(db, user, **filters):
    return inbox_service.notifications(
        db, user, NotificationFilters(**filters), DatabaseInboxPort()
    )


def verified(db, user):
    """C 的收件箱要求已验证学校邮箱。"""
    from datetime import UTC, datetime

    from app.auth.models import SchoolEmailBinding

    db.add(
        SchoolEmailBinding(
            user_id=user.id,
            school_email=user.email,
            school_email_normalized=user.email.lower(),
            verified_at=datetime.now(UTC),
        )
    )
    db.flush()
    return user


def test_notify_and_c_inbox_contract(db, scope):
    member = verified(db, scope.users["member"])
    empty = page(db, member)
    assert empty["total"] == 0 and empty["inbox_version"] == 0
    notify(db, recipient=member, category="project", title="A", target=task_target(scope))
    notify(db, recipient=member, category="system", title="B")
    notify(db, recipient=scope.users["leader"], category="system", title="not mine")
    result = page(db, member)
    assert result["total"] == result["unread_total"] == 2
    assert result["inbox_version"] == 2
    assert {item["title"] for item in result["items"]} == {"A", "B"}
    assert page(db, member, category="project")["total"] == 1

    first = result["items"][0]
    receipt = inbox_service.mark_read(
        db,
        member,
        MarkNotificationRead(
            expected_version=first["lock_version"],
            expected_inbox_version=result["inbox_version"],
            snapshot_id=result["snapshot_id"],
        ),
        "key-1",
        DatabaseInboxPort(),
        notification_id=first["id"],
    )
    assert receipt["marked_count"] == 1 and receipt["unread_after"] == 1
    # 同一个 key 重放得到同一张回执
    replay = DatabaseInboxPort().mark_read(
        db,
        recipient_id=member.id,
        notification_id=first["id"],
        command=MarkNotificationRead(
            expected_version=first["lock_version"],
            expected_inbox_version=result["inbox_version"],
            snapshot_id=result["snapshot_id"],
        ),
        idempotency_key="key-1",
    )
    assert replay.model_dump(mode="json")["read_at"] is not None
    assert replay.resulting_inbox_version == receipt["resulting_inbox_version"]

    # 旧快照不能再操作
    with pytest.raises(ApiError) as stale:
        inbox_service.mark_read(
            db,
            member,
            MarkAllNotificationsRead(
                expected_inbox_version=result["inbox_version"], snapshot_id=result["snapshot_id"]
            ),
            "key-2",
            DatabaseInboxPort(),
        )
    assert stale.value.code == "INBOX_SNAPSHOT_STALE"

    fresh = page(db, member)
    done = inbox_service.mark_read(
        db,
        member,
        MarkAllNotificationsRead(
            expected_inbox_version=fresh["inbox_version"], snapshot_id=fresh["snapshot_id"]
        ),
        "key-3",
        DatabaseInboxPort(),
    )
    assert done["marked_count"] == 1 and done["unread_after"] == 0
    assert page(db, member, state="unread")["total"] == 0


def test_cannot_read_other_users_notification(db, scope):
    member = verified(db, scope.users["member"])
    other = notify(db, recipient=scope.users["leader"], category="system", title="secret")
    state = page(db, member)
    with pytest.raises(ApiError) as error:
        inbox_service.mark_read(
            db,
            member,
            MarkNotificationRead(
                expected_version=0,
                expected_inbox_version=state["inbox_version"],
                snapshot_id=state["snapshot_id"],
            ),
            "k",
            DatabaseInboxPort(),
            notification_id=other.id,
        )
    assert error.value.code == "NOTIFICATION_NOT_FOUND"


def test_notify_dedupe_and_validation(db, scope):
    member = scope.users["member"]
    a = notify(db, recipient=member, category="system", title="x", dedupe_key="d1")
    b = notify(db, recipient=member, category="system", title="x", dedupe_key="d1")
    assert a.id == b.id
    with pytest.raises(ValueError):
        notify(db, recipient=member, category="bogus", title="x")
    with pytest.raises(ValueError):
        notify(db, recipient=member, category="project", title="x", target={"kind": "task"})


def test_important_notification_sends_email(db, scope):
    member = scope.users["member"]
    row = notify(db, recipient=member, category="project", title="验收被退回", email=True)
    assert row.email_status == "pending"
    assert deliver_pending_emails(db)["sent"] >= 1
    assert row.email_status == "sent"
    assert row.email_sent_at is not None


def test_c_factory_uses_database_port():
    assert isinstance(get_inbox_port(), DatabaseInboxPort)


# ---------------------------------------------------------------- A4-03


def test_action_items_create_close_and_list(db, scope):
    teacher = verified(db, scope.users["teacher"])
    target = {"kind": "member_change", "id": str(uuid4()), "course_id": str(scope.course.id)}
    item = create_action_item(
        db,
        recipient=teacher,
        category="member",
        title="入组申请待审批",
        target=target,
        source_key="join:1",
        priority="high",
    )
    assert (
        create_action_item(
            db,
            recipient=teacher,
            category="member",
            title="dup",
            target=target,
            source_key="join:1",
        ).id
        == item.id
    )
    listed = inbox_service.action_items(db, teacher, ActionItemFilters(), DatabaseInboxPort())
    assert listed["total"] == 1 and listed["items"][0]["href"].endswith(f"request={target['id']}")
    close_action_item(db, item.id, status="completed", actor=teacher)
    assert item.status == "completed" and item.closed_by == teacher.id
    close_action_item(db, item.id, status="rejected")  # 重复关闭保持原结果
    assert item.status == "completed"
    assert (
        inbox_service.action_items(db, teacher, ActionItemFilters(), DatabaseInboxPort())["total"]
        == 0
    )
    assert (
        inbox_service.action_items(
            db, teacher, ActionItemFilters(status="completed"), DatabaseInboxPort()
        )["total"]
        == 1
    )


def test_close_by_source_closes_everyones_copy(db, scope):
    target = {"kind": "appeal", "id": str(uuid4()), "course_id": str(scope.course.id)}
    for key in ("teacher", "ta"):
        create_action_item(
            db, recipient=scope.users[key], category="appeal", title="申诉", target=target,
            source_key="appeal:1",
        )  # fmt: skip
    assert close_action_items_by_source(db, "appeal:1", actor=scope.users["teacher"]) == 2


def test_action_item_category_must_match_target(db, scope):
    with pytest.raises(ValueError):
        create_action_item(
            db, recipient=scope.users["teacher"], category="appeal", title="x",
            target=task_target(scope),
        )  # fmt: skip
