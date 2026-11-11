import sys
from datetime import UTC, datetime
from types import SimpleNamespace
from uuid import uuid4

import pytest
import test_c_auth_audit as auth_audit

from app.api.errors import ApiError
from app.modules.c.governance_read_router import router
from app.modules.c.shared_audit import SharedAuditFilters, shared_audit_page

db = auth_audit.db
scope = auth_audit.scope
auth_http = auth_audit.auth_http


def test_shared_audit_http_is_private_and_read_only(auth_http, scope, monkeypatch):
    auth_http.client.app.include_router(router, prefix="/api/v1")
    calls = []

    def read(_session, **filters):
        calls.append(filters)
        return SimpleNamespace(items=(), total=0)

    monkeypatch.setitem(sys.modules, "app.modules.a.audit", SimpleNamespace(list_audit_events=read))
    endpoint = "/api/v1/admin/shared-audit-events"
    auth_http.sign_in(scope.users["member"])
    assert auth_http.client.get(endpoint).status_code == 403
    assert calls == []
    auth_http.sign_in(scope.users["admin"])
    response = auth_http.client.get(endpoint, params={"action_prefix": "task."})
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "private, no-store"
    assert response.json()["data"] == {"items": [], "page": 1, "page_size": 10, "total": 0}
    assert calls[0]["action_prefix"] == "task."
    for verb in ["put", "delete"]:
        assert auth_http.client.request(verb, endpoint).status_code == 405


def test_admin_passes_filters_to_a_and_reads_only_approved_snapshot_metadata(
    db, scope, monkeypatch
):
    when = datetime(2026, 11, 11, tzinfo=UTC)
    event = SimpleNamespace(
        id=uuid4(),
        occurred_at=when,
        action="project.plan.frozen",
        actor_id=None,
        target_type="plan_version",
        target_id="imported-id",
        reason=None,
        before_json=None,
        after_json={"version_no": 2, "raw_email": "private", "status": {"nested": "private"}},
    )
    calls = []

    def read(session, **filters):
        assert session is db
        calls.append(filters)
        return SimpleNamespace(items=(event,), total=11)

    monkeypatch.setitem(sys.modules, "app.modules.a.audit", SimpleNamespace(list_audit_events=read))
    filters = SharedAuditFilters(
        page=2,
        page_size=10,
        action_prefix="project.",
        target_type="plan_version",
        target_id="imported-id",
        since=when,
    )
    page = shared_audit_page(db, scope.users["admin"], filters)
    assert calls == [
        dict(
            page=2,
            page_size=10,
            action_prefix="project.",
            target=("plan_version", "imported-id"),
            actor_id=None,
            since=when,
            until=None,
        )
    ]
    assert page.total == 11 and page.page == 2
    (row,) = page.items
    assert row.actor_id is None and row.reason is None and row.before is None
    assert row.target_type == "plan_version" and row.target_id == "imported-id"
    assert row.after == {"version_no": 2} and row.metadata_redacted


def test_student_denied_before_resolving_a_service(db, scope, monkeypatch):
    monkeypatch.setitem(sys.modules, "app.modules.a.audit", None)
    with pytest.raises(ApiError) as denied:
        shared_audit_page(db, scope.users["member"], SharedAuditFilters())
    assert denied.value.status_code == 403
    with pytest.raises(ApiError) as unavailable:
        shared_audit_page(db, scope.users["admin"], SharedAuditFilters())
    assert unavailable.value.status_code == 503


@pytest.mark.parametrize(
    "params",
    [
        {"target_id": "task-4"},
        {"target_type": "task"},
        {"since": "2026-11-11T00:00:00Z", "until": "2026-11-10T00:00:00Z"},
    ],
)
def test_partial_target_or_reversed_time_is_rejected(db, scope, params):
    with pytest.raises(ApiError) as caught:
        shared_audit_page(db, scope.users["admin"], SharedAuditFilters(**params))
    assert caught.value.status_code == 422
