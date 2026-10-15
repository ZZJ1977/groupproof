"""Directory HTTP/SQL tests; SQLite is not PostgreSQL integration evidence.

Reuse the existing relational fixture. C_TEST_DATABASE_URL selects an already
migrated disposable PostgreSQL database with transaction rollback per test.
"""

from datetime import UTC, datetime
from types import SimpleNamespace
from uuid import uuid4

import pytest
import test_c_discussions as discussion_tests
from fastapi.testclient import TestClient

from app.api.auth import get_current_user
from app.auth.models import SchoolEmailBinding
from app.db.models import User
from app.db.session import get_session
from app.main import app

db = discussion_tests.db
LIST_FIELDS = {
    "id",
    "name",
    "username",
    "email",
    "student_id",
    "college",
    "global_role",
    "status",
    "email_verified",
}


@pytest.fixture()
def directory(db):
    run = str(uuid4())
    created = datetime(2026, 1, 1, tzinfo=UTC)
    admin = User(
        id=uuid4(),
        name="Directory administrator",
        username=f"admin-{run}",
        email=f"admin-{run}@example.test",
        college="Administration",
        global_role="admin",
        status="active",
        created_at=created,
        updated_at=created,
    )
    rows = [
        User(
            id=uuid4(),
            name=f"Directory person {i:02}",
            username=f"directory-{run}-{i:02}",
            email=f"directory-{i:02}-{run}@example.test",
            student_id=f"ST-{run}-{i:03}",
            college="Engineering" if i % 2 else "Science",
            global_role=("student", "teacher", "ta", "student")[i % 4],
            status="disabled" if i % 5 == 0 else "pending" if i % 5 == 1 else "active",
            email_binding=SchoolEmailBinding(
                school_email=f"directory-{i:02}-{run}@example.test",
                school_email_normalized=f"directory-{i:02}-{run}@example.test",
                verified_at=created if i % 2 else None,
            ),
            created_at=created,
            updated_at=created,
        )
        for i in range(23)
    ]
    rows[0].created_at = datetime(2026, 2, 1, tzinfo=UTC)
    db.add_all([admin, *rows])
    db.flush()
    return SimpleNamespace(admin=admin, rows=rows, run=run, actor=admin)


@pytest.fixture()
def client(db, directory):
    app.dependency_overrides[get_session] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: directory.actor
    with TestClient(app) as client:
        try:
            yield client
        finally:
            app.dependency_overrides.clear()


def test_fixed_pagination_total_and_deterministic_tie_breaker(client, directory):
    pages = []
    for page in (1, 2, 3, 4):
        response = client.get("/api/v1/admin/users", params={"q": "Directory person", "page": page})
        assert response.status_code == 200, response.text
        assert response.headers["Cache-Control"] == "private, no-store"
        payload = response.json()["data"]
        assert payload["page"] == page and payload["page_size"] == 10 and payload["total"] == 23
        pages.append(payload["items"])
    assert [len(rows) for rows in pages] == [10, 10, 3, 0]
    assert [row["id"] for rows in pages for row in rows] == [
        str(row.id)
        for row in sorted(directory.rows, key=lambda row: (-row.created_at.timestamp(), row.id))
    ]
    assert set(pages[0][0]) == LIST_FIELDS
    repeated = client.get("/api/v1/admin/users?q=Directory%20person&page=2").json()["data"]
    assert repeated["items"] == pages[1]


def test_all_filters_combine_and_trim(client, directory):
    target = directory.rows[7]
    response = client.get(
        "/api/v1/admin/users",
        params={
            "q": f"  directory-{directory.run}-07  ",
            "name": "  PERSON 07 ",
            "email": "DIRECTORY-07-",
            "student_id": target.student_id.upper(),
            "role": "student",
            "status": "active",
            "college": "Engineering",
            "page_size": 10,
        },
    )
    assert response.status_code == 200, response.text
    payload = response.json()["data"]
    assert payload["total"] == 1
    assert payload["items"][0]["id"] == str(target.id)
    assert payload["items"][0]["email_verified"] is True
    different = client.get(
        "/api/v1/admin/users", params={"name": "person 07", "college": "Science"}
    )
    assert different.json()["data"]["items"] == []


@pytest.mark.parametrize("role", ["student", "teacher", "ta", "admin"])
def test_filter_uses_only_canonical_global_roles(client, directory, role):
    data = client.get("/api/v1/admin/users", params={"role": role, "q": directory.run}).json()[
        "data"
    ]
    expected = [row for row in [directory.admin, *directory.rows] if row.global_role == role]
    assert data["total"] == len(expected)
    assert all(item["global_role"] == role for item in data["items"])


@pytest.mark.parametrize("search", ["%", "_", "/"])
def test_search_treats_like_metacharacters_as_literal(client, directory, db, search):
    directory.rows[0].name = "Literal 100%_match/value"
    db.flush()
    data = client.get("/api/v1/admin/users", params={"name": search}).json()["data"]
    assert data["total"] == 1 and data["items"][0]["id"] == str(directory.rows[0].id)


@pytest.mark.parametrize("status", ["active", "disabled", "pending"])
def test_status_filter_and_empty_search(client, directory, status):
    data = client.get("/api/v1/admin/users", params={"q": directory.run, "status": status}).json()[
        "data"
    ]
    expected = [row for row in [directory.admin, *directory.rows] if row.status == status]
    assert data["total"] == len(expected)
    assert all(item["status"] == status for item in data["items"])
    empty_search = client.get("/api/v1/admin/users", params={"q": " ", "status": status}).json()[
        "data"
    ]
    assert (
        empty_search == client.get("/api/v1/admin/users", params={"status": status}).json()["data"]
    )


def test_detail_is_minimal_metadata_and_unknown_user_is_404(client, directory):
    response = client.get(f"/api/v1/admin/users/{directory.rows[0].id}")
    assert response.status_code == 200
    data = response.json()["data"]
    assert set(data) == LIST_FIELDS | {"created_at", "updated_at", "lock_version"}
    assert data["id"] == str(directory.rows[0].id) and data["email_verified"] is False
    assert response.headers["Cache-Control"] == "private, no-store"
    missing = client.get(f"/api/v1/admin/users/{uuid4()}")
    assert missing.status_code == 404 and missing.json()["error"]["code"] == "USER_NOT_FOUND"
    assert missing.headers["Cache-Control"] == "private, no-store"


@pytest.mark.parametrize(
    "role,status,code",
    [
        ("student", "active", "ADMIN_REQUIRED"),
        ("teacher", "active", "ADMIN_REQUIRED"),
        ("ta", "active", "ADMIN_REQUIRED"),
        ("admin", "disabled", "ACCOUNT_INACTIVE"),
        ("admin", "pending", "ACCOUNT_INACTIVE"),
    ],
)
def test_non_admin_or_inactive_cannot_list_or_probe_any_user(client, directory, role, status, code):
    directory.actor.global_role = role
    directory.actor.status = status
    for path in ("", f"/{directory.rows[0].id}", f"/{uuid4()}"):
        response = client.get("/api/v1/admin/users" + path)
        assert response.status_code == 403
        assert response.json()["error"]["code"] == code
        assert response.headers["Cache-Control"] == "private, no-store"


def test_production_cannot_use_demo_header_or_query_actor(client, directory, monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("ENABLE_DEMO_AUTH", "true")
    app.dependency_overrides.pop(get_current_user)
    for path in ("", f"/{directory.rows[0].id}"):
        response = client.get(
            "/api/v1/admin/users" + path,
            headers={
                "X-Demo-User-Id": str(directory.admin.id),
            },
        )
        assert response.status_code == 401 and response.json()["error"]["code"] == "UNAUTHENTICATED"
        assert response.headers["Cache-Control"] == "private, no-store"


@pytest.mark.parametrize(
    "params",
    [
        {"page": 0},
        {"page": 1.5},
        {"page": 1_000_001},
        {"page_size": 1},
        {"page_size": 100},
        {"role": "leader"},
        {"status": "enabled"},
        {"name": "x" * 121},
        {"actor_id": "admin"},
        {"sort": "password"},
    ],
)
def test_invalid_filters_are_rejected(client, params):
    response = client.get("/api/v1/admin/users", params=params)
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"
    assert response.headers["Cache-Control"] == "private, no-store"


def test_invalid_uuid_and_no_mutation_routes(client, directory):
    assert client.get("/api/v1/admin/users/not-a-uuid").status_code == 422
    for method, path in (
        ("post", ""),
        ("patch", f"/{directory.rows[0].id}"),
        ("delete", f"/{directory.rows[0].id}"),
    ):
        assert getattr(client, method)("/api/v1/admin/users" + path).status_code == 405


def test_openapi_has_typed_read_only_directory_contract():
    schema = app.openapi()
    for path in ("/api/v1/admin/users", "/api/v1/admin/users/{user_id}"):
        assert set(schema["paths"][path]) == {"get"}
        responses = schema["paths"][path]["get"]["responses"]
        assert {"200", "401", "403", "404", "422"} <= set(responses)
        assert "$ref" in responses["200"]["content"]["application/json"]["schema"]
    assert set(schema["components"]["schemas"]["AdminUserDTO"]["properties"]) == LIST_FIELDS
