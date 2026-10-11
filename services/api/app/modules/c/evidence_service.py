from __future__ import annotations

from datetime import UTC, datetime
from urllib.parse import urlsplit
from uuid import UUID, uuid4

from pydantic import HttpUrl, ValidationError
from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import AcceptanceCriterion, SourceReference, Task, User
from app.modules.c.evidence_schemas import CheckEvidenceSource, CreateEvidence, DecideEvidence
from app.modules.c.integration_events import claim_request, content_hash, emit_event, finish_request
from app.modules.c.models import (
    Evidence,
    EvidenceCriterion,
    EvidenceDecision,
    EvidenceSourceSnapshot,
    TaskNote,
    TaskNoteVersion,
)
from app.modules.c.permissions import (
    ProjectAccess,
    get_project_access,
    require_execution_write,
    require_task_plan,
)
from app.modules.c.source_ports import SourcePort, VerifiedSource


def require_contributor(access: ProjectAccess) -> None:
    if not (access.member or access.teacher):
        raise ApiError(403, "EVIDENCE_WRITE_DENIED", "Only project members and teachers may write.")
    require_execution_write(access.project, access.course)


def require_decision(access: ProjectAccess, user: User, evidence: Evidence) -> None:
    require_contributor(access)
    if not (evidence.author_id == user.id or access.leader or access.teacher):
        raise ApiError(
            403, "EVIDENCE_DECISION_DENIED", "Author, project leader or teacher required."
        )


def task_in_project(session: Session, task_id: UUID, project_id: UUID) -> Task:
    task = session.get(Task, task_id)
    if task is None or task.project_id != project_id:
        raise ApiError(404, "TASK_NOT_FOUND", "Task not found in this project.")
    return task


def evidence_in_project(session: Session, evidence_id: UUID, project_id: UUID) -> Evidence:
    row = session.scalar(
        select(Evidence)
        .where(
            Evidence.id == evidence_id,
            Evidence.project_id == project_id,
        )
        .execution_options(populate_existing=True)
    )
    if row is None:
        raise ApiError(404, "EVIDENCE_NOT_FOUND", "Evidence not found in this project.")
    return row


def validate_criteria(
    session: Session,
    *,
    task_id: UUID,
    criterion_ids: list[UUID],
    require_any: bool = False,
) -> None:
    if require_any and not criterion_ids:
        raise ApiError(
            422, "CRITERIA_REQUIRED", "Formal evidence must cover an acceptance criterion."
        )
    if len(set(criterion_ids)) != len(criterion_ids):
        raise ApiError(422, "DUPLICATE_CRITERION", "An acceptance criterion cannot be repeated.")
    if criterion_ids:
        actual = set(
            session.scalars(
                select(AcceptanceCriterion.id).where(
                    AcceptanceCriterion.id.in_(criterion_ids),
                    AcceptanceCriterion.task_id == task_id,
                )
            )
        )
        if actual != set(criterion_ids):
            raise ApiError(
                422, "CRITERION_TASK_MISMATCH", "Every criterion must belong to this task."
            )


def evidence_data(session: Session, row: Evidence, *, history: bool = False) -> dict:
    criteria = list(
        session.scalars(
            select(EvidenceCriterion.criterion_id)
            .where(
                EvidenceCriterion.evidence_id == row.id,
            )
            .order_by(EvidenceCriterion.criterion_id)
        )
    )
    snapshots = list(
        session.scalars(
            select(EvidenceSourceSnapshot)
            .where(
                EvidenceSourceSnapshot.evidence_id == row.id,
            )
            .order_by(EvidenceSourceSnapshot.version_no)
        )
    )
    result = {
        "id": str(row.id),
        "project_id": str(row.project_id),
        "task_id": str(row.task_id),
        "author_id": str(row.author_id),
        "title": row.title,
        "description": row.description,
        "source_type": row.source_type,
        "source_url": row.source_url,
        "status": row.status,
        "criterion_ids": [str(value) for value in criteria],
        "source_changed": row.source_changed,
        "lock_version": row.lock_version,
        "created_at": row.created_at.isoformat(),
        "updated_at": row.updated_at.isoformat(),
        "effective": row.status == "formal" and not row.source_changed,
        "original_snapshot_id": str(snapshots[0].id) if snapshots else None,
    }
    if history:
        result["source_snapshots"] = [
            {
                "id": str(s.id),
                "version_no": s.version_no,
                "source_identity": s.source_identity,
                "source_revision": s.source_revision,
                "content_hash": s.content_hash,
                "content": s.content_json,
                "created_at": s.created_at.isoformat(),
            }
            for s in snapshots
        ]
        result["decisions"] = [
            {
                "id": str(d.id),
                "actor_id": str(d.actor_id),
                "decision": d.decision,
                "resulting_status": d.resulting_status,
                "reason": d.reason,
                "created_at": d.created_at.isoformat(),
            }
            for d in session.scalars(
                select(EvidenceDecision)
                .where(
                    EvidenceDecision.evidence_id == row.id,
                )
                .order_by(EvidenceDecision.created_at, EvidenceDecision.id)
            )
        ]
    return result


def note_source(
    session: Session, project_id: UUID, task_id: UUID, version_id: UUID
) -> VerifiedSource:
    version = session.get(TaskNoteVersion, version_id)
    note = session.get(TaskNote, version.note_id) if version else None
    if note is None or note.project_id != project_id or note.task_id != task_id:
        raise ApiError(404, "NOTE_VERSION_NOT_FOUND", "Note version not found for this task.")
    if version.version_no != note.current_version_no:
        raise ApiError(
            409, "SOURCE_NOT_CURRENT", "Use the current note version for a new candidate."
        )
    return VerifiedSource(
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


def validate_source(session: Session, source: VerifiedSource, project_id: UUID, kind: str) -> None:
    if source.project_id != project_id or source.source_type != kind:
        raise ApiError(
            422, "SOURCE_PROJECT_MISMATCH", "The source does not belong to this project."
        )
    if (
        not source.identity
        or not source.revision
        or (source.availability == "available" and not source.content)
    ):
        raise ApiError(
            503, "SOURCE_SNAPSHOT_UNAVAILABLE", "A reproducible source snapshot is required."
        )
    # A project-authorized adapter is still an integration boundary. Its link is
    # rendered in browsers, so reject malformed/active URLs before persistence.
    if source.source_url is not None:
        raw_url = source.source_url
        try:
            if (
                not isinstance(raw_url, str)
                or raw_url != raw_url.strip()
                or "\\" in raw_url
                or any(ord(character) < 32 or ord(character) == 127 for character in raw_url)
            ):
                raise ValueError("Ambiguous source URL")
            url = HttpUrl(raw_url)
            if (
                url.username is not None
                or url.password is not None
                or "@" in urlsplit(raw_url).netloc
            ):
                raise ValueError("URL credentials are not allowed")
            if kind == "github" and (
                url.scheme != "https" or url.host != "github.com" or url.port != 443
            ):
                raise ValueError("GitHub sources must use the public HTTPS origin")
        except (ValidationError, ValueError) as exc:
            raise ApiError(
                503, "SOURCE_URL_INVALID", "The source adapter returned an invalid source URL."
            ) from exc
    if source.source_reference_id is not None:
        reference = session.get(SourceReference, source.source_reference_id)
        if reference is None or reference.project_id != project_id:
            raise ApiError(422, "SOURCE_PROJECT_MISMATCH", "Source reference project mismatch.")


def create_evidence(
    session: Session,
    user: User,
    project_id: UUID,
    command: CreateEvidence,
    key: str,
    source_port: SourcePort,
) -> dict:
    access = get_project_access(session, user, project_id, lock=True)
    require_contributor(access)
    record, replay = claim_request(
        session,
        actor_id=user.id,
        project_id=project_id,
        operation="evidence.create",
        key=key,
        payload=command.model_dump(mode="json"),
    )
    if replay is not None:
        return replay
    task = task_in_project(session, command.task_id, project_id)
    require_task_plan(access.latest_plan, task.id)
    if task.status not in {"in_progress", "pending_submission"}:
        raise ApiError(409, "TASK_STATE_CONFLICT", "This task is not accepting new evidence.")
    validate_criteria(
        session, task_id=command.task_id, criterion_ids=command.criterion_ids, require_any=True
    )
    evidence_id = uuid4()
    if command.source_type == "manual":
        source = VerifiedSource(
            project_id,
            "manual",
            str(evidence_id),
            "1",
            {
                "title": command.title,
                "body": command.description,
                "provenance": "user_submitted_manual_content",
            },
            str(command.source_url) if command.source_url else None,
        )
    elif command.source_type == "task_note":
        source = note_source(session, project_id, command.task_id, command.source_id)
    else:
        source = source_port.resolve(
            project_id=project_id,
            actor_id=user.id,
            source_type=command.source_type,
            source_id=command.source_id,
        )
    validate_source(session, source, project_id, command.source_type)
    if source.availability != "available":
        raise ApiError(409, "SOURCE_UNAVAILABLE", "A deleted source cannot become new evidence.")
    row = Evidence(
        id=evidence_id,
        project_id=project_id,
        task_id=command.task_id,
        author_id=user.id,
        title=command.title,
        description=command.description,
        source_type=source.source_type,
        source_url=source.source_url,
        source_reference_id=source.source_reference_id,
        status="candidate",
        lock_version=0,
        source_changed=False,
    )
    session.add(row)
    session.flush()
    for criterion_id in command.criterion_ids:
        session.add(EvidenceCriterion(evidence_id=row.id, criterion_id=criterion_id))
    session.add(
        EvidenceSourceSnapshot(
            evidence_id=row.id,
            version_no=1,
            source_identity=source.identity,
            source_revision=source.revision,
            content_hash=content_hash(
                {"availability": source.availability, "source": source.content}
            ),
            content_json={
                "source_id": str(command.source_id) if command.source_id else None,
                "source": source.content,
                "availability": source.availability,
            },
            captured_by=user.id,
        )
    )
    session.add(
        EvidenceDecision(
            evidence_id=row.id,
            actor_id=user.id,
            decision="submitted",
            resulting_status="candidate",
            reason="User submitted an evidence candidate.",
        )
    )
    emit_event(
        session,
        project_id=project_id,
        aggregate_id=row.id,
        event_type="evidence.candidate_created",
        payload={"evidence_id": str(row.id), "task_id": str(row.task_id), "actor_id": str(user.id)},
    )
    session.flush()
    return finish_request(session, record, evidence_data(session, row))


def bump_evidence(session: Session, row: Evidence, expected_version: int, **values: object) -> None:
    changed = session.execute(
        update(Evidence)
        .where(
            Evidence.id == row.id,
            Evidence.lock_version == expected_version,
        )
        .values(**values, lock_version=Evidence.lock_version + 1, updated_at=datetime.now(UTC))
    )
    if changed.rowcount != 1:
        current = session.scalar(select(Evidence.lock_version).where(Evidence.id == row.id))
        raise ApiError(
            409,
            "VERSION_CONFLICT",
            "Evidence has changed; reload and retry.",
            {
                "expected_version": expected_version,
                "current_version": current,
            },
        )
    session.refresh(row)


def decide_evidence(
    session: Session,
    user: User,
    project_id: UUID,
    evidence_id: UUID,
    command: DecideEvidence,
    key: str,
    *,
    decision: str,
) -> dict:
    access = get_project_access(session, user, project_id, lock=True)
    row = evidence_in_project(session, evidence_id, project_id)
    require_decision(access, user, row)
    record, replay = claim_request(
        session,
        actor_id=user.id,
        project_id=project_id,
        operation=f"evidence.{decision}:{evidence_id}",
        key=key,
        payload=command.model_dump(mode="json"),
    )
    if replay is not None:
        return replay
    if row.lock_version != command.expected_version:
        raise ApiError(
            409,
            "VERSION_CONFLICT",
            "Evidence has changed; reload and retry.",
            {
                "expected_version": command.expected_version,
                "current_version": row.lock_version,
            },
        )
    if decision == "adopted":
        task = task_in_project(session, row.task_id, project_id)
        require_task_plan(access.latest_plan, task.id)
        if row.status not in {"candidate", "pending_confirmation"} or row.source_changed:
            raise ApiError(
                409, "EVIDENCE_STATE_CONFLICT", "Only an unchanged candidate can be adopted."
            )
        criteria = list(
            session.scalars(
                select(EvidenceCriterion.criterion_id).where(
                    EvidenceCriterion.evidence_id == row.id
                )
            )
        )
        validate_criteria(session, task_id=row.task_id, criterion_ids=criteria, require_any=True)
        status = "formal"
    elif decision == "withdrawn":
        if row.status not in {"candidate", "pending_confirmation", "formal"}:
            raise ApiError(409, "EVIDENCE_STATE_CONFLICT", "Evidence is already inactive.")
        status = "withdrawn"
    else:
        raise ValueError("Unsupported evidence decision")
    bump_evidence(session, row, command.expected_version, status=status)
    session.add(
        EvidenceDecision(
            evidence_id=row.id,
            actor_id=user.id,
            decision=decision,
            resulting_status=status,
            reason=command.reason,
        )
    )
    emit_event(
        session,
        project_id=project_id,
        aggregate_id=row.id,
        event_type=f"evidence.{decision}",
        payload={
            "evidence_id": str(row.id),
            "task_id": str(row.task_id),
            "actor_id": str(user.id),
            "lock_version": row.lock_version,
            "reason": command.reason,
        },
    )
    session.flush()
    return finish_request(session, record, evidence_data(session, row))


def append_source_change(
    session: Session,
    row: Evidence,
    actor_id: UUID,
    source: VerifiedSource,
    reason: str,
) -> bool:
    """Called by a verified sync adapter or note save; never accepts browser content."""
    validate_source(session, source, row.project_id, row.source_type)
    latest = session.scalar(
        select(EvidenceSourceSnapshot)
        .where(
            EvidenceSourceSnapshot.evidence_id == row.id,
        )
        .order_by(EvidenceSourceSnapshot.version_no.desc())
        .limit(1)
    )
    if latest is None or latest.source_identity != source.identity:
        raise ApiError(409, "SOURCE_IDENTITY_CONFLICT", "The source identity cannot be replaced.")
    digest = content_hash({"availability": source.availability, "source": source.content})
    if latest.source_revision == source.revision and latest.content_hash == digest:
        return False
    bump_evidence(session, row, row.lock_version, source_changed=True)
    session.add(
        EvidenceSourceSnapshot(
            evidence_id=row.id,
            version_no=latest.version_no + 1,
            source_identity=source.identity,
            source_revision=source.revision,
            content_hash=digest,
            content_json={
                "source_id": latest.content_json.get("source_id"),
                "source": source.content,
                "availability": source.availability,
            },
            captured_by=actor_id,
        )
    )
    session.add(
        EvidenceDecision(
            evidence_id=row.id,
            actor_id=actor_id,
            decision="source_changed",
            resulting_status=row.status,
            reason=reason,
        )
    )
    emit_event(
        session,
        project_id=row.project_id,
        aggregate_id=row.id,
        event_type="evidence.source_changed",
        payload={
            "evidence_id": str(row.id),
            "task_id": str(row.task_id),
            "actor_id": str(actor_id),
            "reason": reason,
            "lock_version": row.lock_version,
            "source_revision": source.revision,
            "original_snapshot_preserved": True,
        },
    )
    session.flush()
    return True


def check_source(
    session: Session,
    user: User,
    project_id: UUID,
    evidence_id: UUID,
    command: CheckEvidenceSource,
    key: str,
    source_port: SourcePort,
) -> dict:
    access = get_project_access(session, user, project_id, lock=True)
    row = evidence_in_project(session, evidence_id, project_id)
    require_decision(access, user, row)
    record, replay = claim_request(
        session,
        actor_id=user.id,
        project_id=project_id,
        operation=f"evidence.source_check:{evidence_id}",
        key=key,
        payload=command.model_dump(mode="json"),
    )
    if replay is not None:
        return replay
    if row.lock_version != command.expected_version:
        raise ApiError(409, "VERSION_CONFLICT", "Evidence has changed; reload and retry.")
    if row.source_type in {"manual", "task_note"}:
        raise ApiError(422, "SOURCE_CHECK_UNSUPPORTED", "This source is managed locally.")
    original = session.scalar(
        select(EvidenceSourceSnapshot).where(
            EvidenceSourceSnapshot.evidence_id == row.id, EvidenceSourceSnapshot.version_no == 1
        )
    )
    if original is None or original.content_json.get("source_id") != str(command.source_id):
        raise ApiError(422, "SOURCE_IDENTITY_CONFLICT", "Use the original source identifier.")
    source = source_port.resolve(
        project_id=project_id,
        actor_id=user.id,
        source_type=row.source_type,
        source_id=command.source_id,
    )
    append_source_change(session, row, user.id, source, command.reason)
    return finish_request(session, record, evidence_data(session, row))


def list_evidence(
    session: Session,
    user: User,
    project_id: UUID,
    *,
    effective_only: bool = False,
    task_id: UUID | None = None,
    status: str | None = None,
    source_type: str | None = None,
    author_id: UUID | None = None,
    criterion_id: UUID | None = None,
    q: str | None = None,
    page: int = 1,
    page_size: int = 50,
    offset: int | None = None,
    limit: int | None = None,
) -> dict:
    get_project_access(session, user, project_id)
    page_size = limit if limit is not None else page_size
    offset = offset if offset is not None else (page - 1) * page_size
    if offset < 0 or page < 1 or not 1 <= page_size <= 100:
        raise ApiError(
            422, "INVALID_PAGINATION", "Page and page_size must be positive and bounded."
        )
    page = offset // page_size + 1
    query = select(Evidence).where(Evidence.project_id == project_id)
    if task_id is not None:
        task_in_project(session, task_id, project_id)
        query = query.where(Evidence.task_id == task_id)
    if effective_only:
        query = query.where(Evidence.status == "formal", Evidence.source_changed.is_(False))
    if status:
        query = query.where(Evidence.status == status)
    if source_type:
        query = query.where(Evidence.source_type == source_type)
    if author_id is not None:
        query = query.where(Evidence.author_id == author_id)
    if criterion_id is not None:
        criterion = session.scalar(
            select(AcceptanceCriterion)
            .join(Task)
            .where(
                AcceptanceCriterion.id == criterion_id,
                Task.project_id == project_id,
            )
        )
        if criterion is None:
            raise ApiError(404, "CRITERION_NOT_FOUND", "Criterion not found in this project.")
        query = query.where(
            Evidence.id.in_(
                select(EvidenceCriterion.evidence_id).where(
                    EvidenceCriterion.criterion_id == criterion_id
                )
            )
        )
    if q and q.strip():
        pattern = (
            "%" + q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        )
        query = query.where(
            or_(
                Evidence.title.ilike(pattern, escape="\\"),
                Evidence.description.ilike(pattern, escape="\\"),
            )
        )
    total = session.scalar(select(func.count()).select_from(query.subquery()))
    rows = session.scalars(
        query.order_by(Evidence.created_at.desc(), Evidence.id).offset(offset).limit(page_size)
    )
    return {
        "items": [evidence_data(session, row) for row in rows],
        "total": total,
        "offset": offset,
        "limit": page_size,
        "page": page,
        "page_size": page_size,
    }
