"""A Google callback/session -> C writes on a rollback-only PostgreSQL fixture.

Only the external OIDC issuer and database connection are test fixtures. Requests
use the production auth/C routers and real cookies, without identity, permission,
token-verification or C-service overrides. This is HTTP integration coverage, not
a claim that Google, email delivery or the deployed browser flow was exercised.
"""

from __future__ import annotations

import os
import re
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse
from uuid import UUID, uuid4

import pytest
import test_c_discussions as discussion_tests
from fastapi import FastAPI
from fastapi.testclient import TestClient
from oidc_stub import StubProvider
from sqlalchemy import func, select
from sqlalchemy.orm import sessionmaker
from test_c_auth_verification_integration import bind

from app.api.errors import install_exception_handlers
from app.auth.config import get_settings
from app.auth.db import get_db
from app.auth.errors import AppError, app_error_handler
from app.auth.models import (
    AuthIdentity,
    EmailOutbox,
    OAuthTransaction,
    PasswordCredential,
    utcnow,
)
from app.auth.models import (
    Session as AuthSession,
)
from app.auth.routers import auth, c_admin, me
from app.auth.security import hash_password, token_digest
from app.auth.services import google_oidc, mailer
from app.db.models import ProgressEvent, ProjectMember, TaskAssignee, User
from app.db.session import get_session
from app.main import request_context
from app.modules.c.execution_router import router as execution_router
from app.modules.c.models import TaskNote, TaskNoteVersion
from app.modules.c.note_router import router as note_router

db = discussion_tests.db
scope = discussion_tests.scope
ORIGIN = "http://localhost:3000"
CALLBACK = "/api/v1/auth/google/callback"
PASSWORD = "c-google-isolated-password-2026"


@pytest.fixture(autouse=True)
def require_postgres():
    # The real session/OAuth clock comparisons must be tested with aware PG dates.
    if not os.getenv("C_TEST_DATABASE_URL", "").startswith("postgresql"):
        pytest.skip("set C_TEST_DATABASE_URL to a migrated disposable PostgreSQL database")


@pytest.fixture(scope="module")
def issuer():
    provider = StubProvider()
    provider.start()
    try:
        yield provider
    finally:
        provider.stop()
        provider.server.server_close()


@pytest.fixture()
def http(db, issuer, monkeypatch):
    for name, value in {
        "APP_MODE": "dev",
        "APP_ORIGIN": ORIGIN,
        "ENABLE_DEMO_AUTH": "false",
        "AUTH_GOOGLE_ENABLED": "true",
        "GOOGLE_CLIENT_ID": "test-client-id",
        "GOOGLE_CLIENT_SECRET": "c-google-test-only-secret",
        "GOOGLE_REDIRECT_URI": ORIGIN + CALLBACK,
        "GOOGLE_DISCOVERY_URL": issuer.discovery_url,
        "GOOGLE_EXPECTED_ISSUER": issuer.issuer,
        "MAIL_MODE": "capture",
        "EMAIL_CHALLENGE_HMAC_KEY": "c-google-test-only-hmac",
        "ACCEPTANCE_TEST_TOKEN": "",
        "NO_PROXY": "127.0.0.1,localhost",
        "no_proxy": "127.0.0.1,localhost",
    }.items():
        monkeypatch.setenv(name, value)
    get_settings.cache_clear()
    google_oidc.reset_discovery_cache()
    # A's capture transport opens its own session. Keep that real writer inside
    # the same rollback-only connection instead of leaving captured codes in a
    # shared test database after the scenario ends.
    monkeypatch.setattr(
        mailer,
        "get_session_factory",
        lambda: sessionmaker(bind=db.connection(), join_transaction_mode="create_savepoint"),
    )
    application = FastAPI()
    application.middleware("http")(request_context)
    install_exception_handlers(application)
    application.add_exception_handler(AppError, app_error_handler)
    for router in (auth.router, me.router, c_admin.router):
        application.include_router(router)
    application.include_router(execution_router, prefix="/api/v1")
    application.include_router(note_router, prefix="/api/v1")
    application.dependency_overrides[get_db] = lambda: db
    application.dependency_overrides[get_session] = lambda: db
    try:
        with TestClient(application, base_url=ORIGIN) as client:
            yield SimpleNamespace(client=client, app=application)
    finally:
        google_oidc.reset_discovery_cache()
        get_settings.cache_clear()


def headers(client):
    response = client.get("/api/v1/auth/session")
    assert response.status_code == 200, response.text
    return {"X-CSRF-Token": response.json()["data"]["csrfToken"], "Origin": ORIGIN}


def google_callback(client, db, issuer, subject, *, email=None, link=False):
    response = (
        client.post("/api/v1/me/identities/google/link", headers=headers(client))
        if link
        else client.get("/api/v1/auth/google/start", follow_redirects=False)
    )
    assert response.status_code == (200 if link else 302), response.text
    location = response.json()["data"]["authorizeUrl"] if link else response.headers["location"]
    query = parse_qs(urlparse(location).query)
    assert query["redirect_uri"] == [ORIGIN + CALLBACK]
    state = query["state"][0]
    transaction = db.scalar(
        select(OAuthTransaction).where(OAuthTransaction.state_digest == token_digest(state))
    )
    assert transaction is not None
    code = issuer.mint_code(
        state=state,
        nonce=transaction.nonce,
        code_verifier=transaction.code_verifier,
        sub=subject,
        email=email or f"{subject}@gmail.test",
    )
    callback = client.get(CALLBACK, params={"state": state, "code": code}, follow_redirects=False)
    assert callback.status_code == 302, callback.text
    return callback, state, code


def existing_account(db, user, issuer, *, password=False):
    """An existing, approved fixture account; its sign-in still uses real routes."""
    user.username = user.username_normalized = f"cg-{user.id.hex[:16]}"
    user.student_id = f"S{user.id.hex[:12]}" if user.global_role == "student" else None
    user.requested_identity = "student" if user.global_role == "student" else None
    bind(db, user)
    subject = f"c-google-{user.id.hex}"
    if password:
        db.add(
            PasswordCredential(
                user_id=user.id,
                login_email=f"{user.id.hex}@login.test",
                login_email_normalized=f"{user.id.hex}@login.test",
                login_email_verified_at=utcnow(),
                password_hash=hash_password(PASSWORD),
            )
        )
    else:
        user.identities.append(
            AuthIdentity(
                id=uuid4().hex,
                provider="google",
                issuer=issuer.issuer,
                subject=subject,
                google_email=f"{subject}@gmail.test",
                last_authenticated_at=utcnow(),
            )
        )
    db.commit()
    return subject


def password_login(client, user):
    response = client.post(
        "/api/v1/auth/password/login",
        json={"identifier": user.username, "password": PASSWORD},
        headers={"Origin": ORIGIN},
    )
    assert response.status_code == 200, response.text
    assert client.get("/api/v1/me").json()["data"]["user"]["id"] == str(user.id)


def assign(db, scope, user):
    scope.task.status = "not_started"
    db.add(TaskAssignee(task_id=scope.task.id, user_id=user.id, role="responsible"))
    db.commit()


def events(db, scope):
    return list(
        db.scalars(
            select(ProgressEvent)
            .where(
                ProgressEvent.project_id == scope.project.id, ProgressEvent.task_id == scope.task.id
            )
            .order_by(ProgressEvent.created_at, ProgressEvent.id)
        )
    )


def note_path(scope):
    return f"/api/v1/projects/{scope.project.id}/tasks/{scope.task.id}/note"


@pytest.fixture()
def newcomer(http, db, scope, issuer):
    client = http.client
    subject = f"new-{uuid4().hex}"
    callback, state, code = google_callback(client, db, issuer, subject)
    assert callback.headers["location"] == "/account/profile"
    data = client.get("/api/v1/me").json()["data"]
    user = db.get(User, UUID(data["user"]["id"]))
    school_email = f"{user.id.hex}@student.must.edu.mo"
    response = client.patch(
        "/api/v1/me/profile",
        headers=headers(client),
        json={
            "expectedVersion": data["user"]["version"],
            "name": "New C student",
            "username": f"cg-{user.id.hex[:16]}",
            "studentId": f"S{user.id.hex[:12]}",
            "requestedIdentity": "student",
            "schoolEmail": school_email,
        },
    )
    assert response.status_code == 200, response.text
    # B's membership/confirmed-plan fixture is deliberately already present so
    # that a school-email denial cannot be explained by missing assignment.
    db.add(ProjectMember(id=uuid4(), project_id=scope.project.id, user_id=user.id, role="member"))
    assign(db, scope, user)
    return SimpleNamespace(user=user, subject=subject, email=school_email, state=state, code=code)


def verify_school_email(client, db, newcomer):
    challenge = client.post("/api/v1/me/school-email/challenges", json={}, headers=headers(client))
    assert challenge.status_code == 200, challenge.text
    body = db.scalar(
        select(EmailOutbox.body)
        .where(EmailOutbox.to_email == newcomer.email)
        .order_by(EmailOutbox.id.desc())
        .limit(1)
    )
    match = re.search(r"\b(\d{6})\b", body or "")
    assert match is not None, "isolated capture transport did not persist a verification code"
    response = client.post(
        "/api/v1/me/school-email/verify",
        headers=headers(client),
        json={"challengeId": challenge.json()["data"]["challengeId"], "code": match.group(1)},
    )
    assert response.status_code == 200, response.text
    assert response.json()["data"]["registration"]["accountState"] == "active"


def test_google_verified_claim_does_not_replace_school_verification(http, db, scope, newcomer):
    client = http.client
    assert (
        client.get("/api/v1/me").json()["data"]["registration"]["accountState"] == "email_required"
    )
    denied = client.post(
        f"/api/v1/tasks/{scope.task.id}/start",
        json={"expected_version": 0},
        headers=headers(client),
    )
    assert denied.status_code == 403, denied.text
    assert denied.json()["error"]["code"] == "REGISTRATION_REQUIRED"
    assert newcomer.user.email_binding.verified_at is None
    assert scope.task.status == "not_started" and events(db, scope) == []


def test_google_school_verification_rotates_cookie_and_enables_c_execution(
    http, db, scope, newcomer
):
    client = http.client
    onboarding_cookie = client.cookies.get(get_settings().session_cookie_name)
    verify_school_email(client, db, newcomer)
    assert client.cookies.get(get_settings().session_cookie_name) != onboarding_cookie
    old_session = db.scalar(
        select(AuthSession).where(AuthSession.token_digest == token_digest(onboarding_cookie))
    )
    assert old_session.revoked_at is not None
    base = f"/api/v1/tasks/{scope.task.id}"
    started = client.post(f"{base}/start", json={"expected_version": 0}, headers=headers(client))
    assert started.status_code == 200, started.text
    progressed = client.patch(
        f"{base}/progress",
        json={"expected_version": 1, "progress": 100, "reason": "Implementation finished"},
        headers=headers(client),
    )
    assert progressed.status_code == 200, progressed.text
    assert progressed.json()["data"]["status"] == "in_progress"
    assert [event.actor_id for event in events(db, scope)] == [newcomer.user.id] * 2
    assert client.get("/api/v1/c-admin/users").status_code == 403


def test_link_unlink_and_google_login_keep_c_note_owner_and_canonical_uuid(http, db, scope, issuer):
    client, user = http.client, scope.users["author"]
    subject = existing_account(db, user, issuer, password=True)
    password_login(client, user)
    before_cookie = client.cookies.get(get_settings().session_cookie_name)
    key = str(uuid4())
    command = {"expected_version": 0, "title": "Implementation", "body": "Before Google linking"}
    saved = client.put(
        note_path(scope), json=command, headers={**headers(client), "Idempotency-Key": key}
    )
    assert saved.status_code == 200, saved.text
    note_id = saved.json()["data"]["id"]
    linked, _, _ = google_callback(client, db, issuer, subject, link=True)
    assert linked.headers["location"] == "/account/security?linked=google"
    assert client.cookies.get(get_settings().session_cookie_name) == before_cookie
    assert client.post("/api/v1/auth/logout", headers=headers(client)).status_code == 204
    signed_in, _, _ = google_callback(client, db, issuer, subject)
    assert signed_in.headers["location"] == "/home"
    assert client.get("/api/v1/me").json()["data"]["user"]["id"] == str(user.id)
    original = client.get(note_path(scope)).json()["data"]
    assert original["id"] == note_id and original["versions"][0]["edited_by"] == str(user.id)
    unlinked = client.delete("/api/v1/me/identities/google", headers=headers(client))
    assert unlinked.status_code == 200, unlinked.text
    assert db.scalar(select(AuthIdentity.id).where(AuthIdentity.subject == subject)) is None
    updated = client.put(
        note_path(scope),
        json={
            "expected_version": original["lock_version"],
            "title": "Implementation",
            "body": "After unlinking",
        },
        headers={**headers(client), "Idempotency-Key": str(uuid4())},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["data"]["id"] == note_id
    versions = client.get(note_path(scope), params={"history": True}).json()["data"]["versions"]
    assert [v["version_no"] for v in versions] == [2, 1]
    assert {v["edited_by"] for v in versions} == {str(user.id)}
    assert client.post("/api/v1/auth/logout", headers=headers(client)).status_code == 204
    password_login(client, user)
    assert client.get(note_path(scope)).json()["data"]["id"] == note_id


def test_existing_google_identity_does_not_grant_cross_project_or_admin_access(
    http, db, scope, issuer
):
    client, user = http.client, scope.users["outsider"]
    subject = existing_account(db, user, issuer)
    callback, _, _ = google_callback(client, db, issuer, subject)
    assert callback.headers["location"] == "/home"
    assert client.get(f"/api/v1/tasks/{scope.other_task.id}/execution").status_code == 200
    denied_read = client.get(f"/api/v1/tasks/{scope.task.id}/execution")
    denied_write = client.put(
        note_path(scope),
        json={"expected_version": 0, "title": "Unauthorized", "body": "Must not persist"},
        headers={**headers(client), "Idempotency-Key": str(uuid4())},
    )
    assert denied_read.status_code == denied_write.status_code == 403
    assert client.get("/api/v1/c-admin/users").status_code == 403
    assert (
        db.scalar(
            select(func.count())
            .select_from(TaskNoteVersion)
            .join(TaskNote, TaskNoteVersion.note_id == TaskNote.id)
            .where(TaskNote.task_id == scope.task.id)
        )
        == 0
    )


def test_google_admin_disable_revokes_c_session_and_new_login_stays_restricted(
    http, db, scope, issuer
):
    client, target = http.client, scope.users["author"]
    subject = existing_account(db, target, issuer)
    admin_subject = existing_account(db, scope.users["admin"], issuer)
    assign(db, scope, target)
    google_callback(client, db, issuer, subject)
    token = client.cookies.get(get_settings().session_cookie_name)
    target_session = db.scalar(
        select(AuthSession).where(AuthSession.token_digest == token_digest(token))
    )
    assert client.get(f"/api/v1/tasks/{scope.task.id}/execution").status_code == 200
    with TestClient(http.app, base_url=ORIGIN) as admin_client:
        google_callback(admin_client, db, issuer, admin_subject)
        response = admin_client.post(
            f"/api/v1/c-admin/users/{target.id}/disable",
            headers=headers(admin_client),
            json={"expectedVersion": target.version, "reason": "Revoke this test account"},
        )
        assert response.status_code == 200, response.text
    db.refresh(target_session)
    assert target_session.revoked_at is not None
    denied = client.post(f"/api/v1/tasks/{scope.task.id}/start", json={"expected_version": 0})
    assert denied.status_code == 401, denied.text
    callback, _, _ = google_callback(client, db, issuer, subject)
    assert callback.headers["location"] == "/account/status"
    denied = client.post(f"/api/v1/tasks/{scope.task.id}/start", json={"expected_version": 0})
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "ACCOUNT_INACTIVE"
    assert events(db, scope) == [] and scope.task.status == "not_started"


def test_replayed_google_callback_does_not_duplicate_c_commands(http, db, scope, newcomer):
    client = http.client
    verify_school_email(client, db, newcomer)
    path = f"/api/v1/tasks/{scope.task.id}/start"
    assert (
        client.post(path, json={"expected_version": 0}, headers=headers(client)).status_code == 200
    )
    event_ids = [event.id for event in events(db, scope)]
    key = str(uuid4())
    command = {"expected_version": 0, "title": "Single note", "body": "Must keep one version"}
    saved = client.put(
        note_path(scope), json=command, headers={**headers(client), "Idempotency-Key": key}
    )
    assert saved.status_code == 200, saved.text
    # Restore the consumed OAuth cookie deliberately: this checks transaction
    # replay protection, not only the browser cookie being absent after callback.
    client.cookies.set(
        get_settings().oauth_cookie_name, newcomer.state, domain="localhost.local", path="/"
    )
    replay = client.get(
        CALLBACK, params={"state": newcomer.state, "code": newcomer.code}, follow_redirects=False
    )
    assert replay.status_code == 302 and replay.headers["location"] == "/login?error=failed"
    assert client.get("/api/v1/me").json()["data"]["user"]["id"] == str(newcomer.user.id)
    assert (
        client.post(path, json={"expected_version": 0}, headers=headers(client)).status_code == 200
    )
    retried = client.put(
        note_path(scope), json=command, headers={**headers(client), "Idempotency-Key": key}
    )
    assert retried.status_code == 200 and retried.json()["data"]["id"] == saved.json()["data"]["id"]
    assert [event.id for event in events(db, scope)] == event_ids
    assert (
        client.get(note_path(scope), params={"history": True}).json()["data"]["current_version_no"]
        == 1
    )
    identities = list(
        db.scalars(select(AuthIdentity).where(AuthIdentity.subject == newcomer.subject))
    )
    assert len(identities) == 1 and identities[0].user_id == newcomer.user.id


def test_google_email_conflict_cannot_take_over_existing_c_assignment(http, db, scope, issuer):
    user = scope.users["author"]
    existing_account(db, user, issuer, password=True)
    assign(db, scope, user)
    subject = f"conflict-{uuid4().hex}"
    response, _, _ = google_callback(
        http.client, db, issuer, subject, email=f"{user.id.hex}@login.test"
    )
    assert response.headers["location"] == "/login?error=account_exists"
    assert db.scalar(select(AuthIdentity.id).where(AuthIdentity.subject == subject)) is None
    denied = http.client.post(f"/api/v1/tasks/{scope.task.id}/start", json={"expected_version": 0})
    assert denied.status_code == 401 and events(db, scope) == []
    password_login(http.client, user)
    assert (
        http.client.post(
            f"/api/v1/tasks/{scope.task.id}/start",
            json={"expected_version": 0},
            headers=headers(http.client),
        ).status_code
        == 200
    )
    assert [event.actor_id for event in events(db, scope)] == [user.id]


def test_google_session_rechecks_revoked_school_proof_before_c_write(http, db, scope, issuer):
    user = scope.users["author"]
    subject = existing_account(db, user, issuer)
    assign(db, scope, user)
    google_callback(http.client, db, issuer, subject)
    user.email_binding.verified_at = None
    user.email_verified_at = utcnow()  # a legacy mirror cannot rescue revoked A proof
    db.commit()
    denied = http.client.post(
        f"/api/v1/tasks/{scope.task.id}/start",
        json={"expected_version": 0},
        headers=headers(http.client),
    )
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "REGISTRATION_REQUIRED"
    assert events(db, scope) == [] and scope.task.status == "not_started"


@pytest.mark.parametrize("invalid", ["missing_token", "wrong_token", "foreign_origin"])
@pytest.mark.parametrize("operation", ["start", "progress", "note"])
def test_cookie_authenticated_c_writes_require_session_csrf_and_same_origin(
    http, db, scope, issuer, invalid, operation
):
    client, user = http.client, scope.users["author"]
    subject = existing_account(db, user, issuer)
    assign(db, scope, user)
    if operation != "start":
        scope.task.status = "in_progress"
        db.commit()
    google_callback(client, db, issuer, subject)
    before = (scope.task.status, scope.task.progress_percent, scope.task.lock_version)
    # The real cookie already grants the actor permission to read this task.
    assert client.get(f"/api/v1/tasks/{scope.task.id}/execution").status_code == 200
    request_headers = headers(client)
    if invalid == "missing_token":
        request_headers.pop("X-CSRF-Token")
    elif invalid == "wrong_token":
        request_headers["X-CSRF-Token"] = "not-this-session-token"
    else:
        request_headers["Origin"] = "https://foreign.example"
    if operation == "start":
        response = client.post(
            f"/api/v1/tasks/{scope.task.id}/start",
            json={"expected_version": 0},
            headers=request_headers,
        )
    elif operation == "progress":
        response = client.patch(
            f"/api/v1/tasks/{scope.task.id}/progress",
            json={"expected_version": 0, "progress": 50, "reason": "Attempted change"},
            headers=request_headers,
        )
    else:
        response = client.put(
            note_path(scope),
            json={"expected_version": 0, "title": "Attempted note", "body": "Must not persist"},
            headers={**request_headers, "Idempotency-Key": str(uuid4())},
        )
    assert response.status_code == 403, response.text
    assert response.json()["error"]["code"] == "FORBIDDEN"
    db.refresh(scope.task)
    assert (scope.task.status, scope.task.progress_percent, scope.task.lock_version) == before
    assert events(db, scope) == []
    assert db.scalar(select(TaskNote.id).where(TaskNote.task_id == scope.task.id)) is None
