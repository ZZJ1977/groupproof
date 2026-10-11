"""Real PostgreSQL repository tests, opt-in with C_EXECUTION_TEST_DATABASE_URL.

Each test creates and removes a unique schema in an explicitly provided local test
database. No shared tables are changed. These exercise ORM persistence/transactions,
not Alembic migrations; migration checks remain in test_database.py.
"""

import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from threading import Barrier
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.base import Base
from app.db.models import PlanVersion, ProgressEvent, ProjectMember, Task, TaskAssignee, User
from app.db.seed import seed_core
from app.modules.c.permissions import get_project_access
from app.modules.c.task_execution import SqlExecutionRepository, TaskExecutionService


@pytest.fixture
def postgres(monkeypatch):
    url = os.getenv("C_EXECUTION_TEST_DATABASE_URL")
    if not url:
        pytest.skip("set C_EXECUTION_TEST_DATABASE_URL for real PostgreSQL execution tests")
    parsed = make_url(url)
    if parsed.get_backend_name() != "postgresql" or parsed.host not in {
        "localhost",
        "127.0.0.1",
        "::1",
    }:
        pytest.fail("C_EXECUTION_TEST_DATABASE_URL must name a local PostgreSQL test database")
    monkeypatch.setenv("APP_ENV", "test")
    schema = "c_execution_test_" + uuid4().hex
    admin = create_engine(url)
    engine = None
    with admin.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    try:
        # Exclude public: create_all(checkfirst=True) must not discover application
        # tables there and silently seed/update those instead of isolated tables.
        engine = create_engine(
            url, connect_args={"options": f"-csearch_path={schema} -ctimezone=Asia/Shanghai"}
        )
        Base.metadata.create_all(engine)
        with Session(engine) as session:
            ids = seed_core(session, environment="test")
        yield engine, {key: UUID(value) for key, value in ids.items() if key.endswith("_id")}
    finally:
        if engine is not None:
            engine.dispose()
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()


def add_task(session, ids, *, parent_id=None, status="not_started"):
    item = Task(
        id=uuid4(),
        project_id=ids["project_id"],
        module_id=ids["module_id"],
        parent_task_id=parent_id,
        created_by=ids["student_id"],
        title="C execution test",
        description="isolated PostgreSQL fixture",
        priority="medium",
        weight=1,
        status=status,
        progress_percent=0,
        lock_version=0,
    )
    session.add(item)
    session.flush()
    session.add(TaskAssignee(task_id=item.id, user_id=ids["student_id"], role="responsible"))
    plan = session.get(PlanVersion, ids["plan_id"])
    plan.snapshot_json = {
        **plan.snapshot_json,
        "tasks": [*plan.snapshot_json["tasks"], str(item.id)],
    }
    session.flush()
    return item


def test_sql_start_progress_durable_and_retry_writes_one_start_event(postgres):
    engine, ids = postgres
    with Session(engine) as session:
        item = add_task(session, ids)
        task_id = item.id
        session.commit()
        user = session.get(User, ids["student_id"])
        service = TaskExecutionService(SqlExecutionRepository(session))
        first = service.start(task_id, user, 0)
        repeated = service.start(task_id, user, 0)
        assert first == repeated
        result = service.update_progress(task_id, user, 1, 100, "Implementation recorded")
        assert result.status == "in_progress"
        with pytest.raises(ApiError) as conflict:
            service.update_progress(task_id, user, 1, 20, "Stale write")
        assert conflict.value.code == "VERSION_CONFLICT"
    with Session(engine) as check:
        stored = check.get(Task, task_id)
        assert stored.progress_percent == 100 and stored.lock_version == 2
        assert stored.status == "in_progress" and stored.completed_at is None
        events = list(check.scalars(select(ProgressEvent).where(ProgressEvent.task_id == task_id)))
        assert len(events) == 2
        assert sum(event.from_status == "not_started" for event in events) == 1


def test_sql_constraint_failure_rolls_back_progress_and_audit(postgres):
    engine, ids = postgres

    class InvalidEventRepository(SqlExecutionRepository):
        def add_event(self, event):
            # A real foreign-key failure, not a fake-session rollback assertion.
            event.actor_id = uuid4()
            super().add_event(event)

    with Session(engine) as session:
        item = add_task(session, ids, status="in_progress")
        task_id = item.id
        session.commit()
        user = session.get(User, ids["student_id"])
        service = TaskExecutionService(InvalidEventRepository(session))
        with pytest.raises(IntegrityError):
            service.update_progress(task_id, user, 0, 60, "Must rollback")
    with Session(engine) as check:
        assert check.get(Task, task_id).progress_percent == 0
        assert check.get(Task, task_id).lock_version == 0
        assert (
            check.scalar(
                select(func.count())
                .select_from(ProgressEvent)
                .where(ProgressEvent.task_id == task_id)
            )
            == 0
        )


def test_sql_concurrent_siblings_do_not_lose_parent_rollup(postgres):
    engine, ids = postgres
    with Session(engine) as session:
        parent = add_task(session, ids, status="in_progress")
        first = add_task(session, ids, parent_id=parent.id, status="in_progress")
        second = add_task(session, ids, parent_id=parent.id, status="in_progress")
        parent_id, first_id, second_id = parent.id, first.id, second.id
        session.commit()
    ready = Barrier(2)

    def update(task_id, progress):
        with Session(engine) as session:
            user = session.get(User, ids["student_id"])
            ready.wait(timeout=5)
            return TaskExecutionService(SqlExecutionRepository(session)).update_progress(
                task_id, user, 0, progress, "Concurrent child update"
            )

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(update, first_id, 80), executor.submit(update, second_id, 20)]
        for future in futures:
            assert future.result(timeout=10).version == 1
    with Session(engine) as check:
        assert check.get(Task, first_id).progress_percent == 80
        assert check.get(Task, second_id).progress_percent == 20
        assert check.get(Task, parent_id).progress_percent == 50
        assert check.get(Task, parent_id).lock_version == 2


def test_sql_permissions_use_active_project_relations_and_course_owner(postgres):
    engine, ids = postgres
    with Session(engine) as session:
        student = session.get(User, ids["student_id"])
        teacher = session.get(User, ids["teacher_id"])
        admin = session.get(User, ids["admin_id"])
        member_access = get_project_access(session, student, ids["project_id"])
        assert member_access.member and member_access.leader
        teacher_access = get_project_access(session, teacher, ids["project_id"])
        assert teacher_access.teacher and teacher_access.staff and not teacher_access.member
        with pytest.raises(ApiError) as denied:
            get_project_access(session, admin, ids["project_id"])
        assert denied.value.status_code == 403
        membership = session.scalar(
            select(ProjectMember).where(
                ProjectMember.project_id == ids["project_id"],
                ProjectMember.user_id == ids["student_id"],
                ProjectMember.left_at.is_(None),
            )
        )
        membership.left_at = datetime.now(ZoneInfo("Asia/Shanghai"))
        session.commit()
        with pytest.raises(ApiError) as former_leader:
            get_project_access(session, student, ids["project_id"])
        assert former_leader.value.code == "PROJECT_ACCESS_DENIED"
