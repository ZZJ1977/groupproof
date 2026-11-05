"""C authentication-audit reads over real A rows, with real Cookie HTTP guards.

Uses the shared rollback fixture (SQLite by default, canonical PostgreSQL when
the root test runner explicitly selects C_TEST_DATABASE_URL). No A table writer
is added by C; tests create A events through A services or explicit hostile fixtures.
"""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
import test_c_auth_verification_integration as auth_tests
from pydantic import ValidationError
from sqlalchemy import event, select

from app.api.errors import ApiError
from app.auth.models import AuthAuditEvent
from app.auth.services import accounts, audit
from app.auth.services.email_challenges import PURPOSES
from app.db.models import User
from app.modules.c.auth_audit_router import router
from app.modules.c.auth_audit_schemas import AuthAuditFilters
from app.modules.c.auth_audit_service import (
    SAFE_CHANGED_FIELDS,
    get_auth_audit_log,
    list_auth_audit_logs,
)

db = auth_tests.db
scope = auth_tests.scope
auth_http = auth_tests.http
WHEN = datetime(2026, 10, 15, 12, tzinfo=UTC)
BASE = "/api/v1/admin/auth-audit-logs"
FIELDS = {
    "id",
    "source",
    "scope",
    "action",
    "actor_id",
    "target_user_id",
    "result",
    "occurred_at",
    "changed_fields",
    "metadata_redacted",
}


@pytest.fixture()
def http(auth_http):
    auth_http.client.app.include_router(router, prefix="/api/v1")
    return auth_http


def record(db, *, actor_id=None, target_id=None, action="profile.updated", **changes):
    before = set(db.scalars(select(AuthAuditEvent.id)))
    audit.record(
        db,
        action,
        actor_id=actor_id,
        target_user_id=target_id,
        changed_fields=["name"],
        result="success",
    )
    db.flush()
    created = next(row for row in db.scalars(select(AuthAuditEvent)) if row.id not in before)
    created.created_at = WHEN
    for key, value in changes.items():
        setattr(created, key, value)
    db.flush()
    return created


def listing(db, scope, **filters):
    return list_auth_audit_logs(db, scope.users["admin"], AuthAuditFilters(**filters))


def test_real_a_disable_service_event_is_readable_through_real_admin_cookie(http, db, scope):
    admin, target = scope.users["admin"], scope.users["member"]
    http.sign_in(admin)
    accounts.disable_user(
        db,
        target,
        admin=admin,
        reason="Private suspension explanation must not be returned",
        expected_version=target.version,
    )
    db.commit()
    stored = db.scalar(
        select(AuthAuditEvent).where(
            AuthAuditEvent.event_type == "user.disabled",
            AuthAuditEvent.actor_id == str(admin.id),
            AuthAuditEvent.target_user_id == str(target.id),
        )
    )
    assert stored is not None
    assert target.status == "disabled"
    audit_before = set(db.scalars(select(AuthAuditEvent.id)))
    result = http.client.get(
        BASE,
        params={
            "actor_id": str(admin.id),
            "target_user_id": str(target.id),
            "action": "user.disabled",
        },
    )
    assert result.status_code == 200, result.text
    assert result.headers["Cache-Control"] == "private, no-store"
    page = result.json()["data"]
    assert page["source"] == "auth_audit_events" and page["scope"] == "authentication"
    assert page["total"] == 1 and len(page["items"]) == 1
    row = page["items"][0]
    assert set(row) == FIELDS
    assert row["id"] == stored.id and row["action"] == "user.disabled"
    assert row["actor_id"] == str(admin.id) and row["target_user_id"] == str(target.id)
    assert row["changed_fields"] == ["accountStatus"] and not row["metadata_redacted"]
    detail = http.client.get(f"{BASE}/{stored.id}")
    assert detail.status_code == 200 and detail.json()["data"] == row
    assert detail.headers["Cache-Control"] == "private, no-store"
    assert "Private suspension" not in detail.text
    assert set(db.scalars(select(AuthAuditEvent.id))) == audit_before


def test_sql_filters_all_combine_with_exclusive_until_and_timezone(db, scope):
    actor, target = scope.users["author"], scope.users["member"]
    wanted = record(db, actor_id=actor.id, target_id=target.id, action="auth.password_login")
    record(db, actor_id=actor.id, target_id=target.id, action="auth.logout")
    record(db, actor_id=scope.users["leader"].id, target_id=target.id, action="auth.password_login")
    record(
        db, actor_id=actor.id, target_id=scope.users["outsider"].id, action="auth.password_login"
    )
    record(
        db, actor_id=actor.id, target_id=target.id, action="auth.password_login", result="failure"
    )
    record(
        db,
        actor_id=actor.id,
        target_id=target.id,
        action="auth.password_login",
        created_at=WHEN - timedelta(seconds=1),
    )
    record(
        db,
        actor_id=actor.id,
        target_id=target.id,
        action="auth.password_login",
        created_at=WHEN + timedelta(seconds=1),
    )
    page = listing(
        db,
        scope,
        actor_id=actor.id,
        target_user_id=target.id,
        action="auth.password_login",
        result="success",
        since="2026-10-15T20:00:00+08:00",
        until="2026-10-15T20:00:01+08:00",
    )
    assert page.total == 1 and [row.id for row in page.items] == [wanted.id]


def test_pagination_stable_ties_empty_pages_and_one_query_for_total_and_rows(db, scope):
    target = scope.users["author"]
    created = [record(db, target_id=target.id, id=f"audit-tie-{i:02}") for i in range(12)]
    created[0].created_at = WHEN + timedelta(seconds=1)
    db.flush()
    expected = [created[0].id] + sorted(row.id for row in created[1:])
    statements = []

    def capture(_connection, _cursor, statement, _parameters, _context, _many):
        if "auth_audit_events" in statement:
            statements.append(statement)

    event.listen(db.bind, "before_cursor_execute", capture)
    try:
        first = listing(db, scope, target_user_id=target.id)
    finally:
        event.remove(db.bind, "before_cursor_execute", capture)
    assert len(statements) == 1 and "auth_audit_total" in statements[0]
    assert "request_id" not in statements[0]
    second = listing(db, scope, target_user_id=target.id, page=2)
    beyond = listing(db, scope, target_user_id=target.id, page=3)
    assert [row.id for row in first.items + second.items] == expected
    assert first.total == second.total == beyond.total == 12
    assert len(first.items) == 10 and len(second.items) == 2 and beyond.items == []
    empty = listing(db, scope, target_user_id=uuid4())
    assert empty.total == 0 and empty.items == []


@pytest.mark.parametrize(
    "fields",
    [
        [
            "name",
            "passwordHash",
            "passwordHash=secret",
            "token=secret",
            "<script>secret</script>",
            {"password": "secret"},
            "name",
        ],
        {"name": "secret", "passwordHash": "secret"},
        "secret",
        None,
    ],
)
def test_projection_redacts_hostile_metadata_without_mutating_a_rows(db, scope, fields):
    row = record(
        db,
        actor_id="legacy-secret-actor",
        target_id="secret@example.test",
        event_type="secret-unknown-action",
        result="secret-result",
        changed_fields=fields,
        request_id="secret-session-token",
    )
    dto = get_auth_audit_log(db, scope.users["admin"], row.id)
    assert dto.action == "unrecognized" and dto.result == "unknown"
    assert dto.actor_id is None and dto.target_user_id is None and dto.metadata_redacted
    assert dto.changed_fields == (["name", "passwordHash"] if isinstance(fields, list) else [])
    assert "secret" not in dto.model_dump_json()
    assert row.changed_fields == fields and row.request_id == "secret-session-token"
    page = listing(db, scope, page_size=100)
    assert "secret" not in page.model_dump_json()


@pytest.mark.parametrize("purpose", [*PURPOSES, "password_recovery"])
def test_all_a_email_purposes_are_safe_field_names_only(db, scope, purpose):
    label = f"purpose:{purpose}"
    assert label in SAFE_CHANGED_FIELDS
    row = record(db, action="email_challenge.sent", changed_fields=[label])
    dto = get_auth_audit_log(db, scope.users["admin"], row.id)
    assert dto.changed_fields == [label] and not dto.metadata_redacted


def test_system_anonymous_and_historical_actor_do_not_invent_roles(db, scope):
    system = record(db, actor_id="system", action="admin.bootstrapped")
    anonymous = record(db, actor_id=None, action="auth.password_login", result="failure")
    former_teacher = scope.users["teacher"]
    historical = record(db, actor_id=former_teacher.id, action="auth.login")
    former_teacher.global_role = "student"
    db.flush()
    assert listing(db, scope, actor_id="system").items[0].id == system.id
    for row in (system, anonymous, historical):
        result = get_auth_audit_log(db, scope.users["admin"], row.id)
        assert set(result.model_dump()) == FIELDS
        assert "role" not in result.model_dump_json()
    assert get_auth_audit_log(db, scope.users["admin"], anonymous.id).actor_id is None
    assert get_auth_audit_log(db, scope.users["admin"], historical.id).actor_id == former_teacher.id


@pytest.mark.parametrize("name", ["author", "leader", "teacher", "ta", "outsider"])
def test_non_admin_cannot_list_or_probe_detail_even_for_own_event(db, scope, name):
    user = scope.users[name]
    row = record(db, actor_id=user.id)
    for operation in (
        lambda: list_auth_audit_logs(db, user, AuthAuditFilters()),
        lambda: get_auth_audit_log(db, user, row.id),
        lambda: get_auth_audit_log(db, user, "unknown-event"),
    ):
        with pytest.raises(ApiError) as error:
            operation()
        assert error.value.status_code == 403 and error.value.code == "ADMIN_REQUIRED"


@pytest.mark.parametrize(
    "change,code",
    [
        ("disabled", "ACCOUNT_INACTIVE"),
        ("role", "ADMIN_REQUIRED"),
        ("email", "EMAIL_NOT_VERIFIED"),
        ("address", "EMAIL_NOT_VERIFIED"),
        ("missing", "UNAUTHENTICATED"),
    ],
)
def test_current_admin_and_binding_revocation_beat_stale_object(db, scope, change, code):
    admin = scope.users["admin"]
    stale = User(id=admin.id, status="active", global_role="admin", email_verified_at=WHEN)
    if change == "disabled":
        admin.status = "disabled"
    elif change == "role":
        admin.global_role = "student"
    elif change == "email":
        admin.email_binding.verified_at = None
    elif change == "address":
        admin.email_binding.school_email = None
    else:
        stale.id = uuid4()
    db.flush()
    for operation in (
        lambda: list_auth_audit_logs(db, stale, AuthAuditFilters()),
        lambda: get_auth_audit_log(db, stale, "unknown-event"),
    ):
        with pytest.raises(ApiError) as error:
            operation()
        assert error.value.code == code


def test_real_http_guard_anonymous_member_admin_revocation_and_read_only_methods(http, db, scope):
    row = record(db, actor_id=scope.users["author"].id)
    assert http.client.get(BASE).status_code == 401
    assert http.client.get(f"{BASE}/{row.id}").status_code == 401
    http.sign_in(scope.users["author"])
    assert http.client.get(BASE).status_code == 403
    assert http.client.get(f"{BASE}/{row.id}").status_code == 403
    admin = scope.users["admin"]
    http.sign_in(admin)
    assert http.client.get(f"{BASE}/{row.id}").status_code == 200
    for method in ("post", "patch", "delete"):
        assert http.client.request(method, f"{BASE}/{row.id}", json={}).status_code == 405
    admin.email_binding.verified_at = None
    db.commit()
    assert http.client.get(BASE).status_code == 403
    assert http.client.get(f"{BASE}/{row.id}").status_code == 403


@pytest.mark.parametrize(
    "query",
    [
        {"page": 0},
        {"page_size": 101},
        {"actor_role": "admin"},
        {"target_type": "course"},
        {"actor_id": "' OR 1=1 --"},
        {"target_user_id": "not-a-uuid"},
        {"action": "%"},
        {"result": "other"},
        {"since": "2026-10-15T12:00:00"},
        {"since": "2026-10-15T12:00:00Z", "until": "2026-10-15T12:00:00Z"},
    ],
)
def test_http_rejects_unsupported_or_invalid_filters(http, scope, query):
    http.sign_in(scope.users["admin"])
    assert http.client.get(BASE, params=query).status_code == 422


def test_opaque_id_detail_and_missing_record_safe_sql(http, db, scope):
    http.sign_in(scope.users["admin"])
    row = record(db, id="A_opaque-auth-event-123")
    result = http.client.get(f"{BASE}/{row.id}")
    assert result.status_code == 200 and result.json()["data"]["id"] == row.id
    assert http.client.get(f"{BASE}/unknown-event").status_code == 404
    assert http.client.get(f"{BASE}/bad%20id").status_code == 422
    with pytest.raises(ApiError) as error:
        get_auth_audit_log(db, scope.users["admin"], "' OR 1=1 --")
    assert error.value.code == "AUTH_AUDIT_LOG_NOT_FOUND"
    with pytest.raises(ValidationError):
        AuthAuditFilters(actor_id="not-a-user")
