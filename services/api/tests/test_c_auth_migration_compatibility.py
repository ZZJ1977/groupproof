"""Real Alembic upgrades preserve C history across D/OAuth migrations.

Requires a disposable PostgreSQL role with CREATEDB. Each test creates its own
UUID-named database and drops only that database. The configured database is
used only to issue CREATE/DROP DATABASE; its rows and schemas are never changed.
File receipts below are explicit test doubles, not an external storage check.
"""

from __future__ import annotations

import os
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
import test_c_discussions as discussions
import test_c_evidence as evidence
import test_c_files as files
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth.models import AuthAuditEvent, OAuthTransaction, TeacherApplication
from app.db.models import TaskAssignee, User
from app.db.settings import normalize_database_url
from app.modules.c.note_schemas import SaveTaskNote
from app.modules.c.note_service import save_note
from app.modules.c.task_execution import SqlExecutionRepository, TaskExecutionService
from app.modules.d.models import (
    ContributionCalculation,
    CriterionResult,
    IntegrityCheck,
    VerificationRun,
)

API_ROOT = Path(__file__).resolve().parents[1]
D_TABLES = {
    "integrity_checks",
    "verification_runs",
    "criterion_results",
    "contribution_calculations",
    "contribution_snapshots",
    "contribution_items",
    "contribution_item_tasks",
    "reports",
    "report_snapshots",
}


@pytest.fixture()
def migration_database(monkeypatch):
    raw = os.getenv("C_MIGRATION_TEST_DATABASE_URL") or os.getenv("C_TEST_DATABASE_URL")
    if not raw:
        pytest.skip("Set C_MIGRATION_TEST_DATABASE_URL or C_TEST_DATABASE_URL for PostgreSQL")
    source_url = make_url(normalize_database_url(raw))
    if source_url.get_backend_name() != "postgresql":
        pytest.fail("Migration compatibility requires actual PostgreSQL")
    database_name = "gp_c_migration_" + uuid4().hex
    assert re.fullmatch(r"gp_c_migration_[0-9a-f]{32}", database_name)
    assert database_name != source_url.database
    maintenance = create_engine(source_url, isolation_level="AUTOCOMMIT")
    isolated_url = source_url.set(database=database_name)
    isolated = create_engine(isolated_url)
    created = False
    try:
        with maintenance.connect() as connection:
            connection.exec_driver_sql(f'CREATE DATABASE "{database_name}" TEMPLATE template0')
        created = True
        monkeypatch.setenv("DATABASE_URL", isolated_url.render_as_string(hide_password=False))
        config = Config(str(API_ROOT / "alembic.ini"))
        config.set_main_option("script_location", str(API_ROOT / "migrations"))
        yield SimpleNamespace(engine=isolated, config=config)
    finally:
        isolated.dispose()
        # No force-disconnect, no shared database cleanup and no populated downgrade.
        if created:
            with maintenance.connect() as connection:
                connection.exec_driver_sql(f'DROP DATABASE "{database_name}"')
        maintenance.dispose()


def current_revision(engine):
    with engine.connect() as connection:
        return connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one()


def original_columns(engine):
    inspector = inspect(engine)
    return {
        name: [column["name"] for column in inspector.get_columns(name)]
        for name in inspector.get_table_names()
        if name != "alembic_version"
    }


def snapshot(engine, columns):
    quote = engine.dialect.identifier_preparer.quote
    with engine.connect() as connection:
        return {
            table: sorted(
                [
                    dict(row)
                    for row in connection.execute(
                        text(f"SELECT {', '.join(map(quote, names))} FROM {quote(table)}")
                    ).mappings()
                ],
                key=repr,
            )
            for table, names in columns.items()
        }


def seed_retained_history(engine):
    """Use actual C services to persist historical records on the old schema."""
    with Session(engine, expire_on_commit=False) as session:
        scope = evidence.scope.__wrapped__(session)
        author = scope.users["author"]
        scope.task.status = "not_started"
        session.add(TaskAssignee(task_id=scope.task.id, user_id=author.id, role="responsible"))
        session.commit()
        execution = TaskExecutionService(SqlExecutionRepository(session))
        started = execution.start(scope.task.id, author, scope.task.lock_version)
        execution.update_progress(scope.task.id, author, started.version, 65, "Before migration")
        for version in range(2):
            save_note(
                session,
                author,
                scope.project.id,
                scope.task.id,
                SaveTaskNote(
                    expected_version=version, title="Implementation", body=f"v{version + 1}"
                ),
                f"pre-migration-note-{version}",
            )
        candidate = evidence.candidate(session, scope)
        evidence.decide(session, scope, candidate)
        session.commit()
        storage = files.StorageFake(scope)
        original = files.create(session, scope, storage)
        official = files.designate(session, scope, original)
        files.append(session, scope, storage, official)
        thread = discussions.create(session, scope, task_id=scope.task.id)
        discussions.reply(session, scope, thread)
        discussions.important(session, scope, thread)
        now = datetime.now(UTC)
        session.add(
            TeacherApplication(
                id="retained-teacher-review",
                user_id=scope.users["teacher"].id,
                application_version=0,
                snapshot={"name": "Submitted name", "requestedIdentity": "teacher"},
                status="approved",
                reviewer_id=scope.users["admin"].id,
                reviewed_at=now,
                reason="Reviewed before the migration",
            )
        )
        session.add(
            AuthAuditEvent(
                id="retained-auth-event",
                event_type="teacher.approved",
                actor_id=str(scope.users["admin"].id),
                target_user_id=str(scope.users["teacher"].id),
                result="success",
                changed_fields=["global_role"],
            )
        )
        # The 0013 table has no purpose/user_id columns yet: do not use the new ORM model.
        session.execute(
            text(
                "INSERT INTO oauth_transactions "
                "(state_digest, nonce, code_verifier, return_to, expires_at) "
                "VALUES (:state, :nonce, :verifier, :return_to, :expires)"
            ),
            {
                "state": "retained-oauth-transaction",
                "nonce": "isolated-test-nonce",
                "verifier": "isolated-test-verifier",
                "return_to": "/admin/users",
                "expires": now + timedelta(minutes=10),
            },
        )
        session.commit()
        return scope


def assert_integrity_error(session, row, sqlstate):
    with pytest.raises(IntegrityError) as error:
        with session.begin_nested():
            session.add(row)
            session.flush()
    assert error.value.orig.sqlstate == sqlstate


def check_new_constraints(engine, scope):
    """Exercise actual migrated PG constraints without changing retained C rows."""
    with Session(engine) as session:
        facts = dict(
            project_id=scope.project.id,
            task_id=scope.task.id,
            checked_by=scope.users["author"].id,
            rule_version="migration-regression-v1",
            total_criteria=2,
            covered_criteria=1,
            coverage_rate=50,
        )
        assert_integrity_error(session, IntegrityCheck(**{**facts, "coverage_rate": 100}), "23514")
        check = IntegrityCheck(**facts, details_json={"evidence": ["retained-snapshot"]})
        session.add(check)
        session.flush()
        run = VerificationRun(
            integrity_check_id=check.id,
            project_id=scope.project.id,
            task_id=scope.task.id,
            triggered_by=scope.users["author"].id,
            engine_version="migration-regression-v1",
        )
        session.add(run)
        session.flush()
        result = dict(verification_run_id=run.id, criterion_id=scope.criterion.id, result="passed")
        session.add(CriterionResult(**result))
        session.flush()
        assert_integrity_error(session, CriterionResult(**result), "23505")
        assert_integrity_error(
            session,
            ContributionCalculation(
                project_id=scope.project.id,
                formula_version="v1",
                calculated_by=scope.users["author"].id,
            ),
            "23514",
        )
        oauth = dict(
            nonce="isolated-test-nonce",
            code_verifier="isolated-test-verifier",
            expires_at=datetime.now(UTC) + timedelta(minutes=10),
            purpose="link",
        )
        assert_integrity_error(
            session,
            OAuthTransaction(state_digest="invalid-target", user_id=uuid4(), **oauth),
            "23503",
        )
        temporary_user = User(name="Only for OAuth cascade", status="active", global_role="student")
        session.add(temporary_user)
        session.flush()
        session.add(OAuthTransaction(state_digest="valid-link", user_id=temporary_user.id, **oauth))
        session.flush()
        session.delete(temporary_user)
        session.flush()
        session.expire_all()
        assert session.get(OAuthTransaction, "valid-link") is None
        assert session.get(IntegrityCheck, check.id).details_json == {
            "evidence": ["retained-snapshot"]
        }
        session.commit()


def test_upgrade_0013_through_d_and_google_preserves_c_history(migration_database):
    engine, config = migration_database.engine, migration_database.config
    command.upgrade(config, "0013")
    assert current_revision(engine) == "0013"
    scope = seed_retained_history(engine)
    columns = original_columns(engine)
    before = snapshot(engine, columns)
    # Prevent an empty fixture from making preservation checks vacuously pass.
    for table, minimum in {
        "tasks": 2,
        "progress_events": 2,
        "task_note_versions": 2,
        "evidence": 1,
        "evidence_criteria": 1,
        "evidence_decisions": 2,
        "evidence_source_snapshots": 1,
        "c_file_versions": 2,
        "c_file_decisions": 3,
        "discussions": 1,
        "discussion_replies": 1,
        "discussion_source_snapshots": 1,
        "teacher_applications": 1,
        "auth_audit_events": 1,
        "c_integration_outbox": 1,
        "c_request_idempotency": 1,
    }.items():
        assert len(before[table]) >= minimum, table
    command.upgrade(config, "0014")
    assert current_revision(engine) == "0014"
    assert D_TABLES <= set(inspect(engine).get_table_names())
    assert snapshot(engine, columns) == before
    command.upgrade(config, "head")
    assert current_revision(engine) == "0015"
    assert snapshot(engine, columns) == before
    with Session(engine) as session:
        legacy = session.get(OAuthTransaction, "retained-oauth-transaction")
        assert legacy.purpose == "login" and legacy.user_id is None
    check_new_constraints(engine, scope)
    assert snapshot(engine, columns) == before
    command.check(config)


def test_clean_database_rebuild_has_one_head_and_matches_models(migration_database):
    engine, config = migration_database.engine, migration_database.config
    assert inspect(engine).get_table_names() == []
    assert ScriptDirectory.from_config(config).get_heads() == ["0015"]
    command.upgrade(config, "head")
    assert current_revision(engine) == "0015"
    inspector = inspect(engine)
    assert D_TABLES <= set(inspector.get_table_names())
    with engine.connect() as connection:
        assert {"pgcrypto", "vector"} <= set(
            connection.execute(text("SELECT extname FROM pg_extension")).scalars()
        )
    columns = {column["name"]: column for column in inspector.get_columns("oauth_transactions")}
    assert columns["purpose"]["nullable"] is False and "login" in columns["purpose"]["default"]
    assert columns["user_id"]["nullable"] is True
    assert any(
        fk["constrained_columns"] == ["user_id"]
        and fk["referred_table"] == "users"
        and fk["options"].get("ondelete") == "CASCADE"
        for fk in inspector.get_foreign_keys("oauth_transactions")
    )
    command.check(config)
    # Re-running head is a no-op, not a duplicate D/OAuth schema installation.
    command.upgrade(config, "head")
    assert current_revision(engine) == "0015"
