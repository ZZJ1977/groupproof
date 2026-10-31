import pytest
import test_c_governance as governance_tests
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.auth import get_current_user
from app.api.errors import install_exception_handlers
from app.db.session import get_session
from app.modules.c.governance_ports import get_authorization_port
from app.modules.c.governance_read_router import router as read_router
from app.modules.c.governance_router import router

db = governance_tests.db
scope = governance_tests.scope


@pytest.fixture()
def app(db, scope):
    db.commit()
    app = FastAPI()
    app.include_router(router, prefix="/api/v1")
    app.include_router(read_router, prefix="/api/v1")
    install_exception_handlers(app)

    @app.middleware("http")
    async def context(request, next_handler):
        request.state.request_id = "governance-test"
        response = await next_handler(request)
        response.headers["Cache-Control"] = "private, no-store"
        return response

    app.dependency_overrides[get_session] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: scope.users["admin"]
    return app


@pytest.fixture()
def client(app):
    with TestClient(app) as client:
        yield client


def test_http_course_create_publish_invite_and_end(client, scope):
    result = client.post(
        "/api/v1/admin/courses",
        json=governance_tests.course_command(scope).model_dump(mode="json"),
        headers={"Idempotency-Key": "http-create"},
    )
    assert result.status_code == 201, result.text
    row = result.json()["data"]
    assert row["invite_code"] is None
    url = f"/api/v1/admin/courses/{row['id']}"
    published = client.post(
        url + "/transitions",
        json={"action": "publish", "expected_version": 0, "reason": "Ready"},
        headers={"Idempotency-Key": "http-publish"},
    )
    assert published.status_code == 200, published.text
    code = published.json()["data"]["invite_code"]
    assert code and client.get(url).json()["data"]["invite_code"] == code
    assert client.get(url).headers["cache-control"] == "private, no-store"
    listing = client.get("/api/v1/admin/courses?status=active&q=COURSE-NEW").json()["data"]
    assert listing["total"] == 1 and "invite_code" not in listing["items"][0]
    ended = client.post(
        url + "/transitions",
        json={"action": "end", "expected_version": 1, "reason": "Finished"},
        headers={"Idempotency-Key": "http-end"},
    )
    assert ended.status_code == 200 and ended.json()["data"]["invite_revoked_at"]


def test_http_access_default_unavailable_then_fixture_approval(client, app, scope):
    app.dependency_overrides[get_current_user] = lambda: scope.users["author"]
    body = governance_tests.request_command(scope).model_dump(mode="json")
    result = client.post(
        "/api/v1/me/access-requests", json=body, headers={"Idempotency-Key": "http-request"}
    )
    assert (
        result.status_code == 503
        and result.json()["error"]["code"] == "ACCESS_VISIBILITY_UNAVAILABLE"
    )
    port = governance_tests.AuthorizationFixture()
    app.dependency_overrides[get_authorization_port] = lambda: port
    result = client.post(
        "/api/v1/me/access-requests", json=body, headers={"Idempotency-Key": "http-request"}
    )
    assert result.status_code == 201, result.text
    row = result.json()["data"]
    assert client.get("/api/v1/me/access-requests").json()["data"]["total"] == 1
    assert client.get("/api/v1/admin/access-requests").status_code == 403
    app.dependency_overrides[get_current_user] = lambda: scope.users["admin"]
    url = f"/api/v1/admin/access-requests/{row['id']}"
    response = client.post(
        url + "/decisions",
        json=governance_tests.approval(row).model_dump(mode="json"),
        headers={"Idempotency-Key": "http-approve"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["data"]["status"] == "approved"
    assert (
        client.get(url).json()["data"]["authorization_state"]
        == "receipt_recorded_current_access_not_checked"
    )


@pytest.mark.parametrize("suffix", ["/admin/audit-logs", "/admin/ai-usage?days=7"])
def test_http_a_read_ports_default503_and_admin_only(client, app, scope, suffix):
    assert client.get("/api/v1" + suffix).status_code == 503
    app.dependency_overrides[get_current_user] = lambda: scope.users["teacher"]
    assert client.get("/api/v1" + suffix).status_code == 403


def test_http_strict_schemas_and_uuid_validation(client, scope):
    command = governance_tests.course_command(scope).model_dump(mode="json")
    assert client.post("/api/v1/admin/courses", json=command).status_code == 422
    assert (
        client.post(
            "/api/v1/admin/courses",
            json={**command, "status": "active"},
            headers={"Idempotency-Key": "invalid"},
        ).status_code
        == 422
    )
    assert client.get("/api/v1/admin/courses/mock-course").status_code == 422
    assert client.get("/api/v1/admin/ai-usage?days=8").status_code == 422
    assert client.get("/api/v1/admin/audit-logs?since=2026-01-01T00:00:00").status_code == 422


def test_governance_openapi_has_typed_responses(app):
    spec = app.openapi()
    operations = [
        op
        for path in spec["paths"].values()
        for method, op in path.items()
        if method in {"get", "post"}
    ]
    assert len(operations) == 12
    for op in operations:
        success = op["responses"].get("201", op["responses"].get("200"))
        assert "$ref" in success["content"]["application/json"]["schema"]
    for command in ["CreateCourse", "CreateAccessRequest", "DecideAccessRequest", "AccessScope"]:
        assert spec["components"]["schemas"][command]["additionalProperties"] is False
