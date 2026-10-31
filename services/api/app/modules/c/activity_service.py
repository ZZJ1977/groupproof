"""Project-authorized C4 operations. The caller owns commit/rollback."""

import json
import re
from copy import deepcopy
from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy import and_, func, select, update
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import SourceReference, Task, User
from app.modules.c.activity_models import ActivityRecordDecision, ActivityRecordState
from app.modules.c.activity_ports import (
    ActivityKind,
    ActivitySourcePage,
    ActivitySourcePort,
    ActivitySourceQuery,
    ActivitySourceRecord,
)
from app.modules.c.activity_schemas import AssociateActivity, DecideActivity
from app.modules.c.evidence_schemas import CreateEvidence
from app.modules.c.evidence_service import (
    create_evidence as capture_evidence,
)
from app.modules.c.evidence_service import (
    require_contributor,
    task_in_project,
    validate_source,
)
from app.modules.c.integration_events import claim_request, content_hash, emit_event, finish_request
from app.modules.c.permissions import get_project_access, require_task_plan
from app.modules.c.source_ports import VerifiedSource


def state_row(session: Session, project_id: UUID, kind: str, source_id: UUID):
    return session.scalar(
        select(ActivityRecordState)
        .where(
            ActivityRecordState.project_id == project_id,
            ActivityRecordState.source_type == kind,
            ActivityRecordState.source_id == source_id,
        )
        .execution_options(populate_existing=True)
    )


def state_data(row, project_id: UUID, kind: str, source_id: UUID) -> dict:
    return {
        "record_id": str(row.id) if row else None,
        "project_id": str(project_id),
        "source_type": kind,
        "source_id": str(source_id),
        "status": row.status if row else "candidate",
        "task_id": str(row.task_id) if row and row.task_id else None,
        "evidence_id": str(row.evidence_id) if row and row.evidence_id else None,
        "lock_version": row.lock_version if row else 0,
    }


def validate_record(
    session: Session,
    item: ActivitySourceRecord,
    project_id: UUID,
    kind: str,
    source_id: UUID | None = None,
) -> None:
    if not isinstance(item, ActivitySourceRecord) or not isinstance(item.source, VerifiedSource):
        raise ApiError(
            503, "ACTIVITY_SOURCE_INVALID", "The activity adapter returned invalid data."
        )
    if (
        not isinstance(item.id, UUID)
        or (source_id is not None and item.id != source_id)
        or not isinstance(item.title, str)
        or not item.title.strip()
        or len(item.title) > 240
        or not isinstance(item.summary, str)
        or len(item.summary) > 30000
        or not isinstance(item.author_name, str)
        or len(item.author_name) > 240
        or (item.author_id is not None and not isinstance(item.author_id, UUID))
        or not isinstance(item.occurred_at, datetime)
        or item.occurred_at.utcoffset() is None
        or not isinstance(item.kind, str)
        or not item.kind
        or len(item.kind) > 64
        or (
            item.group_id is not None
            and (
                not isinstance(item.group_id, str)
                or not item.group_id.strip()
                or len(item.group_id) > 200
            )
        )
        or not isinstance(item.source.identity, str)
        or not item.source.identity.strip()
        or len(item.source.identity) > 255
        or not isinstance(item.source.revision, str)
        or not item.source.revision.strip()
        or len(item.source.revision) > 255
        or not isinstance(item.source.content, dict)
        or item.source.availability not in {"available", "deleted"}
        or (
            item.source.source_reference_id is not None
            and not isinstance(item.source.source_reference_id, UUID)
        )
    ):
        raise ApiError(
            503, "ACTIVITY_SOURCE_INVALID", "The activity adapter returned invalid metadata."
        )
    try:
        json.dumps(item.source.content, allow_nan=False, sort_keys=True)
    except (TypeError, ValueError) as error:
        raise ApiError(
            503, "ACTIVITY_SOURCE_INVALID", "Source content must be JSON data."
        ) from error
    validate_source(session, item.source, project_id, kind)


def snapshot(item: ActivitySourceRecord) -> dict:
    return deepcopy(
        {
            "source_id": str(item.id),
            "source_identity": item.source.identity,
            "source_revision": item.source.revision,
            "availability": item.source.availability,
            "source_url": item.source.source_url,
            "source": item.source.content,
            "title": item.title,
            "summary": item.summary,
            "author_id": str(item.author_id) if item.author_id else None,
            "author_name": item.author_name,
            "occurred_at": item.occurred_at.astimezone(UTC).isoformat(),
            "kind": item.kind,
            "group_id": item.group_id,
        }
    )


def task_suggestions(tasks: list[Task], title: str) -> list[str]:
    """Only explicit T-1/T-1.2 title prefixes, unique within the project.

    The current B model has no task-code column. UUID suffixes, list positions
    and GitHub issue numbers must never become synthetic task identifiers.
    """
    mentioned = set(re.findall(r"(?<![A-Z0-9])T-\d+(?:\.\d+)*(?![A-Z0-9.])", title.upper()))
    by_code: dict[str, list[UUID]] = {}
    for task in tasks:
        match = re.match(r"^(T-\d+(?:\.\d+)*)(?=\s|$)", task.title.upper())
        if match:
            by_code.setdefault(match[1], []).append(task.id)
    return [
        str(ids[0]) for code, ids in sorted(by_code.items()) if code in mentioned and len(ids) == 1
    ]


def load_states_and_latest(session, project_id, kind, source_ids):
    """Two bounded queries for a whole page, including immutable latest captures."""
    rows = list(
        session.scalars(
            select(ActivityRecordState)
            .where(
                ActivityRecordState.project_id == project_id,
                ActivityRecordState.source_type == kind,
                ActivityRecordState.source_id.in_(source_ids),
            )
            .execution_options(populate_existing=True)
        )
    )
    latest_version = (
        select(
            ActivityRecordDecision.record_id,
            func.max(ActivityRecordDecision.version_no).label("version_no"),
        )
        .where(ActivityRecordDecision.record_id.in_([row.id for row in rows]))
        .group_by(
            ActivityRecordDecision.record_id,
        )
        .subquery()
    )
    latest = session.scalars(
        select(ActivityRecordDecision).join(
            latest_version,
            and_(
                ActivityRecordDecision.record_id == latest_version.c.record_id,
                ActivityRecordDecision.version_no == latest_version.c.version_no,
            ),
        )
    )
    return {row.source_id: row for row in rows}, {item.record_id: item for item in latest}


def activity_data(project_id, kind, item, tasks, row, latest) -> dict:
    if row and row.source_identity != item.source.identity:
        raise ApiError(
            409, "SOURCE_IDENTITY_CONFLICT", "An existing source identity cannot be replaced."
        )
    return {
        **state_data(row, project_id, kind, item.id),
        "title": item.title,
        "summary": item.summary,
        "author_id": str(item.author_id) if item.author_id else None,
        "author_name": item.author_name,
        "occurred_at": item.occurred_at.isoformat(),
        "kind": item.kind,
        "group_id": item.group_id,
        "source_identity": item.source.identity,
        "source_revision": item.source.revision,
        "source_url": item.source.source_url,
        "availability": item.source.availability,
        "source_changed": bool(latest and latest.source_hash != content_hash(snapshot(item))),
        "suggested_task_ids": task_suggestions(tasks, item.title) if kind == "github" else [],
    }


def query_activities(
    session: Session,
    user: User,
    project_id: UUID,
    kind: ActivityKind,
    port: ActivitySourcePort,
    *,
    page=1,
    page_size=20,
    task_id=None,
    status=None,
    author_id=None,
    since=None,
    until=None,
    q=None,
    group_id=None,
    record_kind=None,
) -> dict:
    get_project_access(session, user, project_id)
    if kind not in {"github", "feishu"} or page < 1 or not 1 <= page_size <= 100:
        raise ApiError(422, "INVALID_ACTIVITY_QUERY", "Invalid source or pagination.")
    if status not in {None, "candidate", "adopted", "ignored"} or (q is not None and len(q) > 200):
        raise ApiError(422, "INVALID_ACTIVITY_QUERY", "Invalid status or search query.")
    if (
        group_id is not None and (kind != "feishu" or not group_id.strip() or len(group_id) > 200)
    ) or (record_kind is not None and (not record_kind.strip() or len(record_kind) > 64)):
        raise ApiError(422, "INVALID_ACTIVITY_QUERY", "Invalid group or activity kind.")
    if any(value is not None and value.utcoffset() is None for value in (since, until)):
        raise ApiError(422, "INVALID_ACTIVITY_QUERY", "Activity timestamps require a timezone.")
    if since is not None and until is not None and since > until:
        raise ApiError(422, "INVALID_ACTIVITY_QUERY", "Start must not follow end.")
    if task_id is not None:
        task_in_project(session, task_id, project_id)
    states = select(ActivityRecordState.source_id).where(
        ActivityRecordState.project_id == project_id,
        ActivityRecordState.source_type == kind,
    )
    include_ids, exclude_ids = None, ()
    if task_id is not None or status in {"adopted", "ignored"}:
        if task_id is not None:
            states = states.where(ActivityRecordState.task_id == task_id)
        if status is not None:
            states = states.where(ActivityRecordState.status == status)
        include_ids = tuple(session.scalars(states))
    elif status == "candidate":
        exclude_ids = tuple(
            session.scalars(states.where(ActivityRecordState.status != "candidate"))
        )
    query = ActivitySourceQuery(
        page, page_size, author_id, since, until, q, include_ids, exclude_ids, group_id, record_kind
    )
    result = port.query(project_id=project_id, actor_id=user.id, source_type=kind, query=query)
    offset = (page - 1) * page_size
    if (
        not isinstance(result, ActivitySourcePage)
        or type(result.total) is not int
        or result.total < 0
        or not isinstance(result.items, tuple)
        or len(result.items) != min(page_size, max(0, result.total - offset))
    ):
        raise ApiError(
            503, "ACTIVITY_PAGE_INVALID", "The adapter returned an incomplete page or total."
        )
    # Retain strong references so C3's session.get validation uses the identity
    # map instead of issuing one source-reference query for each result.
    reference_ids = [
        item.source.source_reference_id
        for item in result.items
        if isinstance(item, ActivitySourceRecord)
        and isinstance(item.source, VerifiedSource)
        and isinstance(item.source.source_reference_id, UUID)
    ]
    _references = (
        list(
            session.scalars(
                select(SourceReference).where(
                    SourceReference.id.in_(reference_ids),
                )
            )
        )
        if reference_ids
        else []
    )
    for item in result.items:
        validate_record(session, item, project_id, kind)
        if (
            (include_ids is not None and item.id not in include_ids)
            or item.id in exclude_ids
            or (author_id is not None and item.author_id != author_id)
            or (since is not None and item.occurred_at < since)
            or (until is not None and item.occurred_at > until)
            or (q and q.casefold() not in (item.title + "\n" + item.summary).casefold())
            or (group_id is not None and item.group_id != group_id)
            or (record_kind is not None and item.kind != record_kind)
        ):
            raise ApiError(
                503, "ACTIVITY_PAGE_INVALID", "The source adapter did not apply query scope."
            )
    if len({item.id for item in result.items}) != len(result.items):
        raise ApiError(503, "ACTIVITY_PAGE_INVALID", "The source adapter repeated a source ID.")
    ordered = sorted(result.items, key=lambda item: (-item.occurred_at.timestamp(), str(item.id)))
    if list(result.items) != ordered:
        raise ApiError(
            503, "ACTIVITY_PAGE_INVALID", "The source adapter returned unstable ordering."
        )
    tasks = list(session.scalars(select(Task).where(Task.project_id == project_id)))
    states, latest = load_states_and_latest(
        session, project_id, kind, [item.id for item in result.items]
    )
    return {
        "items": [
            activity_data(
                project_id,
                kind,
                item,
                tasks,
                states.get(item.id),
                latest.get(states[item.id].id) if item.id in states else None,
            )
            for item in result.items
        ],
        "total": result.total,
        "page": page,
        "page_size": page_size,
    }


def get_activity(session, user, project_id, kind, source_id, port):
    get_project_access(session, user, project_id)
    item = port.get(project_id=project_id, actor_id=user.id, source_type=kind, source_id=source_id)
    validate_record(session, item, project_id, kind, source_id)
    tasks = list(session.scalars(select(Task).where(Task.project_id == project_id)))
    states, latest = load_states_and_latest(session, project_id, kind, [item.id])
    row = states.get(item.id)
    return activity_data(project_id, kind, item, tasks, row, latest.get(row.id) if row else None)


def get_activity_history(session, user, project_id, kind, source_id):
    """Stored provenance remains readable even while A's provider is unavailable."""
    get_project_access(session, user, project_id)
    row = state_row(session, project_id, kind, source_id)
    if row is None:
        raise ApiError(
            404, "ACTIVITY_HISTORY_NOT_FOUND", "No local decisions exist for this source."
        )
    return {
        **state_data(row, project_id, kind, source_id),
        "decisions": [
            {
                "id": str(decision.id),
                "actor_id": str(decision.actor_id),
                "version_no": decision.version_no,
                "action": decision.action,
                "reason": decision.reason,
                "before": decision.before_json,
                "after": decision.after_json,
                "source_revision": decision.source_revision,
                "source_hash": decision.source_hash,
                "source_snapshot": decision.source_snapshot,
                "created_at": decision.created_at.isoformat(),
            }
            for decision in session.scalars(
                select(ActivityRecordDecision)
                .where(
                    ActivityRecordDecision.record_id == row.id,
                )
                .order_by(ActivityRecordDecision.version_no)
            )
        ],
    }


class _CapturedSourcePort:
    """Private adapter over a source already resolved by the trusted A port."""

    def __init__(self, item: ActivitySourceRecord, actor_id: UUID):
        self.item, self.actor_id = item, actor_id

    def resolve(self, *, project_id, actor_id, source_type, source_id) -> VerifiedSource:
        source = self.item.source
        if (project_id, actor_id, source_type, source_id) != (
            source.project_id,
            self.actor_id,
            source.source_type,
            self.item.id,
        ):
            raise ApiError(403, "SOURCE_SCOPE_DENIED", "Captured source scope mismatch.")
        return source


def change_activity(
    session: Session,
    user: User,
    project_id: UUID,
    kind: ActivityKind,
    source_id: UUID,
    command: AssociateActivity | DecideActivity,
    key: str,
    port: ActivitySourcePort,
) -> dict:
    access = get_project_access(session, user, project_id, lock=True)
    require_contributor(access)
    if kind not in {"github", "feishu"}:
        raise ApiError(422, "INVALID_ACTIVITY_SOURCE", "Unsupported activity source.")
    action = "associate" if isinstance(command, AssociateActivity) else command.action
    if action != "associate" and kind != "feishu":
        raise ApiError(422, "INVALID_ACTIVITY_ACTION", "Only Feishu records support triage.")
    record, replay = claim_request(
        session,
        actor_id=user.id,
        project_id=project_id,
        operation=f"activity.{kind}:{source_id}",
        key=key,
        payload={"action": action, **command.model_dump(mode="json")},
    )
    if replay is not None:
        return replay
    row = state_row(session, project_id, kind, source_id)
    before = state_data(row, project_id, kind, source_id)
    if before["lock_version"] != command.expected_version:
        raise ApiError(
            409,
            "VERSION_CONFLICT",
            "The activity decision has changed.",
            {"current_version": before["lock_version"]},
        )
    item = port.get(project_id=project_id, actor_id=user.id, source_type=kind, source_id=source_id)
    validate_record(session, item, project_id, kind, source_id)
    if item.source.availability != "available":
        raise ApiError(409, "SOURCE_UNAVAILABLE", "The source is no longer available.")
    if row and row.source_identity != item.source.identity:
        raise ApiError(
            409, "SOURCE_IDENTITY_CONFLICT", "An existing source identity cannot be replaced."
        )
    if item.kind == "sync":
        raise ApiError(
            422, "INVALID_ACTIVITY_ACTION", "Synchronization events are not development records."
        )
    expected_status = "ignored" if action == "restore" else "candidate"
    if before["status"] != expected_status:
        raise ApiError(409, "ACTIVITY_STATE_CONFLICT", "Reload before changing this activity.")
    if command.task_id is not None:
        task_in_project(session, command.task_id, project_id)
        require_task_plan(access.latest_plan, command.task_id)
    if row is None:
        row = ActivityRecordState(
            id=uuid4(),
            project_id=project_id,
            source_type=kind,
            source_id=source_id,
            source_identity=item.source.identity,
            lock_version=0,
            status="candidate",
        )
        session.add(row)
        session.flush()
    values: dict = {}
    if action == "associate":
        values["task_id"] = command.task_id
    elif action == "adopt":
        evidence = capture_evidence(
            session,
            user,
            project_id,
            CreateEvidence(
                task_id=command.task_id,
                title=item.title,
                description=item.summary or item.title,
                source_type=kind,
                source_id=source_id,
                criterion_ids=command.criterion_ids,
            ),
            f"activity:{row.id}",
            _CapturedSourcePort(item, user.id),
        )
        values = {
            "status": "adopted",
            "task_id": command.task_id,
            "evidence_id": UUID(evidence["id"]),
        }
    else:
        values["status"] = "ignored" if action == "ignore" else "candidate"
    changed = session.execute(
        update(ActivityRecordState)
        .where(
            ActivityRecordState.id == row.id,
            ActivityRecordState.lock_version == command.expected_version,
        )
        .values(
            **values,
            lock_version=ActivityRecordState.lock_version + 1,
            updated_at=datetime.now(UTC),
        )
    )
    if changed.rowcount != 1:
        raise ApiError(409, "VERSION_CONFLICT", "The activity decision has changed.")
    session.refresh(row)
    after = state_data(row, project_id, kind, source_id)
    captured = snapshot(item)
    session.add(
        ActivityRecordDecision(
            record_id=row.id,
            actor_id=user.id,
            version_no=row.lock_version,
            action=action,
            reason=command.reason,
            before_json=before,
            after_json=after,
            source_revision=item.source.revision,
            source_hash=content_hash(captured),
            source_snapshot=captured,
        )
    )
    emit_event(
        session,
        project_id=project_id,
        aggregate_id=row.id,
        event_type=f"activity.{action}",
        payload={**after, "actor_id": str(user.id), "reason": command.reason, "before": before},
    )
    session.flush()
    return finish_request(session, record, after)
