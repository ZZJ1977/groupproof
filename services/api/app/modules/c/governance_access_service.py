from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy import func, select, update

from app.api.errors import ApiError
from app.db.models import Project, Task, User
from app.modules.c.governance_common import claim, current_actor, event, finish, history_data, utc
from app.modules.c.governance_models import AccessDecision, AccessRequest
from app.modules.c.governance_ports import (
    AuthorizationPort,
    AuthorizationReceipt,
    VisibleAccessTarget,
)
from app.modules.c.governance_schemas import (
    AccessFilters,
    AccessScope,
    CreateAccessRequest,
    DecideAccessRequest,
)
from app.modules.c.models import Evidence
from app.modules.c.school_email import has_verified_school_email


def access_data(row):
    return {
        "id": str(row.id),
        "applicant_id": str(row.applicant_id),
        "scope": row.scope_json,
        "reason": row.reason,
        "requested_expires_at": utc(row.requested_expires_at).isoformat(),
        "status": row.status,
        "approved_expires_at": utc(row.approved_expires_at).isoformat()
        if row.approved_expires_at
        else None,
        "approval_expired": bool(
            row.approved_expires_at and utc(row.approved_expires_at) <= datetime.now(UTC)
        ),
        "authorization_receipt": row.authorization_receipt,
        "authorization_state": "receipt_recorded_current_access_not_checked"
        if row.status == "approved"
        else "not_activated",
        "lock_version": row.lock_version,
        "created_at": utc(row.created_at).isoformat(),
    }


def access_detail(session, row):
    rows = session.scalars(
        select(AccessDecision)
        .where(AccessDecision.request_id == row.id)
        .order_by(AccessDecision.version_no)
    )
    return {**access_data(row), "history": history_data(rows)}


def list_requests(session, user, filters: AccessFilters, *, admin=False):
    actor = current_actor(session, user, admin=admin)
    conditions = [] if admin else [AccessRequest.applicant_id == actor.id]
    if filters.status:
        conditions.append(AccessRequest.status == filters.status)
    total = session.scalar(select(func.count()).select_from(AccessRequest).where(*conditions))
    rows = session.scalars(
        select(AccessRequest)
        .where(*conditions)
        .order_by(AccessRequest.created_at.desc(), AccessRequest.id)
        .offset((filters.page - 1) * filters.page_size)
        .limit(filters.page_size)
    )
    return {
        "items": [access_data(row) for row in rows],
        "total": total,
        "page": filters.page,
        "page_size": filters.page_size,
    }


def request_row(session, request_id, *, lock=False):
    query = (
        select(AccessRequest)
        .where(AccessRequest.id == request_id)
        .execution_options(populate_existing=True)
    )
    row = session.scalar(query.with_for_update() if lock else query)
    if row is None:
        raise ApiError(404, "ACCESS_REQUEST_NOT_FOUND", "The access request does not exist.")
    return row


def get_request(session, user, request_id):
    current_actor(session, user, admin=True)
    return access_detail(session, request_row(session, request_id))


def validate_target(session, scope: AccessScope):
    project = session.get(Project, scope.project_id)
    target = (
        project
        if scope.resource_type == "project"
        else session.get(Task if scope.resource_type == "task" else Evidence, scope.resource_id)
    )
    if (
        project is None
        or target is None
        or (scope.resource_type != "project" and target.project_id != scope.project_id)
    ):
        raise ApiError(404, "ACCESS_TARGET_NOT_FOUND", "The authorized target does not exist.")


def visible_target(session, applicant_id, scope, port):
    receipt = port.visible_target(
        session, applicant_id=applicant_id, scope=scope.model_copy(deep=True)
    )
    if (
        not isinstance(receipt, VisibleAccessTarget)
        or receipt.applicant_id != applicant_id
        or receipt.scope != scope
    ):
        raise ApiError(503, "ACCESS_VISIBILITY_INVALID", "Target visibility could not be verified.")
    validate_target(session, scope)


def create_request(session, user, command: CreateAccessRequest, key: str, port: AuthorizationPort):
    actor = current_actor(session, user, write=True)
    record, replay = claim(
        session, actor.id, "access.request", key, command.model_dump(mode="json")
    )
    if replay is not None:
        return access_detail(session, request_row(session, UUID(replay["id"]), lock=True))
    if command.expires_at <= datetime.now(UTC):
        raise ApiError(422, "ACCESS_EXPIRY_INVALID", "Requested access must expire in the future.")
    # Do not look up guessed target IDs before trusted visibility authorization.
    visible_target(session, actor.id, command.scope, port)
    row = AccessRequest(
        id=uuid4(),
        applicant_id=actor.id,
        project_id=command.scope.project_id,
        scope_json=command.scope.model_dump(mode="json"),
        reason=command.reason,
        requested_expires_at=command.expires_at,
        status="pending",
        lock_version=0,
    )
    session.add(row)
    session.flush()
    event(
        session,
        row.id,
        "access.requested",
        {"request_id": str(row.id), "applicant_id": str(actor.id)},
    )
    return finish(session, record, access_detail(session, row))


def decide_request(
    session, user, request_id, command: DecideAccessRequest, key: str, port: AuthorizationPort
):
    actor = current_actor(session, user, admin=True, write=True)
    row = request_row(session, request_id, lock=True)
    record, replay = claim(
        session, actor.id, f"access.decide:{request_id}", key, command.model_dump(mode="json")
    )
    if replay is not None:
        return access_detail(session, row)
    if row.lock_version != command.expected_version:
        raise ApiError(409, "VERSION_CONFLICT", "This access request has changed.")
    if row.status != "pending":
        raise ApiError(409, "ACCESS_STATE_CONFLICT", "This request has already been decided.")
    before = access_data(row)
    values = {"status": command.decision}
    if command.decision == "approved":
        if row.applicant_id == actor.id:
            raise ApiError(
                403, "SELF_APPROVAL_DENIED", "Another administrator must approve this request."
            )
        applicant = session.scalar(
            select(User)
            .where(User.id == row.applicant_id)
            .execution_options(populate_existing=True)
        )
        if (
            applicant is None
            or applicant.status != "active"
            or not has_verified_school_email(session, applicant, lock=True)
        ):
            raise ApiError(
                409, "ACCESS_APPLICANT_INELIGIBLE", "The applicant is not eligible for access."
            )
        if command.expires_at <= datetime.now(UTC) or command.expires_at > utc(
            row.requested_expires_at
        ):
            raise ApiError(
                422,
                "ACCESS_EXPIRY_INVALID",
                "Approval must be future-dated and no later than requested expiry.",
            )
        scope = AccessScope.model_validate(row.scope_json)
        visible_target(session, row.applicant_id, scope, port)
        receipt = port.activate(
            session,
            request_id=row.id,
            applicant_id=row.applicant_id,
            reviewer_id=actor.id,
            scope=scope.model_copy(deep=True),
            expires_at=command.expires_at,
            command_id=record.id,
        )
        if (
            not isinstance(receipt, AuthorizationReceipt)
            or not isinstance(receipt.grant_id, UUID)
            or receipt.request_id != row.id
            or receipt.applicant_id != row.applicant_id
            or receipt.scope != scope
            or not isinstance(receipt.expires_at, datetime)
            or receipt.expires_at.utcoffset() is None
            or receipt.expires_at != command.expires_at
        ):
            raise ApiError(
                503,
                "ACCESS_AUTHORIZATION_INVALID",
                "Authorization did not confirm the exact subject, scope and expiry.",
            )
        values.update(
            approved_expires_at=command.expires_at,
            authorization_receipt={
                "grant_id": str(receipt.grant_id),
                "request_id": str(row.id),
                "applicant_id": str(row.applicant_id),
                "scope": row.scope_json,
                "expires_at": command.expires_at.isoformat(),
            },
        )
    result = session.execute(
        update(AccessRequest)
        .where(AccessRequest.id == row.id, AccessRequest.lock_version == command.expected_version)
        .values(**values, lock_version=AccessRequest.lock_version + 1, updated_at=datetime.now(UTC))
    )
    if result.rowcount != 1:
        raise ApiError(409, "VERSION_CONFLICT", "This access request has changed.")
    session.refresh(row)
    session.add(
        AccessDecision(
            request_id=row.id,
            actor_id=actor.id,
            version_no=row.lock_version,
            decision=command.decision,
            reason=command.reason,
            before_json=before,
            after_json=access_data(row),
        )
    )
    event(
        session,
        row.id,
        f"access.{command.decision}",
        {
            "request_id": str(row.id),
            "actor_id": str(actor.id),
            "reason": command.reason,
            "lock_version": row.lock_version,
        },
    )
    session.flush()
    return finish(session, record, access_detail(session, row))
