"""C request and approval, A grant activation and C content reads in one database."""

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
import test_c_discussions
import test_c_evidence
from fastapi.testclient import TestClient

from app.api.auth import get_current_user
from app.db.models import CourseMember
from app.db.session import get_session
from app.main import app
from app.modules.a.access_grants import revoke_grant
from app.modules.a.models import AccessGrant

db = test_c_discussions.db
scope = test_c_evidence.scope


@pytest.mark.parametrize("resource_type", ["task", "evidence", "project"])
def test_approved_scope_controls_content_until_revoked_or_expired(db, scope, resource_type):
    peer = scope.users["outsider"]
    admin = scope.users["admin"]
    scope.project.visibility = "course"
    db.add(
        CourseMember(
            id=uuid4(), course_id=scope.course.id, user_id=peer.id, role="student", status="active"
        )
    )
    db.commit()
    actor = scope.users["author"]
    app.dependency_overrides[get_session] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: actor
    try:
        with TestClient(app) as client:
            project = f"/api/v1/projects/{scope.project.id}"
            created = client.post(
                f"{project}/evidence",
                json=test_c_evidence.command(scope).model_dump(mode="json"),
                headers={"Idempotency-Key": "capture"},
            )
            assert created.status_code == 201, created.text
            evidence = created.json()["data"]["id"]
            urls = {
                "task": f"/api/v1/tasks/{scope.task.id}/execution",
                "evidence": f"{project}/evidence/{evidence}",
                "project": f"{project}/c-context",
            }
            identifiers = {
                "task": str(scope.task.id),
                "evidence": evidence,
                "project": str(scope.project.id),
            }
            actor = peer
            assert client.get(urls[resource_type]).status_code == 403
            expiry = (datetime.now(UTC) + timedelta(hours=1)).isoformat()
            requested = client.post(
                "/api/v1/me/access-requests",
                json={
                    "scope": {
                        "project_id": str(scope.project.id),
                        "resource_type": resource_type,
                        "resource_id": identifiers[resource_type],
                    },
                    "reason": "课程评阅",
                    "expires_at": expiry,
                },
                headers={"Idempotency-Key": "request"},
            )
            assert requested.status_code == 201, requested.text
            request_id = requested.json()["data"]["id"]
            actor = admin
            approved = client.post(
                f"/api/v1/admin/access-requests/{request_id}/decisions",
                json={
                    "decision": "approved",
                    "expected_version": 0,
                    "reason": "同意评阅",
                    "expires_at": expiry,
                },
                headers={"Idempotency-Key": "approve"},
            )
            assert approved.status_code == 200, approved.text
            grant_id = UUID(approved.json()["data"]["authorization_receipt"]["grant_id"])
            actor = peer
            for kind, url in urls.items():
                response = client.get(url)
                assert response.status_code == (200 if resource_type in (kind, "project") else 403)
                if kind == "task" and response.is_success:
                    task = response.json()["data"]
                    assert task["temporary_read"] and task["read_only"]
                    assert task["title"] == scope.task.title
                    assert not task["can_update_progress"]
                    assert task["module_progress"] == {} and task["project_progress"] is None
            assert (
                client.patch(
                    f"/api/v1/tasks/{scope.task.id}/progress",
                    json={"expected_version": 0, "progress": 10, "reason": "只读角色"},
                ).status_code
                == 403
            )
            if resource_type == "evidence":
                db.get(AccessGrant, grant_id).expires_at = datetime.now(UTC) - timedelta(seconds=1)
            else:
                revoke_grant(db, admin, grant_id, "评阅结束")
            db.commit()
            assert client.get(urls[resource_type]).status_code == 403
    finally:
        app.dependency_overrides.pop(get_current_user)
        app.dependency_overrides.pop(get_session)
