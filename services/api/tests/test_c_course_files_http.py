"""HTTP boundary tests with real persisted rows and an explicit storage test port."""

from uuid import uuid4

import pytest
import test_c_course_files as file_tests
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app.api.auth import get_current_user
from app.api.errors import install_exception_handlers
from app.db.session import get_session
from app.modules.c.course_files_router import router
from app.modules.c.course_files_storage import get_course_storage_port

db = file_tests.db
scope = file_tests.scope
storage = file_tests.storage


@pytest.fixture()
def api(db, scope, storage):
    # Independent app lets root assemble canonical routes without test-time mutation.
    db.commit()  # Seed relationships survive a failed command's rollback.
    app = FastAPI()

    @app.middleware("http")
    async def context(request: Request, call_next):
        request.state.request_id = str(uuid4())
        response = await call_next(request)
        response.headers["X-Request-Id"] = request.state.request_id
        response.headers["Cache-Control"] = "private, no-store"
        return response

    install_exception_handlers(app)
    app.include_router(router, prefix="/api/v1")
    app.dependency_overrides[get_session] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: scope.users["teacher"]
    app.dependency_overrides[get_course_storage_port] = lambda: storage
    return app


@pytest.fixture()
def client(api):
    with TestClient(api) as client:
        yield client


def base(scope):
    return f"/api/v1/courses/{scope.course.id}/files"


def register(client, scope, storage, *, key="create", patch=None):
    receipt = storage.receipt()
    return client.post(
        base(scope),
        json={"receipt_id": str(receipt.receipt_id), "reason": "Upload", **(patch or {})},
        headers={"Idempotency-Key": key},
    )


def test_http_file_version_designation_detail_filter_and_link(client, scope, storage):
    response = register(client, scope, storage)
    assert response.status_code == 201, response.text
    assert response.headers["cache-control"] == "private, no-store"
    assert response.json()["meta"]["request_id"] == response.headers["x-request-id"]
    original = response.json()["data"]
    path = base(scope) + "/" + original["id"]
    version_id = original["versions"][0]["id"]
    response = client.post(
        path + "/publish",
        json={"version_id": version_id, "expected_version": 0, "reason": "Reviewed"},
        headers={"Idempotency-Key": "designate"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["data"]["official_version_no"] == 1
    receipt = storage.receipt()
    response = client.post(
        path + "/versions",
        json={"receipt_id": str(receipt.receipt_id), "expected_version": 1, "reason": "Update"},
        headers={"Idempotency-Key": "append"},
    )
    assert response.status_code == 201, response.text
    assert [v["status"] for v in response.json()["data"]["versions"]] == ["draft", "current"]
    detail = client.get(path).json()["data"]
    assert len(detail["decisions"]) == 3 and len(detail["versions"]) == 2
    listing = client.get(
        base(scope) + "?category=documents&q=brief&file_type=pdf&status=current&page_size=1"
    )
    assert listing.status_code == 200 and listing.json()["data"]["total"] == 1
    for purpose in ("preview", "download"):
        link = client.get(path + f"/versions/{version_id}/link?purpose={purpose}")
        assert link.status_code == 200, link.text
        assert link.json()["data"]["purpose"] == purpose
        assert link.headers["cache-control"] == "private, no-store"


@pytest.mark.parametrize(
    "field,value",
    [
        ("content_hash", "forged"),
        ("object_id", "bucket/path"),
        ("url", "https://example.test"),
        ("actor_id", str(uuid4())),
        ("reason", " "),
        ("receipt_id", "mock-id"),
    ],
)
def test_http_rejects_client_byte_provenance(client, scope, storage, field, value):
    response = register(client, scope, storage, patch={field: value})
    assert response.status_code == 422 and response.json()["error"]["code"] == "VALIDATION_ERROR"
    assert storage.resolve_calls == 0


@pytest.mark.parametrize(
    "query",
    ["category=anything", "page=0", "page_size=101", "sort=bad", "file_type=../pdf", "status=void"],
)
def test_http_validates_combined_filter_inputs(client, scope, query):
    response = client.get(base(scope) + "?" + query)
    assert response.status_code == 422
    assert response.headers["cache-control"] == "private, no-store"


def test_http_default_storage_never_claims_uploaded_bytes(api, client, scope, storage):
    api.dependency_overrides.pop(get_course_storage_port)
    response = register(client, scope, storage)
    assert (
        response.status_code == 503
        and response.json()["error"]["code"] == "COURSE_FILE_STORAGE_UNAVAILABLE"
    )
    assert client.get(base(scope)).json()["data"]["total"] == 0


@pytest.mark.parametrize("actor", ["author", "ta", "outsider", "admin"])
def test_http_authorization_precedes_storage(api, client, scope, storage, actor):
    api.dependency_overrides[get_current_user] = lambda: scope.users[actor]
    response = register(client, scope, storage)
    assert response.status_code == 403 and storage.resolve_calls == 0


def test_http_requires_idempotency_and_expected_version(client, scope, storage):
    receipt = storage.receipt()
    assert (
        client.post(
            base(scope), json={"receipt_id": str(receipt.receipt_id), "reason": "Upload"}
        ).status_code
        == 422
    )
    original = register(client, scope, storage).json()["data"]
    path = base(scope) + "/" + original["id"]
    response = client.post(
        path + "/publish",
        json={"version_id": original["versions"][0]["id"], "reason": "Reviewed"},
        headers={"Idempotency-Key": "review"},
    )
    assert response.status_code == 422


def test_http_canonical_auth_remains_closed_in_production(api, client, scope, monkeypatch):
    api.dependency_overrides.pop(get_current_user)
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("ENABLE_DEMO_AUTH", "true")
    response = client.get(base(scope), headers={"X-Demo-User-Id": str(scope.users["teacher"].id)})
    assert response.status_code == 401 and response.json()["error"]["code"] == "UNAUTHENTICATED"


def test_http_openapi_has_typed_contracts_and_error_responses(api):
    schema = api.openapi()
    route = schema["paths"]["/api/v1/courses/{course_id}/files"]["post"]
    assert {"201", "401", "403", "404", "409", "422", "503"} <= set(route["responses"])
    assert "$ref" in route["responses"]["201"]["content"]["application/json"]["schema"]
    fields = schema["components"]["schemas"]["RegisterCourseFile"]["properties"]
    assert set(fields) == {"receipt_id", "reason", "category"}


def test_http_student_cannot_discover_or_download_draft_versions(api, client, scope, storage):
    first = register(client, scope, storage).json()["data"]
    path = base(scope) + "/" + first["id"]
    version_id = first["versions"][0]["id"]
    api.dependency_overrides[get_current_user] = lambda: scope.users["author"]
    assert client.get(base(scope)).json()["data"]["total"] == 0
    assert client.get(path).status_code == 404
    assert client.get(path + f"/versions/{version_id}/link").status_code == 404
    assert storage.sign_calls == 0
    api.dependency_overrides[get_current_user] = lambda: scope.users["teacher"]
    publication = client.post(
        path + "/publish",
        json={"version_id": version_id, "expected_version": 0, "reason": "Released to class"},
        headers={"Idempotency-Key": "released"},
    )
    assert publication.status_code == 200
    api.dependency_overrides[get_current_user] = lambda: scope.users["author"]
    listed = client.get(base(scope)).json()["data"]
    assert listed["total"] == 1 and not listed["can_write"]
    assert client.get(path).status_code == 200
    assert client.get(path + f"/versions/{version_id}/link").status_code == 200


@pytest.mark.parametrize("actor", ["author", "ta", "outsider", "admin"])
@pytest.mark.parametrize("action", ["append", "designate"])
def test_http_every_version_write_is_owner_only(api, client, scope, storage, actor, action):
    original = register(client, scope, storage).json()["data"]
    api.dependency_overrides[get_current_user] = lambda: scope.users[actor]
    path = base(scope) + "/" + original["id"]
    command = {"expected_version": 0, "reason": "Attempt"}
    if action == "append":
        path += "/versions"
        command["receipt_id"] = str(storage.receipt().receipt_id)
    else:
        path += "/publish"
        command["version_id"] = original["versions"][0]["id"]
    response = client.post(path, json=command, headers={"Idempotency-Key": "denied"})
    assert response.status_code == 403
    assert storage.resolve_calls == 1


@pytest.mark.parametrize("action", ["read", "append", "designate", "link"])
def test_http_foreign_file_id_is_not_found_in_other_course(client, scope, storage, api, action):
    original = register(client, scope, storage).json()["data"]
    api.dependency_overrides[get_current_user] = lambda: scope.users["teacher"]
    path = f"/api/v1/courses/{scope.other_course.id}/files/{original['id']}"
    if action == "read":
        response = client.get(path)
    elif action == "link":
        response = client.get(path + f"/versions/{original['versions'][0]['id']}/link")
    elif action == "append":
        response = client.post(
            path + "/versions",
            json={"receipt_id": str(uuid4()), "expected_version": 0, "reason": "Attempt"},
            headers={"Idempotency-Key": "cross-project"},
        )
    else:
        response = client.post(
            path + "/publish",
            json={
                "version_id": original["versions"][0]["id"],
                "expected_version": 0,
                "reason": "Attempt",
            },
            headers={"Idempotency-Key": "cross-project"},
        )
    assert response.status_code == 404 and response.json()["error"]["code"] == "FILE_NOT_FOUND"
