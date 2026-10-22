"""Actual PG races/migrations. Run only against the explicitly configured test DB."""

import importlib
from uuid import UUID

import pytest
import test_c_activity as activity_tests
import test_c_evidence_postgres as postgres_tests
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import func, inspect, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.modules.c.activity_models import ActivityRecordDecision, ActivityRecordState
from app.modules.c.activity_schemas import DecideActivity
from app.modules.c.activity_service import change_activity
from app.modules.c.models import Evidence, EvidenceSourceSnapshot, IntegrationOutbox

pg_scope = postgres_tests.pg_scope
race = postgres_tests.race


def test_concurrent_duplicate_adoption_creates_one_candidate_history_and_event_pair(pg_scope):
    engine, scope = pg_scope
    item = activity_tests.source(scope)
    port = activity_tests.FixtureSources([item])

    def operation(session):
        return change_activity(
            session,
            scope.users["author"],
            scope.project.id,
            "feishu",
            item.id,
            activity_tests.adopt_command(scope),
            "same-racing-key",
            port,
        )

    results = race(engine, [operation, operation])
    assert results[0] == results[1] and isinstance(results[0], dict)
    with Session(engine) as session:
        for model in [
            ActivityRecordState,
            ActivityRecordDecision,
            Evidence,
            EvidenceSourceSnapshot,
        ]:
            assert session.scalar(select(func.count()).select_from(model)) == 1
        assert session.scalar(select(func.count()).select_from(IntegrationOutbox)) == 2


def test_concurrent_adopt_ignore_with_same_initial_version_has_one_winner(pg_scope):
    engine, scope = pg_scope
    item = activity_tests.source(scope)
    port = activity_tests.FixtureSources([item])

    def adopt(session):
        return change_activity(
            session,
            scope.users["author"],
            scope.project.id,
            "feishu",
            item.id,
            activity_tests.adopt_command(scope),
            "adopt-race",
            port,
        )

    def ignore(session):
        return change_activity(
            session,
            scope.users["member"],
            scope.project.id,
            "feishu",
            item.id,
            DecideActivity(action="ignore", expected_version=0, reason="Not relevant"),
            "ignore-race",
            port,
        )

    results = race(engine, [adopt, ignore])
    assert sum(isinstance(result, dict) for result in results) == 1
    error = next(result for result in results if isinstance(result, ApiError))
    assert error.code == "VERSION_CONFLICT"
    winner = next(result for result in results if isinstance(result, dict))
    with Session(engine) as session:
        assert session.scalar(select(func.count()).select_from(ActivityRecordDecision)) == 1
        assert session.scalar(select(func.count()).select_from(Evidence)) == (
            winner["status"] == "adopted"
        )


def test_concurrent_different_source_commands_preserve_both_histories(pg_scope):
    engine, scope = pg_scope
    items = [activity_tests.source(scope), activity_tests.source(scope)]
    port = activity_tests.FixtureSources(items)

    def for_item(item):
        def operation(session):
            return change_activity(
                session,
                scope.users["author"],
                scope.project.id,
                "feishu",
                item.id,
                DecideActivity(action="ignore", expected_version=0, reason="Separate record"),
                "shared-key-different-target",
                port,
            )

        return operation

    results = race(engine, [for_item(item) for item in items])
    assert all(isinstance(result, dict) for result in results)
    with Session(engine) as session:
        assert session.scalar(select(func.count()).select_from(ActivityRecordDecision)) == 2


def test_migration_downgrade_refuses_to_erase_activity_history(pg_scope):
    engine, scope = pg_scope
    item = activity_tests.source(scope)
    with Session(engine) as session:
        result = change_activity(
            session,
            scope.users["author"],
            scope.project.id,
            "feishu",
            item.id,
            activity_tests.adopt_command(scope),
            "migration-data",
            activity_tests.FixtureSources([item]),
        )
        session.commit()
    migration = importlib.import_module("migrations.versions.0009_c_activity_records")
    schema = engine.get_execution_options()["schema_translate_map"][None]
    with pytest.raises(RuntimeError, match="preserve C4 activity"):
        with engine.begin() as connection:
            connection.exec_driver_sql('SET LOCAL search_path TO "' + schema + '"')
            with Operations.context(MigrationContext.configure(connection)):
                migration.downgrade()
    with Session(engine) as session:
        assert session.get(Evidence, UUID(result["evidence_id"])).status == "candidate"
        assert session.scalar(select(func.count()).select_from(ActivityRecordDecision)) == 1


def test_migration_empty_downgrade_upgrade_preserves_constraints(pg_scope):
    engine, _ = pg_scope
    migration = importlib.import_module("migrations.versions.0009_c_activity_records")
    assert migration.revision == "0009" and migration.down_revision == "0008"
    schema = engine.get_execution_options()["schema_translate_map"][None]
    with engine.begin() as connection:
        connection.exec_driver_sql('SET LOCAL search_path TO "' + schema + '"')
        with Operations.context(MigrationContext.configure(connection)):
            migration.downgrade()
            assert "c_activity_records" not in inspect(connection).get_table_names(schema=schema)
            migration.upgrade()
            checks = inspect(connection).get_check_constraints("c_activity_records", schema=schema)
            assert "ck_c_activity_adoption" in {check["name"] for check in checks}
            assert "c_activity_decisions" in inspect(connection).get_table_names(schema=schema)
