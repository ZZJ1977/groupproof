"""Idempotent daily risk detection from current project facts."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import (
    Milestone,
    ProgressEvent,
    Project,
    ProjectMember,
    Task,
    TaskAssignee,
    TaskMilestone,
)
from app.modules.c.models import Evidence
from app.modules.d.models import Risk, RiskEvent


def run_daily_risk_checks(session: Session, now: datetime | None = None) -> int:
    # One transaction across scheduler replicas; retries remain safe.
    if session.bind.dialect.name == "postgresql" and not session.scalar(
        select(func.pg_try_advisory_xact_lock(74190322))
    ):
        return 0
    now = now or datetime.now(UTC)
    day = now.date()
    created = 0
    projects = session.scalars(select(Project).where(Project.lifecycle == "active")).all()
    for project in projects:
        members = session.scalars(
            select(ProjectMember).where(
                ProjectMember.project_id == project.id, ProjectMember.left_at.is_(None)
            )
        ).all()
        if not members:
            continue
        owner_id = next(
            (member.user_id for member in members if member.role == "leader"), members[0].user_id
        )
        if owner_id is None:
            continue
        milestones = session.scalars(
            select(Milestone).where(Milestone.project_id == project.id)
        ).all()
        tasks = session.scalars(select(Task).where(Task.project_id == project.id)).all()
        candidates: list[tuple[str, str, str, object | None, object | None, object]] = []
        for milestone in milestones:
            if milestone.status == "completed" or milestone.deadline is None:
                continue
            deadline = milestone.deadline
            if deadline.tzinfo is None:
                deadline = deadline.replace(tzinfo=UTC)
            if deadline < now:
                candidates.append(
                    (
                        "milestone_overdue",
                        "high",
                        "Milestone deadline passed",
                        None,
                        milestone.id,
                        owner_id,
                    )
                )
            elif deadline <= now + timedelta(days=7) and milestone.progress_percent < 50:
                candidates.append(
                    (
                        "milestone_low_progress",
                        "medium",
                        "Milestone is due within seven days and progress is below 50%",
                        None,
                        milestone.id,
                        owner_id,
                    )
                )
        links = (
            session.scalars(
                select(TaskMilestone).where(
                    TaskMilestone.milestone_id.in_([milestone.id for milestone in milestones])
                )
            ).all()
            if milestones
            else []
        )
        milestone_by_id = {milestone.id: milestone for milestone in milestones}
        deadline_by_task = {
            link.task_id: milestone_by_id[link.milestone_id].deadline for link in links
        }
        for task in tasks:
            if task.status == "completed":
                continue
            deadline = deadline_by_task.get(task.id)
            if deadline is not None:
                if deadline.tzinfo is None:
                    deadline = deadline.replace(tzinfo=UTC)
                if deadline < now:
                    candidates.append(
                        (
                            "task_overdue",
                            "high",
                            "Task milestone deadline passed",
                            task.id,
                            None,
                            owner_id,
                        )
                    )
        assignees = session.scalars(
            select(TaskAssignee)
            .join(Task, Task.id == TaskAssignee.task_id)
            .where(
                Task.project_id == project.id,
                Task.status != "completed",
                TaskAssignee.unassigned_at.is_(None),
            )
        ).all()
        by_member: dict[object, list[TaskAssignee]] = {}
        for assignee in assignees:
            by_member.setdefault(assignee.user_id, []).append(assignee)
        for member_id, assignments in by_member.items():
            last_evidence = session.scalar(
                select(Evidence.created_at)
                .where(Evidence.project_id == project.id, Evidence.author_id == member_id)
                .order_by(Evidence.created_at.desc())
                .limit(1)
            )
            last_submission = session.scalar(
                select(ProgressEvent.created_at)
                .where(
                    ProgressEvent.project_id == project.id,
                    ProgressEvent.actor_id == member_id,
                    ProgressEvent.to_status == "pending_submission",
                )
                .order_by(ProgressEvent.created_at.desc())
                .limit(1)
            )
            last = max(
                [
                    value.replace(tzinfo=UTC) if value.tzinfo is None else value
                    for value in [
                        last_evidence,
                        last_submission,
                        *(item.assigned_at for item in assignments),
                    ]
                    if value is not None
                ],
                default=now,
            )
            if last <= now - timedelta(days=7):
                candidates.append(
                    (
                        f"member_inactive:{member_id}",
                        "medium",
                        "Member has not submitted task evidence for seven days",
                        assignments[0].task_id,
                        None,
                        member_id,
                    )
                )
        for kind, level, description, task_id, milestone_id, risk_owner in candidates:
            # A stable title makes retries and subsequent daily runs idempotent while
            # the issue remains open. A closed issue can be raised again later.
            title = f"auto:{kind}:{task_id or milestone_id}"
            exists = session.scalar(
                select(Risk.id).where(
                    Risk.project_id == project.id, Risk.title == title, Risk.status != "closed"
                )
            )
            if exists:
                continue
            risk = Risk(
                project_id=project.id,
                task_id=task_id,
                milestone_id=milestone_id,
                owner_id=risk_owner,
                title=title,
                description=description,
                level=level,
                status="open",
            )
            session.add(risk)
            session.flush()
            session.add(
                RiskEvent(
                    risk_id=risk.id,
                    actor_id=owner_id,
                    event_type="created",
                    note=f"Daily check {day}: {description}",
                )
            )
            created += 1
    session.commit()
    return created
