from uuid import UUID, uuid4

import pytest
import test_c_evidence as evidence_tests
import test_c_files as file_tests
from sqlalchemy import func, select

from app.api.errors import ApiError
from app.modules.c.evidence_schemas import CheckEvidenceSource
from app.modules.c.evidence_service import (
    check_source,
    create_evidence,
    evidence_data,
    list_evidence,
)
from app.modules.c.file_evidence import FileEvidenceSourcePort, replace_file_evidence_source
from app.modules.c.files_models import FileVersion, LogicalFile
from app.modules.c.models import Evidence, EvidenceSourceSnapshot, IntegrationOutbox

db, scope, storage = file_tests.db, file_tests.scope, file_tests.storage


def capture(db, scope, storage, file, kind="file"):
    return create_evidence(
        db,
        scope.users["member"],
        scope.project.id,
        evidence_tests.command(scope, source_type=kind, source_id=file["versions"][0]["id"]),
        str(uuid4()),
        FileEvidenceSourcePort(db, storage),
    )


@pytest.mark.parametrize("kind", ["file", "screenshot"])
def test_official_evidence_stays_effective_until_its_version_is_replaced(db, scope, storage, kind):
    receipt = storage.receipt(filename="proof.png", mime_type="image/png")
    original = file_tests.designate(
        db, scope, file_tests.create(db, scope, storage, receipt=receipt)
    )
    version_id = UUID(original["versions"][0]["id"])
    created = capture(db, scope, storage, original, kind)
    assert storage.sign_calls == 1
    adopted = evidence_tests.decide(db, scope, created, actor="member")
    row = db.get(Evidence, UUID(adopted["id"]))
    updated = file_tests.append(
        db,
        scope,
        storage,
        original,
        receipt=storage.receipt(
            filename="update.png", mime_type="image/png", content_hash="b" * 64
        ),
    )
    assert evidence_data(db, row)["effective"]
    file_tests.designate(db, scope, updated, key="publish-second")
    file_tests.designate(db, scope, updated, key="publish-second")
    after = evidence_data(db, row, history=True)
    assert after["source_changed"] and not after["effective"]
    assert (
        list_evidence(db, scope.users["teacher"], scope.project.id, effective_only=True)["total"]
        == 0
    )
    snaps = [item["content"]["source"] for item in after["source_snapshots"]]
    assert [(s["version_no"], s["sha256"]) for s in snaps] == [(1, "a" * 64), (2, "b" * 64)]
    assert all(s["file_id"] == original["id"] for s in snaps)
    assert after["source_url"] is None and "signature=token" not in str(snaps)
    assert (
        db.scalar(
            select(func.count())
            .select_from(IntegrationOutbox)
            .where(IntegrationOutbox.event_type == "evidence.source_changed")
        )
        == 1
    )
    # The page posts the original source id even after its replacement.
    checked = check_source(
        db,
        scope.users["member"],
        scope.project.id,
        row.id,
        CheckEvidenceSource(
            source_id=version_id, expected_version=row.lock_version, reason="Recheck"
        ),
        "check-current",
        FileEvidenceSourcePort(db, storage),
    )
    assert (
        checked["source_changed"]
        and len(evidence_data(db, row, history=True)["source_snapshots"]) == 2
    )


def test_superseding_a_draft_invalidates_captured_evidence_and_rejects_stale_picker(
    db, scope, storage
):
    original = file_tests.create(db, scope, storage)
    created = capture(db, scope, storage, original)
    file_tests.append(db, scope, storage, original)
    row = db.get(Evidence, UUID(created["id"]))
    assert row.source_changed
    with pytest.raises(ApiError, match="current file version") as error, db.begin_nested():
        capture(db, scope, storage, original)
    assert error.value.status_code == 409
    assert file_tests.count(db, Evidence) == 1


def test_source_requires_project_file_permission_verified_image_and_live_storage(
    db, scope, storage
):
    original = file_tests.create(db, scope, storage)
    calls = FileEvidenceSourcePort(db, storage)
    source_id = UUID(original["versions"][0]["id"])
    for project, actor, kind, status in [
        (scope.project, "outsider", "file", 403),
        (scope.other_project, "outsider", "file", 404),
        (scope.project, "author", "screenshot", 422),
    ]:
        with pytest.raises(ApiError) as error:
            calls.resolve(
                project_id=project.id,
                actor_id=scope.users[actor].id,
                source_type=kind,
                source_id=source_id,
            )
        assert error.value.status_code == status
    assert storage.sign_calls == 0
    storage.link_patch = {"actor_id": scope.users["outsider"].id}
    with pytest.raises(ApiError) as error, db.begin_nested():
        capture(db, scope, storage, original)
    assert error.value.status_code == 503 and file_tests.count(db, Evidence) == 0


def test_historical_replacement_cannot_rewind_source_and_new_document_is_not_a_screenshot(
    db, scope, storage
):
    original = file_tests.create(
        db, scope, storage, receipt=storage.receipt(filename="proof.png", mime_type="image/png")
    )
    created = capture(db, scope, storage, original, "screenshot")
    v2 = file_tests.append(db, scope, storage, original)
    v3 = file_tests.append(db, scope, storage, v2)
    evidence = db.get(Evidence, UUID(created["id"]))
    file_row = db.get(LogicalFile, UUID(original["id"]))
    previous_replacement = db.get(FileVersion, UUID(v2["versions"][0]["id"]))
    replace_file_evidence_source(
        db, file_row, 1, previous_replacement, scope.users["author"].id, "Old transition"
    )
    result = check_source(
        db,
        scope.users["member"],
        scope.project.id,
        evidence.id,
        CheckEvidenceSource(
            source_id=UUID(original["versions"][0]["id"]),
            expected_version=evidence.lock_version,
            reason="Recheck replacement",
        ),
        "check-replaced-image",
        FileEvidenceSourcePort(db, storage),
    )
    assert result["source_changed"]
    snapshots = evidence_data(db, evidence, history=True)["source_snapshots"]
    assert [s["content"]["source"]["version_no"] for s in snapshots] == [1, 2, 3]
    assert snapshots[-1]["content"]["source"]["mime_type"] == "application/pdf"
    with pytest.raises(ApiError) as error, db.begin_nested():
        capture(db, scope, storage, v3, "screenshot")
    assert error.value.code == "SCREENSHOT_REQUIRED"


@pytest.mark.parametrize("legacy_content", [{}, {"source": "legacy text"}])
def test_unrecognized_historical_snapshot_does_not_block_file_replacement(
    db, scope, storage, legacy_content
):
    original = file_tests.create(db, scope, storage)
    created = capture(db, scope, storage, original)
    row_id = UUID(created["id"])
    db.add(
        EvidenceSourceSnapshot(
            evidence_id=row_id,
            version_no=2,
            source_identity=original["id"],
            source_revision=original["versions"][0]["id"],
            content_hash="c" * 64,
            content_json=legacy_content,
            captured_by=scope.users["member"].id,
        )
    )
    db.flush()
    updated = file_tests.append(db, scope, storage, original)
    assert updated["latest_version_no"] == 2
    history = evidence_data(db, db.get(Evidence, row_id), history=True)
    assert len(history["source_snapshots"]) == 2
