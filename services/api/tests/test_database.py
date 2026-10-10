from __future__ import annotations

import os

import pytest
from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

from app.db.seed import seed_core
from app.db.session import SessionLocal, check_database_timezone, engine

CORE_TABLES = {
    "users",
    "sessions",
    "email_verifications",
    "oauth_connections",
    "courses",
    "course_staff",
    "course_members",
    "groups",
    "group_members",
    "projects",
    "project_members",
    "functional_modules",
    "requirements",
    "source_references",
    "requirement_source_references",
    "requirement_conflicts",
    "conflict_resolutions",
    "milestones",
    "tasks",
    "task_requirements",
    "task_assignees",
    "task_dependencies",
    "acceptance_criteria",
    "task_milestones",
    "progress_events",
    "baseline_versions",
    "baseline_confirmations",
    "plan_versions",
    "plan_confirmations",
}


@pytest.fixture()
def database_session() -> Session:
    if not os.getenv("DATABASE_URL"):
        pytest.skip("set DATABASE_URL to run PostgreSQL integration tests")

    with SessionLocal() as session:
        yield session


def test_core_schema_is_migrated(database_session: Session) -> None:
    assert (
        database_session.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
        == "0006"
    )
    assert CORE_TABLES <= set(inspect(engine).get_table_names())


def test_database_connection_uses_beijing_timezone(database_session: Session) -> None:
    assert check_database_timezone(database_session) == "Asia/Shanghai"


def test_seed_core_is_idempotent(database_session: Session) -> None:
    first = seed_core(database_session)
    second = seed_core(database_session)

    assert first == second
    counts = (
        database_session.execute(
            text(
                """
            SELECT
                (SELECT count(*) FROM users
                 WHERE email LIKE 'seed.%@groupproof.local') AS users_count,
                (SELECT count(*) FROM courses WHERE code = 'GP-DEMO') AS courses_count,
                (SELECT count(*) FROM projects WHERE name = 'Seed Project') AS projects_count,
                (SELECT count(*) FROM tasks WHERE title = 'Create task persistence') AS tasks_count
            """
            )
        )
        .mappings()
        .one()
    )

    assert counts == {
        "users_count": 2,
        "courses_count": 1,
        "projects_count": 1,
        "tasks_count": 1,
    }
