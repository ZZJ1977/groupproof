"""D3-01 risk input and authorization boundaries."""

from types import SimpleNamespace
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.api.errors import ApiError
from app.modules.d.router import CreateRisk, RiskTransition, require_risk_writer


def test_valid_risk_requires_real_target_and_records_fields():
    command = CreateRisk(
        title=" Delivery risk ",
        description=" Missing test evidence ",
        level="high",
        owner_id=uuid4(),
        task_id=uuid4(),
    )
    assert command.title == "Delivery risk"
    assert command.description == "Missing test evidence"
    with pytest.raises(ValidationError):
        CreateRisk(title="Risk", description="Description", level="high", owner_id=uuid4())
    with pytest.raises(ValidationError):
        RiskTransition(action="close", note="   ", expected_version=0)


def test_risk_writer_rejects_unrelated_or_read_only_actor():
    active = SimpleNamespace(
        project=SimpleNamespace(lifecycle="active"),
        course=SimpleNamespace(status="active"),
        member=True,
        teacher=False,
    )
    require_risk_writer(active)
    with pytest.raises(ApiError) as denied:
        require_risk_writer(
            SimpleNamespace(
                project=active.project, course=active.course, member=False, teacher=False
            )
        )
    assert denied.value.status_code == 403
    with pytest.raises(ApiError) as closed:
        require_risk_writer(
            SimpleNamespace(
                project=SimpleNamespace(lifecycle="archived"),
                course=active.course,
                member=True,
                teacher=False,
            )
        )
    assert closed.value.status_code == 403
