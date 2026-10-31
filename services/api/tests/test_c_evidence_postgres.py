"""PostgreSQL-only concurrency tests; skipped without C_TEST_DATABASE_URL.

Each test uses a generated, isolated schema and removes only that schema. These
tests verify row locking and uniqueness, not Alembic upgrade/downgrade coverage.
"""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import UUID, uuid4

import pytest
import test_c_evidence as evidence_tests
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session
from sqlalchemy.schema import CreateSchema, DropSchema

from app.api.errors import ApiError
from app.db.base import Base
from app.modules.c.evidence_schemas import DecideEvidence
from app.modules.c.evidence_service import create_evidence, decide_evidence
from app.modules.c.models import (
    Evidence,
    EvidenceDecision,
    IntegrationOutbox,
    TaskNote,
    TaskNoteVersion,
)
from app.modules.c.note_schemas import SaveTaskNote
from app.modules.c.note_service import save_note
from app.modules.c.source_ports import UnavailableSourcePort


@pytest.fixture()
def pg_scope():
    url = evidence_tests.os.getenv("C_TEST_DATABASE_URL")
    if not url:
        pytest.skip("Set C_TEST_DATABASE_URL for actual PostgreSQL concurrency tests")
    engine = create_engine(url)
    if engine.dialect.name != "postgresql":
        engine.dispose()
        pytest.skip("Concurrent SQL tests require PostgreSQL, not a substitute dialect")
    schema = "c_evidence_test_" + uuid4().hex
    scoped_engine = engine.execution_options(schema_translate_map={None: schema})
    with engine.begin() as connection:
        connection.execute(CreateSchema(schema))
    try:
        Base.metadata.create_all(scoped_engine)
        with Session(scoped_engine, expire_on_commit=False) as session:
            data = evidence_tests.scope.__wrapped__(session)
            session.commit()
        yield scoped_engine, data
    finally:
        # Only a UUID-named schema created above belongs to this fixture.
        with engine.begin() as connection:
            connection.execute(DropSchema(schema, cascade=True))
        engine.dispose()


def race(engine, operations):
    barrier = Barrier(len(operations))

    def run(operation):
        with Session(engine, expire_on_commit=False) as session:
            barrier.wait(timeout=10)
            try:
                result = operation(session)
                session.commit()
                return result
            except ApiError as error:
                session.rollback()
                return error

    with ThreadPoolExecutor(max_workers=len(operations)) as pool:
        return list(pool.map(run, operations))


def test_concurrent_duplicate_creation_produces_one_evidence_and_one_event(pg_scope):
    engine, data = pg_scope

    def create(session):
        return create_evidence(
            session,
            data.users["author"],
            data.project.id,
            evidence_tests.command(data),
            "same-racing-request",
            UnavailableSourcePort(),
        )

    results = race(engine, [create, create])
    assert results[0] == results[1]
    with Session(engine) as session:
        assert session.scalar(select(func.count()).select_from(Evidence)) == 1
        assert session.scalar(select(func.count()).select_from(IntegrationOutbox)) == 1


def test_concurrent_adoptions_with_same_expected_version_have_one_winner(pg_scope):
    engine, data = pg_scope
    with Session(engine) as session:
        candidate = create_evidence(
            session,
            data.users["author"],
            data.project.id,
            evidence_tests.command(data),
            "create-candidate",
            UnavailableSourcePort(),
        )
        session.commit()

    def adopt(session):
        return decide_evidence(
            session,
            data.users["author"],
            data.project.id,
            UUID(candidate["id"]),
            DecideEvidence(expected_version=0, reason="Checked"),
            str(uuid4()),
            decision="adopted",
        )

    results = race(engine, [adopt, adopt])
    assert sum(isinstance(result, dict) for result in results) == 1
    conflict = next(result for result in results if isinstance(result, ApiError))
    assert conflict.status_code == 409 and conflict.code == "VERSION_CONFLICT"
    with Session(engine) as session:
        assert session.scalar(select(func.count()).select_from(EvidenceDecision)) == 2
        assert session.scalar(select(func.count()).select_from(IntegrationOutbox)) == 2


def test_concurrent_first_note_saves_keep_one_singleton_and_version(pg_scope):
    engine, data = pg_scope

    def save(session):
        return save_note(
            session,
            data.users["author"],
            data.project.id,
            data.task.id,
            SaveTaskNote(expected_version=0, title="Concurrent note", body="Version one"),
            str(uuid4()),
        )

    results = race(engine, [save, save])
    assert sum(isinstance(result, dict) for result in results) == 1
    conflict = next(result for result in results if isinstance(result, ApiError))
    assert conflict.code == "VERSION_CONFLICT"
    with Session(engine) as session:
        assert session.scalar(select(func.count()).select_from(TaskNote)) == 1
        assert session.scalar(select(func.count()).select_from(TaskNoteVersion)) == 1
