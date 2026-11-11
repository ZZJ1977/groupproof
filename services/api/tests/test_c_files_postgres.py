"""Actual PG races, only when the root schedules C_TEST_DATABASE_URL.

The shared concurrency fixture creates/removes its own UUID-named schema.
It does not modify other containers or any pre-existing schema.
"""

import hashlib
import importlib
from uuid import UUID, uuid4

import pytest
import test_a_storage as storage_tests
import test_c_evidence_postgres as pg_tests
import test_c_files as file_tests
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import delete, func, inspect, select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session, sessionmaker

from app.api.errors import ApiError
from app.modules.a import inbox, storage
from app.modules.c.files_models import FileDecision, FileVersion, LogicalFile
from app.modules.c.files_schemas import AppendFileVersion, DesignateFileVersion, RegisterFile
from app.modules.c.files_service import (
    append_version,
    designate_version,
    get_signed_link,
    register_file,
)
from app.modules.c.inbox_schemas import NotificationFilters
from app.modules.c.models import IntegrationOutbox, RequestIdempotency

pg_scope = pg_tests.pg_scope


def test_pg_storage_receipts_to_project_versions_inbox_and_historical_download(pg_scope):
    engine, scope = pg_scope
    sessions = sessionmaker(engine)
    bucket = storage_tests.FakeStorageClient()
    port = storage.SupabaseProjectStoragePort(sessions, bucket)
    project_id = scope.project.id
    author = scope.users["author"]
    leader = scope.users["leader"]
    bodies = (b"first draft", b"revised draft")
    tickets = []
    for content in bodies:
        with sessions.begin() as session:
            ticket = storage.create_upload(
                session,
                author,
                scope="project",
                scope_id=project_id,
                filename="design.txt",
                mime_type="text/plain",
                size_bytes=len(content),
                client=bucket,
            )
        bucket.objects[ticket.object_id] = content
        with sessions.begin() as session:
            storage.complete_upload(session, author, ticket.receipt_id, client=bucket)
        tickets.append(ticket)

    with sessions.begin() as session:
        original = register_file(
            session,
            author,
            project_id,
            RegisterFile(receipt_id=tickets[0].receipt_id, reason="Initial design"),
            "register",
            port,
        )
    file_id = UUID(original["id"])
    first = UUID(original["versions"][0]["id"])
    with sessions.begin() as session:
        published = designate_version(
            session,
            leader,
            project_id,
            file_id,
            DesignateFileVersion(version_id=first, expected_version=0, reason="Review passed"),
            "publish-first",
            writer=inbox.notify,
        )
    with sessions.begin() as session:
        revised = append_version(
            session,
            author,
            project_id,
            file_id,
            AppendFileVersion(
                receipt_id=tickets[1].receipt_id,
                expected_version=published["lock_version"],
                reason="Correct diagram",
            ),
            "append",
            port,
        )
    publish = DesignateFileVersion(
        version_id=UUID(revised["versions"][0]["id"]),
        expected_version=revised["lock_version"],
        reason="Approved revision",
    )
    for _ in range(2):
        with sessions.begin() as session:
            current = designate_version(
                session, leader, project_id, file_id, publish, "publish-second", writer=inbox.notify
            )
    assert [(v["status"], v["content_hash"]) for v in current["versions"]] == [
        ("current", hashlib.sha256(bodies[1]).hexdigest()),
        ("superseded", hashlib.sha256(bodies[0]).hexdigest()),
    ]
    with sessions() as session:
        messages = inbox.DatabaseInboxPort().notifications(
            session,
            recipient_id=scope.users["member"].id,
            filters=NotificationFilters(category="project"),
        )
        assert messages.unread_total == 2
        assert {message.description for message in messages.items} == {"正式版本 v1", "正式版本 v2"}
        for role in ("member", "teacher", "ta"):
            for purpose in ("preview", "download"):
                link = get_signed_link(
                    session, scope.users[role], project_id, file_id, first, purpose, port
                )
                assert link["version_id"] == str(first)
                assert link["url"] == bucket.create_signed_download_url(
                    tickets[0].object_id, storage.DOWNLOAD_URL_TTL_SECONDS
                )


def test_pg_duplicate_registration_is_one_file_version_and_outbox(pg_scope):
    engine, scope = pg_scope
    storage = file_tests.StorageFake(scope)
    receipt = storage.receipt()

    def run(session):
        return register_file(
            session,
            scope.users["author"],
            scope.project.id,
            RegisterFile(receipt_id=receipt.receipt_id, reason="Upload"),
            "same-create",
            storage,
        )

    results = pg_tests.race(engine, [run, run])
    assert results[0] == results[1]
    with Session(engine) as session:
        for model in (LogicalFile, FileVersion, FileDecision, IntegrationOutbox):
            assert session.scalar(select(func.count()).select_from(model)) == 1


def test_pg_competing_appends_have_one_cas_winner(pg_scope):
    engine, scope = pg_scope
    storage = file_tests.StorageFake(scope)
    with Session(engine) as session:
        original = file_tests.create(session, scope, storage)
    receipts = [storage.receipt(), storage.receipt()]

    def run(receipt):
        return lambda session: append_version(
            session,
            scope.users["author"],
            scope.project.id,
            UUID(original["id"]),
            AppendFileVersion(receipt_id=receipt.receipt_id, reason="Update", expected_version=0),
            str(uuid4()),
            storage,
        )

    results = pg_tests.race(engine, [run(receipt) for receipt in receipts])
    assert sum(isinstance(result, dict) for result in results) == 1
    assert (
        next(result for result in results if isinstance(result, ApiError)).code
        == "VERSION_CONFLICT"
    )
    with Session(engine) as session:
        assert session.scalar(select(func.count()).select_from(FileVersion)) == 2
        assert session.get(LogicalFile, UUID(original["id"])).latest_version_no == 2


def test_pg_duplicate_designation_has_one_decision_and_event(pg_scope):
    engine, scope = pg_scope
    storage = file_tests.StorageFake(scope)
    with Session(engine) as session:
        original = file_tests.create(session, scope, storage)

    def run(session):
        return designate_version(
            session,
            scope.users["author"],
            scope.project.id,
            UUID(original["id"]),
            DesignateFileVersion(
                version_id=UUID(original["versions"][0]["id"]),
                reason="Reviewed",
                expected_version=0,
            ),
            "same-designation",
        )

    results = pg_tests.race(engine, [run, run])
    assert results[0] == results[1]
    with Session(engine) as session:
        assert session.scalar(select(func.count()).select_from(FileDecision)) == 2
        assert session.scalar(select(func.count()).select_from(IntegrationOutbox)) == 2


def test_pg_migration_empty_downgrade_upgrade_preserves_constraints(pg_scope):
    engine, _ = pg_scope
    migration = importlib.import_module("migrations.versions.0010_c_files")
    assert migration.revision == "0010" and migration.down_revision == "0009"
    schema = engine.get_execution_options()["schema_translate_map"][None]
    expected_checks = {
        "c_logical_files": {"ck_c_file_latest", "ck_c_file_official", "ck_c_file_category"},
        "c_file_versions": {"ck_c_file_version", "ck_c_file_size"},
        "c_file_decisions": {"ck_c_file_action", "ck_c_file_reason"},
    }
    expected_unique_columns = {
        "c_logical_files": {("project_id", "name_key")},
        "c_file_versions": {("file_id", "version_no"), ("receipt_id",)},
        "c_file_decisions": set(),
    }
    expected_fk_columns = {
        "c_logical_files": {("project_id",), ("created_by",)},
        "c_file_versions": {("file_id",), ("uploaded_by",)},
        "c_file_decisions": {("file_id",), ("version_id",), ("actor_id",)},
    }
    with engine.begin() as connection:
        # Only the UUID schema created by pg_scope is in the migration search path.
        connection.exec_driver_sql('SET LOCAL search_path TO "' + schema + '"')
        with Operations.context(MigrationContext.configure(connection)):
            migration.downgrade()
            assert set(expected_checks).isdisjoint(
                inspect(connection).get_table_names(schema=schema)
            )
            migration.upgrade()
        inspector = inspect(connection)
        for table, checks in expected_checks.items():
            assert checks == {
                check["name"] for check in inspector.get_check_constraints(table, schema=schema)
            }
            assert expected_unique_columns[table] == {
                tuple(unique["column_names"])
                for unique in inspector.get_unique_constraints(table, schema=schema)
            }
            assert expected_fk_columns[table] == {
                tuple(fk["constrained_columns"])
                for fk in inspector.get_foreign_keys(table, schema=schema)
            }
            assert inspector.get_pk_constraint(table, schema=schema)["constrained_columns"] == [
                "id"
            ]
        assert {
            index["name"] for index in inspector.get_indexes("c_logical_files", schema=schema)
        } >= {"ix_c_logical_files_project_id"}
        for table in ("c_file_versions", "c_file_decisions"):
            assert f"ix_{table}_file_id" in {
                index["name"] for index in inspector.get_indexes(table, schema=schema)
            }


@pytest.mark.parametrize("guard", ["history", "outbox", "idempotency"])
def test_pg_migration_refuses_to_erase_each_retained_file_record_kind(pg_scope, guard):
    engine, scope = pg_scope
    models = (LogicalFile, FileVersion, FileDecision, IntegrationOutbox, RequestIdempotency)

    def snapshot(session):
        return {
            model.__tablename__: [
                {column.name: getattr(row, column.name) for column in model.__table__.columns}
                for row in session.scalars(select(model).order_by(model.id))
            ]
            for model in models
        }

    with Session(engine) as session:
        if guard == "history":
            storage = file_tests.StorageFake(scope)
            original = file_tests.create(session, scope, storage)
            official = file_tests.designate(session, scope, original)
            file_tests.append(session, scope, storage, official)
            # Isolate the history guard: neither outbox nor replay records can mask it.
            session.execute(delete(IntegrationOutbox))
            session.execute(delete(RequestIdempotency))
        elif guard == "outbox":
            session.add(
                IntegrationOutbox(
                    id=uuid4(),
                    project_id=scope.project.id,
                    aggregate_id=uuid4(),
                    event_type="file.designated",
                    payload_json={"reason": "Pending delivery"},
                )
            )
        else:
            session.add(
                RequestIdempotency(
                    id=uuid4(),
                    actor_id=scope.users["author"].id,
                    project_id=scope.project.id,
                    operation="file.designate",
                    idempotency_key="retained-replay",
                    request_hash="a" * 64,
                    response_json={"id": str(uuid4())},
                )
            )
        session.commit()
        before = snapshot(session)
    if guard == "history":
        assert len(before["c_file_versions"]) == 2 and len(before["c_file_decisions"]) == 3
        assert before["c_integration_outbox"] == [] and before["c_request_idempotency"] == []
    else:
        assert all(before[model.__tablename__] == [] for model in models[:3])
    migration = importlib.import_module("migrations.versions.0010_c_files")
    schema = engine.get_execution_options()["schema_translate_map"][None]
    with pytest.raises(DBAPIError, match="preserve C file data"):
        with engine.begin() as connection:
            connection.exec_driver_sql('SET LOCAL search_path TO "' + schema + '"')
            with Operations.context(MigrationContext.configure(connection)):
                migration.downgrade()
    with Session(engine) as session:
        assert snapshot(session) == before
    assert {"c_logical_files", "c_file_versions", "c_file_decisions"} <= set(
        inspect(engine).get_table_names(schema=schema)
    )
