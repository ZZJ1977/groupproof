"""The local B acceptance accounts can sign in with a password and see the course."""

from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from scripts.seed_b_accounts import INVITE_CODE, PASSWORD, seed_b_accounts
from tests.test_b_planning_postgres import b_engine  # noqa: F401  (fixture)


def login(client: TestClient, username: str) -> dict:
    response = client.post(
        "/api/v1/auth/password/login", json={"identifier": username, "password": PASSWORD}
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]


def test_accounts_reach_a_full_session_and_can_be_reseeded(b_engine):  # noqa: F811
    from app.auth.db import get_db
    from app.db.session import get_session
    from app.main import app

    with Session(b_engine) as session:
        first = seed_b_accounts(session)
    with Session(b_engine) as session:
        again = seed_b_accounts(session)  # idempotent
    assert first == again

    def override():
        with Session(b_engine) as session:
            yield session
            session.commit()

    app.dependency_overrides[get_db] = override
    app.dependency_overrides[get_session] = override
    try:
        for name, role in (("b-teacher", "teacher"), ("b-student1", "student")):
            with TestClient(app) as client:
                data = login(client, name)
                assert (data["accountState"], data["sessionScope"]) == ("active", "full"), data
                if role == "student":
                    preview = client.post(
                        "/api/v1/course-joins/preview",
                        json={"invite_code": INVITE_CODE},
                        headers={
                            "Idempotency-Key": "seed-preview",
                            "X-CSRF-Token": data["csrfToken"],
                        },
                    )
                    assert preview.status_code == 200, preview.text
                    assert preview.json()["data"]["course_id"] == first["course_id"]
                else:
                    # The teacher can open page 48 of the course.
                    path = f"/api/v1/courses/{first['course_id']}/membership-changes"
                    assert client.get(path).status_code == 200
    finally:
        app.dependency_overrides.clear()
