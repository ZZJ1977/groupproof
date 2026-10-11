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
    first = seed_core(database_session, environment="test")
    second = seed_core(database_session, environment="test")

    assert first == second
    counts = (
        database_session.execute(
            text(
                """
            SELECT
                (SELECT count(*) FROM users
                 WHERE email LIKE 'seed.%@groupproof.local') AS users_count,
                (SELECT count(*) FROM courses WHERE code = 'GP-DEMO') AS courses_count,
                (SELECT count(*) FROM groups WHERE name = 'Seed Team') AS groups_count,
                (SELECT count(*) FROM projects WHERE name = 'Seed Project') AS projects_count,
                (SELECT count(*) FROM functional_modules
                 WHERE project_id = CAST(:project_id AS UUID)) AS modules_count,
                (SELECT count(*) FROM requirements
                 WHERE project_id = CAST(:project_id AS UUID)) AS requirements_count,
                (SELECT count(*) FROM tasks
                 WHERE project_id = CAST(:project_id AS UUID)) AS tasks_count,
                (SELECT count(*) FROM acceptance_criteria ac
                 JOIN tasks t ON ac.task_id = t.id
                 WHERE t.project_id = CAST(:project_id AS UUID)) AS criteria_count,
                (SELECT count(*) FROM task_dependencies td
                 JOIN tasks t ON td.task_id = t.id
                 WHERE t.project_id = CAST(:project_id AS UUID)) AS dependencies_count,
                (SELECT count(*) FROM baseline_confirmations bc
                 JOIN baseline_versions bv ON bc.baseline_version_id = bv.id
                 WHERE bv.project_id = CAST(:project_id AS UUID)) AS baseline_confirmations_count,
                (SELECT count(*) FROM plan_confirmations pc
                 JOIN plan_versions pv ON pc.plan_version_id = pv.id
                 WHERE pv.project_id = CAST(:project_id AS UUID)) AS plan_confirmations_count,
                (SELECT count(*) FROM progress_events
                 WHERE project_id = CAST(:project_id AS UUID)) AS progress_events_count
            """
            ).bindparams(project_id=first["project_id"])
        )
        .mappings()
        .one()
    )

    assert counts == {
        "users_count": 4,
        "courses_count": 1,
        "groups_count": 1,
        "projects_count": 1,
        "modules_count": 2,
        "requirements_count": 2,
        "tasks_count": 3,
        "criteria_count": 4,
        "dependencies_count": 2,
        "baseline_confirmations_count": 2,
        "plan_confirmations_count": 2,
        "progress_events_count": 1,
    }
