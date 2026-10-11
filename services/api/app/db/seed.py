from __future__ import annotations

import os
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import (
    AcceptanceCriterion,
    BaselineConfirmation,
    BaselineVersion,
    ConflictResolution,
    Course,
    CourseMember,
    CourseStaff,
    FunctionalModule,
    GroupMember,
    Milestone,
    PlanConfirmation,
    PlanVersion,
    ProgressEvent,
    Project,
    ProjectGroup,
    ProjectMember,
    Requirement,
    RequirementConflict,
    RequirementSourceReference,
    SourceReference,
    Task,
    TaskAssignee,
    TaskDependency,
    TaskMilestone,
    TaskRequirement,
    User,
)

SEED_TIMEZONE = ZoneInfo("Asia/Shanghai")
ALLOWED_SEED_ENVIRONMENTS = frozenset({"development", "test"})


class SeedEnvironmentError(RuntimeError):
    """Raised when demo data is requested outside a non-production environment."""


def require_seed_environment(environment: str | None = None) -> str:
    """Return a safe seed environment or fail closed for staging/production."""

    configured_environment = os.getenv("APP_ENV")
    if (
        configured_environment is not None
        and environment is not None
        and configured_environment != environment
    ):
        raise SeedEnvironmentError(
            f"Seed environment {environment!r} does not match APP_ENV={configured_environment!r}."
        )
    active_environment = environment or configured_environment
    if active_environment not in ALLOWED_SEED_ENVIRONMENTS:
        allowed = ", ".join(sorted(ALLOWED_SEED_ENVIRONMENTS))
        raise SeedEnvironmentError(
            f"Demo seed is disabled for APP_ENV={active_environment!r}; "
            f"set APP_ENV to one of: {allowed}."
        )
    return active_environment


def _one(session: Session, model: type, *criteria: object) -> object | None:
    return session.scalar(select(model).where(*criteria))


def _get_or_create(session: Session, model: type, *criteria: object, **values: object) -> object:
    existing = _one(session, model, *criteria)
    if existing is not None:
        return existing
    created = model(**values)
    session.add(created)
    session.flush()
    return created


def _link_if_missing(
    session: Session, model: type, identity: tuple[object, ...], **values: object
) -> object:
    existing = session.get(model, identity)
    if existing is not None:
        return existing
    created = model(**values)
    session.add(created)
    session.flush()
    return created


def seed_core(session: Session, *, environment: str | None = None) -> dict[str, str]:
    """Create a complete, repeatable demo graph for local development and tests.

    The current schema intentionally stops at the core project workflow. This fixture
    therefore covers every persisted core table (identity, course/group/project,
    planning, tasks, confirmations and progress events) while leaving external
    integrations and file records to their own feature migrations.
    """

    active_environment = require_seed_environment(environment)
    now = datetime.now(SEED_TIMEZONE)

    teacher = _get_or_create(
        session,
        User,
        User.email == "seed.teacher@groupproof.local",
        name="Seed Teacher",
        username="seed-teacher",
        email="seed.teacher@groupproof.local",
        college="GroupProof",
        global_role="teacher",
        status="active",
        email_verified_at=now,
        avatar_color="#dce9ff",
    )
    student = _get_or_create(
        session,
        User,
        User.email == "seed.student@groupproof.local",
        name="Seed Student",
        username="seed-student",
        email="seed.student@groupproof.local",
        student_id="SEED-001",
        college="GroupProof",
        global_role="student",
        status="active",
        email_verified_at=now,
        avatar_color="#dcf4eb",
    )
    reviewer = _get_or_create(
        session,
        User,
        User.email == "seed.reviewer@groupproof.local",
        name="Seed Reviewer",
        username="seed-reviewer",
        email="seed.reviewer@groupproof.local",
        student_id="SEED-002",
        college="GroupProof",
        global_role="student",
        status="active",
        email_verified_at=now,
        avatar_color="#ede3fa",
    )
    admin = _get_or_create(
        session,
        User,
        User.email == "seed.admin@groupproof.local",
        name="Seed Admin",
        username="seed-admin",
        email="seed.admin@groupproof.local",
        college="GroupProof",
        global_role="admin",
        status="active",
        email_verified_at=now,
        avatar_color="#ffe8db",
    )

    course = _get_or_create(
        session,
        Course,
        Course.code == "GP-DEMO",
        Course.semester == "2026-Spring",
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
    _link_if_missing(
        session,
        CourseStaff,
        (course.id, teacher.id),
        course_id=course.id,
        user_id=teacher.id,
        role="teacher",
    )
    for member, role in (
        (teacher, "teacher"),
        (student, "student"),
        (reviewer, "student"),
    ):
        _get_or_create(
            session,
            CourseMember,
            CourseMember.course_id == course.id,
            CourseMember.user_id == member.id,
            course_id=course.id,
            user_id=member.id,
            role=role,
            status="active",
        )

    group = _get_or_create(
        session,
        ProjectGroup,
        ProjectGroup.course_id == course.id,
        ProjectGroup.name == "Seed Team",
        course_id=course.id,
        leader_id=student.id,
        name="Seed Team",
        direction="Evidence-driven project workflow",
        roster_frozen=False,
    )
    _get_or_create(
        session,
        GroupMember,
        GroupMember.group_id == group.id,
        GroupMember.user_id == student.id,
        group_id=group.id,
        user_id=student.id,
        role="leader",
    )
    _get_or_create(
        session,
        GroupMember,
        GroupMember.group_id == group.id,
        GroupMember.user_id == reviewer.id,
        group_id=group.id,
        user_id=reviewer.id,
        role="member",
    )

    project = _get_or_create(
        session,
        Project,
        Project.group_id == group.id,
        course_id=course.id,
        group_id=group.id,
        name="Seed Project",
        description="Demo graph used to exercise the core project workflow.",
        project_type="web",
        language="en",
        visibility="members",
        setup_status="frozen",
        setup_step=3,
        lifecycle="active",
        final_deadline=now + timedelta(days=90),
    )
    _get_or_create(
        session,
        ProjectMember,
        ProjectMember.project_id == project.id,
        ProjectMember.user_id == student.id,
        project_id=project.id,
        user_id=student.id,
        role="leader",
    )
    _get_or_create(
        session,
        ProjectMember,
        ProjectMember.project_id == project.id,
        ProjectMember.user_id == reviewer.id,
        project_id=project.id,
        user_id=reviewer.id,
        role="member",
    )

    core_module = _get_or_create(
        session,
        FunctionalModule,
        FunctionalModule.project_id == project.id,
        FunctionalModule.name == "Core workflow",
        project_id=project.id,
        owner_id=student.id,
        name="Core workflow",
        description="Persist the project and task workflow.",
        core=True,
        progress_percent=100,
        sort_order=1,
    )
    evidence_module = _get_or_create(
        session,
        FunctionalModule,
        FunctionalModule.project_id == project.id,
        FunctionalModule.name == "Evidence and review",
        project_id=project.id,
        owner_id=reviewer.id,
        name="Evidence and review",
        description="Trace acceptance criteria to review decisions.",
        core=True,
        progress_percent=25,
        sort_order=2,
    )

    requirement = _get_or_create(
        session,
        Requirement,
        Requirement.project_id == project.id,
        Requirement.title == "Persist project tasks",
        project_id=project.id,
        module_id=core_module.id,
        title="Persist project tasks",
        description="Users can create and track project tasks.",
        priority="high",
        status="confirmed",
        source_summary="Seed requirement",
        created_by=teacher.id,
    )
    evidence_requirement = _get_or_create(
        session,
        Requirement,
        Requirement.project_id == project.id,
        Requirement.title == "Trace acceptance evidence",
        project_id=project.id,
        module_id=evidence_module.id,
        title="Trace acceptance evidence",
        description="Every acceptance criterion can point to reviewable evidence.",
        priority="medium",
        status="in_progress",
        source_summary="Seed evidence requirement",
        created_by=teacher.id,
    )

    source = _get_or_create(
        session,
        SourceReference,
        SourceReference.project_id == project.id,
        SourceReference.source_uri == "seed://core-requirement",
        project_id=project.id,
        created_by=teacher.id,
        source_type="manual",
        source_uri="seed://core-requirement",
        title="Seed requirement source",
        metadata_json={"seed": True, "environment": active_environment},
    )
    evidence_source = _get_or_create(
        session,
        SourceReference,
        SourceReference.project_id == project.id,
        SourceReference.source_uri == "seed://evidence-requirement",
        project_id=project.id,
        created_by=teacher.id,
        source_type="manual",
        source_uri="seed://evidence-requirement",
        title="Seed evidence source",
        metadata_json={"seed": True, "environment": active_environment},
    )
    _link_if_missing(
        session,
        RequirementSourceReference,
        (requirement.id, source.id),
        requirement_id=requirement.id,
        source_reference_id=source.id,
        relation_type="supports",
    )
    _link_if_missing(
        session,
        RequirementSourceReference,
        (evidence_requirement.id, evidence_source.id),
        requirement_id=evidence_requirement.id,
        source_reference_id=evidence_source.id,
        relation_type="supports",
    )

    conflict = _get_or_create(
        session,
        RequirementConflict,
        RequirementConflict.project_id == project.id,
        RequirementConflict.left_requirement_id == requirement.id,
        RequirementConflict.right_requirement_id == evidence_requirement.id,
        project_id=project.id,
        left_requirement_id=requirement.id,
        right_requirement_id=evidence_requirement.id,
        conflict_type="scope",
        description=(
            "The two requirements share the task workflow but have separate acceptance owners."
        ),
        status="resolved",
    )
    _get_or_create(
        session,
        ConflictResolution,
        ConflictResolution.conflict_id == conflict.id,
        ConflictResolution.resolved_by == teacher.id,
        conflict_id=conflict.id,
        resolved_by=teacher.id,
        decision="keep_both",
        reason="Keep both requirements and separate their acceptance criteria.",
    )

    milestone = _get_or_create(
        session,
        Milestone,
        Milestone.project_id == project.id,
        Milestone.title == "Core milestone",
        project_id=project.id,
        title="Core milestone",
        description="Complete the persisted task workflow.",
        deadline=now + timedelta(days=30),
        status="completed",
        progress_percent=100,
        sort_order=1,
    )
    evidence_milestone = _get_or_create(
        session,
        Milestone,
        Milestone.project_id == project.id,
        Milestone.title == "Evidence milestone",
        project_id=project.id,
        title="Evidence milestone",
        description="Review the first acceptance evidence.",
        deadline=now + timedelta(days=45),
        status="in_progress",
        progress_percent=25,
        sort_order=2,
    )

    task = _get_or_create(
        session,
        Task,
        Task.project_id == project.id,
        Task.title == "Create task persistence",
        project_id=project.id,
        module_id=core_module.id,
        created_by=student.id,
        title="Create task persistence",
        description="Create the first persisted task.",
        priority="high",
        weight=1,
        status="completed",
        progress_percent=100,
        started_at=now - timedelta(days=3),
        completed_at=now - timedelta(days=2),
    )
    evidence_task = _get_or_create(
        session,
        Task,
        Task.project_id == project.id,
        Task.title == "Capture acceptance evidence",
        project_id=project.id,
        module_id=evidence_module.id,
        parent_task_id=task.id,
        created_by=student.id,
        title="Capture acceptance evidence",
        description="Attach evidence to the acceptance criteria.",
        priority="medium",
        weight=1,
        status="in_progress",
        progress_percent=25,
        started_at=now - timedelta(days=1),
    )
    review_task = _get_or_create(
        session,
        Task,
        Task.project_id == project.id,
        Task.title == "Review acceptance evidence",
        project_id=project.id,
        module_id=evidence_module.id,
        parent_task_id=evidence_task.id,
        created_by=reviewer.id,
        title="Review acceptance evidence",
        description="Review the submitted evidence and record a decision.",
        priority="medium",
        weight=1,
        status="not_started",
        progress_percent=0,
    )
    for current_task, current_requirement in (
        (task, requirement),
        (evidence_task, evidence_requirement),
        (review_task, evidence_requirement),
    ):
        _link_if_missing(
            session,
            TaskRequirement,
            (current_task.id, current_requirement.id),
            task_id=current_task.id,
            requirement_id=current_requirement.id,
            relation_type="implements",
        )
    _link_if_missing(
        session,
        TaskAssignee,
        (task.id, student.id),
        task_id=task.id,
        user_id=student.id,
        role="responsible",
    )
    _link_if_missing(
        session,
        TaskAssignee,
        (evidence_task.id, student.id),
        task_id=evidence_task.id,
        user_id=student.id,
        role="responsible",
    )
    _link_if_missing(
        session,
        TaskAssignee,
        (review_task.id, reviewer.id),
        task_id=review_task.id,
        user_id=reviewer.id,
        role="reviewer",
    )
    _link_if_missing(
        session,
        TaskDependency,
        (evidence_task.id, task.id),
        task_id=evidence_task.id,
        depends_on_task_id=task.id,
        dependency_type="blocks",
    )
    _link_if_missing(
        session,
        TaskDependency,
        (review_task.id, evidence_task.id),
        task_id=review_task.id,
        depends_on_task_id=evidence_task.id,
        dependency_type="blocks",
    )

    for current_task, key, criterion_text in (
        (task, "AC-1", "The task can be read back from PostgreSQL."),
        (evidence_task, "AC-1", "Evidence can be associated with the task."),
        (review_task, "AC-1", "A reviewer can record an acceptance decision."),
    ):
        _get_or_create(
            session,
            AcceptanceCriterion,
            AcceptanceCriterion.task_id == current_task.id,
            AcceptanceCriterion.criterion_key == key,
            task_id=current_task.id,
            criterion_key=key,
            text=criterion_text,
            weight=1,
            sort_order=1,
        )
    _get_or_create(
        session,
        AcceptanceCriterion,
        AcceptanceCriterion.task_id == task.id,
        AcceptanceCriterion.criterion_key == "AC-2",
        task_id=task.id,
        criterion_key="AC-2",
        text="Task progress stays between 0 and 100 percent.",
        weight=1,
        sort_order=2,
    )
    _link_if_missing(
        session,
        TaskMilestone,
        (task.id, milestone.id),
        task_id=task.id,
        milestone_id=milestone.id,
    )
    _link_if_missing(
        session,
        TaskMilestone,
        (evidence_task.id, evidence_milestone.id),
        task_id=evidence_task.id,
        milestone_id=evidence_milestone.id,
    )
    _link_if_missing(
        session,
        TaskMilestone,
        (review_task.id, evidence_milestone.id),
        task_id=review_task.id,
        milestone_id=evidence_milestone.id,
    )

    baseline = _get_or_create(
        session,
        BaselineVersion,
        BaselineVersion.project_id == project.id,
        BaselineVersion.version_no == 1,
        project_id=project.id,
        version_no=1,
        created_by=teacher.id,
        status="frozen",
        snapshot_json={"requirements": [str(requirement.id), str(evidence_requirement.id)]},
        confirmed_at=now - timedelta(days=1),
        frozen_at=now - timedelta(days=1),
    )
    for member in (student, reviewer):
        _get_or_create(
            session,
            BaselineConfirmation,
            BaselineConfirmation.baseline_version_id == baseline.id,
            BaselineConfirmation.user_id == member.id,
            baseline_version_id=baseline.id,
            user_id=member.id,
            status="confirmed",
            comment="Seed member confirmed the baseline.",
            confirmed_at=now - timedelta(days=1),
        )
    plan = _get_or_create(
        session,
        PlanVersion,
        PlanVersion.project_id == project.id,
        PlanVersion.version_no == 1,
        project_id=project.id,
        version_no=1,
        created_by=teacher.id,
        status="frozen",
        snapshot_json={
            "tasks": [str(task.id), str(evidence_task.id), str(review_task.id)],
            "milestones": [str(milestone.id), str(evidence_milestone.id)],
        },
        confirmed_at=now - timedelta(hours=12),
        frozen_at=now - timedelta(hours=12),
    )
    for member in (student, reviewer):
        _get_or_create(
            session,
            PlanConfirmation,
            PlanConfirmation.plan_version_id == plan.id,
            PlanConfirmation.user_id == member.id,
            plan_version_id=plan.id,
            user_id=member.id,
            status="confirmed",
            comment="Seed member confirmed the plan.",
            confirmed_at=now - timedelta(hours=12),
        )
    _get_or_create(
        session,
        ProgressEvent,
        ProgressEvent.task_id == task.id,
        ProgressEvent.reason.in_(("seed:task-start", "seed:task-complete", "seed:task-progress")),
        project_id=project.id,
        task_id=task.id,
        actor_id=student.id,
        from_status="in_progress",
        to_status="completed",
        progress_before=80,
        progress_after=100,
        reason="seed:task-progress",
    )

    session.commit()
    return {
        "environment": active_environment,
        "teacher_id": str(teacher.id),
        "student_id": str(student.id),
        "reviewer_id": str(reviewer.id),
        "admin_id": str(admin.id),
        "course_id": str(course.id),
        "group_id": str(group.id),
        "project_id": str(project.id),
        "module_id": str(core_module.id),
        "evidence_module_id": str(evidence_module.id),
        "requirement_id": str(requirement.id),
        "evidence_requirement_id": str(evidence_requirement.id),
        "milestone_id": str(milestone.id),
        "evidence_milestone_id": str(evidence_milestone.id),
        "task_id": str(task.id),
        "evidence_task_id": str(evidence_task.id),
        "review_task_id": str(review_task.id),
        "baseline_id": str(baseline.id),
        "plan_id": str(plan.id),
    }
