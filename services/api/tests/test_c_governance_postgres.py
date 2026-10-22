import importlib
from uuid import UUID

import pytest
import test_c_evidence_postgres as postgres_tests
import test_c_governance as governance_tests
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import func, inspect, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import User
from app.modules.c import governance_access_service as access
from app.modules.c import governance_course_service as courses
from app.modules.c.evidence_router import commit_command
from app.modules.c.governance_models import (
    AccessDecision,
    AccessRequest,
    CourseCodeRegistry,
    CourseInvite,
    CourseLifecycleDecision,
    GovernanceOutbox,
)
from app.modules.c.governance_schemas import DecideAccessRequest, TransitionCourse

pg_scope = postgres_tests.pg_scope
race = postgres_tests.race


def test_concurrent_course_creation_same_key_replays_one_course(pg_scope):
    engine, scope = pg_scope
    command = governance_tests.course_command(scope)

    def create(session):
        return courses.create_course(session, scope.users["admin"], command, "same-create")

    results = race(engine, [create, create])
    assert results[0] == results[1] and isinstance(results[0], dict)
    with Session(engine) as session:
        assert session.scalar(select(func.count()).select_from(CourseCodeRegistry)) == 1
        assert session.scalar(select(func.count()).select_from(CourseLifecycleDecision)) == 1


def test_different_admins_cannot_create_same_code_across_semesters(pg_scope):
    engine, scope = pg_scope
    with Session(engine) as session:
        session.get(User, scope.users["other_teacher"].id).global_role = "admin"
        session.commit()

    def create(actor, semester):
        def operation(session):
            return commit_command(
                session,
                lambda: courses.create_course(
                    session,
                    scope.users[actor],
                    governance_tests.course_command(scope, semester=semester),
                    "code-race",
                ),
            )

        return operation

    results = race(engine, [create("admin", "One"), create("other_teacher", "Two")])
    assert sum(isinstance(row, dict) for row in results) == 1
    assert next(row for row in results if isinstance(row, ApiError)).status_code == 409
    with Session(engine) as session:
        assert session.scalar(select(func.count()).select_from(CourseCodeRegistry)) == 1


def test_concurrent_publication_has_one_version_and_invite(pg_scope):
    engine, scope = pg_scope
    with Session(engine) as session:
        draft = courses.create_course(
            session, scope.users["admin"], governance_tests.course_command(scope), "draft"
        )
        session.commit()

    def publish(session):
        return courses.transition_course(
            session,
            scope.users["admin"],
            UUID(draft["id"]),
            TransitionCourse(action="publish", expected_version=0, reason="Ready"),
            "publish",
        )

    results = race(engine, [publish, publish])
    assert results[0] == results[1] and results[0]["invite_code"]
    with Session(engine) as session:
        assert session.scalar(select(func.count()).select_from(CourseInvite)) == 1
        assert session.scalar(select(func.count()).select_from(CourseLifecycleDecision)) == 2


def test_concurrent_approve_reject_has_one_winner_and_no_lost_activation(pg_scope):
    engine, scope = pg_scope
    port = governance_tests.AuthorizationFixture()
    with Session(engine) as session:
        row = access.create_request(
            session, scope.users["author"], governance_tests.request_command(scope), "request", port
        )
        session.commit()

    def approve(session):
        return access.decide_request(
            session,
            scope.users["admin"],
            UUID(row["id"]),
            governance_tests.approval(row),
            "approve",
            port,
        )

    def reject(session):
        return access.decide_request(
            session,
            scope.users["admin"],
            UUID(row["id"]),
            DecideAccessRequest(decision="rejected", reason="Not needed", expected_version=0),
            "reject",
            port,
        )

    results = race(engine, [approve, reject])
    assert sum(isinstance(result, dict) for result in results) == 1
    assert (
        next(result for result in results if isinstance(result, ApiError)).code
        == "VERSION_CONFLICT"
    )
    winner = next(result for result in results if isinstance(result, dict))
    with Session(engine) as session:
        assert session.scalar(select(func.count()).select_from(AccessDecision)) == 1
        assert session.scalar(
            select(func.count())
            .select_from(GovernanceOutbox)
            .where(GovernanceOutbox.event_type == "test.a_grant")
        ) == (winner["status"] == "approved")


def test_concurrent_approval_same_key_activates_only_once(pg_scope):
    engine, scope = pg_scope
    port = governance_tests.AuthorizationFixture()
    with Session(engine) as session:
        row = access.create_request(
            session, scope.users["author"], governance_tests.request_command(scope), "request", port
        )
        session.commit()
    command = governance_tests.approval(row)

    def approve(session):
        return access.decide_request(
            session, scope.users["admin"], UUID(row["id"]), command, "approve-once", port
        )

    results = race(engine, [approve, approve])
    assert results[0] == results[1] and len(port.activation_calls) == 1


def test_governance_migration_protects_populated_history(pg_scope):
    engine, scope = pg_scope
    with Session(engine) as session:
        courses.create_course(
            session, scope.users["admin"], governance_tests.course_command(scope), "preserve"
        )
        session.commit()
    migration = importlib.import_module("migrations.versions.0012_c_governance")
    schema = engine.get_execution_options()["schema_translate_map"][None]
    with pytest.raises(RuntimeError, match="preserve C governance"):
        with engine.begin() as connection:
            connection.exec_driver_sql('SET LOCAL search_path TO "' + schema + '"')
            with Operations.context(MigrationContext.configure(connection)):
                migration.downgrade()
    with Session(engine) as session:
        assert session.scalar(select(func.count()).select_from(CourseLifecycleDecision)) == 1


def test_governance_migration_empty_roundtrip_leaves_canonical_course_constraint(pg_scope):
    engine, _ = pg_scope
    migration = importlib.import_module("migrations.versions.0012_c_governance")
    assert migration.revision == "0012" and migration.down_revision == "0011"
    schema = engine.get_execution_options()["schema_translate_map"][None]
    with engine.begin() as connection:
        connection.exec_driver_sql('SET LOCAL search_path TO "' + schema + '"')
        with Operations.context(MigrationContext.configure(connection)):
            migration.downgrade()
            assert "c_access_requests" not in inspect(connection).get_table_names(schema=schema)
            migration.upgrade()
    unique = inspect(engine).get_unique_constraints("courses", schema=schema)
    assert any(row["column_names"] == ["code", "semester"] for row in unique)
    with Session(engine) as session:
        assert session.scalar(select(func.count()).select_from(AccessRequest)) == 0
