"""SQLite relational A inbox fixture, never a production adapter or PG locking proof."""

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
import test_c_discussions as discussion_tests
import test_c_evidence as evidence_tests
from sqlalchemy import JSON, Integer, String, Uuid, select
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from app.api.errors import ApiError
from app.db.models import User
from app.modules.c import inbox_service as service
from app.modules.c.evidence_router import commit_command
from app.modules.c.inbox_ports import ActionItemPage, NotificationPage, UnavailableInboxPort
from app.modules.c.inbox_schemas import (
    ActionItemFilters,
    ActionItemRecord,
    InboxTarget,
    MarkAllNotificationsRead,
    MarkNotificationRead,
    NotificationFilters,
    NotificationReadReceipt,
    NotificationRecord,
)


class FixtureBase(DeclarativeBase):
    pass


class FixtureInbox(FixtureBase):
    __tablename__ = "test_c_inbox_ledger"
    recipient_id: Mapped[UUID] = mapped_column(Uuid, primary_key=True)
    version: Mapped[int] = mapped_column(Integer)
    snapshot_id: Mapped[UUID] = mapped_column(Uuid)


class FixtureNotification(FixtureBase):
    __tablename__ = "test_c_inbox_notification"
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True)
    recipient_id: Mapped[UUID] = mapped_column(Uuid)
    data: Mapped[dict] = mapped_column(JSON)


class FixtureReplay(FixtureBase):
    __tablename__ = "test_c_inbox_replay"
    recipient_id: Mapped[UUID] = mapped_column(Uuid, primary_key=True)
    key: Mapped[str] = mapped_column(String, primary_key=True)
    payload: Mapped[dict] = mapped_column(JSON)
    receipt: Mapped[dict] = mapped_column(JSON)


@pytest.fixture()
def db(monkeypatch):
    monkeypatch.delenv("C_TEST_DATABASE_URL", raising=False)
    fixture = discussion_tests.db.__wrapped__()
    session = next(fixture)
    FixtureBase.metadata.create_all(session.connection())
    try:
        yield session
    finally:
        try:
            next(fixture)
        except StopIteration:
            pass


scope = evidence_tests.scope


class InboxFixture:
    """A contract simulation: real SQL state, replay and read mutation share C's transaction."""

    def __init__(self):
        self.calls = []
        self.bad_receipt = {}
        self.actions = []

    def notifications(self, session, *, recipient_id, filters):
        self.calls.append("list")
        ledger = session.get(FixtureInbox, recipient_id)
        all_rows = [
            NotificationRecord.model_validate(row.data)
            for row in session.scalars(
                select(FixtureNotification).where(FixtureNotification.recipient_id == recipient_id)
            )
        ]
        rows = [
            row
            for row in all_rows
            if (filters.category == "all" or filters.category == row.category)
            and (filters.state == "all" or (filters.state == "read") == (row.read_at is not None))
        ]
        rows.sort(key=lambda row: (-row.created_at.timestamp(), str(row.id)))
        offset = (filters.page - 1) * filters.page_size
        return NotificationPage(
            recipient_id,
            tuple(rows[offset : offset + filters.page_size]),
            len(rows),
            len(all_rows),
            sum(row.read_at is None for row in all_rows),
            ledger.snapshot_id,
            ledger.version,
        )

    def action_items(self, session, *, recipient_id, filters):
        self.calls.append("actions")
        rows = [
            row
            for row in self.actions
            if row.recipient_id == recipient_id
            and (filters.category == "all" or row.category == filters.category)
            and (filters.status == "all" or row.status == filters.status)
        ]
        rows.sort(key=lambda row: (-row.created_at.timestamp(), str(row.id)))
        offset = (filters.page - 1) * filters.page_size
        return ActionItemPage(
            recipient_id, tuple(rows[offset : offset + filters.page_size]), len(rows)
        )

    def mark_read(self, session, *, notification_id, **kwargs):
        return self._read(session, notification_id=notification_id, **kwargs)

    def mark_all_read(self, session, **kwargs):
        return self._read(session, notification_id=None, **kwargs)

    def _read(self, session, *, recipient_id, notification_id, command, idempotency_key):
        self.calls.append("write")
        payload = {
            **command.model_dump(mode="json"),
            "notification_id": str(notification_id) if notification_id else None,
        }
        replay = session.get(FixtureReplay, (recipient_id, idempotency_key))
        if replay:
            if replay.payload != payload:
                raise ApiError(409, "IDEMPOTENCY_CONFLICT", "Different request")
            return NotificationReadReceipt.model_validate(replay.receipt)
        ledger = session.get(FixtureInbox, recipient_id)
        if (
            ledger.version != command.expected_inbox_version
            or ledger.snapshot_id != command.snapshot_id
        ):
            raise ApiError(409, "VERSION_CONFLICT", "Snapshot changed")
        rows = list(
            session.scalars(
                select(FixtureNotification).where(FixtureNotification.recipient_id == recipient_id)
            )
        )
        unread_before = sum(row.data["read_at"] is None for row in rows)
        selected = [row for row in rows if row.id == notification_id] if notification_id else rows
        if notification_id and not selected:
            raise ApiError(404, "NOT_FOUND", "Not this recipient's notification")
        if notification_id and selected[0].data["lock_version"] != command.expected_version:
            raise ApiError(409, "VERSION_CONFLICT", "Notification changed")
        stamp = datetime.now(UTC)
        marked = 0
        for row in selected:
            if row.data["read_at"] is None:
                row.data = {
                    **row.data,
                    "read_at": stamp.isoformat(),
                    "lock_version": row.data["lock_version"] + 1,
                }
                marked += 1
        if marked:
            ledger.version += 1
            ledger.snapshot_id = uuid4()
        receipt = NotificationReadReceipt(
            recipient_id=recipient_id,
            operation="single" if notification_id else "all",
            notification_id=notification_id,
            idempotency_key=idempotency_key,
            snapshot_id=command.snapshot_id,
            expected_version=command.expected_version if notification_id else None,
            expected_inbox_version=command.expected_inbox_version,
            resulting_version=selected[0].data["lock_version"] if notification_id else None,
            resulting_inbox_version=ledger.version,
            total_all=len(rows),
            unread_before=unread_before,
            unread_after=unread_before - marked,
            marked_count=marked,
            read_at=stamp,
        )
        session.add(
            FixtureReplay(
                recipient_id=recipient_id,
                key=idempotency_key,
                payload=payload,
                receipt=receipt.model_dump(mode="json"),
            )
        )
        session.flush()
        return receipt.model_copy(update=self.bad_receipt)


@pytest.fixture()
def inbox(db, scope):
    port = InboxFixture()
    for name in ("author", "outsider"):
        recipient = scope.users[name].id
        db.add(FixtureInbox(recipient_id=recipient, version=3, snapshot_id=uuid4()))
        for i in range(12):
            record = NotificationRecord(
                id=uuid4(),
                recipient_id=recipient,
                category="project" if i % 2 else "course",
                title=f"{name} notice {i}",
                description="A-owned content",
                created_at=datetime.now(UTC) - timedelta(days=i + 1),
                read_at=datetime.now(UTC) if i == 0 else None,
                lock_version=1 if i == 0 else 0,
                target=InboxTarget(kind="task", id=scope.task.id, project_id=scope.project.id),
            )
            db.add(
                FixtureNotification(
                    id=record.id, recipient_id=recipient, data=record.model_dump(mode="json")
                )
            )
        port.actions.append(
            ActionItemRecord(
                id=uuid4(),
                recipient_id=recipient,
                category="verification",
                title=f"{name} action",
                description="Complete in the source workflow",
                status="pending",
                priority="high",
                created_at=datetime.now(UTC),
                due_at=None,
                target=InboxTarget(
                    kind="verification", id=scope.task.id, project_id=scope.project.id
                ),
            )
        )
    db.commit()
    return port


def listing(db, scope, inbox, **filters):
    return service.notifications(db, scope.users["author"], NotificationFilters(**filters), inbox)


def read(db, scope, inbox, *, all_read=False, key="read", item=None, command=None):
    page = listing(db, scope, inbox)
    item = item or next(row for row in page["items"] if row["read_at"] is None)
    command = command or (MarkAllNotificationsRead if all_read else MarkNotificationRead)(
        snapshot_id=page["snapshot_id"],
        expected_inbox_version=page["inbox_version"],
        **({} if all_read else {"expected_version": item["lock_version"]}),
    )
    result = commit_command(
        db,
        lambda: service.mark_read(
            db,
            scope.users["author"],
            command,
            key,
            inbox,
            notification_id=None if all_read else item["id"],
        ),
    )
    return result, item, command


def test_query_counts_pagination_filters_and_structured_destinations(db, scope, inbox):
    page = listing(db, scope, inbox)
    assert page["total"] == page["total_all"] == 12 and page["unread_total"] == 11
    assert len(page["items"]) == 10
    assert all(row["recipient_id"] == scope.users["author"].id for row in page["items"])
    assert len(listing(db, scope, inbox, page=2)["items"]) == 2
    assert listing(db, scope, inbox, state="unread")["total"] == 11
    assert listing(db, scope, inbox, category="project", state="unread")["total"] == 6
    assert page["items"][0]["href"] == f"/projects/{scope.project.id}/tasks/{scope.task.id}"
    actions = service.action_items(db, scope.users["author"], ActionItemFilters(), inbox)
    assert len(actions["items"]) == 1 and actions["items"][0]["href"].endswith("/verification")


@pytest.mark.parametrize("change", ["disabled", "unverified", "deleted"])
@pytest.mark.parametrize("operation", ["list", "actions", "read"])
def test_current_actor_required_before_port_calls(db, scope, inbox, change, operation):
    user = scope.users["author"]
    stale = User(id=user.id, status="active", email_verified_at=datetime.now(UTC))
    if change == "disabled":
        user.status = "disabled"
    elif change == "unverified":
        user.email_verified_at = None
    else:
        stale.id = uuid4()
    db.commit()
    inbox.calls.clear()
    with pytest.raises(ApiError) as error:
        if operation == "list":
            service.notifications(db, stale, NotificationFilters(), inbox)
        elif operation == "actions":
            service.action_items(db, stale, ActionItemFilters(), inbox)
        else:
            service.mark_read(
                db,
                stale,
                MarkAllNotificationsRead(expected_inbox_version=3, snapshot_id=uuid4()),
                "key",
                inbox,
            )
    assert error.value.status_code in (401, 403) and not inbox.calls


@pytest.mark.parametrize(
    "bad",
    [
        "recipient",
        "row_recipient",
        "total",
        "unread",
        "version",
        "snapshot",
        "missing",
        "duplicate",
        "order",
        "filter",
        "target",
    ],
)
def test_malformed_notification_ports_fail_closed(db, scope, inbox, bad):
    original = inbox.notifications

    def malformed(*args, **kwargs):
        page = original(*args, **kwargs)
        changes = {}
        if bad == "recipient":
            changes["recipient_id"] = uuid4()
        if bad == "total":
            changes["total"] = 2
        if bad == "unread":
            changes["unread_total"] = 0
        if bad == "version":
            changes["inbox_version"] = True
        if bad == "snapshot":
            changes["snapshot_id"] = "guess"
        if bad == "missing":
            changes["items"] = page.items[:-1]
        if bad == "duplicate":
            changes["items"] = (page.items[0],) + page.items[:-1]
        if bad == "order":
            changes["items"] = tuple(reversed(page.items))
        if bad in ("row_recipient", "filter", "target"):
            fields = (
                {"recipient_id": uuid4()}
                if bad == "row_recipient"
                else {"read_at": None}
                if bad == "filter"
                else {"target": {"kind": "url", "url": "javascript:alert(1)"}}
            )
            changes["items"] = (page.items[0].model_copy(update=fields),) + page.items[1:]
        return replace(page, **changes)

    inbox.notifications = malformed
    with pytest.raises(ApiError) as error:
        listing(db, scope, inbox, state="read" if bad == "filter" else "all")
    assert error.value.status_code == 503


def test_read_is_atomic_idempotent_and_all_read_covers_other_pages(db, scope, inbox):
    result, item, command = read(db, scope, inbox)
    replay, _, _ = read(db, scope, inbox, item=item, command=command)
    assert replay == result and listing(db, scope, inbox)["unread_total"] == 10
    assert len(list(db.scalars(select(FixtureReplay)))) == 1
    all_result, _, _ = read(db, scope, inbox, all_read=True, key="all")
    assert all_result["marked_count"] == 10 and listing(db, scope, inbox)["unread_total"] == 0
    assert listing(db, scope, inbox, page=2)["items"][0]["read_at"]


def test_stale_versions_cross_recipient_and_key_conflict_cannot_mutate(db, scope, inbox):
    page = listing(db, scope, inbox)
    cmd = MarkNotificationRead(
        snapshot_id=page["snapshot_id"], expected_inbox_version=3, expected_version=0
    )
    other = db.scalar(
        select(FixtureNotification).where(
            FixtureNotification.recipient_id == scope.users["outsider"].id
        )
    )
    with pytest.raises(ApiError) as error:
        read(db, scope, inbox, item={"id": other.id}, command=cmd)
    assert error.value.status_code == 404
    first, item, command = read(db, scope, inbox)
    with pytest.raises(ApiError) as error:
        read(db, scope, inbox, key="stale", item=item, command=command)
    assert error.value.status_code == 409
    with pytest.raises(ApiError) as error:
        read(db, scope, inbox, key="read")
    assert error.value.status_code == 409
    assert listing(db, scope, inbox)["unread_total"] == first["unread_after"]


@pytest.mark.parametrize(
    "bad",
    [
        "recipient_id",
        "notification_id",
        "snapshot_id",
        "operation",
        "idempotency_key",
        "expected_version",
        "expected_inbox_version",
        "resulting_version",
        "resulting_inbox_version",
        "unread_after",
        "total_all",
        "marked_count",
    ],
)
def test_bad_receipt_rolls_back_real_fixture_read_and_replay(db, scope, inbox, bad):
    value = (
        uuid4()
        if bad.endswith("_id")
        else "all"
        if bad == "operation"
        else "other"
        if bad == "idempotency_key"
        else 0
        if bad == "total_all"
        else 90
    )
    inbox.bad_receipt = {bad: value}
    with pytest.raises(ApiError) as error:
        read(db, scope, inbox)
    assert error.value.status_code == 503
    assert listing(db, scope, inbox)["unread_total"] == 11
    assert not list(db.scalars(select(FixtureReplay)))
    inbox.bad_receipt = {}
    read(db, scope, inbox)  # Same key is safe after rollback.


@pytest.mark.parametrize(
    "kind",
    [
        "course",
        "project",
        "task",
        "verification",
        "evidence",
        "discussion",
        "member_change",
        "appeal",
        "baseline",
        "plan",
        "rule_change",
    ],
)
def test_targets_never_accept_external_navigation(kind, scope):
    course_kind = kind in {"course", "member_change", "appeal", "rule_change"}
    identity = (
        scope.project.id
        if kind in {"project", "baseline", "plan"}
        else scope.course.id
        if kind == "course"
        else uuid4()
    )
    target = InboxTarget(
        kind=kind,
        id=identity,
        project_id=None if course_kind else scope.project.id,
        course_id=scope.course.id if course_kind else None,
    )
    assert service.target_href(target).startswith(("/projects/", "/courses/", "/teacher/courses/"))


@pytest.mark.parametrize(
    "category,kind",
    [("appeal", "course"), ("member", "task"), ("verification", "task"), ("evidence", "appeal")],
)
def test_action_category_cannot_point_to_unrelated_workflow(db, scope, inbox, category, kind):
    from pydantic import ValidationError

    target = (
        {
            "kind": kind,
            "id": scope.course.id if kind == "course" else uuid4(),
            "course_id": scope.course.id,
        }
        if kind in {"course", "appeal"}
        else {"kind": kind, "id": scope.task.id, "project_id": scope.project.id}
    )
    with pytest.raises(ValidationError):
        ActionItemRecord.model_validate(
            {**inbox.actions[0].model_dump(), "category": category, "target": target}
        )


@pytest.mark.parametrize(
    "target",
    [
        {"kind": "task", "id": uuid4(), "project_id": uuid4(), "course_id": uuid4()},
        {"kind": "appeal", "id": uuid4(), "project_id": uuid4()},
        {"kind": "baseline", "id": uuid4(), "project_id": uuid4()},
        {"kind": "course", "id": uuid4(), "course_id": uuid4()},
        {"kind": "task", "id": uuid4(), "project_id": uuid4(), "url": "https://evil.test"},
    ],
)
def test_target_scope_and_unknown_fields_are_rejected(target):
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        InboxTarget.model_validate(target)


def test_default_ports_explicitly_unavailable_not_empty_success(db, scope):
    with pytest.raises(ApiError) as error:
        listing(db, scope, UnavailableInboxPort())
    assert error.value.status_code == 503
    with pytest.raises(ApiError):
        service.action_items(db, scope.users["author"], ActionItemFilters(), UnavailableInboxPort())


@pytest.mark.parametrize("state", ["unread", "read"])
def test_filtered_total_must_fit_corresponding_global_count(db, scope, inbox, state):
    original = inbox.notifications

    def malformed(*args, **kwargs):
        page = original(*args, **kwargs)
        return replace(page, total=100, total_all=100, unread_total=1 if state == "unread" else 99)

    inbox.notifications = malformed
    with pytest.raises(ApiError, match="filtered total"):
        listing(db, scope, inbox, category="course", state=state, page_size=1)
