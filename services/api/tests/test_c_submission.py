"""Submission preparation: real relational unit tests and optional PostgreSQL races.

SQLite verifies the domain transaction and HTTP contract; PostgreSQL-only races use
the existing isolated-schema fixture and never infer locking from SQLite results.
"""

import os
from uuid import UUID, uuid4

import pytest
import test_c_evidence as evidence_tests
import test_c_evidence_postgres as evidence_pg_tests
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import JSON, MetaData, create_engine, event, func, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool
from sqlalchemy.schema import CreateSchema, DropSchema

from app.api.auth import get_current_user
from app.api.errors import ApiError, install_exception_handlers
from app.db.base import Base
from app.db.models import ProgressEvent, Task, TaskAssignee
from app.db.session import get_session
from app.modules.c import task_execution
from app.modules.c.execution_router import get_submission_service, router
from app.modules.c.execution_schemas import PrepareSubmissionRequest
from app.modules.c.models import (
    Evidence,
    EvidenceSourceSnapshot,
    IntegrationOutbox,
    RequestIdempotency,
    TaskNote,
    TaskNoteVersion,
)
from app.modules.c.task_execution import TaskSubmissionService


@pytest.fixture
def setup():
    url = os.getenv("C_TEST_DATABASE_URL")
    engine = (
        create_engine(url)
        if url
        else create_engine(
            "sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False}
        )
    )
    schema = None
    if url:
        schema = "c_submission_test_" + uuid4().hex
        with engine.begin() as connection:
            connection.execute(CreateSchema(schema))
        engine = engine.execution_options(schema_translate_map={None: schema})
        Base.metadata.create_all(engine)
    else:

        @event.listens_for(engine, "connect")
        def foreign_keys(connection, _):
            connection.execute("PRAGMA foreign_keys=ON")

        metadata = MetaData()
        for table in Base.metadata.sorted_tables:
            portable = table.to_metadata(metadata)
            for column in portable.columns:
                if isinstance(column.type, JSONB):
                    column.type = JSON()
                if (
                    column.server_default is not None
                    and str(column.server_default.arg) == "gen_random_uuid()"
                ):
                    column.server_default = None
        metadata.create_all(engine)
    with engine.connect() as connection:
        outer = connection.begin()
        session = Session(
            connection, expire_on_commit=False, join_transaction_mode="create_savepoint"
        )
        data = evidence_tests.scope.__wrapped__(session)
        session.add(
            TaskAssignee(task_id=data.task.id, user_id=data.users["author"].id, role="responsible")
        )
        session.commit()
        try:
            yield session, data, TaskSubmissionService(session)
        finally:
            session.close()
            outer.rollback()
    if schema:
        with engine.begin() as connection:
            connection.execute(DropSchema(schema, cascade=True))
    engine.dispose()


def command(*, version=0, note_version=0, with_note=True, body="Implementation draft"):
    values = {"expected_version": version}
    if with_note:
        values["note"] = {"expected_version": note_version, "title": "Implementation", "body": body}
    return PrepareSubmissionRequest(**values)


def prepare(setup, *, key="prepare-once", actor="author", **kwargs):
    _, data, service = setup
    return service.prepare(data.task.id, data.users[actor], command(**kwargs), key)


def count(session, model):
    return session.scalar(select(func.count()).select_from(model))


def test_prepare_atomically_saves_persistent_note_and_pending_state_without_verification(setup):
    session, data, _ = setup
    data.task.progress_percent = 100
    session.commit()
    result = prepare(setup)
    assert result.execution.status == "pending_submission"
    assert result.execution.progress == 100 and result.execution.completed_at is None
    assert result.note.current_version_no == result.note.lock_version == 1
    session.expire_all()
    assert session.get(Task, data.task.id).status == "pending_submission"
    assert session.scalar(select(TaskNoteVersion.body)) == "Implementation draft"
    assert count(session, ProgressEvent) == 1
    assert set(session.scalars(select(IntegrationOutbox.event_type))) == {
        "task_note.version_saved",
        "task.submission_prepared",
    }


def test_prepare_without_note_or_evidence_hands_missing_items_to_d(setup):
    session, _, _ = setup
    result = prepare(setup, with_note=False)
    assert result.execution.status == "pending_submission" and result.execution.progress == 0
    assert result.note is None and count(session, TaskNote) == 0
    assert count(session, IntegrationOutbox) == 1


def test_omitted_note_preserves_existing_draft_without_new_note_version(setup):
    session, _, _ = setup
    first = prepare(setup)
    second = prepare(setup, key="prepare-again", version=1, with_note=False)
    assert first.note == second.note
    assert count(session, TaskNoteVersion) == 1
    assert second.execution.version == 2


def test_exact_retry_replays_without_new_note_audit_or_outbox(setup):
    session, _, _ = setup
    first = prepare(setup)
    assert prepare(setup) == first
    assert count(session, TaskNoteVersion) == count(session, ProgressEvent) == 1
    assert count(session, IntegrationOutbox) == count(session, RequestIdempotency) == 2


def test_retry_does_not_revert_task_that_d_has_advanced(setup):
    session, data, _ = setup
    first = prepare(setup)
    data.task.status = "pending_verification"
    data.task.lock_version += 1
    session.commit()
    assert prepare(setup) == first
    assert session.get(Task, data.task.id).status == "pending_verification"
    assert count(session, TaskNoteVersion) == count(session, ProgressEvent) == 1


def test_same_key_with_different_note_conflicts_without_overwriting_draft(setup):
    session, _, _ = setup
    prepare(setup)
    with pytest.raises(ApiError) as error:
        prepare(setup, body="Different draft")
    assert error.value.code == "IDEMPOTENCY_CONFLICT"
    assert session.scalar(select(TaskNoteVersion.body)) == "Implementation draft"


@pytest.mark.parametrize("actor", ["member", "leader", "teacher", "ta", "outsider", "admin"])
def test_only_current_task_responsible_can_prepare(setup, actor):
    session, data, _ = setup
    with pytest.raises(ApiError) as error:
        prepare(setup, actor=actor)
    assert error.value.status_code == 403
    assert session.get(Task, data.task.id).status == "in_progress"
    assert count(session, TaskNoteVersion) == count(session, ProgressEvent) == 0


@pytest.mark.parametrize(
    "restriction,code",
    [
        ("unverified", "EMAIL_NOT_VERIFIED"),
        ("left", "PROJECT_ACCESS_DENIED"),
        ("archived", "PROJECT_READ_ONLY"),
        ("ended", "COURSE_READ_ONLY"),
        ("draft_plan", "PLAN_NOT_FROZEN"),
        ("not_in_plan", "TASK_NOT_IN_PLAN"),
    ],
)
def test_prepare_rechecks_current_permissions_and_plan_even_for_retry(setup, restriction, code):
    session, data, _ = setup
    prepare(setup)
    if restriction == "unverified":
        data.users["author"].email_verified_at = None
    elif restriction == "left":
        from app.db.models import ProjectMember

        session.query(ProjectMember).filter_by(
            project_id=data.project.id, user_id=data.users["author"].id
        ).delete()
    elif restriction == "archived":
        data.project.lifecycle = "archived"
    elif restriction == "ended":
        data.course.status = "ended"
    elif restriction == "draft_plan":
        data.plan.status = "draft"
    else:
        data.plan.snapshot_json = {"tasks": []}
    session.commit()
    with pytest.raises(ApiError) as error:
        prepare(setup)
    assert error.value.code == code
    assert count(session, TaskNoteVersion) == 1


@pytest.mark.parametrize("state", ["not_started", "pending_verification", "completed"])
def test_new_prepare_rejects_noneditable_states(setup, state):
    session, data, _ = setup
    data.task.status = state
    session.commit()
    with pytest.raises(ApiError) as error:
        prepare(setup)
    assert error.value.code == "INVALID_TASK_STATE"
    assert count(session, TaskNoteVersion) == count(session, ProgressEvent) == 0


@pytest.mark.parametrize("conflict", ["task", "note"])
def test_stale_task_or_note_version_changes_neither_draft_nor_state(setup, conflict):
    session, data, _ = setup
    first = prepare(setup)
    with pytest.raises(ApiError) as error:
        prepare(
            setup,
            key="stale-prepare",
            version=0 if conflict == "task" else 1,
            note_version=1 if conflict == "task" else 0,
            body="Stale draft",
        )
    assert error.value.code == "VERSION_CONFLICT"
    assert session.get(Task, data.task.id).lock_version == first.execution.version
    assert count(session, TaskNoteVersion) == count(session, ProgressEvent) == 1


def test_failure_after_note_save_rolls_back_every_domain_and_replay_row(setup, monkeypatch):
    session, data, _ = setup

    def unavailable(*args, **kwargs):
        raise RuntimeError("submission outbox unavailable")

    monkeypatch.setattr(task_execution, "emit_event", unavailable)
    with pytest.raises(RuntimeError, match="outbox unavailable"):
        prepare(setup)
    assert session.get(Task, data.task.id).status == "in_progress"
    for model in [TaskNote, TaskNoteVersion, ProgressEvent, RequestIdempotency, IntegrationOutbox]:
        assert count(session, model) == 0


def test_prepare_failure_rolls_back_existing_note_source_invalidation(setup, monkeypatch):
    session, data, _ = setup
    first = prepare(setup)
    candidate = evidence_tests.candidate(
        session, data, source_type="task_note", source_id=first.note.versions[0].id
    )
    formal = evidence_tests.decide(session, data, candidate)
    session.commit()
    before_events = count(session, IntegrationOutbox)

    def unavailable(*args, **kwargs):
        raise RuntimeError("submission outbox unavailable")

    monkeypatch.setattr(task_execution, "emit_event", unavailable)
    with pytest.raises(RuntimeError):
        prepare(setup, key="changed-draft", version=1, note_version=1, body="Changed draft")
    evidence = session.get(Evidence, UUID(formal["id"]))
    assert evidence.status == "formal" and not evidence.source_changed
    assert count(session, TaskNoteVersion) == count(session, EvidenceSourceSnapshot) == 1
    assert count(session, IntegrationOutbox) == before_events
    assert session.get(Task, data.task.id).lock_version == 1


@pytest.mark.parametrize(
    "note",
    [
        {"expected_version": True, "title": "Draft", "body": "Content"},
        {"expected_version": 0, "title": "Draft", "body": "   "},
        {"expected_version": 0, "title": "Draft", "body": "Content", "author_id": str(uuid4())},
    ],
)
def test_prepare_rejects_invalid_or_forged_nested_note(note):
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        PrepareSubmissionRequest(expected_version=0, note=note)


def test_prepare_production_auth_remains_closed(setup, monkeypatch):
    session, data, service = setup
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("ENABLE_DEMO_AUTH", "true")
    app = FastAPI()
    install_exception_handlers(app)

    @app.middleware("http")
    async def request_id(request, call_next):
        request.state.request_id = "submission-auth-test"
        return await call_next(request)

    app.include_router(router, prefix="/api/v1")
    app.dependency_overrides[get_submission_service] = lambda: service
    app.dependency_overrides[get_session] = lambda: session
    with TestClient(app) as client:
        response = client.post(
            f"/api/v1/tasks/{data.task.id}/prepare-submission",
            json=command().model_dump(),
            headers={
                "Idempotency-Key": "auth-test",
                "X-Demo-User-Id": str(data.users["author"].id),
            },
        )
    assert response.status_code == 401
    assert count(session, TaskNoteVersion) == count(session, ProgressEvent) == 0


def test_prepare_http_contract_validation_and_idempotency_header(setup):
    session, data, service = setup
    app = FastAPI()
    install_exception_handlers(app)

    @app.middleware("http")
    async def request_id(request, call_next):
        request.state.request_id = "submission-test"
        return await call_next(request)

    app.include_router(router, prefix="/api/v1")
    app.dependency_overrides[get_current_user] = lambda: data.users["author"]
    app.dependency_overrides[get_submission_service] = lambda: service
    app.dependency_overrides[get_session] = lambda: session
    url = f"/api/v1/tasks/{data.task.id}/prepare-submission"
    with TestClient(app) as client:
        assert client.post(url, json=command().model_dump()).status_code == 422
        invalid = {"expected_version": 0, "next_url": "https://evil.example"}
        assert (
            client.post(url, json=invalid, headers={"Idempotency-Key": "test"}).status_code == 422
        )
        response = client.post(
            url, json=command().model_dump(), headers={"Idempotency-Key": "test"}
        )
        assert response.status_code == 200
        assert response.headers["cache-control"] == "private, no-store"
        body = response.json()["data"]
        assert body["execution"]["task_id"] == str(data.task.id)
        assert body["execution"]["status"] == "pending_submission"
        assert body["note"]["current_version_no"] == 1


pg_scope = evidence_pg_tests.pg_scope


@pytest.mark.parametrize("same_key", [True, False])
def test_postgres_concurrent_prepare_has_no_duplicate_note_or_status_event(pg_scope, same_key):
    engine, data = pg_scope
    with Session(engine) as session:
        session.add(
            TaskAssignee(task_id=data.task.id, user_id=data.users["author"].id, role="responsible")
        )
        session.commit()

    def operation(session):
        return TaskSubmissionService(session).prepare(
            data.task.id,
            data.users["author"],
            command(),
            "same-prepare" if same_key else str(uuid4()),
        )

    results = evidence_pg_tests.race(engine, [operation, operation])
    if same_key:
        assert results[0] == results[1]
    else:
        assert sum(isinstance(value, ApiError) for value in results) == 1
        assert (
            next(value for value in results if isinstance(value, ApiError)).code
            == "VERSION_CONFLICT"
        )
    with Session(engine) as session:
        assert session.scalar(select(func.count()).select_from(TaskNoteVersion)) == 1
        assert session.scalar(select(func.count()).select_from(ProgressEvent)) == 1
        assert session.get(Task, data.task.id).lock_version == 1
