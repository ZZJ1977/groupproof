"""Shared B test data: one course, one teacher, four students, one group, one project.

Two entry points:

* ``build_b_world(session)`` adds the graph to any session and returns its IDs.
  Every call uses fresh UUIDs and unique codes, so tests can build several worlds
  side by side (e.g. "A 组改 B 组" cross-group checks).
* ``b_postgres_schema(url)`` creates an isolated schema in an explicitly local
  PostgreSQL test database, yields an engine bound to it and drops it afterwards.
  No shared tables are touched. It mirrors C's execution fixture. A test module
  wraps it in its own fixture::

      @pytest.fixture
      def b_engine(monkeypatch):
          monkeypatch.setenv("APP_ENV", "test")
          with b_postgres_schema(b_test_database_url()) as engine:
              yield engine

The world is deliberately "fresh": the project is not initialized (no baseline,
no plan, no tasks) because each B stage builds those through its own commands.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.orm import Session

from app.auth.models import SchoolEmailBinding
from app.db.base import Base
from app.db.models import (
    Course,
    CourseMember,
    CourseStaff,
    GroupMember,
    Project,
    ProjectGroup,
    ProjectMember,
    User,
)

UTC = ZoneInfo("UTC")
B_TEST_DATABASE_ENV = "B_TEST_DATABASE_URL"


@dataclass(frozen=True)
class BWorld:
    teacher_id: UUID
    # students[0] is the group leader; students[1:] are ordinary members.
    student_ids: tuple[UUID, UUID, UUID, UUID]
    course_id: UUID
    group_id: UUID
    project_id: UUID

    @property
    def leader_id(self) -> UUID:
        return self.student_ids[0]

    @property
    def member_ids(self) -> tuple[UUID, ...]:
        return self.student_ids[1:]


def _user(session: Session, *, tag: str, role: str, index: int, now: datetime) -> User:
    email = f"b-{tag}-{role}-{index}@b-fixture.test"
    user = User(
        id=uuid4(),
        name=f"B {role.title()} {index}",
        username=f"b-{tag}-{role}-{index}",
        email=email,
        student_id=f"B{tag}{index}" if role == "student" else None,
        college="GroupProof",
        global_role=role,
        status="active",
        email_verified_at=now,
    )
    session.add(user)
    session.flush()
    # A3 requires a verified school email binding before course actions.
    session.add(
        SchoolEmailBinding(
            user_id=user.id,
            school_email=email,
            school_email_normalized=email.lower(),
            verified_at=now,
            verification_method="documented_manual_review",
        )
    )
    return user


def build_b_world(
    session: Session,
    *,
    now: datetime | None = None,
    formation_deadline: timedelta = timedelta(days=14),
    project_deadline: timedelta = timedelta(days=90),
    max_group_size: int = 5,
) -> BWorld:
    now = now or datetime.now(UTC)
    tag = uuid4().hex[:8]
    teacher = _user(session, tag=tag, role="teacher", index=1, now=now)
    students = [_user(session, tag=tag, role="student", index=i, now=now) for i in range(1, 5)]

    course = Course(
        id=uuid4(),
        owner_id=teacher.id,
        code=f"B-{tag}",
        name=f"B Fixture Course {tag}",
        college="GroupProof",
        semester="2026-Autumn",
        status="active",
        formation_deadline=now + formation_deadline,
        project_deadline=now + project_deadline,
        grouping_mode="free",
        min_group_size=1,
        max_group_size=max_group_size,
    )
    session.add(course)
    session.flush()
    session.add(CourseStaff(course_id=course.id, user_id=teacher.id, role="teacher"))
    session.add(CourseMember(course_id=course.id, user_id=teacher.id, role="teacher"))
    for student in students:
        session.add(CourseMember(course_id=course.id, user_id=student.id, role="student"))

    leader = students[0]
    group = ProjectGroup(id=uuid4(), course_id=course.id, leader_id=leader.id, name=f"B Team {tag}")
    session.add(group)
    session.flush()
    for student in students:
        role = "leader" if student is leader else "member"
        session.add(GroupMember(group_id=group.id, user_id=student.id, role=role))

    project = Project(
        id=uuid4(),
        course_id=course.id,
        group_id=group.id,
        name=f"B Project {tag}",
        setup_status="not_initialized",
        setup_step=0,
        lifecycle="active",
        final_deadline=course.project_deadline,
    )
    session.add(project)
    session.flush()
    for student in students:
        role = "leader" if student is leader else "member"
        session.add(ProjectMember(project_id=project.id, user_id=student.id, role=role))
    session.flush()

    return BWorld(
        teacher_id=teacher.id,
        student_ids=tuple(student.id for student in students),  # type: ignore[arg-type]
        course_id=course.id,
        group_id=group.id,
        project_id=project.id,
    )


def b_test_database_url() -> str:
    url = os.getenv(B_TEST_DATABASE_ENV)
    if not url:
        pytest.skip(f"set {B_TEST_DATABASE_ENV} for real PostgreSQL B tests")
    parsed = make_url(url)
    if parsed.get_backend_name() != "postgresql" or parsed.host not in {
        "localhost",
        "127.0.0.1",
        "::1",
    }:
        pytest.fail(f"{B_TEST_DATABASE_ENV} must name a local PostgreSQL test database")
    return url


@contextmanager
def b_postgres_schema(url: str, *, prefix: str = "b_test_") -> Iterator[Engine]:
    schema = prefix + uuid4().hex
    admin = create_engine(url)
    engine = None
    with admin.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    try:
        # Exclude public so create_all never discovers shared application tables.
        engine = create_engine(
            url, connect_args={"options": f"-csearch_path={schema} -ctimezone=Asia/Shanghai"}
        )
        Base.metadata.create_all(engine)
        yield engine
    finally:
        if engine is not None:
            engine.dispose()
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()
