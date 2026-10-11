"""Relational service unit tests.

SQLite runs exercise real SQLAlchemy persistence, FKs and rollback, but do not
claim PostgreSQL migration/locking coverage. Set C_TEST_DATABASE_URL to an
already migrated disposable PostgreSQL database for the same service tests.
"""

from __future__ import annotations

import os
from dataclasses import replace
from datetime import UTC, datetime
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError
from sqlalchemy import JSON, MetaData, create_engine, event, func, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.api.errors import ApiError
from app.db.base import Base
from app.db.models import (
    AcceptanceCriterion,
    Course,
    CourseStaff,
    FunctionalModule,
    PlanVersion,
    Project,
    ProjectMember,
    Task,
    User,
)
from app.modules.c import evidence_service
from app.modules.c.evidence_schemas import CheckEvidenceSource, CreateEvidence, DecideEvidence
from app.modules.c.evidence_service import (
    check_source,
    create_evidence,
    decide_evidence,
    evidence_data,
    list_evidence,
)
from app.modules.c.models import (
    Evidence,
    EvidenceDecision,
    EvidenceSourceSnapshot,
    IntegrationOutbox,
    RequestIdempotency,
)
from app.modules.c.source_ports import UnavailableSourcePort, VerifiedSource


@pytest.fixture()
def db():
    url = os.getenv("C_TEST_DATABASE_URL")
    if url:
        engine = create_engine(url)
    else:
        engine = create_engine(
            "sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False}
        )

        @event.listens_for(engine, "connect")
        def enforce_foreign_keys(connection, _):
            connection.execute("PRAGMA foreign_keys=ON")

        # Explicitly a test-only portable schema; production migration stays PG.
        metadata = MetaData()
        names = {
            "users",
            "courses",
            "course_staff",
            "groups",
            "projects",
            "project_members",
            "plan_versions",
            "functional_modules",
            "tasks",
            "acceptance_criteria",
            "source_references",
            "evidence",
            "evidence_criteria",
            "evidence_decisions",
            "evidence_source_snapshots",
            "task_notes",
            "task_note_versions",
            "c_integration_outbox",
            "c_request_idempotency",
        }
        for table in Base.metadata.sorted_tables:
            if table.name in names:
                portable = table.to_metadata(metadata)
                for column in portable.columns:
                    if isinstance(column.type, JSONB):
                        column.type = JSON()
                    if column.server_default is not None and (
                        str(column.server_default.arg) == "gen_random_uuid()"
                    ):
                        column.server_default = None
        metadata.create_all(engine)
    with engine.connect() as connection:
        transaction = connection.begin()
        session = Session(
            connection, expire_on_commit=False, join_transaction_mode="create_savepoint"
        )
        try:
            yield session
        finally:
            session.close()
            transaction.rollback()
    engine.dispose()


@pytest.fixture()
def scope(db):
    users = {}
    for name, role in [
        ("author", "student"),
        ("member", "student"),
        ("leader", "student"),
        ("teacher", "teacher"),
        ("ta", "ta"),
        ("outsider", "student"),
        ("other_teacher", "teacher"),
        ("admin", "admin"),
    ]:
        identity = uuid4()
        users[name] = User(
            id=identity,
            name=name,
            username=f"c-{identity}",
            email=f"{identity}@example.test",
            college="Test",
            global_role=role,
            status="active",
            email_verified_at=datetime.now(UTC),
        )
        db.add(users[name])
    db.flush()
    course = Course(
        id=uuid4(),
        owner_id=users["teacher"].id,
        code=str(uuid4()),
        name="Test course",
        college="Test",
        semester="2026",
        status="active",
    )
    db.add(course)
    db.flush()
    project = Project(
        id=uuid4(),
        course_id=course.id,
        name="Evidence project",
        lifecycle="active",
        setup_status="frozen",
    )
    other_project = Project(
        id=uuid4(),
        course_id=course.id,
        name="Other project",
        lifecycle="active",
        setup_status="frozen",
    )
    db.add_all([project, other_project])
    db.flush()
    for name in ["author", "member", "leader"]:
        db.add(
            ProjectMember(
                id=uuid4(),
                project_id=project.id,
                user_id=users[name].id,
                role="leader" if name == "leader" else "member",
            )
        )
    db.add(
        ProjectMember(
            id=uuid4(), project_id=other_project.id, user_id=users["outsider"].id, role="leader"
        )
    )
    db.add(CourseStaff(course_id=course.id, user_id=users["ta"].id, role="ta"))
    module = FunctionalModule(id=uuid4(), project_id=project.id, name="Main")
    other_module = FunctionalModule(id=uuid4(), project_id=other_project.id, name="Other")
    db.add_all([module, other_module])
    db.flush()
    task = Task(
        id=uuid4(),
        project_id=project.id,
        module_id=module.id,
        title="Implement",
        status="in_progress",
    )
    other_task = Task(
        id=uuid4(), project_id=other_project.id, module_id=other_module.id, title="Other task"
    )
    db.add_all([task, other_task])
    db.flush()
    criterion = AcceptanceCriterion(id=uuid4(), task_id=task.id, criterion_key="AC1", text="Works")
    other_criterion = AcceptanceCriterion(
        id=uuid4(), task_id=other_task.id, criterion_key="AC1", text="Other"
    )
    db.add_all([criterion, other_criterion])
    plan = PlanVersion(
        id=uuid4(),
        project_id=project.id,
        version_no=1,
        created_by=users["leader"].id,
        status="frozen",
        snapshot_json={"tasks": [str(task.id)]},
    )
    db.add(plan)
    db.flush()
    return SimpleNamespace(
        users=users,
        course=course,
        project=project,
        task=task,
        other_project=other_project,
        other_task=other_task,
        criterion=criterion,
        other_criterion=other_criterion,
        plan=plan,
    )


def command(scope, **overrides):
    fields = dict(
        task_id=scope.task.id,
        title="Implementation",
        description="Manually supplied proof",
        source_type="manual",
        criterion_ids=[scope.criterion.id],
    )
    fields.update(overrides)
    return CreateEvidence(**fields)


def candidate(db, scope, **overrides):
    return create_evidence(
        db,
        scope.users["author"],
        scope.project.id,
        command(scope, **overrides),
        str(uuid4()),
        UnavailableSourcePort(),
    )


def decide(db, scope, row, *, actor="author", decision="adopted", version=None, key=None):
    return decide_evidence(
        db,
        scope.users[actor],
        scope.project.id,
        UUID(row["id"]),
        DecideEvidence(
            expected_version=row["lock_version"] if version is None else version,
            reason="Reviewed against the acceptance criterion.",
        ),
        key or str(uuid4()),
        decision=decision,
    )


def count(db, model):
    return db.scalar(select(func.count()).select_from(model))


def test_candidate_adopt_withdraw_preserves_history_and_atomic_events(db, scope):
    created = candidate(db, scope)
    assert created["status"] == "candidate"
    assert (
        list_evidence(db, scope.users["teacher"], scope.project.id, effective_only=True)["total"]
        == 0
    )
    adopted = decide(db, scope, created)
    assert adopted["status"] == "formal" and adopted["lock_version"] == 1
    assert (
        list_evidence(db, scope.users["teacher"], scope.project.id, effective_only=True)["total"]
        == 1
    )
    withdrawn = decide(db, scope, adopted, decision="withdrawn", actor="leader")
    assert withdrawn["status"] == "withdrawn"
    assert (
        list_evidence(db, scope.users["teacher"], scope.project.id, effective_only=True)["total"]
        == 0
    )
    history = evidence_data(db, db.get(Evidence, UUID(created["id"])), history=True)
    assert len(history["decisions"]) == 3 and len(history["source_snapshots"]) == 1
    assert count(db, IntegrationOutbox) == 3


@pytest.mark.parametrize("actor", ["author", "leader", "teacher"])
def test_only_allowed_decision_actors_can_adopt(db, scope, actor):
    assert decide(db, scope, candidate(db, scope), actor=actor)["status"] == "formal"


@pytest.mark.parametrize("actor", ["member", "ta", "outsider", "other_teacher", "admin"])
def test_unauthorized_decision_does_not_create_history_or_events(db, scope, actor):
    row = candidate(db, scope)
    with pytest.raises(ApiError) as error:
        with db.begin_nested():
            decide(db, scope, row, actor=actor)
    assert error.value.status_code == 403
    assert count(db, EvidenceDecision) == 1 and count(db, IntegrationOutbox) == 1


def test_idempotency_replays_exact_result_and_rejects_different_body(db, scope):
    data = command(scope)
    first = create_evidence(
        db, scope.users["author"], scope.project.id, data, "create-once", UnavailableSourcePort()
    )
    assert (
        create_evidence(
            db,
            scope.users["author"],
            scope.project.id,
            data,
            "create-once",
            UnavailableSourcePort(),
        )
        == first
    )
    assert count(db, Evidence) == count(db, IntegrationOutbox) == 1
    with pytest.raises(ApiError, match="different request"):
        with db.begin_nested():
            create_evidence(
                db,
                scope.users["author"],
                scope.project.id,
                command(scope, title="different"),
                "create-once",
                UnavailableSourcePort(),
            )


def test_decision_replay_precedes_stale_version_check(db, scope):
    row = candidate(db, scope)
    adopted = decide(db, scope, row, key="adopt-once")
    assert decide(db, scope, row, key="adopt-once") == adopted
    assert count(db, EvidenceDecision) == 2
    with pytest.raises(ApiError) as error:
        with db.begin_nested():
            decide(db, scope, row, key="another-command")
    assert error.value.code == "VERSION_CONFLICT"


def test_cross_project_task_and_criterion_are_rejected(db, scope):
    for field in [{"task_id": scope.other_task.id}, {"criterion_ids": [scope.other_criterion.id]}]:
        with pytest.raises(ApiError):
            with db.begin_nested():
                candidate(db, scope, **field)
    assert count(db, Evidence) == 0


def test_candidate_without_criteria_cannot_be_submitted(db, scope):
    with pytest.raises(ValidationError):
        candidate(db, scope, criterion_ids=[])
    assert count(db, Evidence) == 0


@pytest.mark.parametrize("kind", ["file", "screenshot", "github", "feishu"])
def test_missing_real_source_adapters_return_503_without_persisting(db, scope, kind):
    with pytest.raises(ApiError) as error:
        with db.begin_nested():
            candidate(db, scope, source_type=kind, source_id=uuid4())
    assert error.value.status_code == 503
    assert count(db, Evidence) == count(db, IntegrationOutbox) == count(db, RequestIdempotency) == 0


def test_outbox_failure_rolls_back_evidence_and_idempotency(db, scope, monkeypatch):
    def unavailable(*args, **kwargs):
        raise RuntimeError("outbox insert failed")

    monkeypatch.setattr(evidence_service, "emit_event", unavailable)
    with pytest.raises(RuntimeError):
        with db.begin_nested():
            candidate(db, scope)
    assert (
        count(db, Evidence)
        == count(db, EvidenceSourceSnapshot)
        == count(db, RequestIdempotency)
        == 0
    )


class VerifiedTestPort:
    def __init__(self, project_id):
        self.project_id = project_id
        self.revision = "commit-a"

    def resolve(self, **kwargs):
        return VerifiedSource(
            self.project_id,
            kwargs["source_type"],
            "trusted-connection/item-1",
            self.revision,
            {"verified_commit": self.revision},
        )


class UrlTestPort(VerifiedTestPort):
    def __init__(self, project_id, url):
        super().__init__(project_id)
        self.url = url

    def resolve(self, **kwargs):
        return replace(super().resolve(**kwargs), source_url=self.url)


@pytest.mark.parametrize(
    "kind,url",
    [
        ("github", "javascript:alert(1)"),
        ("github", "https://github.com.evil.example/org/repo"),
        ("github", "https://www.github.com/org/repo"),
        ("github", "http://github.com/org/repo"),
        ("github", "https://github.com:8443/org/repo"),
        ("github", "https://user:secret@github.com/org/repo"),
        ("github", "https://@github.com/org/repo"),
        ("github", "https://github.com\\@evil.example/org/repo"),
        ("feishu", "https://user:secret@tenant.feishu.cn/wiki/document"),
        ("feishu", "\nhttps://tenant.feishu.cn/wiki/document"),
        ("file", "data:text/html,<script>alert(1)</script>"),
        ("file", "ftp://storage.example/proof"),
        ("screenshot", "/local/screenshot.png"),
    ],
)
def test_invalid_adapter_url_cannot_persist_evidence_or_audit(db, scope, kind, url):
    with pytest.raises(ApiError) as error:
        with db.begin_nested():
            create_evidence(
                db,
                scope.users["author"],
                scope.project.id,
                command(scope, source_type=kind, source_id=uuid4()),
                "unsafe-source-url",
                UrlTestPort(scope.project.id, url),
            )
    assert error.value.status_code == 503 and error.value.code == "SOURCE_URL_INVALID"
    assert count(db, Evidence) == count(db, EvidenceSourceSnapshot) == 0
    assert count(db, IntegrationOutbox) == count(db, RequestIdempotency) == 0


@pytest.mark.parametrize(
    "kind,url",
    [
        ("github", "https://github.com/owner/repo/commit/abc"),
        ("github", "https://github.com:443/owner/repo/commit/abc"),
        ("feishu", "https://tenant.feishu.cn/wiki/document"),
        ("file", "http://storage.example/proof.txt"),
        ("screenshot", "https://storage.example/proof.png?version=1"),
    ],
)
def test_valid_adapter_urls_are_retained(db, scope, kind, url):
    row = create_evidence(
        db,
        scope.users["author"],
        scope.project.id,
        command(scope, source_type=kind, source_id=uuid4()),
        "valid-source-url",
        UrlTestPort(scope.project.id, url),
    )
    assert row["source_url"] == url


def test_source_recheck_rejects_invalid_url_without_changing_snapshot(db, scope):
    source_id = uuid4()
    port = UrlTestPort(scope.project.id, "https://github.com/owner/repo/commit/abc")
    row = create_evidence(
        db,
        scope.users["author"],
        scope.project.id,
        command(scope, source_type="github", source_id=source_id),
        "original-source",
        port,
    )
    adopted = decide(db, scope, row)
    port.url = "javascript:alert(1)"
    port.revision = "commit-b"
    with pytest.raises(ApiError) as error:
        with db.begin_nested():
            check_source(
                db,
                scope.users["author"],
                scope.project.id,
                UUID(row["id"]),
                CheckEvidenceSource(source_id=source_id, expected_version=1, reason="Recheck"),
                "unsafe-source-recheck",
                port,
            )
    assert error.value.code == "SOURCE_URL_INVALID"
    stored = db.get(Evidence, UUID(row["id"]))
    assert stored.lock_version == adopted["lock_version"] and not stored.source_changed
    assert count(db, EvidenceSourceSnapshot) == 1
    assert count(db, EvidenceDecision) == count(db, IntegrationOutbox) == 2


@pytest.mark.parametrize(
    "plan_state", ["missing", "draft", "confirmed", "archived", "unplanned_task", "new_draft"]
)
def test_adoption_rechecks_latest_plan_after_candidate_creation(db, scope, plan_state):
    row = candidate(db, scope)
    if plan_state == "missing":
        db.delete(scope.plan)
    elif plan_state == "unplanned_task":
        scope.plan.snapshot_json = {"tasks": []}
    elif plan_state == "new_draft":
        db.add(
            PlanVersion(
                id=uuid4(),
                project_id=scope.project.id,
                version_no=2,
                created_by=scope.users["leader"].id,
                status="draft",
                snapshot_json={"tasks": [str(scope.task.id)]},
            )
        )
    else:
        scope.plan.status = plan_state
    db.flush()
    with pytest.raises(ApiError) as error:
        with db.begin_nested():
            decide(db, scope, row)
    expected = "TASK_NOT_IN_PLAN" if plan_state == "unplanned_task" else "PLAN_NOT_FROZEN"
    assert error.value.status_code == 409 and error.value.code == expected
    stored = db.get(Evidence, UUID(row["id"]))
    assert stored.status == "candidate" and stored.lock_version == 0
    assert count(db, EvidenceDecision) == count(db, IntegrationOutbox) == 1
    assert count(db, RequestIdempotency) == 1


def test_withdrawal_can_remove_formal_evidence_while_plan_is_unlocked(db, scope):
    row = decide(db, scope, candidate(db, scope))
    scope.plan.status = "draft"
    db.flush()
    withdrawn = decide(db, scope, row, decision="withdrawn")
    assert withdrawn["status"] == "withdrawn" and not withdrawn["effective"]


def test_source_change_appends_history_and_excludes_formal_evidence(db, scope):
    port = VerifiedTestPort(scope.project.id)
    source_id = uuid4()
    row = create_evidence(
        db,
        scope.users["author"],
        scope.project.id,
        command(scope, source_type="github", source_id=source_id),
        "github-candidate",
        port,
    )
    adopted = decide(db, scope, row)
    port.revision = "commit-b"
    checked = check_source(
        db,
        scope.users["teacher"],
        scope.project.id,
        UUID(row["id"]),
        CheckEvidenceSource(
            source_id=source_id,
            expected_version=adopted["lock_version"],
            reason="Verified remote revision changed",
        ),
        "check-source",
        port,
    )
    assert checked["status"] == "formal" and checked["source_changed"] is True
    snapshots = list(
        db.scalars(select(EvidenceSourceSnapshot).order_by(EvidenceSourceSnapshot.version_no))
    )
    assert [s.source_revision for s in snapshots] == ["commit-a", "commit-b"]
    assert (
        list_evidence(db, scope.users["teacher"], scope.project.id, effective_only=True)["total"]
        == 0
    )
    assert count(db, IntegrationOutbox) == 3


def test_adapter_cannot_return_foreign_project_source(db, scope):
    with pytest.raises(ApiError) as error:
        with db.begin_nested():
            create_evidence(
                db,
                scope.users["author"],
                scope.project.id,
                command(scope, source_type="feishu", source_id=uuid4()),
                "bad-adapter",
                VerifiedTestPort(scope.other_project.id),
            )
    assert error.value.code == "SOURCE_PROJECT_MISMATCH"


@pytest.mark.parametrize(
    "field,value", [("reason", "   "), ("expected_version", -1), ("expected_version", True)]
)
def test_decisions_reject_blank_reason_and_invalid_versions(field, value):
    values = {"reason": "checked", "expected_version": 0, field: value}
    with pytest.raises(ValidationError):
        DecideEvidence(**values)


def test_invalid_uuid_and_extra_status_are_rejected():
    with pytest.raises(ValidationError):
        CreateEvidence(task_id="not-a-uuid", title="A", description="B", source_type="manual")
    with pytest.raises(ValidationError):
        CreateEvidence(
            task_id=uuid4(), title="A", description="B", source_type="manual", status="formal"
        )


@pytest.mark.parametrize("attribute,value", [("lifecycle", "archived"), ("setup_status", "draft")])
def test_read_only_project_rejects_evidence_creation(db, scope, attribute, value):
    setattr(scope.project, attribute, value)
    db.flush()
    with pytest.raises(ApiError):
        candidate(db, scope)
    assert count(db, Evidence) == 0


def test_list_filters_are_applied_before_pagination(db, scope):
    first = candidate(db, scope, title="First")
    candidate(db, scope, title="Second")
    decide(db, scope, first)
    result = list_evidence(db, scope.users["member"], scope.project.id, status="candidate", limit=1)
    assert result["total"] == 1 and result["items"][0]["title"] == "Second"


@pytest.mark.parametrize("state", ["not_started", "pending_verification", "completed"])
def test_tasks_reject_evidence_outside_editable_execution_states(db, scope, state):
    scope.task.status = state
    db.flush()
    with pytest.raises(ApiError) as error:
        with db.begin_nested():
            candidate(db, scope)
    assert error.value.code == "TASK_STATE_CONFLICT"


@pytest.mark.parametrize("plan_state", ["draft", "confirmed", "archived"])
def test_candidate_requires_current_frozen_plan(db, scope, plan_state):
    scope.plan.status = plan_state
    db.flush()
    with pytest.raises(ApiError) as error:
        with db.begin_nested():
            candidate(db, scope)
    assert error.value.code == "PLAN_NOT_FROZEN"


def test_all_evidence_filters_and_page_contract(db, scope):
    candidate(db, scope, title="Search this proof")
    candidate(db, scope, title="Other proof")
    result = list_evidence(
        db,
        scope.users["member"],
        scope.project.id,
        q="Search this",
        author_id=scope.users["author"].id,
        criterion_id=scope.criterion.id,
        page=1,
        page_size=1,
    )
    assert result["total"] == 1 and result["page"] == 1 and result["page_size"] == 1
    assert result["items"][0]["title"] == "Search this proof"
    assert (
        list_evidence(
            db, scope.users["member"], scope.project.id, author_id=scope.users["member"].id
        )["total"]
        == 0
    )


def test_verified_deletion_invalidates_without_replacing_original_snapshot(db, scope):
    source_id = uuid4()
    port = VerifiedTestPort(scope.project.id)
    row = create_evidence(
        db,
        scope.users["author"],
        scope.project.id,
        command(scope, source_type="github", source_id=source_id),
        "deletion-candidate",
        port,
    )
    adopted = decide(db, scope, row)

    class DeletedPort:
        def resolve(self, **kwargs):
            return VerifiedSource(
                scope.project.id,
                "github",
                "trusted-connection/item-1",
                "verified-deletion-event-2",
                {},
                availability="deleted",
            )

    result = check_source(
        db,
        scope.users["teacher"],
        scope.project.id,
        UUID(row["id"]),
        CheckEvidenceSource(
            expected_version=adopted["lock_version"],
            source_id=source_id,
            reason="Provider reported deletion",
        ),
        "delete-check",
        DeletedPort(),
    )
    assert result["source_changed"] and not result["effective"]
    snapshots = list(
        db.scalars(select(EvidenceSourceSnapshot).order_by(EvidenceSourceSnapshot.version_no))
    )
    assert snapshots[0].content_json["source"]["verified_commit"] == "commit-a"
    assert snapshots[1].content_json["availability"] == "deleted"


def test_unverified_member_can_read_but_cannot_create_evidence(db, scope):
    scope.users["author"].email_verified_at = None
    db.flush()
    assert list_evidence(db, scope.users["author"], scope.project.id)["total"] == 0
    with pytest.raises(ApiError) as error:
        candidate(db, scope)
    assert error.value.code == "EMAIL_NOT_VERIFIED"
