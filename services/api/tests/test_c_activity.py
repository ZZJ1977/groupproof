"""C4 relational behavior; SQLite is not evidence of PostgreSQL locking."""

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
import test_c_discussions as discussion_tests
import test_c_evidence as evidence_tests
from pydantic import ValidationError
from sqlalchemy import event, func, select

from app.api.errors import ApiError
from app.db.models import ProjectMember, SourceReference, Task
from app.modules.c import activity_service
from app.modules.c.activity_models import ActivityRecordDecision, ActivityRecordState
from app.modules.c.activity_ports import (
    ActivitySourcePage,
    ActivitySourceRecord,
    UnavailableActivitySourcePort,
)
from app.modules.c.activity_schemas import AssociateActivity, DecideActivity
from app.modules.c.activity_service import (
    change_activity,
    get_activity,
    get_activity_history,
    query_activities,
)
from app.modules.c.models import (
    Evidence,
    EvidenceSourceSnapshot,
    IntegrationOutbox,
    RequestIdempotency,
)
from app.modules.c.source_ports import VerifiedSource

db = discussion_tests.db
scope = evidence_tests.scope


class FixtureSources:
    """Explicit A test double, never installed in the real application."""

    def __init__(self, records):
        self.records = {record.id: record for record in records}
        self.calls = []

    def get(self, *, project_id, actor_id, source_type, source_id):
        self.calls.append((project_id, actor_id, source_type, source_id))
        row = self.records.get(source_id)
        if row is None:
            raise ApiError(404, "ACTIVITY_SOURCE_NOT_FOUND", "No such authorized source")
        return row

    def query(self, *, project_id, actor_id, source_type, query):
        self.calls.append(query)
        rows = [
            r
            for r in self.records.values()
            if r.source.project_id == project_id
            and r.source.source_type == source_type
            and (query.include_ids is None or r.id in query.include_ids)
            and r.id not in query.exclude_ids
            and (query.author_id is None or r.author_id == query.author_id)
            and (query.since is None or r.occurred_at >= query.since)
            and (query.until is None or r.occurred_at <= query.until)
            and (query.group_id is None or r.group_id == query.group_id)
            and (query.record_kind is None or r.kind == query.record_kind)
            and (not query.q or query.q.casefold() in (r.title + "\n" + r.summary).casefold())
        ]
        rows.sort(key=lambda r: (-r.occurred_at.timestamp(), str(r.id)))
        offset = (query.page - 1) * query.page_size
        return ActivitySourcePage(tuple(rows[offset : offset + query.page_size]), len(rows))


def source(scope, *, kind="feishu", **overrides):
    source_id = uuid4()
    verified = VerifiedSource(
        scope.project.id,
        kind,
        f"a-canonical-{source_id}",
        "revision-1",
        {"body": "Original authorized source", "external_author": "A verified author"},
        "https://github.com/group/repo/commit/abc"
        if kind == "github"
        else "https://example.feishu.cn/wiki/source",
    )
    row = ActivitySourceRecord(
        source_id,
        "T-1 implementation",
        "Trusted source summary",
        scope.users["member"].id,
        "A verified author",
        datetime.now(UTC),
        "commit" if kind == "github" else "message",
        verified,
    )
    return replace(row, **overrides)


@pytest.fixture()
def sources(scope):
    return FixtureSources([source(scope)])


def first(sources):
    return next(iter(sources.records.values()))


def adopt_command(scope, **changes):
    fields = dict(
        action="adopt",
        expected_version=0,
        reason="Verified original record",
        task_id=scope.task.id,
        criterion_ids=[scope.criterion.id],
    )
    fields.update(changes)
    return DecideActivity(**fields)


def change(db, scope, sources, command=None, *, actor="author", key=None, row=None):
    item = row or first(sources)
    # A savepoint models the request transaction without discarding the test seed.
    with db.begin_nested():
        return change_activity(
            db,
            scope.users[actor],
            scope.project.id,
            item.source.source_type,
            item.id,
            command or adopt_command(scope),
            key or str(uuid4()),
            sources,
        )


def count(db, model):
    return db.scalar(select(func.count()).select_from(model))


def test_adoption_is_candidate_with_authoritative_snapshot_and_atomic_outbox(db, scope, sources):
    result = change(db, scope, sources)
    row = db.get(Evidence, UUID(result["evidence_id"]))
    assert result["status"] == "adopted" and result["lock_version"] == 1
    assert row.status == "candidate" and row.author_id == scope.users["author"].id
    assert row.title == first(sources).title and row.description == first(sources).summary
    snapshot = db.scalar(select(EvidenceSourceSnapshot))
    assert snapshot.content_json["source"] == first(sources).source.content
    history = get_activity_history(
        db, scope.users["author"], scope.project.id, "feishu", first(sources).id
    )
    assert history["decisions"][0]["source_snapshot"]["author_id"] == str(scope.users["member"].id)
    assert {r.event_type for r in db.scalars(select(IntegrationOutbox))} == {
        "activity.adopt",
        "evidence.candidate_created",
    }
    assert scope.task.status == "in_progress"


def test_repeat_adoption_replays_without_provider_and_does_not_duplicate(db, scope, sources):
    item = first(sources)
    result = change(db, scope, sources, key="replay")
    again = change_activity(
        db,
        scope.users["author"],
        scope.project.id,
        "feishu",
        item.id,
        adopt_command(scope),
        "replay",
        UnavailableActivitySourcePort(),
    )
    assert result == again
    assert count(db, Evidence) == count(db, ActivityRecordDecision) == 1
    assert count(db, IntegrationOutbox) == 2


def test_replay_rechecks_membership_before_returning_original(db, scope, sources):
    change(db, scope, sources, key="replay")
    member = db.scalar(
        select(ProjectMember).where(ProjectMember.user_id == scope.users["author"].id)
    )
    member.left_at = datetime.now(UTC)
    db.flush()
    with pytest.raises(ApiError, match="Project access"):
        change(db, scope, sources, key="replay")
    assert count(db, Evidence) == 1


@pytest.mark.parametrize("actor", ["author", "member", "leader", "teacher"])
def test_project_contributors_can_adopt(db, scope, sources, actor):
    assert change(db, scope, sources, actor=actor)["status"] == "adopted"


@pytest.mark.parametrize("actor", ["ta", "outsider", "other_teacher", "admin"])
def test_unauthorized_writers_cannot_call_provider(db, scope, sources, actor):
    with pytest.raises(ApiError) as error:
        change(db, scope, sources, actor=actor)
    assert error.value.status_code == 403 and not sources.calls
    assert count(db, ActivityRecordState) == count(db, Evidence) == 0


@pytest.mark.parametrize("actor", ["author", "member", "leader", "teacher", "ta"])
def test_authorized_reads(db, scope, sources, actor):
    assert (
        query_activities(db, scope.users[actor], scope.project.id, "feishu", sources)["total"] == 1
    )


@pytest.mark.parametrize("actor", ["outsider", "other_teacher", "admin"])
def test_cross_project_read_cannot_leak_total_or_call_provider(db, scope, sources, actor):
    with pytest.raises(ApiError) as error:
        query_activities(db, scope.users[actor], scope.project.id, "feishu", sources)
    assert error.value.status_code == 403 and not sources.calls


@pytest.mark.parametrize(
    "field,value,code",
    [
        ("project", "archived", "PROJECT_READ_ONLY"),
        ("course", "ended", "COURSE_READ_ONLY"),
        ("baseline", "draft", "PROJECT_NOT_READY"),
        ("plan", "draft", "PLAN_NOT_FROZEN"),
        ("task", "not_started", "TASK_STATE_CONFLICT"),
        ("task", "completed", "TASK_STATE_CONFLICT"),
        ("email", None, "EMAIL_NOT_VERIFIED"),
        ("account", "disabled", "ACCOUNT_INACTIVE"),
    ],
)
def test_adoption_respects_execution_guards(db, scope, sources, field, value, code):
    obj, attr = {
        "project": (scope.project, "lifecycle"),
        "course": (scope.course, "status"),
        "baseline": (scope.project, "setup_status"),
        "plan": (scope.plan, "status"),
        "task": (scope.task, "status"),
        "email": (scope.users["author"].email_binding, "verified_at"),
        "account": (scope.users["author"], "status"),
    }[field]
    setattr(obj, attr, value)
    db.flush()
    with pytest.raises(ApiError) as error:
        change(db, scope, sources)
    assert error.value.code == code
    assert (
        count(db, Evidence) == count(db, ActivityRecordState) == count(db, RequestIdempotency) == 0
    )


@pytest.mark.parametrize("binding", ["task", "criterion", "plan"])
def test_task_and_ac_must_belong_to_project_and_confirmed_plan(db, scope, sources, binding):
    fields = {}
    if binding == "task":
        fields["task_id"] = scope.other_task.id
    elif binding == "criterion":
        fields["criterion_ids"] = [scope.other_criterion.id]
    else:
        scope.plan.snapshot_json = {"tasks": []}
        db.flush()
    with pytest.raises(ApiError) as error:
        change(db, scope, sources, adopt_command(scope, **fields))
    assert error.value.code in {"TASK_NOT_FOUND", "CRITERION_TASK_MISMATCH", "TASK_NOT_IN_PLAN"}
    assert count(db, Evidence) == count(db, ActivityRecordState) == 0


def test_ignore_restore_preserves_snapshots_and_version_history(db, scope, sources):
    row = first(sources)
    change(
        db, scope, sources, DecideActivity(action="ignore", reason="Unrelated", expected_version=0)
    )
    original = db.scalar(select(ActivityRecordDecision)).source_snapshot
    sources.records[row.id] = replace(
        row, source=replace(row.source, revision="revision-2", content={"body": "Updated"})
    )
    current = get_activity(db, scope.users["author"], scope.project.id, "feishu", row.id, sources)
    assert current["source_changed"] is True
    restored = change(
        db,
        scope,
        sources,
        DecideActivity(action="restore", reason="Relevant now", expected_version=1),
    )
    assert restored["status"] == "candidate" and restored["lock_version"] == 2
    history = get_activity_history(db, scope.users["teacher"], scope.project.id, "feishu", row.id)
    assert history["decisions"][0]["source_snapshot"] == original
    assert [d["source_revision"] for d in history["decisions"]] == ["revision-1", "revision-2"]
    assert count(db, Evidence) == 0


@pytest.mark.parametrize(
    "action,version", [("restore", 0), ("adopt", 0), ("adopt", 1), ("ignore", 1)]
)
def test_stale_or_invalid_triage_cannot_duplicate_evidence(db, scope, sources, action, version):
    if action != "restore":
        change(db, scope, sources)
    command = (
        adopt_command(scope, expected_version=version)
        if action == "adopt"
        else DecideActivity(action=action, expected_version=version, reason="Retry")
    )
    with pytest.raises(ApiError) as error:
        change(db, scope, sources, command)
    assert error.value.code in {"VERSION_CONFLICT", "ACTIVITY_STATE_CONFLICT"}
    assert count(db, Evidence) == (0 if action == "restore" else 1)


def test_same_key_changed_reason_is_conflict(db, scope, sources):
    change(db, scope, sources, key="fixed")
    with pytest.raises(ApiError) as error:
        change(db, scope, sources, adopt_command(scope, reason="Changed request"), key="fixed")
    assert error.value.code == "IDEMPOTENCY_CONFLICT"


@pytest.mark.parametrize("bad", ["project", "kind", "id", "deleted", "revision", "url", "identity"])
def test_untrusted_or_unavailable_adapter_result_fails_closed(db, scope, sources, bad):
    row = first(sources)
    source_changes = {
        "project": {"project_id": scope.other_project.id},
        "kind": {"source_type": "github"},
        "deleted": {"availability": "deleted"},
        "revision": {"revision": ""},
        "url": {"source_url": "javascript:alert(1)"},
        "identity": {"identity": ""},
    }
    sources.records[row.id] = (
        replace(row, id=uuid4())
        if bad == "id"
        else replace(row, source=replace(row.source, **source_changes[bad]))
    )
    with pytest.raises(ApiError):
        change(db, scope, sources, row=row)
    assert (
        count(db, Evidence) == count(db, ActivityRecordState) == count(db, RequestIdempotency) == 0
    )


@pytest.mark.parametrize(
    "url",
    [
        "http://github.com/group/repo",
        "https://github.com.evil.test/r",
        "https://user@github.com/r",
        "https://github.com:444/r",
    ],
)
def test_github_origin_enforced_even_for_trusted_adapter(db, scope, url):
    row = source(scope, kind="github")
    sources = FixtureSources([replace(row, source=replace(row.source, source_url=url))])
    with pytest.raises(ApiError) as error:
        change(
            db,
            scope,
            sources,
            AssociateActivity(task_id=scope.task.id, expected_version=0, reason="Link"),
        )
    assert error.value.code == "SOURCE_URL_INVALID"


def test_github_manual_association_clear_and_unique_explicit_suggestions(db, scope):
    scope.task.title = "T-1 Implement"
    scope.other_task.title = "T-2 Other project"
    db.flush()
    row = source(scope, kind="github", title="Fix T-1; unrelated #2, T-2, AT-1 and T-12")
    sources = FixtureSources([row])
    dto = get_activity(db, scope.users["author"], scope.project.id, "github", row.id, sources)
    assert dto["suggested_task_ids"] == [str(scope.task.id)]
    linked = change(
        db,
        scope,
        sources,
        AssociateActivity(task_id=scope.task.id, expected_version=0, reason="Confirmed task"),
    )
    assert linked["task_id"] == str(scope.task.id)
    cleared = change(
        db,
        scope,
        sources,
        AssociateActivity(task_id=None, expected_version=1, reason="Wrong relation"),
    )
    assert cleared["task_id"] is None and cleared["lock_version"] == 2
    duplicate = Task(
        id=uuid4(),
        project_id=scope.project.id,
        module_id=scope.task.module_id,
        title="T-1 Duplicate",
    )
    db.add(duplicate)
    db.flush()
    assert (
        get_activity(db, scope.users["author"], scope.project.id, "github", row.id, sources)[
            "suggested_task_ids"
        ]
        == []
    )
    assert count(db, Evidence) == 0


def test_filters_apply_before_pagination_and_totals_include_only_matches(db, scope):
    now = datetime.now(UTC)
    rows = [
        source(scope, occurred_at=now + timedelta(minutes=i), title=f"Record {i} 100%_")
        for i in range(8)
    ]
    sources = FixtureSources(rows)
    for row in rows[:3]:
        change(
            db,
            scope,
            sources,
            DecideActivity(action="ignore", reason="Ignore", expected_version=0),
            row=row,
        )
    for row in rows[3:6]:
        change(
            db,
            scope,
            sources,
            AssociateActivity(task_id=scope.task.id, reason="Link", expected_version=0),
            row=row,
        )
    result = query_activities(
        db,
        scope.users["author"],
        scope.project.id,
        "feishu",
        sources,
        status="candidate",
        task_id=scope.task.id,
        author_id=scope.users["member"].id,
        page=2,
        page_size=2,
        q="100%_",
        since=now,
    )
    assert result["total"] == 3 and [i["source_id"] for i in result["items"]] == [str(rows[3].id)]
    assert set(sources.calls[-1].include_ids) == {r.id for r in rows[3:6]}
    candidates = query_activities(
        db, scope.users["author"], scope.project.id, "feishu", sources, status="candidate"
    )
    assert candidates["total"] == 5
    assert set(sources.calls[-1].exclude_ids) == {r.id for r in rows[:3]}


@pytest.mark.parametrize("case", ["partial", "duplicate", "wrong_filter", "reverse"])
def test_invalid_provider_pages_fail_without_partial_leak(db, scope, case):
    rows = [
        source(scope, title="other", occurred_at=datetime.now(UTC) - timedelta(minutes=i))
        for i in range(2)
    ]

    class InvalidPage(FixtureSources):
        def query(self, **kwargs):
            items = tuple(rows)
            total = 3 if case == "partial" else 2
            if case == "duplicate":
                items = (rows[0], rows[0])
            if case == "reverse":
                items = tuple(reversed(rows))
            return ActivitySourcePage(items, total)

    with pytest.raises(ApiError) as error:
        query_activities(
            db,
            scope.users["author"],
            scope.project.id,
            "feishu",
            InvalidPage(rows),
            q="needle" if case == "wrong_filter" else None,
        )
    assert error.value.code == "ACTIVITY_PAGE_INVALID"


@pytest.mark.parametrize("boundary", ["capture", "outbox", "finish"])
def test_failure_rolls_back_candidate_triage_history_idempotency_and_events(
    db, scope, sources, monkeypatch, boundary
):
    target = {"capture": "capture_evidence", "outbox": "emit_event", "finish": "finish_request"}[
        boundary
    ]
    original = getattr(activity_service, target)

    def fail(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError("Injected transaction failure")

    monkeypatch.setattr(activity_service, target, fail)
    with pytest.raises(RuntimeError):
        change(db, scope, sources)
    for model in [
        Evidence,
        EvidenceSourceSnapshot,
        ActivityRecordState,
        ActivityRecordDecision,
        IntegrationOutbox,
        RequestIdempotency,
    ]:
        assert count(db, model) == 0


@pytest.mark.parametrize(
    "fields",
    [
        {"author_id": str(uuid4())},
        {"source_url": "https://example.test"},
        {"source": {"body": "forged"}},
        {"reason": " "},
        {"expected_version": -1},
        {"task_id": "mock-task-1"},
        {"criterion_ids": []},
    ],
)
def test_commands_forbid_forged_source_metadata_and_invalid_fields(scope, fields):
    with pytest.raises(ValidationError):
        adopt_command(scope, **fields)


def test_default_adapter_is_503_and_does_not_persist(db, scope):
    port = UnavailableActivitySourcePort()
    with pytest.raises(ApiError) as error:
        query_activities(db, scope.users["author"], scope.project.id, "github", port)
    assert error.value.status_code == 503
    with pytest.raises(ApiError), db.begin_nested():
        change_activity(
            db,
            scope.users["author"],
            scope.project.id,
            "feishu",
            uuid4(),
            adopt_command(scope),
            "unavailable",
            port,
        )
    assert (
        count(db, ActivityRecordState) == count(db, Evidence) == count(db, RequestIdempotency) == 0
    )


@pytest.mark.parametrize(
    "field,value",
    [
        ("identity", "x" * 256),
        ("revision", "x" * 256),
        ("identity", 1),
        ("revision", None),
        ("content", []),
        ("content", {"value": float("nan")}),
        ("content", {"value": uuid4()}),
        ("source_reference_id", "mock-id"),
    ],
)
def test_invalid_adapter_metadata_cannot_reach_pg_storage(db, scope, sources, field, value):
    row = first(sources)
    sources.records[row.id] = replace(row, source=replace(row.source, **{field: value}))
    with pytest.raises(ApiError) as error:
        change(db, scope, sources)
    assert error.value.code == "ACTIVITY_SOURCE_INVALID" and error.value.status_code == 503
    assert count(db, Evidence) == count(db, RequestIdempotency) == 0


def test_group_and_kind_filters_are_pushed_down_before_pagination(db, scope):
    rows = [
        replace(source(scope, group_id="group-A"), kind="message"),
        replace(source(scope, group_id="group-A"), kind="document"),
        replace(source(scope, group_id="group-B"), kind="message"),
    ]
    port = FixtureSources(rows)
    result = query_activities(
        db,
        scope.users["author"],
        scope.project.id,
        "feishu",
        port,
        group_id="group-A",
        record_kind="message",
        page_size=1,
    )
    assert result["total"] == 1 and result["items"][0]["source_id"] == str(rows[0].id)
    assert result["items"][0]["group_id"] == "group-A"
    assert port.calls[-1].group_id == "group-A" and port.calls[-1].record_kind == "message"


@pytest.mark.parametrize("with_references", [False, True])
def test_source_query_count_does_not_grow_with_page_size(db, scope, with_references):
    rows = [source(scope) for _ in range(8)]
    if with_references:
        references = [
            SourceReference(id=uuid4(), project_id=scope.project.id, source_type="feishu")
            for _ in rows
        ]
        db.add_all(references)
        db.flush()
        rows = [
            replace(row, source=replace(row.source, source_reference_id=reference.id))
            for row, reference in zip(rows, references, strict=True)
        ]
    port = FixtureSources(rows)
    for row in rows:
        change(
            db,
            scope,
            port,
            DecideActivity(action="ignore", expected_version=0, reason="Triage"),
            row=row,
        )
    statements = []
    db.expunge_all()
    connection = db.connection()

    def trace(_connection, _cursor, statement, _parameters, _context, _executemany):
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement)

    event.listen(connection, "before_cursor_execute", trace)
    try:
        query_activities(db, scope.users["author"], scope.project.id, "feishu", port, page_size=1)
        one = len(statements)
        statements.clear()
        result = query_activities(
            db, scope.users["author"], scope.project.id, "feishu", port, page_size=8
        )
        assert len(result["items"]) == 8 and len(statements) == one
    finally:
        event.remove(connection, "before_cursor_execute", trace)
