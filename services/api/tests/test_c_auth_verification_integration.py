"""Real A binding/session -> C SQL/HTTP regressions using isolated SQLite.

There is no demo identity or permission dependency override. SQLite verifies
query/transaction behavior, not PostgreSQL row-lock semantics.
"""

from datetime import UTC, datetime
from types import SimpleNamespace
from uuid import uuid4

import pytest
import test_c_discussions as discussion_tests
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import func, select, update

from app.api.errors import ApiError, install_exception_handlers
from app.auth.config import get_settings
from app.auth.db import get_db
from app.auth.errors import AppError, app_error_handler
from app.auth.models import AuthAuditEvent, SchoolEmailBinding
from app.auth.routers.c_admin import router as identity_router
from app.auth.services import email_challenges, sessions
from app.db.models import ProgressEvent, TaskAssignee, User
from app.db.session import get_session
from app.main import request_context
from app.modules.c.admin_users_schemas import AdminUserFilters
from app.modules.c.admin_users_service import get_admin_user, list_admin_users
from app.modules.c.course_files_permissions import course_access
from app.modules.c.execution_router import router as execution_router
from app.modules.c.governance_common import current_actor
from app.modules.c.governance_course_service import require_teacher
from app.modules.c.permissions import get_project_access
from app.modules.c.school_email import has_verified_school_email, school_email_binding_verified
from app.modules.c.task_execution import SqlExecutionRepository, TaskExecutionService

db = discussion_tests.db
scope = discussion_tests.scope


def bind(db, user):
    """Use A's actual successful-verification persistence path, not a mirror write."""
    # Start this scenario before the first school verification. Rebinding an
    # already-approved teacher correctly revokes A's old teacher review basis.
    user.email_binding.school_email = None
    user.email_binding.school_email_normalized = None
    user.email_binding.verified_at = None
    email = f"{user.id.hex}@{'student.' if user.global_role == 'student' else ''}must.edu.mo"
    return email_challenges.bind_verified_target(db, user, email=email, email_normalized=email)


@pytest.fixture()
def http(db, scope, monkeypatch):
    monkeypatch.setenv("APP_MODE", "dev")
    monkeypatch.setenv("APP_ORIGIN", "http://localhost:3000")
    monkeypatch.setenv("ENABLE_DEMO_AUTH", "false")
    get_settings.cache_clear()
    app = FastAPI()
    app.middleware("http")(request_context)
    install_exception_handlers(app)
    app.add_exception_handler(AppError, app_error_handler)
    app.include_router(identity_router)
    app.include_router(execution_router, prefix="/api/v1")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_session] = lambda: db
    # Keep issued rows in the identity map: SQLite loses timezone metadata when
    # materializing a new DateTime row; PostgreSQL coverage is run separately.
    issued_sessions = []
    with TestClient(app, base_url="http://localhost:3000") as client:

        def sign_in(user):
            user.username = f"c-auth-{user.id.hex[:12]}"
            user.student_id = "ST0001" if user.global_role == "student" else None
            user.requested_identity = "student" if user.global_role == "student" else None
            bind(db, user)
            facts = sessions.current_facts(db, user)
            assert facts["accountState"] == "active", facts
            issued = sessions.issue_session(db, user, facts, auth_method="google")
            issued_sessions.append(issued)
            db.commit()
            client.cookies.set(get_settings().session_cookie_name, issued.raw_token)
            client.headers.update({"X-CSRF-Token": issued.record.csrf_token})
            return issued

        yield SimpleNamespace(client=client, sign_in=sign_in)
    get_settings.cache_clear()


@pytest.mark.parametrize(
    "changes",
    [
        {"verified_at": None},
        {"school_email": None},
        {"school_email": ""},
        {"school_email": "not-an-email"},
        {"school_email": "other@must.edu.mo"},
        {"school_email_normalized": None},
        {"school_email_normalized": "other@must.edu.mo"},
    ],
)
def test_c_verification_requires_current_valid_binding_not_legacy_timestamp(db, scope, changes):
    user = scope.users["author"]
    assert user.email_verified_at is None
    bind(db, user)
    assert has_verified_school_email(db, user)
    user.email_verified_at = datetime.now(UTC)  # stale legacy mirror cannot rescue a revoked proof
    for field, value in changes.items():
        setattr(user.email_binding, field, value)
    db.flush()
    assert not has_verified_school_email(db, user)
    with pytest.raises(ApiError) as error:
        get_project_access(db, user, scope.project.id, lock=True)
    assert error.value.code == "EMAIL_NOT_VERIFIED"


def test_missing_binding_is_closed_even_when_legacy_mirror_claims_verified(db, scope):
    user = scope.users["author"]
    user.email_verified_at = datetime.now(UTC)
    db.delete(user.email_binding)
    db.flush()
    assert not has_verified_school_email(db, user)
    with pytest.raises(ApiError) as error:
        get_project_access(db, user, scope.project.id, lock=True)
    assert error.value.code == "EMAIL_NOT_VERIFIED"


def test_pending_change_keeps_existing_a_proof_and_fresh_query_observes_revocation(db, scope):
    user = scope.users["author"]
    binding = bind(db, user)
    binding.pending_school_email = "pending@student.must.edu.mo"
    binding.pending_school_email_normalized = "pending@student.must.edu.mo"
    db.flush()
    assert has_verified_school_email(db, user)
    # A different writer can revoke the database record while the relationship
    # stays cached. The next C operation must read the current database value.
    db.execute(
        update(SchoolEmailBinding)
        .where(SchoolEmailBinding.user_id == user.id)
        .values(verified_at=None)
        .execution_options(synchronize_session=False)
    )
    assert binding.verified_at is not None
    assert not has_verified_school_email(db, user, lock=True)
    assert binding.verified_at is None


def test_governance_teacher_file_and_directory_share_a_binding_fact(db, scope):
    admin, teacher = scope.users["admin"], scope.users["teacher"]
    bind(db, admin)
    bind(db, teacher)
    assert admin.email_verified_at is teacher.email_verified_at is None
    assert current_actor(db, admin, admin=True, write=True).id == admin.id
    require_teacher(db, teacher.id)
    assert course_access(db, teacher, scope.course.id).can_write
    page = list_admin_users(db, admin, AdminUserFilters(role="teacher"))
    assert next(row for row in page.items if row.id == teacher.id).email_verified
    assert get_admin_user(db, admin, teacher.id).email_verified
    teacher.email_binding.verified_at = None
    admin.email_binding.verified_at = None
    db.flush()
    assert not course_access(db, teacher, scope.course.id).can_write
    assert not get_admin_user(db, admin, teacher.id).email_verified
    page = list_admin_users(db, admin, AdminUserFilters(role="teacher"))
    assert not next(row for row in page.items if row.id == teacher.id).email_verified
    with pytest.raises(ApiError, match="teacher"):
        require_teacher(db, teacher.id)
    with pytest.raises(ApiError) as error:
        current_actor(db, admin, admin=True, write=True)
    assert error.value.code == "EMAIL_NOT_VERIFIED"


def test_verified_a_session_can_write_c_execution_and_revocation_denies_same_cookie(
    http, db, scope
):
    user = scope.users["author"]
    scope.task.status = "not_started"
    db.add(TaskAssignee(task_id=scope.task.id, user_id=user.id, role="responsible"))
    # The shared PG test database contains B's seeded progress history. Include
    # unrelated history on SQLite too so this test cannot assume an empty table.
    db.add(
        ProgressEvent(
            id=uuid4(),
            project_id=scope.other_project.id,
            task_id=scope.other_task.id,
            actor_id=scope.users["outsider"].id,
            from_status="in_progress",
            to_status="in_progress",
            progress_before=0,
            progress_after=10,
            reason="Unrelated pre-existing fixture event",
        )
    )

    def task_events():
        return list(
            db.scalars(
                select(ProgressEvent).where(
                    ProgressEvent.project_id == scope.project.id,
                    ProgressEvent.task_id == scope.task.id,
                )
            )
        )

    issued = http.sign_in(user)
    assert issued.record.scope == "full" and user.email_verified_at is None
    assert (
        db.scalar(
            select(func.count())
            .select_from(AuthAuditEvent)
            .where(
                AuthAuditEvent.actor_id == str(user.id),
                AuthAuditEvent.event_type == "school_email.verified",
            )
        )
        == 1
    )
    assert task_events() == []
    base = f"/api/v1/tasks/{scope.task.id}"
    result = http.client.post(f"{base}/start", json={"expected_version": 0})
    assert result.status_code == 200, result.text
    assert result.json()["data"]["status"] == "in_progress"
    events = task_events()
    assert len(events) == 1
    started = events[0]
    assert (started.actor_id, started.from_status, started.to_status) == (
        user.id,
        "not_started",
        "in_progress",
    )
    retry = http.client.post(f"{base}/start", json={"expected_version": 0})
    assert retry.status_code == 200, retry.text
    assert [row.id for row in task_events()] == [started.id]
    user.email_binding.verified_at = None
    user.email_verified_at = datetime.now(UTC)
    db.commit()
    denied = http.client.patch(
        f"{base}/progress", json={"expected_version": 1, "progress": 25, "reason": "Work done"}
    )
    assert denied.status_code == 403, denied.text
    assert denied.json()["error"]["code"] == "REGISTRATION_REQUIRED"
    assert [row.id for row in task_events()] == [started.id]
    # The C service boundary also rejects it when invoked without HTTP.
    with pytest.raises(ApiError) as error:
        TaskExecutionService(SqlExecutionRepository(db)).update_progress(
            scope.task.id, user, 1, 25, "Work done"
        )
    assert error.value.code == "EMAIL_NOT_VERIFIED"
    assert [row.id for row in task_events()] == [started.id]


def test_identity_directory_filters_use_real_status_columns_and_combine(http, db, scope):
    http.sign_in(scope.users["admin"])
    for name, status in (("author", "active"), ("member", "pending"), ("leader", "disabled")):
        user = scope.users[name]
        user.name = "Unique directory row"
        user.college = "Only this college"
        user.status = status
    db.commit()
    query = {"q": "Unique directory", "college": "Only this college", "role": "student"}
    enabled = http.client.get("/api/v1/c-admin/users", params={**query, "status": "enabled"})
    disabled = http.client.get("/api/v1/c-admin/users", params={**query, "status": "disabled"})
    assert enabled.status_code == disabled.status_code == 200
    assert enabled.json()["data"]["total"] == 2
    assert {row["id"] for row in enabled.json()["data"]["items"]} == {
        str(scope.users[name].id) for name in ("author", "member")
    }
    assert disabled.json()["data"]["total"] == 1
    assert disabled.json()["data"]["items"][0]["id"] == str(scope.users["leader"].id)


def test_version_zero_disable_is_real_atomic_admin_action(http, db, scope):
    target = scope.users["member"]
    target_session = http.sign_in(target)
    http.sign_in(scope.users["admin"])
    assert target.version == 0
    response = http.client.post(
        f"/api/v1/c-admin/users/{target.id}/disable",
        json={"expectedVersion": 0, "reason": "Requested account suspension"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["data"] == {"id": str(target.id), "status": "disabled", "version": 1}
    assert db.get(User, target.id).status == "disabled"
    db.refresh(target_session.record)
    assert target_session.record.revoked_at is not None
    http.client.cookies.set(get_settings().session_cookie_name, target_session.raw_token)
    assert http.client.get("/api/v1/c-admin/users").status_code == 401
    assert (
        db.scalar(
            select(func.count())
            .select_from(AuthAuditEvent)
            .where(
                AuthAuditEvent.event_type == "user.disabled",
                AuthAuditEvent.target_user_id == str(target.id),
            )
        )
        == 1
    )


def test_version_zero_does_not_bypass_cas_or_teacher_application_contract(http, db, scope):
    http.sign_in(scope.users["admin"])
    target = scope.users["member"]
    target.version = 1
    db.commit()
    conflict = http.client.post(
        f"/api/v1/c-admin/users/{target.id}/disable",
        json={"expectedVersion": 0, "reason": "Stale action"},
    )
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "VERSION_CONFLICT"
    assert target.status == "active"
    review = http.client.post(
        f"/api/v1/c-admin/teacher-applications/{uuid4()}/review",
        json={"expectedVersion": 0, "reason": "Review", "decision": "approve"},
    )
    assert review.status_code == 422


def test_identity_actions_keep_real_session_admin_and_csrf_checks(http, scope):
    target = scope.users["member"]
    path = f"/api/v1/c-admin/users/{target.id}/disable"
    command = {"expectedVersion": 0, "reason": "Disable account"}
    assert http.client.get("/api/v1/c-admin/users?status=enabled").status_code == 401
    http.sign_in(scope.users["author"])
    assert http.client.get("/api/v1/c-admin/users?status=enabled").status_code == 403
    assert http.client.post(path, json=command).status_code == 403
    http.sign_in(scope.users["admin"])
    assert (
        http.client.post(path, json=command, headers={"X-CSRF-Token": "wrong"}).status_code == 403
    )
    assert target.status == "active" and target.version == 0


def test_binding_predicate_accepts_a_normalized_display_email():
    assert school_email_binding_verified(
        SchoolEmailBinding(
            school_email=" Teacher@must.edu.mo ",
            school_email_normalized="teacher@must.edu.mo",
            verified_at=datetime.now(UTC),
        )
    )


def test_identity_write_rechecks_current_email_even_if_legacy_timestamp_remains(http, db, scope):
    admin = scope.users["admin"]
    http.sign_in(admin)
    admin.email_binding.school_email = None
    admin.email_verified_at = datetime.now(UTC)
    db.commit()
    response = http.client.post(
        f"/api/v1/c-admin/users/{scope.users['member'].id}/disable",
        json={"expectedVersion": 0, "reason": "Must not use the stale proof"},
    )
    assert response.status_code == 403, response.text
    assert response.json()["error"]["code"] == "REGISTRATION_REQUIRED"
    assert scope.users["member"].status == "active"
