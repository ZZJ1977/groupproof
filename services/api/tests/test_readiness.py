from unittest.mock import MagicMock

import pytest
from fastapi import Response

from app import main


@pytest.mark.parametrize("revision, status", [("0015", 200), ("0014", 503), (None, 503)])
def test_readiness_requires_current_migrations(monkeypatch, revision, status):
    engine = MagicMock()
    result = engine.connect.return_value.__enter__.return_value.execute.return_value
    result.scalars.return_value = [revision] if revision else []
    monkeypatch.setattr(main, "engine", engine)
    response = Response()
    payload = main.readyz(response)
    assert response.status_code == status
    assert payload["status"] == ("ready" if status == 200 else "not_ready")


def test_readiness_does_not_leak_database_errors(monkeypatch):
    engine = MagicMock()
    engine.connect.side_effect = RuntimeError("database credentials must remain private")
    monkeypatch.setattr(main, "engine", engine)
    response = Response()
    assert main.readyz(response) == {"service": "api", "status": "not_ready"}
    assert response.status_code == 503
