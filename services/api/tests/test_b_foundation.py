"""B0 foundation: router entry point and default ports (no database needed)."""

from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.api.errors import ApiError
from app.main import app
from app.modules.b.ports import (
    UnavailableMaterialTextPort,
    UnavailableVerificationPort,
    get_material_text_port,
    get_verification_port,
)


def test_b_ready_still_returns_200():
    with TestClient(app) as client:
        response = client.get("/api/b/ready")
    assert response.status_code == 200
    assert response.json() == {"module": "b", "status": "ready"}


def test_default_material_text_port_reports_unavailable_without_inventing_text():
    receipt_id = uuid4()
    result = get_material_text_port().get_text(None, receipt_id=receipt_id, actor_id=uuid4())
    assert isinstance(get_material_text_port(), UnavailableMaterialTextPort)
    assert result.receipt_id == receipt_id
    assert result.status == "unavailable"
    assert result.segments == ()
    assert result.text == ""
    assert result.reason


def test_default_verification_port_refuses_status_queries():
    port = get_verification_port()
    assert isinstance(port, UnavailableVerificationPort)
    with pytest.raises(ApiError) as raised:
        port.task_verification_status(None, task_ids=[uuid4()])
    assert raised.value.status_code == 503
    assert raised.value.code == "VERIFICATION_UNAVAILABLE"


def test_default_verification_port_never_claims_an_invalidation():
    task_id = uuid4()
    outcome = get_verification_port().invalidate_criterion_results(
        None, task_id=task_id, criterion_ids=[uuid4()], reason="标准修改", actor_id=uuid4()
    )
    assert outcome.task_id == task_id
    assert outcome.accepted is False
    assert outcome.invalidated_result_ids == ()
