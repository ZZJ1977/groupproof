"""C2 task execution with PostgreSQL locking and append-only progress events.

Only execution fields are mutated. Task planning, evidence completeness, and D's
verification decisions are separate capabilities. The service commits the entire
execution change, rollup and event together; a failure rolls all of them back.
"""

from dataclasses import dataclass
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Protocol
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import (
    Course,
    FunctionalModule,
    PlanVersion,
    ProgressEvent,
    Project,
    Task,
    TaskAssignee,
    TaskDependency,
    User,
)
from app.modules.c.execution_schemas import (
    PrepareSubmissionRequest,
    PrepareSubmissionView,
    TaskDependencyView,
    TaskExecutionView,
    TaskStatus,
)
from app.modules.c.integration_events import claim_request, emit_event, finish_request
from app.modules.c.note_service import get_note, save_note
from app.modules.c.permissions import (
    ExecutionPermissions,
    execution_permissions,
    get_project_access,
    require_execution_write,
    require_read,
    require_task_plan,
    require_verified_email,
    task_in_frozen_plan,
)
from app.modules.c.school_email import has_verified_school_email

BEIJING = ZoneInfo("Asia/Shanghai")
TASK_STATUSES = frozenset(
    {"not_started", "in_progress", "pending_submission", "pending_verification", "completed"}
)
ALLOWED_TRANSITIONS = {
    "not_started": {"in_progress"},
    "in_progress": {"pending_submission"},
    "pending_submission": {"in_progress", "pending_verification"},
    "pending_verification": {"in_progress", "completed"},
    "completed": {"in_progress"},
}


@dataclass
class ExecutionScope:
    task: Task
    project: Project
    course: Course | None
    permissions: ExecutionPermissions
    tasks: list[Task]
    modules: list[FunctionalModule]
    responsible_ids: list[UUID]
    dependency_ids: list[UUID]
    latest_plan: PlanVersion | None = None


class ExecutionRepository(Protocol):
    def load(self, task_id: UUID, user: User, *, lock: bool) -> ExecutionScope: ...

    def add_event(self, event: ProgressEvent) -> None: ...

    def commit(self) -> None: ...

    def rollback(self) -> None: ...


class TransitionProvider(Protocol):
    """Trusted in-process B/C/D adapter, never populated from an HTTP request.

    Must verify current persisted completeness/verification facts and register any
    invalidation in the caller's transaction. A provider that merely trusts a bool
    from the browser does not satisfy this contract. No default provider exists.
    """

    def authorize(
        self, scope: ExecutionScope, user: User, target: TaskStatus, reason: str
    ) -> None: ...


class SqlExecutionRepository:
    def __init__(self, session: Session):
        self.session = session

    def _scalar(self, statement, *, lock: bool = False):
        if lock:
            statement = statement.with_for_update(read=True)
        return self.session.scalar(statement.execution_options(populate_existing=True))

    def load(self, task_id: UUID, user: User, *, lock: bool) -> ExecutionScope:
        task = self._scalar(select(Task).where(Task.id == task_id))
        if task is None:
            raise ApiError(404, "TASK_NOT_FOUND", "Task not found.")
        # All C execution writers lock the project first, then tasks in UUID order.
        # This prevents concurrent sibling updates from losing a parent rollup.
        access = get_project_access(self.session, user, task.project_id, lock=lock)
        project, course = access.project, access.course
        assignees_query = select(TaskAssignee).where(
            TaskAssignee.task_id == task_id,
            TaskAssignee.role == "responsible",
            TaskAssignee.unassigned_at.is_(None),
        )
        if lock:
            assignees_query = assignees_query.with_for_update(read=True)
        assignees = list(self.session.scalars(assignees_query))
        responsible_ids = sorted((item.user_id for item in assignees), key=str)
        permissions = execution_permissions(
            user,
            active_member=access.member,
            responsible=user.id in responsible_ids,
            project_leader=access.leader,
            course_teacher=access.teacher,
            active_course_staff=access.staff,
            email_verified=has_verified_school_email(self.session, user, lock=lock),
        )
        require_read(permissions)
        tasks_query = select(Task).where(Task.project_id == project.id).order_by(Task.id)
        modules_query = (
            select(FunctionalModule)
            .where(FunctionalModule.project_id == project.id)
            .order_by(FunctionalModule.id)
        )
        if lock:
            tasks_query = tasks_query.with_for_update()
            modules_query = modules_query.with_for_update()
        tasks = list(self.session.scalars(tasks_query.execution_options(populate_existing=True)))
        task = next((item for item in tasks if item.id == task_id), None)
        if task is None:
            raise ApiError(409, "TASK_CONTEXT_CHANGED", "Task context changed. Refresh and retry.")
        dependency_query = select(TaskDependency).where(TaskDependency.task_id == task_id)
        if lock:
            dependency_query = dependency_query.with_for_update(read=True)
        dependencies = list(self.session.scalars(dependency_query))
        return ExecutionScope(
            task=task,
            project=project,
            course=course,
            permissions=permissions,
            tasks=tasks,
            modules=list(
                self.session.scalars(modules_query.execution_options(populate_existing=True))
            ),
            responsible_ids=responsible_ids,
            dependency_ids=sorted((item.depends_on_task_id for item in dependencies), key=str),
            latest_plan=access.latest_plan,
        )

    def add_event(self, event: ProgressEvent) -> None:
        self.session.add(event)

    def commit(self) -> None:
        self.session.commit()

    def rollback(self) -> None:
        self.session.rollback()


def weighted_progress(tasks: list[Task], values: dict[UUID, int]) -> int | None:
    total = sum((Decimal(str(task.weight)) for task in tasks), Decimal(0))
    if total <= 0:
        return None
    result = (
        sum((Decimal(str(task.weight)) * values[task.id] for task in tasks), Decimal(0)) / total
    )
    return int(result.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def progress_projection(tasks: list[Task]) -> tuple[dict[UUID, int], int | None]:
    """Evaluate children once, then weight only roots: no parent/child double counting."""
    by_id = {task.id: task for task in tasks}
    children: dict[UUID, list[Task]] = {}
    for task in tasks:
        if task.parent_task_id:
            if task.parent_task_id not in by_id:
                raise ApiError(409, "INVALID_TASK_TREE", "Task parent is outside this project.")
            children.setdefault(task.parent_task_id, []).append(task)
    values: dict[UUID, int] = {}
    visiting: set[UUID] = set()

    def visit(task: Task) -> int:
        if task.id in visiting:
            raise ApiError(409, "INVALID_TASK_TREE", "Task hierarchy contains a cycle.")
        if task.id in values:
            return values[task.id]
        visiting.add(task.id)
        nested = children.get(task.id, [])
        for child in nested:
            visit(child)
        aggregate = weighted_progress(nested, values) if nested else None
        values[task.id] = task.progress_percent if aggregate is None else aggregate
        visiting.remove(task.id)
        return values[task.id]

    for task in tasks:
        visit(task)
    roots = [task for task in tasks if task.parent_task_id is None]
    return values, weighted_progress(roots, values)


def _is_writable(scope: ExecutionScope) -> bool:
    return (
        scope.project.lifecycle == "active"
        and scope.project.setup_status == "frozen"
        and (scope.course is None or scope.course.status == "active")
        and task_in_frozen_plan(scope.latest_plan, scope.task.id)
    )


def module_roots(tasks: list[Task], module_id: UUID) -> list[Task]:
    """Include module tasks whose ancestors do not already represent this module.

    The canonical seed permits a subtask in a different module from its parent.
    Filtering only project roots would silently leave that module unaggregated.
    Call after progress_projection has validated the tree.
    """
    by_id = {task.id: task for task in tasks}
    roots = []
    for task in tasks:
        if task.module_id != module_id:
            continue
        parent_id = task.parent_task_id
        while parent_id and by_id[parent_id].module_id != module_id:
            parent_id = by_id[parent_id].parent_task_id
        if parent_id is None:
            roots.append(task)
    return roots


def execution_view(scope: ExecutionScope) -> TaskExecutionView:
    by_id = {task.id: task for task in scope.tasks}
    dependencies = [
        TaskDependencyView(
            task_id=task_id,
            status=by_id[task_id].status if task_id in by_id else None,
            satisfied=task_id in by_id and by_id[task_id].status == "completed",
        )
        for task_id in scope.dependency_ids
    ]
    values, overall = progress_projection(scope.tasks)
    task = scope.task
    return TaskExecutionView(
        task_id=task.id,
        project_id=task.project_id,
        status=task.status,
        progress=values[task.id],
        version=task.lock_version,
        started_at=task.started_at,
        completed_at=task.completed_at,
        responsible_ids=scope.responsible_ids,
        dependencies=dependencies,
        project_progress=overall,
        module_progress={
            str(module.id): weighted_progress(module_roots(scope.tasks, module.id), values)
            for module in scope.modules
        },
        can_start=_is_writable(scope)
        and scope.permissions.can_start
        and task.status == "not_started"
        and all(item.satisfied for item in dependencies),
        can_update_progress=_is_writable(scope)
        and scope.permissions.can_update_progress
        and task.status in {"in_progress", "pending_submission"}
        and not any(item.parent_task_id == task.id for item in scope.tasks),
        read_only=not _is_writable(scope),
    )


class TaskExecutionService:
    def __init__(self, repository: ExecutionRepository):
        self.repository = repository

    def read(self, task_id: UUID, user: User) -> TaskExecutionView:
        scope = self.repository.load(task_id, user, lock=False)
        require_read(scope.permissions)
        return execution_view(scope)

    @staticmethod
    def _version(task: Task, expected_version: int) -> None:
        if type(expected_version) is not int or expected_version < 0:
            raise ApiError(422, "VALIDATION_ERROR", "A non-negative integer version is required.")
        if task.lock_version != expected_version:
            raise ApiError(
                409,
                "VERSION_CONFLICT",
                "Task changed. Refresh and retry.",
                {"expected_version": expected_version, "current_version": task.lock_version},
            )

    @staticmethod
    def _reason(reason: str) -> str:
        if not isinstance(reason, str) or not reason.strip() or len(reason.strip()) > 2000:
            raise ApiError(422, "VALIDATION_ERROR", "A reason of 1 to 2000 characters is required.")
        return reason.strip()

    def _event(
        self, task: Task, user: User, status_before: str, progress_before: int, reason: str
    ) -> None:
        self.repository.add_event(
            ProgressEvent(
                id=uuid4(),
                project_id=task.project_id,
                task_id=task.id,
                actor_id=user.id,
                from_status=status_before,
                to_status=task.status,
                progress_before=progress_before,
                progress_after=task.progress_percent,
                reason=reason,
                created_at=datetime.now(BEIJING),
            )
        )

    def _rollup(self, scope: ExecutionScope, user: User) -> None:
        task = scope.task
        values, _ = progress_projection(scope.tasks)
        for parent in scope.tasks:
            if parent.id != task.id and parent.progress_percent != values[parent.id]:
                previous = parent.progress_percent
                parent.progress_percent = values[parent.id]
                parent.lock_version += 1
                parent.updated_at = task.updated_at
                self._event(parent, user, parent.status, previous, f"Rollup from task {task.id}.")
        for module in scope.modules:
            aggregate = weighted_progress(module_roots(scope.tasks, module.id), values)
            if aggregate is not None and module.progress_percent != aggregate:
                module.progress_percent = aggregate
                module.lock_version += 1
                module.updated_at = task.updated_at

    def start(self, task_id: UUID, user: User, expected_version: int) -> TaskExecutionView:
        try:
            if type(expected_version) is not int or expected_version < 0:
                raise ApiError(
                    422, "VALIDATION_ERROR", "A non-negative integer version is required."
                )
            scope = self.repository.load(task_id, user, lock=True)
            require_read(scope.permissions)
            require_verified_email(scope.permissions.email_verified)
            require_execution_write(scope.project, scope.course)
            require_task_plan(scope.latest_plan, scope.task.id)
            if not scope.permissions.can_start:
                raise ApiError(403, "TASK_ASSIGNEE_REQUIRED", "Only a task assignee can start it.")
            # Repeating a successful start is a no-op, even with the original version.
            # No write occurs and current facts (membership/course/project) are rechecked.
            if scope.task.status == "in_progress":
                view = execution_view(scope)
                self.repository.commit()
                return view
            self._version(scope.task, expected_version)
            if scope.task.status != "not_started":
                raise ApiError(409, "INVALID_TASK_STATE", "Only an unstarted task can be started.")
            if not all(item.satisfied for item in execution_view(scope).dependencies):
                raise ApiError(409, "DEPENDENCIES_INCOMPLETE", "Complete blocking tasks first.")
            task = scope.task
            task.status = "in_progress"
            task.started_at = datetime.now(BEIJING)
            task.updated_at = task.started_at
            task.lock_version += 1
            self._event(task, user, "not_started", task.progress_percent, "Task started.")
            result = execution_view(scope)
            self.repository.commit()
            return result
        except Exception:
            self.repository.rollback()
            raise

    def update_progress(
        self, task_id: UUID, user: User, expected_version: int, progress: int, reason: str
    ) -> TaskExecutionView:
        try:
            reason = self._reason(reason)
            if type(progress) is not int or not 0 <= progress <= 100:
                raise ApiError(
                    422, "VALIDATION_ERROR", "Progress must be an integer from 0 to 100."
                )
            scope = self.repository.load(task_id, user, lock=True)
            require_read(scope.permissions)
            require_verified_email(scope.permissions.email_verified)
            require_execution_write(scope.project, scope.course)
            require_task_plan(scope.latest_plan, scope.task.id)
            if not scope.permissions.can_update_progress:
                raise ApiError(
                    403, "TASK_WRITE_DENIED", "Only an assignee or project leader can edit."
                )
            task = scope.task
            self._version(task, expected_version)
            if task.status not in {"in_progress", "pending_submission"}:
                raise ApiError(409, "INVALID_TASK_STATE", "This task's progress is read-only.")
            if any(item.parent_task_id == task.id for item in scope.tasks):
                raise ApiError(
                    409, "AGGREGATE_PROGRESS", "Parent progress is derived from children."
                )
            before = task.progress_percent
            task.progress_percent = progress
            task.lock_version += 1
            task.updated_at = datetime.now(BEIJING)
            self._event(task, user, task.status, before, reason)
            self._rollup(scope, user)
            result = execution_view(scope)
            self.repository.commit()
            return result
        except Exception:
            self.repository.rollback()
            raise

    def change_task_status(
        self,
        task_id: UUID,
        user: User,
        expected_version: int,
        target: TaskStatus,
        reason: str,
        *,
        provider: TransitionProvider | None = None,
    ) -> TaskExecutionView:
        """Internal B/C/D entry point; intentionally has no arbitrary HTTP route."""
        try:
            reason = self._reason(reason)
            scope = self.repository.load(task_id, user, lock=True)
            if target == "in_progress" and scope.task.status == "not_started":
                # The start path rechecks the stricter assignee/dependency contract.
                return self.start(task_id, user, expected_version)
            require_read(scope.permissions)
            require_verified_email(scope.permissions.email_verified)
            require_execution_write(scope.project, scope.course)
            require_task_plan(scope.latest_plan, scope.task.id)
            if not (scope.permissions.can_update_progress or scope.permissions.staff):
                raise ApiError(403, "TASK_WRITE_DENIED", "This actor cannot transition this task.")
            self._version(scope.task, expected_version)
            if target not in ALLOWED_TRANSITIONS.get(scope.task.status, set()):
                raise ApiError(
                    409, "INVALID_TASK_STATE", "The requested transition is not allowed."
                )
            # Even return-to-progress needs D invalidation. Refuse until the owner provides
            # the trusted adapter; never mutate verification or contribution tables here.
            if provider is None:
                raise ApiError(
                    503,
                    "TRANSITION_PROVIDER_UNAVAILABLE",
                    "The transition adapter is not connected.",
                )
            if target == "completed":
                values, _ = progress_projection(scope.tasks)
                if any(
                    child.parent_task_id == scope.task.id
                    and (child.status != "completed" or values[child.id] != 100)
                    for child in scope.tasks
                ):
                    raise ApiError(
                        409, "CHILDREN_INCOMPLETE", "Complete and verify child tasks first."
                    )
            provider.authorize(scope, user, target, reason)
            task = scope.task
            status_before, progress_before = task.status, task.progress_percent
            task.status = target
            if target == "completed":
                task.progress_percent = 100
            task.completed_at = datetime.now(BEIJING) if target == "completed" else None
            task.updated_at = datetime.now(BEIJING)
            task.lock_version += 1
            self._event(task, user, status_before, progress_before, reason)
            self._rollup(scope, user)
            result = execution_view(scope)
            self.repository.commit()
            return result
        except Exception:
            self.repository.rollback()
            raise

    def mark_completed(
        self,
        task_id: UUID,
        user: User,
        expected_version: int,
        reason: str,
        *,
        provider: TransitionProvider | None = None,
    ) -> TaskExecutionView:
        return self.change_task_status(
            task_id, user, expected_version, "completed", reason, provider=provider
        )

    def return_to_in_progress(
        self,
        task_id: UUID,
        user: User,
        expected_version: int,
        reason: str,
        *,
        provider: TransitionProvider | None = None,
    ) -> TaskExecutionView:
        return self.change_task_status(
            task_id, user, expected_version, "in_progress", reason, provider=provider
        )


class TaskSubmissionService:
    """C2-08 saves the draft and hands the task to D's check page, not verification.

    The dedicated request transaction includes note versions, source invalidation,
    progress audit, replay and outbox records. No D provider/result is invoked.
    """

    def __init__(self, session: Session):
        self.session = session
        self.repository = SqlExecutionRepository(session)
        self.execution = TaskExecutionService(self.repository)

    def prepare(
        self, task_id: UUID, user: User, command: PrepareSubmissionRequest, key: str
    ) -> PrepareSubmissionView:
        try:
            scope = self.repository.load(task_id, user, lock=True)
            require_read(scope.permissions)
            require_verified_email(scope.permissions.email_verified)
            require_execution_write(scope.project, scope.course)
            require_task_plan(scope.latest_plan, task_id)
            if not scope.permissions.can_start:
                raise ApiError(
                    403, "TASK_ASSIGNEE_REQUIRED", "Only a task assignee can prepare submission."
                )
            record, replay = claim_request(
                self.session,
                actor_id=user.id,
                project_id=scope.project.id,
                operation=f"task.prepare_submission:{task_id}",
                key=key,
                payload=command.model_dump(mode="json"),
            )
            if replay is not None:
                result = PrepareSubmissionView.model_validate(replay)
                self.session.commit()
                return result
            task = scope.task
            self.execution._version(task, command.expected_version)
            if task.status not in {"in_progress", "pending_submission"}:
                raise ApiError(
                    409, "INVALID_TASK_STATE", "This task cannot prepare a submission draft."
                )
            if command.note is not None:
                # The newly generated outer record ID prevents collisions with
                # client-chosen keys in the existing note.save operation.
                note = save_note(
                    self.session,
                    user,
                    scope.project.id,
                    task_id,
                    command.note,
                    f"prepare-submission:{record.id}",
                )
            else:
                note = get_note(self.session, user, scope.project.id, task_id)
            # save_note never commits. Status, evidence-source invalidation and
            # every note/outbox row still belong to this one transaction.
            before = task.status
            task.status = "pending_submission"
            task.lock_version += 1
            task.updated_at = datetime.now(BEIJING)
            self.execution._event(
                task, user, before, task.progress_percent, "Prepared submission draft for checking."
            )
            emit_event(
                self.session,
                project_id=scope.project.id,
                aggregate_id=task_id,
                event_type="task.submission_prepared",
                payload={
                    "task_id": str(task_id),
                    "actor_id": str(user.id),
                    "lock_version": task.lock_version,
                    "note_id": note["id"] if note else None,
                    "note_version_no": note["current_version_no"] if note else None,
                },
            )
            result = PrepareSubmissionView(execution=execution_view(scope), note=note)
            finish_request(self.session, record, result.model_dump(mode="json"))
            self.session.commit()
            return result
        except Exception:
            self.session.rollback()
            raise
