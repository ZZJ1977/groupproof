"""C7 wrappers use real identity sessions, roles, CSRF and A account services."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from tests.conftest import csrf_headers, session_csrf
from tests.flows import login_admin, register_student, register_teacher_to_review


def test_directory_requires_real_admin_and_has_minimal_ten_row_projection(client, stub):
    assert client.get("/api/v1/c-admin/users").status_code == 401
    register_student(client, stub)
    assert client.get("/api/v1/c-admin/users").status_code == 403
    login_admin(client, stub)
    result = client.get("/api/v1/c-admin/users?role=student").json()
    assert result["pageSize"] == 10 and result["total"] == 1
    assert result["items"][0]["roles"] == ["student"]
    assert set(result["items"][0]) == {
        "id",
        "name",
        "studentId",
        "college",
        "roles",
        "status",
        "version",
        "schoolEmail",
        "schoolEmailVerified",
        "canDisable",
    }
    assert client.get("/api/v1/c-admin/users?q=%25").json()["items"] == []


def test_disable_requires_reason_csrf_and_cannot_disable_self(client, stub):
    actor = login_admin(client, stub)
    path = "/api/v1/c-admin/users/" + actor.id + "/disable"
    headers = csrf_headers(session_csrf(client))
    assert (
        client.post(
            path, json={"reason": "x", "expectedVersion": actor.version}
        ).status_code
        == 403
    )
    assert (
        client.post(
            path,
            headers=headers,
            json={"reason": " ", "expectedVersion": actor.version},
        ).status_code
        == 422
    )
    assert (
        client.post(
            path,
            headers=headers,
            json={"reason": "x", "expectedVersion": actor.version},
        ).status_code
        == 403
    )


def test_disable_revokes_existing_session_and_replay_has_no_second_write(
    client, stub, db_session
):
    from app.main import app
    from app.models import AuthAuditEvent, User

    register_student(client, stub)
    target_id = client.get("/api/v1/me").json()["user"]["id"]
    with TestClient(app, base_url="http://localhost:8000") as admin:
        login_admin(admin, stub)
        row = admin.get("/api/v1/c-admin/users?role=student").json()["items"][0]
        body = {"reason": "Policy review", "expectedVersion": row["version"]}
        path = "/api/v1/c-admin/users/" + target_id + "/disable"
        headers = csrf_headers(session_csrf(admin))
        assert admin.post(path, headers=headers, json=body).status_code == 200
        assert admin.post(path, headers=headers, json=body).status_code == 409
    db_session.expire_all()
    assert db_session.get(User, target_id).disabled_reason == "Policy review"
    assert client.get("/api/v1/auth/session").json() == {"authenticated": False}
    rows = list(
        db_session.scalars(
            select(AuthAuditEvent).where(AuthAuditEvent.event_type == "user.disabled")
        )
    )
    assert len(rows) == 1


@pytest.mark.parametrize("decision", ["approve", "reject"])
def test_review_reuses_current_identity_basis_and_preserves_reason(
    client, stub, db_session, decision
):
    from app.main import app
    from app.models import TeacherApplication, User

    register_teacher_to_review(client, stub)
    with TestClient(app, base_url="http://localhost:8000") as admin:
        login_admin(admin, stub)
        listing = admin.get("/api/v1/c-admin/teacher-applications").json()
        row = listing["items"][0]
        assert row["emailVerified"] is True
        path = "/api/v1/c-admin/teacher-applications/" + row["id"] + "/review"
        headers = csrf_headers(session_csrf(admin))
        body = {
            "decision": decision,
            "reason": "Reviewed evidence",
            "expectedVersion": row["applicationVersion"],
        }
        assert (
            admin.post(path, headers=headers, json={**body, "reason": ""}).status_code
            == 422
        )
        result = admin.post(path, headers=headers, json=body)
        assert result.status_code == 200, result.text
        assert admin.post(path, headers=headers, json=body).status_code == 409
    application = db_session.get(TeacherApplication, row["id"])
    assert application.reason == body["reason"]
    assert ("teacher" in db_session.get(User, row["userId"]).roles) == (
        decision == "approve"
    )


def test_review_refuses_current_unverified_email(client, stub, db_session):
    from app.main import app
    from app.models import SchoolEmailBinding

    register_teacher_to_review(client, stub)
    with TestClient(app, base_url="http://localhost:8000") as admin:
        login_admin(admin, stub)
        row = admin.get("/api/v1/c-admin/teacher-applications").json()["items"][0]
        binding = db_session.get(SchoolEmailBinding, row["userId"])
        binding.verified_at = None
        db_session.commit()
        result = admin.post(
            "/api/v1/c-admin/teacher-applications/" + row["id"] + "/review",
            headers=csrf_headers(session_csrf(admin)),
            json={
                "decision": "approve",
                "reason": "Cannot approve",
                "expectedVersion": row["applicationVersion"],
            },
        )
        assert result.status_code == 422
