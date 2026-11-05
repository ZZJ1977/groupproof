"""A 模块测试共用：PostgreSQL 事务内的测试数据，结束时整体回滚。

需要 PostgreSQL（CI 的 backend 任务已提供 C_TEST_DATABASE_URL / DATABASE_URL）。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from uuid import UUID, uuid4

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

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


def _database_url() -> str | None:
    url = os.getenv("C_TEST_DATABASE_URL") or os.getenv("DATABASE_URL")
    if url and url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url.removeprefix("postgresql://")
    return url


@pytest.fixture()
def db():
    url = _database_url()
    if not url:
        pytest.skip("set C_TEST_DATABASE_URL or DATABASE_URL to run A PostgreSQL tests")
    engine = create_engine(url)
    with engine.connect() as connection:
        transaction = connection.begin()
        session = Session(
            connection, expire_on_commit=False, join_transaction_mode="create_savepoint"
        )
        try:
            yield session
        finally:
            session.close()
            transaction.rollback()
    engine.dispose()


@dataclass
class Scope:
    users: dict[str, User] = field(default_factory=dict)
    course: Course | None = None
    other_course: Course | None = None
    group: ProjectGroup | None = None
    other_group: ProjectGroup | None = None
    project: Project | None = None
    other_project: Project | None = None
    archived_project: Project | None = None


def make_user(db: Session, key: str, role: str, *, status: str = "active") -> User:
    suffix = uuid4().hex[:10]
    user = User(
        id=uuid4(),
        name=f"{key}-{suffix}",
        email=f"{key}.{suffix}@student.must.edu.mo",
        global_role=role,
        status=status,
    )
    db.add(user)
    db.flush()
    return user


def _course(db: Session, owner: User, code: str) -> Course:
    course = Course(
        id=uuid4(),
        owner_id=owner.id,
        code=f"{code}-{uuid4().hex[:6]}",
        name=f"Course {code}",
        college="FIE",
        semester="2026 Fall",
        status="active",
    )
    db.add(course)
    db.flush()
    return course


def _group(db: Session, course: Course, leader: User, members: list[User]) -> ProjectGroup:
    group = ProjectGroup(
        id=uuid4(), course_id=course.id, leader_id=leader.id, name=f"Team {uuid4().hex[:6]}"
    )
    db.add(group)
    db.flush()
    for user in members:
        role = "leader" if user is leader else "member"
        db.add(GroupMember(id=uuid4(), group_id=group.id, user_id=user.id, role=role))
    db.flush()
    return group


def _project(
    db: Session,
    course: Course,
    group: ProjectGroup,
    members: list[User],
    leader: User,
    *,
    lifecycle: str = "active",
    visibility: str = "members",
) -> Project:
    project = Project(
        id=uuid4(),
        course_id=course.id,
        group_id=group.id,
        name="Project",
        lifecycle=lifecycle,
        visibility=visibility,
    )
    db.add(project)
    db.flush()
    for user in members:
        role = "leader" if user is leader else "member"
        db.add(ProjectMember(id=uuid4(), project_id=project.id, user_id=user.id, role=role))
    db.flush()
    return project


def build_scope(db: Session) -> Scope:
    """两门课：课程 1 有 A 组（leader + member）和 B 组（peer），课程 2 有外课项目。"""
    scope = Scope()
    u = scope.users
    for key, role in [
        ("teacher", "teacher"),
        ("other_teacher", "teacher"),
        ("ta", "ta"),
        ("unassigned_ta", "ta"),
        ("leader", "student"),
        ("member", "student"),
        ("peer", "student"),
        ("outsider", "student"),
        ("admin", "admin"),
    ]:
        u[key] = make_user(db, key, role)
    u["disabled"] = make_user(db, "disabled", "student", status="disabled")

    scope.course = _course(db, u["teacher"], "SE")
    scope.other_course = _course(db, u["other_teacher"], "OS")
    db.add(CourseStaff(course_id=scope.course.id, user_id=u["ta"].id, role="ta"))
    for key in ("leader", "member", "peer", "disabled"):
        db.add(
            CourseMember(
                id=uuid4(),
                course_id=scope.course.id,
                user_id=u[key].id,
                role="student",
                status="active",
            )
        )
    db.add(
        CourseMember(
            id=uuid4(),
            course_id=scope.other_course.id,
            user_id=u["outsider"].id,
            role="student",
            status="active",
        )
    )
    db.flush()
    team = [u["leader"], u["member"], u["disabled"]]
    scope.group = _group(db, scope.course, u["leader"], team)
    scope.other_group = _group(db, scope.course, u["peer"], [u["peer"]])
    scope.project = _project(db, scope.course, scope.group, team, u["leader"], visibility="course")
    scope.other_project = _project(db, scope.course, scope.other_group, [u["peer"]], u["peer"])
    archived_group = _group(db, scope.course, u["leader"], team)
    scope.archived_project = _project(
        db, scope.course, archived_group, team, u["leader"], lifecycle="archived"
    )
    outsider_group = _group(db, scope.other_course, u["outsider"], [u["outsider"]])
    _project(db, scope.other_course, outsider_group, [u["outsider"]], u["outsider"])
    return scope


@pytest.fixture()
def scope(db) -> Scope:
    return build_scope(db)


def ids(*values: UUID) -> list[str]:
    return [str(v) for v in values]
