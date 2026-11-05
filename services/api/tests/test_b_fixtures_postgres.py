"""B0: b_fixtures builds the shared B graph in real PostgreSQL.

Opt-in with B_TEST_DATABASE_URL (a local test database). Each test runs in its
own schema created and dropped by the fixture.
"""

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.models import SchoolEmailBinding
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
from tests.b_fixtures import b_postgres_schema, b_test_database_url, build_b_world


@pytest.fixture
def b_engine(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    with b_postgres_schema(b_test_database_url()) as engine:
        yield engine


def test_build_b_world_creates_one_course_teacher_four_students_group_and_project(b_engine):
    with Session(b_engine) as session:
        world = build_b_world(session)
        session.commit()

    with Session(b_engine) as session:
        assert session.scalar(select(func.count()).select_from(Course)) == 1
        assert session.scalar(select(func.count()).select_from(ProjectGroup)) == 1
        assert session.scalar(select(func.count()).select_from(Project)) == 1
        teachers = session.scalars(select(User).where(User.global_role == "teacher")).all()
        students = session.scalars(select(User).where(User.global_role == "student")).all()
        assert [t.id for t in teachers] == [world.teacher_id]
        assert {s.id for s in students} == set(world.student_ids)
        assert len(students) == 4

        course = session.get(Course, world.course_id)
        assert course.status == "active" and course.owner_id == world.teacher_id
        staff = session.scalars(select(CourseStaff.user_id)).all()
        assert staff == [world.teacher_id]
        course_students = session.scalars(
            select(CourseMember.user_id).where(
                CourseMember.course_id == world.course_id,
                CourseMember.role == "student",
                CourseMember.left_at.is_(None),
            )
        ).all()
        assert set(course_students) == set(world.student_ids)

        group = session.get(ProjectGroup, world.group_id)
        assert group.leader_id == world.leader_id
        roles = dict(session.execute(select(GroupMember.user_id, GroupMember.role)).all())
        assert roles[world.leader_id] == "leader"
        assert all(roles[m] == "member" for m in world.member_ids)

        project = session.get(Project, world.project_id)
        assert project.group_id == world.group_id and project.course_id == world.course_id
        assert project.setup_status == "not_initialized"
        assert project.final_deadline == course.project_deadline
        project_members = set(session.scalars(select(ProjectMember.user_id)).all())
        assert project_members == set(world.student_ids)

        bindings = session.scalars(select(SchoolEmailBinding.user_id)).all()
        assert set(bindings) == {world.teacher_id, *world.student_ids}


def test_two_worlds_do_not_collide(b_engine):
    with Session(b_engine) as session:
        first = build_b_world(session)
        second = build_b_world(session)
        session.commit()
    assert first.course_id != second.course_id
    assert not set(first.student_ids) & set(second.student_ids)
    with Session(b_engine) as session:
        assert session.scalar(select(func.count()).select_from(Project)) == 2
