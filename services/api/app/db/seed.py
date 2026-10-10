from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import (
    AcceptanceCriterion,
    BaselineVersion,
    Course,
    CourseMember,
    CourseStaff,
    FunctionalModule,
    GroupMember,
    Milestone,
    PlanVersion,
    Project,
    ProjectGroup,
    ProjectMember,
    Requirement,
    RequirementSourceReference,
    SourceReference,
    Task,
    TaskAssignee,
    TaskRequirement,
    User,
)

SEED_TIMEZONE = ZoneInfo("Asia/Shanghai")


def _one(session: Session, model: type, *criteria: object) -> object | None:
    return session.scalar(select(model).where(*criteria))


def seed_core(session: Session) -> dict[str, str]:
    """Create one complete core graph; repeated calls reuse existing rows."""

    now = datetime.now(SEED_TIMEZONE)

    teacher = _one(session, User, User.email == "seed.teacher@groupproof.local")
    if teacher is None:
        teacher = User(
            name="Seed Teacher",
            username="seed-teacher",
            email="seed.teacher@groupproof.local",
            college="GroupProof",
            global_role="teacher",
            status="active",
            email_verified_at=now,
        )
        session.add(teacher)
        session.flush()

    student = _one(session, User, User.email == "seed.student@groupproof.local")
    if student is None:
        student = User(
            name="Seed Student",
            username="seed-student",
            email="seed.student@groupproof.local",
            student_id="SEED-001",
            college="GroupProof",
            global_role="student",
            status="active",
            email_verified_at=now,
        )
        session.add(student)
        session.flush()

    course = _one(
        session,
        Course,
        Course.code == "GP-DEMO",
        Course.semester == "2026-Spring",
    )
    if course is None:
        course = Course(
            owner_id=teacher.id,
            code="GP-DEMO",
            name="GroupProof Demo Course",
            college="GroupProof",
            semester="2026-Spring",
            status="active",
            project_deadline=now + timedelta(days=90),
            formation_deadline=now + timedelta(days=14),
            grouping_mode="free",
            min_group_size=1,
            max_group_size=8,
        )
        session.add(course)
        session.flush()

    if session.get(CourseStaff, (course.id, teacher.id)) is None:
        session.add(CourseStaff(course_id=course.id, user_id=teacher.id, role="teacher"))
    if (
        _one(
            session,
            CourseMember,
            CourseMember.course_id == course.id,
            CourseMember.user_id == teacher.id,
        )
        is None
    ):
        session.add(CourseMember(course_id=course.id, user_id=teacher.id, role="teacher"))
    if (
        _one(
            session,
            CourseMember,
            CourseMember.course_id == course.id,
            CourseMember.user_id == student.id,
        )
        is None
    ):
        session.add(CourseMember(course_id=course.id, user_id=student.id, role="student"))
    session.flush()

    group = _one(
        session, ProjectGroup, ProjectGroup.course_id == course.id, ProjectGroup.name == "Seed Team"
    )
    if group is None:
        group = ProjectGroup(
            course_id=course.id,
            leader_id=student.id,
            name="Seed Team",
            direction="Core workflow",
        )
        session.add(group)
        session.flush()
    if (
        _one(
            session,
            GroupMember,
            GroupMember.group_id == group.id,
            GroupMember.user_id == student.id,
        )
        is None
    ):
        session.add(GroupMember(group_id=group.id, user_id=student.id, role="leader"))

    project = _one(session, Project, Project.group_id == group.id)
    if project is None:
        project = Project(
            course_id=course.id,
            group_id=group.id,
            name="Seed Project",
            description="Minimal project graph used to verify the core schema.",
            project_type="web",
            language="en",
            visibility="members",
            setup_status="frozen",
            setup_step=3,
            lifecycle="active",
            final_deadline=now + timedelta(days=90),
        )
        session.add(project)
        session.flush()
    if (
        _one(
            session,
            ProjectMember,
            ProjectMember.project_id == project.id,
            ProjectMember.user_id == student.id,
        )
        is None
    ):
        session.add(ProjectMember(project_id=project.id, user_id=student.id, role="leader"))

    module = _one(
        session,
        FunctionalModule,
        FunctionalModule.project_id == project.id,
        FunctionalModule.name == "Core",
    )
    if module is None:
        module = FunctionalModule(
            project_id=project.id,
            owner_id=student.id,
            name="Core",
            description="Core project workflow",
            core=True,
        )
        session.add(module)
        session.flush()

    requirement = _one(
        session,
        Requirement,
        Requirement.project_id == project.id,
        Requirement.title == "Persist project tasks",
    )
    if requirement is None:
        requirement = Requirement(
            project_id=project.id,
            module_id=module.id,
            title="Persist project tasks",
            description="Users can create and track project tasks.",
            priority="high",
            status="confirmed",
            source_summary="Seed requirement",
            created_by=teacher.id,
        )
        session.add(requirement)
        session.flush()

    source = _one(
        session,
        SourceReference,
        SourceReference.project_id == project.id,
        SourceReference.source_uri == "seed://core-requirement",
    )
    if source is None:
        source = SourceReference(
            project_id=project.id,
            created_by=teacher.id,
            source_type="manual",
            source_uri="seed://core-requirement",
            title="Seed requirement source",
        )
        session.add(source)
        session.flush()
    if session.get(RequirementSourceReference, (requirement.id, source.id)) is None:
        session.add(
            RequirementSourceReference(requirement_id=requirement.id, source_reference_id=source.id)
        )

    milestone = _one(
        session, Milestone, Milestone.project_id == project.id, Milestone.title == "Core milestone"
    )
    if milestone is None:
        milestone = Milestone(
            project_id=project.id,
            title="Core milestone",
            description="Complete the core task workflow.",
            deadline=now + timedelta(days=30),
            status="in_progress",
            progress_percent=0,
        )
        session.add(milestone)
        session.flush()

    task = _one(
        session, Task, Task.project_id == project.id, Task.title == "Create task persistence"
    )
    if task is None:
        task = Task(
            project_id=project.id,
            module_id=module.id,
            created_by=student.id,
            title="Create task persistence",
            description="Create the first persisted task.",
            priority="high",
            weight=1,
            status="not_started",
            progress_percent=0,
        )
        session.add(task)
        session.flush()
    if session.get(TaskRequirement, (task.id, requirement.id)) is None:
        session.add(TaskRequirement(task_id=task.id, requirement_id=requirement.id))
    if session.get(TaskAssignee, (task.id, student.id)) is None:
        session.add(TaskAssignee(task_id=task.id, user_id=student.id, role="responsible"))

    criterion = _one(
        session,
        AcceptanceCriterion,
        AcceptanceCriterion.task_id == task.id,
        AcceptanceCriterion.criterion_key == "AC-1",
    )
    if criterion is None:
        session.add(
            AcceptanceCriterion(
                task_id=task.id,
                criterion_key="AC-1",
                text="The task can be read back from PostgreSQL.",
                weight=1,
                sort_order=1,
            )
        )

    baseline = _one(
        session,
        BaselineVersion,
        BaselineVersion.project_id == project.id,
        BaselineVersion.version_no == 1,
    )
    if baseline is None:
        session.add(
            BaselineVersion(
                project_id=project.id,
                version_no=1,
                created_by=teacher.id,
                status="frozen",
                snapshot_json={"requirements": [str(requirement.id)]},
                confirmed_at=now,
                frozen_at=now,
            )
        )

    plan = _one(
        session, PlanVersion, PlanVersion.project_id == project.id, PlanVersion.version_no == 1
    )
    if plan is None:
        session.add(
            PlanVersion(
                project_id=project.id,
                version_no=1,
                created_by=teacher.id,
                status="frozen",
                snapshot_json={"tasks": [str(task.id)]},
                confirmed_at=now,
                frozen_at=now,
            )
        )

    session.commit()
    return {
        "teacher_id": str(teacher.id),
        "student_id": str(student.id),
        "course_id": str(course.id),
        "group_id": str(group.id),
        "project_id": str(project.id),
        "module_id": str(module.id),
        "requirement_id": str(requirement.id),
        "task_id": str(task.id),
        "milestone_id": str(milestone.id),
    }
