from dataclasses import replace
from datetime import UTC, datetime
from unittest.mock import Mock
from uuid import uuid4

import pytest

from app.api.errors import ApiError
from app.modules.c.activity_ports import ActivitySourceRecord
from app.modules.c.evidence_sources import WorkspaceEvidenceSources
from app.modules.c.source_ports import VerifiedSource


@pytest.fixture
def record():
    return ActivitySourceRecord(
        id=uuid4(),
        title="Meeting decision",
        summary="Agreed scope",
        author_id=None,
        author_name="Member",
        occurred_at=datetime.now(UTC),
        kind="message",
        source=VerifiedSource(
            uuid4(), "feishu", "message-id", "revision", {"text": "Agreed scope"}
        ),
    )


@pytest.mark.parametrize("availability", ["available", "deleted"])
def test_capture_and_recheck_read_the_authorized_activity_revision(record, availability):
    actor = uuid4()
    record = replace(record, source=replace(record.source, availability=availability))
    activity = Mock()
    activity.get.return_value = record
    ports = WorkspaceEvidenceSources(Mock(), Mock(), activity)
    request = dict(
        project_id=record.source.project_id,
        actor_id=actor,
        source_type="feishu",
        source_id=record.id,
    )
    assert ports.resolve(**request) == record.source
    activity.get.assert_called_once_with(**request)


@pytest.mark.parametrize("wrong", ["project_id", "source_id", "source_type", "reference"])
def test_mismatched_provider_snapshot_or_noncanonical_reference_is_rejected(record, wrong):
    db = Mock()
    db.get.return_value = None
    activity = Mock()
    if wrong == "reference":
        record = replace(record, source=replace(record.source, source_reference_id=record.id))
    activity.get.return_value = record
    ports = WorkspaceEvidenceSources(db, Mock(), activity)
    request = dict(
        project_id=record.source.project_id,
        actor_id=uuid4(),
        source_type="feishu",
        source_id=record.id,
    )
    if wrong != "reference":
        request[wrong] = "github" if wrong == "source_type" else uuid4()
    with pytest.raises(ApiError) as exc:
        ports.resolve(**request)
    assert exc.value.code in {"ACTIVITY_SOURCE_INVALID", "SOURCE_PROJECT_MISMATCH"}
