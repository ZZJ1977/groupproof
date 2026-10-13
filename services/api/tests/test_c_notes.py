from uuid import UUID

import pytest
import test_c_evidence as evidence_tests
from sqlalchemy import select
from test_c_evidence import candidate, count, decide

from app.api.errors import ApiError
from app.modules.c.evidence_service import list_evidence
from app.modules.c.models import Evidence, EvidenceSourceSnapshot, TaskNote, TaskNoteVersion
from app.modules.c.note_schemas import SaveTaskNote
from app.modules.c.note_service import get_note, save_note

db = evidence_tests.db
scope = evidence_tests.scope


def save(session, data, *, expected=0, body="Version one", key="save-one", actor="author"):
    return save_note(
        session,
        data.users[actor],
        data.project.id,
        data.task.id,
        SaveTaskNote(expected_version=expected, title="Task work log", body=body),
        key,
    )


def test_note_is_singleton_with_immutable_versions_and_retry_dedup(db, scope):
    assert get_note(db, scope.users["member"], scope.project.id, scope.task.id) is None
    first = save(db, scope)
    assert save(db, scope) == first
    second = save(db, scope, expected=1, body="Version two", key="save-two", actor="member")
    assert second["id"] == first["id"] and second["lock_version"] == 2
    history = get_note(db, scope.users["teacher"], scope.project.id, scope.task.id, history=True)
    assert [item["body"] for item in history["versions"]] == ["Version two", "Version one"]
    assert count(db, TaskNote) == 1 and count(db, TaskNoteVersion) == 2


def test_stale_note_save_cannot_overwrite_or_create_history(db, scope):
    save(db, scope)
    with pytest.raises(ApiError) as error:
        with db.begin_nested():
            save(db, scope, expected=0, body="Stale overwrite", key="stale-key")
    assert error.value.code == "VERSION_CONFLICT"
    assert count(db, TaskNoteVersion) == 1


def test_note_change_keeps_original_evidence_snapshot_and_invalidates_effective_query(db, scope):
    first = save(db, scope)
    row = candidate(db, scope, source_type="task_note", source_id=UUID(first["versions"][0]["id"]))
    adopted = decide(db, scope, row)
    save(db, scope, expected=1, body="Changed source", key="save-two")
    evidence = db.get(Evidence, UUID(adopted["id"]))
    assert evidence.status == "formal" and evidence.source_changed
    snapshots = list(
        db.scalars(select(EvidenceSourceSnapshot).order_by(EvidenceSourceSnapshot.version_no))
    )
    assert snapshots[0].content_json["source"]["body"] == "Version one"
    assert snapshots[1].content_json["source"]["body"] == "Changed source"
    assert (
        list_evidence(db, scope.users["teacher"], scope.project.id, effective_only=True)["total"]
        == 0
    )


def test_old_note_version_cannot_be_submitted_as_current_candidate(db, scope):
    first = save(db, scope)
    save(db, scope, expected=1, key="save-two")
    with pytest.raises(ApiError) as error:
        with db.begin_nested():
            candidate(
                db, scope, source_type="task_note", source_id=UUID(first["versions"][0]["id"])
            )
    assert error.value.code == "SOURCE_NOT_CURRENT"


@pytest.mark.parametrize("actor", ["ta", "outsider", "other_teacher", "admin"])
def test_note_write_requires_project_contributor(db, scope, actor):
    with pytest.raises(ApiError) as error:
        with db.begin_nested():
            save(db, scope, actor=actor)
    assert error.value.status_code == 403
    assert count(db, TaskNote) == 0


def test_unverified_member_cannot_save_note(db, scope):
    scope.users["author"].email_binding.verified_at = None
    db.flush()
    with pytest.raises(ApiError) as error:
        save(db, scope)
    assert error.value.code == "EMAIL_NOT_VERIFIED"
