from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import User
from app.modules.c.evidence_service import (
    append_source_change,
    require_contributor,
    task_in_project,
)
from app.modules.c.integration_events import claim_request, content_hash, emit_event, finish_request
from app.modules.c.models import Evidence, TaskNote, TaskNoteVersion
from app.modules.c.note_schemas import SaveTaskNote
from app.modules.c.permissions import get_project_access, require_task_plan
from app.modules.c.source_ports import VerifiedSource


def note_data(session: Session, note: TaskNote, *, history: bool = False) -> dict:
    query = select(TaskNoteVersion).where(TaskNoteVersion.note_id == note.id)
    if not history:
        query = query.where(TaskNoteVersion.version_no == note.current_version_no)
    versions = list(session.scalars(query.order_by(TaskNoteVersion.version_no.desc())))
    return {
        "id": str(note.id),
        "project_id": str(note.project_id),
        "task_id": str(note.task_id),
        "lock_version": note.lock_version,
        "current_version_no": note.current_version_no,
        "versions": [
            {
                "id": str(v.id),
                "version_no": v.version_no,
                "title": v.title,
                "body": v.body,
                "edited_by": str(v.edited_by),
                "content_hash": v.content_hash,
                "created_at": v.created_at.isoformat(),
            }
            for v in versions
        ],
    }


def get_note(
    session: Session,
    user: User,
    project_id: UUID,
    task_id: UUID,
    *,
    history: bool = False,
) -> dict | None:
    get_project_access(session, user, project_id)
    task_in_project(session, task_id, project_id)
    note = session.scalar(select(TaskNote).where(TaskNote.task_id == task_id))
    return note_data(session, note, history=history) if note else None


def save_note(
    session: Session,
    user: User,
    project_id: UUID,
    task_id: UUID,
    command: SaveTaskNote,
    key: str,
) -> dict:
    access = get_project_access(session, user, project_id, lock=True)
    require_contributor(access)
    task = task_in_project(session, task_id, project_id)
    record, replay = claim_request(
        session,
        actor_id=user.id,
        project_id=project_id,
        operation=f"note.save:{task_id}",
        key=key,
        payload=command.model_dump(mode="json"),
    )
    if replay is not None:
        return replay
    require_task_plan(access.latest_plan, task.id)
    if task.status not in {"in_progress", "pending_submission"}:
        raise ApiError(409, "TASK_STATE_CONFLICT", "This task is not accepting note changes.")
    note = session.scalar(
        select(TaskNote)
        .where(TaskNote.task_id == task_id)
        .execution_options(populate_existing=True)
    )
    if note is None:
        if command.expected_version != 0:
            raise ApiError(
                409,
                "VERSION_CONFLICT",
                "This task does not have a saved note yet.",
                {
                    "expected_version": command.expected_version,
                    "current_version": 0,
                },
            )
        note = TaskNote(
            project_id=project_id, task_id=task_id, lock_version=0, current_version_no=0
        )
        session.add(note)
        session.flush()
    changed = session.execute(
        update(TaskNote)
        .where(
            TaskNote.id == note.id,
            TaskNote.lock_version == command.expected_version,
        )
        .values(
            lock_version=TaskNote.lock_version + 1,
            current_version_no=TaskNote.current_version_no + 1,
            updated_at=datetime.now(UTC),
        )
    )
    if changed.rowcount != 1:
        raise ApiError(
            409,
            "VERSION_CONFLICT",
            "The note has changed; reload before saving.",
            {
                "expected_version": command.expected_version,
                "current_version": note.lock_version,
            },
        )
    session.refresh(note)
    version = TaskNoteVersion(
        note_id=note.id,
        version_no=note.current_version_no,
        edited_by=user.id,
        title=command.title,
        body=command.body,
        content_hash=content_hash({"title": command.title, "body": command.body}),
    )
    session.add(version)
    session.flush()
    source = VerifiedSource(
        project_id,
        "task_note",
        str(note.id),
        str(version.id),
        {
            "note_id": str(note.id),
            "note_version_id": str(version.id),
            "version_no": version.version_no,
            "title": version.title,
            "body": version.body,
        },
    )
    # Old captures remain immutable. D/verification receives an explicit invalidation
    # event rather than silently evaluating different content under the same ID.
    for evidence in session.scalars(
        select(Evidence).where(
            Evidence.project_id == project_id,
            Evidence.task_id == task_id,
            Evidence.source_type == "task_note",
            Evidence.status.in_(["candidate", "pending_confirmation", "formal"]),
        )
    ):
        append_source_change(
            session, evidence, user.id, source, f"Task note saved as version {version.version_no}."
        )
    emit_event(
        session,
        project_id=project_id,
        aggregate_id=note.id,
        event_type="task_note.version_saved",
        payload={
            "note_id": str(note.id),
            "task_id": str(task_id),
            "note_version_id": str(version.id),
            "version_no": version.version_no,
            "actor_id": str(user.id),
        },
    )
    return finish_request(session, record, note_data(session, note))
