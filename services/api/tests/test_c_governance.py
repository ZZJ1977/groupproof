"""Relational governance tests with an explicit transactional A authorization fixture."""

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
import test_c_discussions as discussion_tests
import test_c_evidence as evidence_tests
from pydantic import ValidationError
from sqlalchemy import func, select

from app.api.errors import ApiError
from app.db.models import Course, User
from app.modules.c import governance_access_service as access
from app.modules.c import governance_course_service as courses
from app.modules.c.governance_models import (
    AccessDecision,
    AccessRequest,
    CourseCodeRegistry,
    CourseInvite,
    CourseLifecycleDecision,
    GovernanceIdempotency,
    GovernanceOutbox,
)
from app.modules.c.governance_ports import (
    AuthorizationReceipt,
    UnavailableAuthorizationPort,
    VisibleAccessTarget,
)
from app.modules.c.governance_schemas import (
    AccessFilters,
    AccessScope,
    CourseFilters,
    CreateAccessRequest,
    CreateCourse,
    DecideAccessRequest,
    TransitionCourse,
)

db = discussion_tests.db
scope = evidence_tests.scope


class AuthorizationFixture:
    """Records activation in the supplied DB transaction; never production wiring."""

    def __init__(self):
        self.visible_calls = []
        self.activation_calls = []
        self.deny_visibility = False
        self.unavailable_activation = False
        self.bad_receipt = None

    def visible_target(self, session, *, applicant_id, scope):
        self.visible_calls.append((applicant_id, scope))
        if self.deny_visibility:
            raise ApiError(403, "TARGET_NOT_VISIBLE", "The target is not discoverable.")
        return VisibleAccessTarget(applicant_id, scope)

    def activate(
        self, session, *, request_id, applicant_id, reviewer_id, scope, expires_at, command_id
    ):
        self.activation_calls.append(command_id)
        if self.unavailable_activation:
            raise ApiError(503, "ACCESS_AUTHORIZATION_UNAVAILABLE", "A activation unavailable")
        receipt = AuthorizationReceipt(uuid4(), request_id, applicant_id, scope, expires_at)
        session.add(
            GovernanceOutbox(
                aggregate_id=request_id,
                event_type="test.a_grant",
                payload_json={
                    "subject": str(applicant_id),
                    "scope": scope.model_dump(mode="json"),
                    "expires_at": expires_at.isoformat(),
                    "command_id": str(command_id),
                },
            )
        )
        session.flush()
        return replace(receipt, **self.bad_receipt) if self.bad_receipt else receipt


def count(db, model):
    return db.scalar(select(func.count()).select_from(model))


def course_command(scope, **changes):
    fields = dict(
        code="COURSE-NEW",
        name="New course",
        college="Engineering",
        semester="2027 Spring",
        owner_id=scope.users["teacher"].id,
        reason="Create teaching course",
        project_deadline=datetime.now(UTC) + timedelta(days=60),
        formation_deadline=datetime.now(UTC) + timedelta(days=10),
    )
    fields.update(changes)
    return CreateCourse(**fields)


def create_course(db, scope, command=None, actor="admin", key=None):
    with db.begin_nested():
        return courses.create_course(
            db, scope.users[actor], command or course_command(scope), key or str(uuid4())
        )


def transition(db, scope, row, action="publish", actor="admin", key=None, **fields):
    with db.begin_nested():
        return courses.transition_course(
            db,
            scope.users[actor],
            UUID(row["id"]),
            TransitionCourse(
                action=action,
                expected_version=row["lock_version"],
                reason="Authorized lifecycle change",
                **fields,
            ),
            key or str(uuid4()),
        )


def request_command(data, **changes):
    fields = dict(
        scope=AccessScope(
            project_id=data.project.id, resource_type="task", resource_id=data.task.id
        ),
        reason="Review the implementation",
        expires_at=datetime.now(UTC) + timedelta(hours=3),
    )
    fields.update(changes)
    return CreateAccessRequest(**fields)


def create_request(db, scope, port, command=None, actor="author", key=None):
    with db.begin_nested():
        return access.create_request(
            db, scope.users[actor], command or request_command(scope), key or str(uuid4()), port
        )


def approval(row, **changes):
    fields = dict(
        decision="approved",
        expected_version=row["lock_version"],
        reason="Necessary bounded review",
        expires_at=datetime.fromisoformat(row["requested_expires_at"]) - timedelta(minutes=1),
    )
    fields.update(changes)
    return DecideAccessRequest(**fields)


def decide(db, scope, port, row, command=None, actor="admin", key=None):
    with db.begin_nested():
        return access.decide_request(
            db,
            scope.users[actor],
            UUID(row["id"]),
            command or approval(row),
            key or str(uuid4()),
            port,
        )


def test_course_draft_publish_end_retains_history_and_atomic_secure_invite(db, scope):
    original_plan = scope.plan.snapshot_json.copy()
    draft = create_course(db, scope)
    assert draft["status"] == "draft" and draft["invite_code"] is None
    active = transition(db, scope, draft)
    assert active["status"] == "active" and len(active["invite_code"]) >= 32
    assert courses.resolve_course_invite(db, active["invite_code"]) == UUID(active["id"])
    assert count(db, CourseInvite) == 1
    assert (
        "invite_code"
        not in courses.list_courses(db, scope.users["admin"], CourseFilters())["items"][0]
    )
    ended = transition(db, scope, active, action="end")
    assert ended["status"] == "ended" and ended["invite_revoked_at"]
    assert [item["action"] for item in ended["history"]] == ["create", "publish", "end"]
    with pytest.raises(ApiError, match="active invitation"):
        courses.resolve_course_invite(db, active["invite_code"])
    assert scope.plan.snapshot_json == original_plan
    assert count(db, CourseLifecycleDecision) == count(db, GovernanceOutbox) == 3


@pytest.mark.parametrize("actor", ["author", "member", "leader", "teacher", "ta", "outsider"])
def test_course_admin_only_for_reads_and_writes(db, scope, actor):
    with pytest.raises(ApiError) as error:
        create_course(db, scope, actor=actor)
    assert error.value.code == "ADMIN_REQUIRED"
    with pytest.raises(ApiError):
        courses.list_courses(db, scope.users[actor], CourseFilters())
    with pytest.raises(ApiError):
        courses.get_course(db, scope.users[actor], scope.course.id)
    assert count(db, CourseCodeRegistry) == count(db, GovernanceIdempotency) == 0


@pytest.mark.parametrize(
    "attribute,value",
    [("status", "disabled"), ("global_role", "student"), ("email_verified_at", None)],
)
def test_current_actor_revocation_beats_stale_admin_object(db, scope, attribute, value):
    stale = User(
        id=scope.users["admin"].id,
        status="active",
        global_role="admin",
        email_verified_at=datetime.now(UTC),
    )
    setattr(scope.users["admin"], attribute, value)
    db.flush()
    with pytest.raises(ApiError), db.begin_nested():
        courses.create_course(db, stale, course_command(scope), "stale-admin")
    assert count(db, CourseCodeRegistry) == 0


def test_global_code_claim_case_insensitive_across_semesters_without_changing_old_rows(db, scope):
    create_course(db, scope)
    with pytest.raises(ApiError) as error:
        create_course(db, scope, course_command(scope, code="course-new", semester="2028"))
    assert error.value.code == "COURSE_CODE_CONFLICT"
    original = scope.course.code
    with pytest.raises(ApiError):
        create_course(db, scope, course_command(scope, code=original.upper(), semester="Different"))
    assert scope.course.code == original and count(db, CourseCodeRegistry) == 1


def test_historical_same_code_different_semester_is_preserved_and_publication_refused(db, scope):
    row = Course(
        id=uuid4(),
        owner_id=scope.users["teacher"].id,
        code=scope.course.code,
        semester="Another semester",
        name="Historical duplicate",
        college="Test",
        status="draft",
        project_deadline=datetime.now(UTC) + timedelta(days=60),
    )
    db.add(row)
    db.flush()
    with pytest.raises(ApiError) as error:
        transition(db, scope, courses.course_data(row))
    assert error.value.code == "COURSE_CODE_CONFLICT"
    assert row.status == "draft" and scope.course.status == "active"


def test_lifecycle_idempotency_preserves_one_invite_and_current_reply(db, scope):
    command = course_command(scope)
    draft = create_course(db, scope, command, key="create-once")
    assert create_course(db, scope, command, key="create-once") == draft
    result = transition(db, scope, draft, key="publish-once")
    assert transition(db, scope, draft, key="publish-once") == result
    assert count(db, CourseInvite) == 1 and count(db, CourseLifecycleDecision) == 2


def test_create_and_publish_replay_return_current_ended_course_without_reactivation(db, scope):
    command = course_command(scope)
    draft = create_course(db, scope, command, key="create-current")
    published = transition(db, scope, draft, key="publish-current")
    ended = transition(db, scope, published, action="end")
    for replay in [
        create_course(db, scope, command, key="create-current"),
        transition(db, scope, draft, key="publish-current"),
    ]:
        assert replay == ended
        assert replay["status"] == "ended" and replay["invite_revoked_at"]
    assert count(db, CourseInvite) == 1
    assert count(db, CourseLifecycleDecision) == count(db, GovernanceOutbox) == 3
    scope.users["admin"].status = "disabled"
    db.flush()
    with pytest.raises(ApiError):
        create_course(db, scope, command, key="create-current")


@pytest.mark.parametrize("replay_kind", ["create", "approve"])
def test_access_replay_returns_current_expired_approval_without_a_activation(
    db, scope, monkeypatch, replay_kind
):
    port = AuthorizationFixture()
    command = request_command(scope)
    row = create_request(db, scope, port, command, key="request-current")
    decision = approval(row)
    approved = decide(db, scope, port, row, decision, key="approve-current")
    assert not approved["approval_expired"]

    class Later(datetime):
        @classmethod
        def now(cls, tz=None):
            return decision.expires_at + timedelta(seconds=1)

    monkeypatch.setattr(access, "datetime", Later)
    unavailable = UnavailableAuthorizationPort()
    replay = (
        create_request(db, scope, unavailable, command, key="request-current")
        if replay_kind == "create"
        else decide(db, scope, unavailable, row, decision, key="approve-current")
    )
    assert replay["status"] == "approved" and replay["approval_expired"]
    assert replay["lock_version"] == 1 and len(replay["history"]) == 1
    assert len(port.activation_calls) == 1 and count(db, AccessDecision) == 1
    assert count(db, GovernanceOutbox) == 3


@pytest.mark.parametrize("action", ["end", "publish"])
def test_invalid_or_stale_course_transitions_rejected(db, scope, action):
    draft = create_course(db, scope)
    if action == "publish":
        transition(db, scope, draft)
    with pytest.raises(ApiError) as error:
        transition(db, scope, draft, action=action)
    assert error.value.code in {"VERSION_CONFLICT", "COURSE_STATE_CONFLICT"}


@pytest.mark.parametrize("owner", ["author", "admin", "ta"])
def test_course_requires_eligible_teacher(db, scope, owner):
    with pytest.raises(ApiError) as error:
        create_course(db, scope, course_command(scope, owner_id=scope.users[owner].id))
    assert error.value.code == "COURSE_OWNER_INELIGIBLE"


def test_publication_failure_rolls_back_invite_status_and_outbox(db, scope, monkeypatch):
    draft = create_course(db, scope)
    original = courses.event

    def fail(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError("Delivery record failed")

    monkeypatch.setattr(courses, "event", fail)
    with pytest.raises(RuntimeError):
        transition(db, scope, draft)
    assert courses.get_course(db, scope.users["admin"], UUID(draft["id"]))["status"] == "draft"
    assert count(db, CourseInvite) == 0
    assert count(db, CourseLifecycleDecision) == count(db, GovernanceOutbox) == 1


def test_access_approval_requires_exact_transactional_receipt_and_retains_history(db, scope):
    port = AuthorizationFixture()
    row = create_request(db, scope, port)
    result = decide(db, scope, port, row)
    assert result["status"] == "approved" and result["lock_version"] == 1
    assert result["authorization_state"] == "receipt_recorded_current_access_not_checked"
    assert result["authorization_receipt"]["applicant_id"] == str(scope.users["author"].id)
    assert len(result["history"]) == 1 and not result["approval_expired"]
    assert count(db, AccessDecision) == 1
    assert {event.event_type for event in db.scalars(select(GovernanceOutbox))} == {
        "access.requested",
        "access.approved",
        "test.a_grant",
    }


def test_unavailable_visibility_prevents_target_probe_and_request_persistence(db, scope):
    with pytest.raises(ApiError) as error:
        create_request(
            db,
            scope,
            UnavailableAuthorizationPort(),
            request_command(
                scope,
                scope=AccessScope(project_id=uuid4(), resource_type="task", resource_id=uuid4()),
            ),
        )
    assert error.value.code == "ACCESS_VISIBILITY_UNAVAILABLE"
    assert count(db, AccessRequest) == count(db, GovernanceIdempotency) == 0


def test_denied_visibility_is_checked_before_target_existence(db, scope):
    port = AuthorizationFixture()
    port.deny_visibility = True
    with pytest.raises(ApiError) as error:
        create_request(
            db,
            scope,
            port,
            request_command(
                scope,
                scope=AccessScope(project_id=uuid4(), resource_type="task", resource_id=uuid4()),
            ),
        )
    assert error.value.code == "TARGET_NOT_VISIBLE"


def test_missing_activation_does_not_claim_approved(db, scope):
    port = AuthorizationFixture()
    row = create_request(db, scope, port)
    port.unavailable_activation = True
    with pytest.raises(ApiError) as error:
        decide(db, scope, port, row)
    assert error.value.status_code == 503
    assert db.get(AccessRequest, UUID(row["id"])).status == "pending"
    assert count(db, AccessDecision) == 0 and count(db, GovernanceOutbox) == 1


@pytest.mark.parametrize("changed", ["applicant_id", "request_id", "scope", "expiry", "grant_id"])
def test_invalid_activation_receipt_rolls_back_a_fixture_and_c_decision(db, scope, changed):
    port = AuthorizationFixture()
    row = create_request(db, scope, port)
    port.bad_receipt = (
        {"applicant_id": uuid4()}
        if changed == "applicant_id"
        else {"request_id": uuid4()}
        if changed == "request_id"
        else {
            "scope": AccessScope(
                project_id=scope.other_project.id,
                resource_type="project",
                resource_id=scope.other_project.id,
            )
        }
        if changed == "scope"
        else {"expires_at": datetime.now(UTC) + timedelta(days=1)}
        if changed == "expiry"
        else {"grant_id": "untrusted-text"}
    )
    with pytest.raises(ApiError) as error:
        decide(db, scope, port, row)
    assert error.value.code == "ACCESS_AUTHORIZATION_INVALID"
    assert count(db, AccessDecision) == 0 and count(db, GovernanceOutbox) == 1
    assert db.get(AccessRequest, UUID(row["id"])).authorization_receipt is None


def test_approval_transaction_failure_rolls_back_fixture_activation(db, scope, monkeypatch):
    port = AuthorizationFixture()
    row = create_request(db, scope, port)
    original = access.finish

    def fail(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError("Persistence failed")

    monkeypatch.setattr(access, "finish", fail)
    with pytest.raises(RuntimeError):
        decide(db, scope, port, row)
    assert count(db, AccessDecision) == 0 and count(db, GovernanceOutbox) == 1
    assert db.get(AccessRequest, UUID(row["id"])).status == "pending"


def test_expiry_cannot_be_past_or_expanded_and_self_approval_is_forbidden(db, scope):
    port = AuthorizationFixture()
    row = create_request(db, scope, port, actor="admin")
    with pytest.raises(ApiError) as error:
        decide(db, scope, port, row)
    assert error.value.code == "SELF_APPROVAL_DENIED"
    row = create_request(db, scope, port)
    for expiry in [
        datetime.now(UTC) - timedelta(seconds=1),
        datetime.now(UTC) + timedelta(days=10),
    ]:
        with pytest.raises(ApiError) as error:
            decide(db, scope, port, row, approval(row, expires_at=expiry))
        assert error.value.code == "ACCESS_EXPIRY_INVALID"


def test_request_scope_must_match_actual_target_project(db, scope):
    with pytest.raises(ApiError) as error:
        create_request(
            db,
            scope,
            AuthorizationFixture(),
            request_command(
                scope,
                scope=AccessScope(
                    project_id=scope.project.id,
                    resource_type="task",
                    resource_id=scope.other_task.id,
                ),
            ),
        )
    assert error.value.code == "ACCESS_TARGET_NOT_FOUND"


def test_mine_lists_only_self_admin_lists_all_and_nonadmin_cannot_decide(db, scope):
    port = AuthorizationFixture()
    row = create_request(db, scope, port)
    create_request(db, scope, port, actor="member")
    assert access.list_requests(db, scope.users["author"], AccessFilters())["total"] == 1
    assert access.list_requests(db, scope.users["admin"], AccessFilters(), admin=True)["total"] == 2
    with pytest.raises(ApiError):
        access.list_requests(db, scope.users["author"], AccessFilters(), admin=True)
    with pytest.raises(ApiError):
        decide(db, scope, port, row, actor="teacher")
    assert not port.activation_calls


def test_rejection_needs_no_provider_and_approval_replay_does_not_reactivate(db, scope):
    port = AuthorizationFixture()
    row = create_request(db, scope, port)
    command = DecideAccessRequest(decision="rejected", expected_version=0, reason="Not necessary")
    rejected = decide(db, scope, UnavailableAuthorizationPort(), row, command)
    assert rejected["status"] == "rejected" and rejected["authorization_receipt"] is None
    row = create_request(db, scope, port)
    command = approval(row)
    result = decide(db, scope, port, row, command, key="approve-once")
    assert (
        decide(db, scope, UnavailableAuthorizationPort(), row, command, key="approve-once")
        == result
    )
    assert len(port.activation_calls) == 1


def test_changed_key_body_and_stale_access_version_conflict(db, scope):
    port = AuthorizationFixture()
    command = request_command(scope)
    row = create_request(db, scope, port, command, key="create-key")
    assert create_request(db, scope, port, command, key="create-key") == row
    with pytest.raises(ApiError) as error:
        create_request(db, scope, port, request_command(scope), key="create-key")
    assert error.value.code == "IDEMPOTENCY_CONFLICT"
    decide(db, scope, port, row)
    with pytest.raises(ApiError) as error:
        decide(db, scope, port, row)
    assert error.value.code == "VERSION_CONFLICT" and len(port.activation_calls) == 1


@pytest.mark.parametrize(
    "extra",
    [
        {"applicant_id": str(uuid4())},
        {"status": "approved"},
        {"reason": " "},
        {"expires_at": "2026-10-10T00:00:00"},
    ],
)
def test_request_command_rejects_impersonation_and_invalid_expiry(scope, extra):
    with pytest.raises(ValidationError):
        request_command(scope, **extra)
