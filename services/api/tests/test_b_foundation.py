"""B0 foundation: router entry point and default ports (no database needed)."""

from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.api.errors import ApiError
from app.main import app
from app.modules.b.common import MAX_OPERATION_LENGTH, _receipt_operation
from app.modules.b.material_text_port import PersistedMaterialTextPort
from app.modules.b.ports import (
    UnavailableMaterialTextPort,
    UnavailableVerificationPort,
    get_material_text_port,
    get_verification_port,
)
from app.modules.b.verification_port import PersistedVerificationPort


def test_b_ready_still_returns_200():
    with TestClient(app) as client:
        response = client.get("/api/b/ready")
    assert response.status_code == 200
    assert response.json() == {"module": "b", "status": "ready"}


def test_default_material_text_port_uses_persisted_adapter():
    port = get_material_text_port()
    assert isinstance(port, PersistedMaterialTextPort)
    receipt_id = uuid4()
    result = port.get_text(None, receipt_id=receipt_id, actor_id=uuid4())
    assert result.receipt_id == receipt_id
    assert result.status == "unavailable"
    assert result.segments == ()
    assert result.text == ""
    assert result.reason


def test_unavailable_material_text_port_reports_unavailable_without_inventing_text():
    receipt_id = uuid4()
    result = UnavailableMaterialTextPort().get_text(None, receipt_id=receipt_id, actor_id=uuid4())
    assert result.receipt_id == receipt_id
    assert result.status == "unavailable"
    assert result.segments == ()
    assert result.text == ""
    assert result.reason


def test_default_verification_port_uses_persisted_adapter():
    assert isinstance(get_verification_port(), PersistedVerificationPort)


def test_unavailable_verification_port_refuses_status_queries():
    port = UnavailableVerificationPort()
    with pytest.raises(ApiError) as raised:
        port.task_verification_status(None, task_ids=[uuid4()])
    assert raised.value.status_code == 503
    assert raised.value.code == "VERIFICATION_UNAVAILABLE"


def test_unavailable_verification_port_never_claims_an_invalidation():
    task_id = uuid4()
    outcome = UnavailableVerificationPort().invalidate_criterion_results(
        None, task_id=task_id, criterion_ids=[uuid4()], reason="标准修改", actor_id=uuid4()
    )
    assert outcome.task_id == task_id
    assert outcome.accepted is False
    assert outcome.invalidated_result_ids == ()


def test_receipt_operation_compacts_overlong_names_deterministically():
    short = f"course.join.decide:{uuid4()}"
    assert _receipt_operation(short) == short

    long_a = f"teacher.actions.remind:{uuid4()}:milestone:{uuid4()}"
    long_b = f"teacher.actions.remind:{uuid4()}:milestone:{uuid4()}"
    assert len(long_a) > MAX_OPERATION_LENGTH
    compacted_a = _receipt_operation(long_a)
    compacted_b = _receipt_operation(long_b)
    assert len(compacted_a) == MAX_OPERATION_LENGTH
    assert compacted_a == _receipt_operation(long_a)
    assert compacted_a != compacted_b
