"""Execution rules/HTTP contracts using an explicit in-memory repository test double.

These tests do not prove SQL locking, migrations or database durability. The separate
test_c_execution_postgres module exercises the real PostgreSQL repository.
"""

from copy import deepcopy
from datetime import UTC, datetime
from decimal import Decimal
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.auth import get_current_user
from app.api.errors import ApiError, install_exception_handlers
from app.auth.models import SchoolEmailBinding
from app.db.models import Course, FunctionalModule, PlanVersion, Project, Task, User
from app.db.session import get_session
from app.modules.c.execution_router import get_execution_service, router
from app.modules.c.permissions import execution_permissions
from app.modules.c.school_email import school_email_binding_verified
from app.modules.c.task_execution import (
    ExecutionScope,
    TaskExecutionService,
    progress_projection,
)


def actor(role="student"):
    return User(
        id=uuid4(),
        status="active",
        global_role=role,
        email_binding=SchoolEmailBinding(
            school_email="execution@example.test",
            school_email_normalized="execution@example.test",
            verified_at=datetime.now(UTC),
        ),
    )


def task(project_id, module_id, **changes):
    values = dict(
        id=uuid4(),
        project_id=project_id,
        module_id=module_id,
        parent_task_id=None,
        title="Planning title",
        description="Planning description",
        status="not_started",
        progress_percent=0,
        weight=Decimal("1"),
        lock_version=0,
        started_at=None,
        completed_at=None,
    )
    values.update(changes)
    return Task(**values)


class MemoryRepository:
    """Deliberately fake unit-test storage, not a replacement SQL implementation."""

    def __init__(self, user):
        self.member_ids = {user.id}
        self.leader_ids = set()
        self.staff_ids = set()
        self.project = Project(id=uuid4(), lifecycle="active", setup_status="frozen")
        self.course = Course(id=uuid4(), status="active", owner_id=uuid4())
        module = FunctionalModule(
            id=uuid4(), project_id=self.project.id, progress_percent=0, lock_version=0
        )
        item = task(self.project.id, module.id)
        self.scope = ExecutionScope(
            item, self.project, self.course, None, [item], [module], [user.id], []
        )
        self.scope.latest_plan = PlanVersion(
            id=uuid4(),
            project_id=self.project.id,
            status="frozen",
            version_no=1,
            snapshot_json={"tasks": [str(item.id)]},
        )
        self.events = []
        self.snapshot = None
        self.commits = 0
        self.rollbacks = 0
        self.fail_commit = False

    def load(self, task_id, user, *, lock):
        item = next((item for item in self.scope.tasks if item.id == task_id), None)
        if item is None:
            raise ApiError(404, "TASK_NOT_FOUND", "Task not found.")
        self.scope.task = item
        self.scope.permissions = execution_permissions(
            user,
            active_member=user.id in self.member_ids,
            responsible=user.id in self.scope.responsible_ids,
            project_leader=user.id in self.leader_ids,
            course_teacher=user.id == self.course.owner_id,
            active_course_staff=user.id in self.staff_ids,
            email_verified=school_email_binding_verified(user.email_binding),
        )
        if lock and self.snapshot is None:
            self.snapshot = deepcopy((self.scope, self.events))
        return self.scope

    def add_event(self, event):
        self.events.append(event)

    def commit(self):
        if self.fail_commit:
            raise RuntimeError("injected storage failure")
        self.commits += 1
        self.snapshot = None

    def rollback(self):
        self.rollbacks += 1
        if self.snapshot:
            self.scope, self.events = self.snapshot
            self.project, self.course = self.scope.project, self.scope.course
            self.snapshot = None


@pytest.fixture
def setup():
    user = actor()
    repository = MemoryRepository(user)
    return user, repository, TaskExecutionService(repository)


def app_for(user, service, *, authenticated=True):
    app = FastAPI()
    install_exception_handlers(app)

    @app.middleware("http")
    async def request_id(request, call_next):
        request.state.request_id = "execution-test"
        return await call_next(request)

    app.include_router(router, prefix="/api/v1")
    app.dependency_overrides[get_execution_service] = lambda: service
    app.dependency_overrides[get_session] = lambda: None
    if authenticated:
        app.dependency_overrides[get_current_user] = lambda: user
    return app


def assert_error(code, operation, status=None):
    with pytest.raises(ApiError) as exc:
        operation()
    assert exc.value.code == code
    if status:
        assert exc.value.status_code == status


def test_start_retry_is_idempotent_and_records_authenticated_actor(setup):
    user, repo, service = setup
    item = repo.scope.task
    first = service.start(item.id, user, 0)
    second = service.start(item.id, user, 0)
    assert first == second
    assert first.status == "in_progress"
    assert first.version == 1
    assert first.started_at is not None
    assert len(repo.events) == 1
    assert repo.events[0].actor_id == user.id
    assert repo.events[0].from_status == "not_started"
    assert repo.events[0].to_status == "in_progress"
    assert item.title == "Planning title"
    assert item.description == "Planning description"
    assert item.weight == 1


@pytest.mark.parametrize(
    "status", ["not_started", "in_progress", "pending_submission", "pending_verification"]
)
def test_start_requires_every_dependency_to_be_completed(setup, status):
    user, repo, service = setup
    blocker = task(repo.project.id, repo.scope.task.module_id, status=status)
    repo.scope.tasks.append(blocker)
    repo.scope.dependency_ids.append(blocker.id)
    assert_error("DEPENDENCIES_INCOMPLETE", lambda: service.start(repo.scope.task.id, user, 0), 409)
    assert repo.scope.task.status == "not_started"
    assert repo.events == []


def test_start_missing_dependency_is_blocked_without_exposing_other_project(setup):
    user, repo, service = setup
    repo.scope.dependency_ids = [uuid4()]
    context = service.read(repo.scope.task.id, user)
    assert context.dependencies[0].status is None
    assert not context.can_start
    assert_error("DEPENDENCIES_INCOMPLETE", lambda: service.start(repo.scope.task.id, user, 0))


def test_start_completed_dependency_allows_start(setup):
    user, repo, service = setup
    blocker = task(repo.project.id, repo.scope.task.module_id, status="completed")
    repo.scope.tasks.append(blocker)
    repo.scope.dependency_ids.append(blocker.id)
    assert service.start(repo.scope.task.id, user, 0).status == "in_progress"


@pytest.mark.parametrize("operation", ["read", "start", "progress"])
@pytest.mark.parametrize("role", ["student", "teacher", "ta", "admin"])
def test_outsider_cannot_access_any_execution_endpoint(setup, operation, role):
    _, repo, service = setup
    outsider = actor(role)
    repo.scope.task.status = "in_progress"
    operations = {
        "read": lambda: service.read(repo.scope.task.id, outsider),
        "start": lambda: service.start(repo.scope.task.id, outsider, 0),
        "progress": lambda: service.update_progress(repo.scope.task.id, outsider, 0, 20, "work"),
    }
    assert_error("PROJECT_ACCESS_DENIED", operations[operation], 403)
    assert not repo.events


@pytest.mark.parametrize("operation", ["start", "progress"])
@pytest.mark.parametrize(
    "field,value,code",
    [
        ("lifecycle", "archived", "PROJECT_READ_ONLY"),
        ("lifecycle", "finalized", "PROJECT_READ_ONLY"),
        ("course", "ended", "COURSE_READ_ONLY"),
        ("course", "draft", "COURSE_READ_ONLY"),
        ("setup_status", "draft", "PROJECT_NOT_READY"),
        ("setup_status", "pending_confirmation", "PROJECT_NOT_READY"),
    ],
)
def test_inactive_project_or_course_is_read_only(setup, operation, field, value, code):
    user, repo, service = setup
    if field == "course":
        repo.course.status = value
    else:
        setattr(repo.project, field, value)
    repo.scope.task.status = "in_progress" if operation == "progress" else "not_started"
    context = service.read(repo.scope.task.id, user)
    assert context.read_only
    assert not context.can_start and not context.can_update_progress
    action = (
        (lambda: service.start(repo.scope.task.id, user, 0))
        if operation == "start"
        else (lambda: service.update_progress(repo.scope.task.id, user, 0, 50, "work"))
    )
    assert_error(code, action)
    assert not repo.events


def test_leader_cannot_start_others_task_but_can_update_progress(setup):
    _, repo, service = setup
    leader = actor()
    repo.member_ids.add(leader.id)
    repo.leader_ids.add(leader.id)
    assert_error("TASK_ASSIGNEE_REQUIRED", lambda: service.start(repo.scope.task.id, leader, 0))
    repo.scope.task.status = "in_progress"
    result = service.update_progress(repo.scope.task.id, leader, 0, 30, "Reviewed work")
    assert result.progress == 30
    assert repo.events[0].actor_id == leader.id


@pytest.mark.parametrize("role", ["teacher", "ta", "student"])
def test_course_staff_and_unassigned_member_can_read_but_not_edit(setup, role):
    _, repo, service = setup
    user = actor(role)
    if role == "student":
        repo.member_ids.add(user.id)
    else:
        repo.staff_ids.add(user.id)
    repo.scope.task.status = "in_progress"
    assert service.read(repo.scope.task.id, user).status == "in_progress"
    assert_error("TASK_ASSIGNEE_REQUIRED", lambda: service.start(repo.scope.task.id, user, 0))
    assert_error(
        "TASK_WRITE_DENIED", lambda: service.update_progress(repo.scope.task.id, user, 0, 5, "work")
    )


def test_progress_hundred_does_not_submit_or_complete(setup):
    user, repo, service = setup
    service.start(repo.scope.task.id, user, 0)
    result = service.update_progress(repo.scope.task.id, user, 1, 100, "  Implementation ready  ")
    assert result.status == "in_progress"
    assert result.completed_at is None
    assert result.progress == result.project_progress == 100
    assert repo.events[-1].reason == "Implementation ready"
    assert repo.events[-1].progress_before == 0
    assert repo.events[-1].progress_after == 100


def test_progress_rolls_up_parents_module_and_project_without_double_counting(setup):
    user, repo, service = setup
    item = repo.scope.task
    item.status = "in_progress"
    item.weight = Decimal("3")
    parent = task(repo.project.id, item.module_id, status="in_progress", weight=Decimal("2"))
    sibling = task(repo.project.id, item.module_id, parent_task_id=parent.id, progress_percent=40)
    other = task(repo.project.id, item.module_id, progress_percent=20)
    item.parent_task_id = parent.id
    repo.scope.tasks.extend([parent, sibling, other])
    result = service.update_progress(item.id, user, 0, 80, "Two weighted subtasks")
    assert parent.progress_percent == 70  # (3*80+1*40)/4
    assert parent.lock_version == 1
    assert parent.status == "in_progress"
    assert result.project_progress == 53  # (2*70+1*20)/3, half-up
    assert result.module_progress[str(item.module_id)] == 53
    assert repo.scope.modules[0].progress_percent == 53
    assert repo.scope.modules[0].lock_version == 1
    assert len(repo.events) == 2
    assert repo.events[-1].task_id == parent.id


def test_cross_module_subtask_rolls_up_its_own_module(setup):
    user, repo, service = setup
    item = repo.scope.task
    parent = task(repo.project.id, item.module_id, status="in_progress")
    own_module = FunctionalModule(
        id=uuid4(), project_id=repo.project.id, progress_percent=0, lock_version=0
    )
    item.module_id = own_module.id
    item.parent_task_id = parent.id
    item.status = "in_progress"
    repo.scope.tasks.append(parent)
    repo.scope.modules.append(own_module)
    result = service.update_progress(item.id, user, 0, 70, "Child in another module")
    assert set(result.module_progress.values()) == {70}
    assert all(module.progress_percent == 70 for module in repo.scope.modules)
    assert result.project_progress == 70


@pytest.mark.parametrize("status", ["not_started", "pending_verification", "completed"])
def test_progress_rejects_immutable_status(setup, status):
    user, repo, service = setup
    repo.scope.task.status = status
    assert_error(
        "INVALID_TASK_STATE",
        lambda: service.update_progress(repo.scope.task.id, user, 0, 20, "work"),
    )


def test_progress_accepts_pending_submission_without_changing_status(setup):
    user, repo, service = setup
    repo.scope.task.status = "pending_submission"
    assert (
        service.update_progress(repo.scope.task.id, user, 0, 40, "More work").status
        == "pending_submission"
    )


def test_parent_progress_cannot_be_manually_overwritten(setup):
    user, repo, service = setup
    parent = repo.scope.task
    parent.status = "in_progress"
    repo.scope.tasks.append(task(repo.project.id, parent.module_id, parent_task_id=parent.id))
    assert_error(
        "AGGREGATE_PROGRESS", lambda: service.update_progress(parent.id, user, 0, 50, "work")
    )


@pytest.mark.parametrize("operation", ["start", "progress"])
def test_conflict_does_not_overwrite_newer_task(setup, operation):
    user, repo, service = setup
    repo.scope.task.lock_version = 3
    if operation == "start":

        def action():
            return service.start(repo.scope.task.id, user, 2)

    else:
        repo.scope.task.status = "in_progress"

        def action():
            return service.update_progress(repo.scope.task.id, user, 2, 40, "work")

    assert_error("VERSION_CONFLICT", action, 409)
    assert repo.scope.task.lock_version == 3
    assert not repo.events


def test_storage_failure_rolls_back_task_aggregate_and_audit(setup):
    user, repo, service = setup
    repo.scope.task.status = "in_progress"
    repo.fail_commit = True
    with pytest.raises(RuntimeError, match="injected storage"):
        service.update_progress(repo.scope.task.id, user, 0, 70, "work")
    assert repo.scope.task.progress_percent == 0
    assert repo.scope.task.lock_version == 0
    assert repo.scope.modules[0].progress_percent == 0
    assert repo.events == []


@pytest.mark.parametrize("bad_tree", ["cycle", "other_project"])
def test_invalid_task_tree_fails_without_committing(setup, bad_tree):
    user, repo, service = setup
    item = repo.scope.task
    item.status = "in_progress"
    item.parent_task_id = item.id if bad_tree == "cycle" else uuid4()
    assert_error("INVALID_TASK_TREE", lambda: progress_projection(repo.scope.tasks))
    assert repo.commits == 0


@pytest.mark.parametrize(
    "from_status,target",
    [
        ("in_progress", "pending_submission"),
        ("pending_submission", "pending_verification"),
        ("pending_verification", "completed"),
        ("completed", "in_progress"),
    ],
)
def test_internal_transitions_refuse_missing_trusted_provider(setup, from_status, target):
    user, repo, service = setup
    repo.scope.task.status = from_status
    assert_error(
        "TRANSITION_PROVIDER_UNAVAILABLE",
        lambda: service.change_task_status(
            repo.scope.task.id, user, 0, target, "Requested transition"
        ),
        503,
    )
    assert repo.scope.task.status == from_status
    assert not repo.events


def test_completion_requires_legal_state_and_trusted_adapter(setup):
    user, repo, service = setup
    calls = []

    class Adapter:
        def authorize(self, scope, actor, target, reason):
            calls.append((scope.task.id, actor.id, target, reason))

    assert_error(
        "INVALID_TASK_STATE",
        lambda: service.mark_completed(repo.scope.task.id, user, 0, "Verified", provider=Adapter()),
    )
    assert calls == []
    repo.scope.task.status = "pending_verification"
    result = service.mark_completed(repo.scope.task.id, user, 0, "Verified", provider=Adapter())
    assert result.status == "completed" and result.completed_at is not None
    assert result.progress == result.project_progress == 100
    assert repo.scope.modules[0].progress_percent == 100
    assert calls == [(repo.scope.task.id, user.id, "completed", "Verified")]
    assert len(repo.events) == 1
    assert repo.events[0].progress_after == 100


@pytest.mark.parametrize(
    "plan_state", ["missing", "draft", "confirmed", "archived", "unplanned_task"]
)
@pytest.mark.parametrize("operation", ["start", "progress"])
def test_task_requires_latest_frozen_plan_and_snapshot_membership(setup, plan_state, operation):
    user, repo, service = setup
    if plan_state == "missing":
        repo.scope.latest_plan = None
    elif plan_state == "unplanned_task":
        repo.scope.latest_plan.snapshot_json = {"tasks": []}
    else:
        repo.scope.latest_plan.status = plan_state
    if operation == "progress":
        repo.scope.task.status = "in_progress"
    context = service.read(repo.scope.task.id, user)
    assert context.read_only and not context.can_start and not context.can_update_progress
    code = "TASK_NOT_IN_PLAN" if plan_state == "unplanned_task" else "PLAN_NOT_FROZEN"
    assert_error(
        code,
        lambda: (
            service.start(repo.scope.task.id, user, 0)
            if operation == "start"
            else service.update_progress(repo.scope.task.id, user, 0, 50, "work")
        ),
        409,
    )
    assert not repo.events


@pytest.mark.parametrize("child_state,child_progress", [("in_progress", 100), ("completed", 60)])
def test_parent_completion_rejects_unverified_or_incomplete_children(
    setup, child_state, child_progress
):
    user, repo, service = setup
    repo.scope.task.status = "pending_verification"
    repo.scope.tasks.append(
        task(
            repo.project.id,
            repo.scope.task.module_id,
            parent_task_id=repo.scope.task.id,
            status=child_state,
            progress_percent=child_progress,
        )
    )

    class Adapter:
        def authorize(self, *_):
            pytest.fail("Incomplete parent must not reach verification adapter")

    assert_error(
        "CHILDREN_INCOMPLETE",
        lambda: service.mark_completed(
            repo.scope.task.id, user, 0, "Complete parent", provider=Adapter()
        ),
    )
    assert not repo.events


def test_adapter_failure_leaves_status_unchanged(setup):
    user, repo, service = setup
    repo.scope.task.status = "pending_verification"

    class Deny:
        def authorize(self, *_):
            raise ApiError(409, "VERIFICATION_INCOMPLETE", "Human confirmation missing.")

    assert_error(
        "VERIFICATION_INCOMPLETE",
        lambda: service.mark_completed(repo.scope.task.id, user, 0, "Complete", provider=Deny()),
    )
    assert repo.scope.task.status == "pending_verification"
    assert not repo.events


def test_api_read_start_progress_contract_and_cache_headers(setup):
    user, repo, service = setup
    with TestClient(app_for(user, service)) as client:
        base = f"/api/v1/tasks/{repo.scope.task.id}"
        read = client.get(base + "/execution")
        assert read.status_code == 200
        assert read.headers["cache-control"] == "private, no-store"
        assert read.json()["meta"]["request_id"] == "execution-test"
        assert read.json()["data"]["can_start"]
        start = client.post(base + "/start", json={"expected_version": 0})
        assert start.status_code == 200
        progress = client.patch(
            base + "/progress",
            json={"expected_version": 1, "progress": 80, "reason": "Finished core flow"},
        )
        assert progress.status_code == 200
        assert progress.json()["data"]["progress"] == 80
        assert progress.json()["data"]["status"] == "in_progress"
        assert client.patch(base + "/status", json={"status": "completed"}).status_code == 404


@pytest.mark.parametrize(
    "payload",
    [
        {"expected_version": -1},
        {"expected_version": True},
        {"expected_version": "0"},
        {"expected_version": 0, "actor_id": str(uuid4())},
        {"expected_version": 0, "status": "completed"},
    ],
)
def test_start_rejects_invalid_or_forged_fields(setup, payload):
    user, repo, service = setup
    with TestClient(app_for(user, service)) as client:
        result = client.post(f"/api/v1/tasks/{repo.scope.task.id}/start", json=payload)
    assert result.status_code == 422
    assert repo.events == []


@pytest.mark.parametrize(
    "changes",
    [
        {"progress": -1},
        {"progress": 101},
        {"progress": True},
        {"progress": 1.5},
        {"progress": "50"},
        {"reason": " "},
        {"reason": "x" * 2001},
        {"reason": None},
        {"expected_version": False},
        {"status": "completed"},
    ],
)
def test_progress_rejects_invalid_or_forged_fields(setup, changes):
    user, repo, service = setup
    payload = {"expected_version": 0, "progress": 40, "reason": "work", **changes}
    with TestClient(app_for(user, service)) as client:
        result = client.patch(f"/api/v1/tasks/{repo.scope.task.id}/progress", json=payload)
    assert result.status_code == 422
    assert repo.events == []


@pytest.mark.parametrize(
    "endpoint,method", [("execution", "get"), ("start", "post"), ("progress", "patch")]
)
def test_production_auth_stays_closed_even_with_demo_header(setup, monkeypatch, endpoint, method):
    user, repo, service = setup
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("ENABLE_DEMO_AUTH", "true")
    with TestClient(app_for(user, service, authenticated=False)) as client:
        response = client.request(
            method,
            f"/api/v1/tasks/{repo.scope.task.id}/{endpoint}",
            headers={"X-Demo-User-Id": str(user.id)},
            json={"expected_version": 0, "progress": 40, "reason": "work"}
            if method != "get"
            else None,
        )
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "UNAUTHENTICATED"
    assert repo.events == []


@pytest.mark.parametrize(
    "endpoint,method,payload",
    [
        ("execution", "get", None),
        ("start", "post", {"expected_version": 0}),
        ("progress", "patch", {"expected_version": 0, "progress": 10, "reason": "work"}),
    ],
)
def test_unknown_task_returns_404_for_every_endpoint(setup, endpoint, method, payload):
    user, _, service = setup
    with TestClient(app_for(user, service)) as client:
        response = client.request(method, f"/api/v1/tasks/{uuid4()}/{endpoint}", json=payload)
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "TASK_NOT_FOUND"


def test_disabled_actor_is_rejected_before_project_access(setup):
    user, repo, service = setup
    user.status = "disabled"
    assert_error("ACCOUNT_INACTIVE", lambda: service.read(repo.scope.task.id, user), 403)


@pytest.mark.parametrize("operation", ["start", "progress", "complete"])
def test_unverified_email_can_read_but_cannot_write(setup, operation):
    user, repo, service = setup
    user.email_binding.verified_at = None
    context = service.read(repo.scope.task.id, user)
    assert not context.can_start and not context.can_update_progress
    if operation == "progress":
        repo.scope.task.status = "in_progress"
    elif operation == "complete":
        repo.scope.task.status = "pending_verification"
    operations = {
        "start": lambda: service.start(repo.scope.task.id, user, 0),
        "progress": lambda: service.update_progress(repo.scope.task.id, user, 0, 30, "work"),
        "complete": lambda: service.mark_completed(repo.scope.task.id, user, 0, "verified"),
    }
    assert_error("EMAIL_NOT_VERIFIED", operations[operation], 403)
    assert not repo.events
