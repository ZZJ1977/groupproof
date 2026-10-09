from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_healthz_returns_api_status() -> None:
    response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {"service": "api", "status": "ok"}


def test_each_member_module_has_a_separate_boundary() -> None:
    for member in "abcd":
        response = client.get(f"/api/{member}/ready")

        assert response.status_code == 200
        assert response.json() == {"module": member, "status": "ready"}
