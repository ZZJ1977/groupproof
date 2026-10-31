"""Relational course-file tests; storage is an explicit test port, not uploaded bytes."""

import os
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
import test_c_evidence as evidence_tests
from pydantic import ValidationError
from sqlalchemy import JSON, MetaData, create_engine, event, func, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.api.errors import ApiError
from app.db.base import Base
from app.db.models import Course, CourseMember, CourseStaff
from app.modules.c.course_files_models import (
    CourseFile,
    CourseFileDecision,
    CourseFileOutbox,
    CourseFileRequest,
    CourseFileVersion,
)
from app.modules.c.course_files_schemas import (
    AppendCourseFileVersion,
    PublishCourseFileVersion,
    RegisterCourseFile,
)
from app.modules.c.course_files_service import (
    append_version,
    get_file,
    get_signed_link,
    list_files,
    publish_version,
    register_file,
)
from app.modules.c.course_files_storage import (
    CourseStorageLink,
    CourseUploadReceipt,
    UnavailableCourseStoragePort,
    signed_link,
)
from app.modules.c.evidence_router import commit_command


@pytest.fixture()
def db():
    url = os.getenv("C_TEST_DATABASE_URL")
    engine = (
        create_engine(url)
        if url
        else create_engine(
            "sqlite://",
            poolclass=StaticPool,
            connect_args={"check_same_thread": False},
        )
    )
    if not url:

        @event.listens_for(engine, "connect")
        def foreign_keys(connection, _):
            connection.execute("PRAGMA foreign_keys=ON")

        names = {
            "users",
            "school_email_bindings",
            "courses",
            "course_staff",
            "groups",
            "projects",
            "project_members",
            "plan_versions",
            "functional_modules",
            "tasks",
            "acceptance_criteria",
            "c_integration_outbox",
            "c_request_idempotency",
            "course_members",
            "c_course_files",
            "c_course_file_versions",
            "c_course_file_decisions",
            "c_course_file_outbox",
            "c_course_file_requests",
            "c_logical_files",
            "c_file_versions",
            "c_file_decisions",
        }
        metadata = MetaData()
        for table in Base.metadata.sorted_tables:
            if table.name in names:
                portable = table.to_metadata(metadata)
                for column in portable.columns:
                    if isinstance(column.type, JSONB):
                        column.type = JSON()
                    if (
                        column.server_default is not None
                        and str(column.server_default.arg) == "gen_random_uuid()"
                    ):
                        column.server_default = None
        metadata.create_all(engine)
    with engine.connect() as connection:
        transaction = connection.begin()
        session = Session(
            connection, expire_on_commit=False, join_transaction_mode="create_savepoint"
        )
        try:
            yield session
        finally:
            session.close()
            transaction.rollback()
    engine.dispose()


@pytest.fixture()
def scope(db):
    value = evidence_tests.scope.__wrapped__(db)
    for name in ("author", "member"):
        db.add(
            CourseMember(
                id=uuid4(),
                course_id=value.course.id,
                user_id=value.users[name].id,
                role="student",
                status="active",
            )
        )
    value.other_course = Course(
        id=uuid4(),
        owner_id=value.users["teacher"].id,
        code=str(uuid4()),
        name="Other course",
        college="Test",
        semester="2026",
        status="active",
    )
    db.add(value.other_course)
    db.commit()
    return value


class StorageFake:
    allowed_download_hosts = frozenset({"storage.example.test"})

    def __init__(self, scope):
        self.scope = scope
        self.receipts = {}
        self.receipt_patch = {}
        self.link_patch = {}
        self.resolve_calls = 0
        self.sign_calls = 0

    def receipt(self, **fields):
        row = CourseUploadReceipt(
            receipt_id=uuid4(),
            course_id=self.scope.course.id,
            actor_id=self.scope.users["teacher"].id,
            provider="course-port",
            object_id=str(uuid4()),
            revision="immutable-r1",
            filename="brief.pdf",
            content_hash="a" * 64,
            size_bytes=123,
            mime_type="application/pdf",
            status="completed",
            scan_status="clean",
            expires_at=datetime.now(UTC) + timedelta(hours=1),
        ).model_copy(update=fields)
        self.receipts[row.receipt_id] = row
        return row

    def resolve_receipt(self, **kwargs):
        assert "course_id" in kwargs and "project_id" not in kwargs
        self.resolve_calls += 1
        return self.receipts[kwargs["receipt_id"]].model_copy(update=self.receipt_patch)

    def sign_version(self, **kwargs):
        assert "course_id" in kwargs and "project_id" not in kwargs
        self.sign_calls += 1
        return CourseStorageLink(
            **kwargs,
            url="https://storage.example.test/file?signature=trusted",
            expires_at=datetime.now(UTC) + timedelta(minutes=5),
        ).model_copy(update=self.link_patch)


@pytest.fixture()
def storage(scope):
    return StorageFake(scope)


def create(db, scope, storage, *, receipt=None, key="create", actor="teacher"):
    receipt = receipt or storage.receipt()
    return commit_command(
        db,
        lambda: register_file(
            db,
            scope.users[actor],
            scope.course.id,
            RegisterCourseFile(receipt_id=receipt.receipt_id, reason="Prepared course material"),
            key,
            storage,
        ),
    )


def append(db, scope, storage, row, *, receipt=None, expected=None, key="append", actor="teacher"):
    receipt = receipt or storage.receipt(filename="brief-v2.pdf")
    return commit_command(
        db,
        lambda: append_version(
            db,
            scope.users[actor],
            scope.course.id,
            UUID(row["id"]),
            AppendCourseFileVersion(
                receipt_id=receipt.receipt_id,
                expected_version=row["lock_version"] if expected is None else expected,
                reason="Updated requirements",
            ),
            key,
            storage,
        ),
    )


def publish(db, scope, row, *, expected=None, version_id=None, key="publish", actor="teacher"):
    return commit_command(
        db,
        lambda: publish_version(
            db,
            scope.users[actor],
            scope.course.id,
            UUID(row["id"]),
            PublishCourseFileVersion(
                version_id=version_id or UUID(row["versions"][0]["id"]),
                expected_version=row["lock_version"] if expected is None else expected,
                reason="Reviewed and published",
            ),
            key,
        ),
    )


def counts(db):
    return [
        db.scalar(select(func.count()).select_from(m))
        for m in (
            CourseFile,
            CourseFileVersion,
            CourseFileDecision,
            CourseFileOutbox,
            CourseFileRequest,
        )
    ]


def test_student_publication_isolation_retained_history_and_frozen_reference(db, scope, storage):
    first = create(db, scope, storage)
    assert list_files(db, scope.users["author"], scope.course.id)["total"] == 0
    for user in ("teacher", "ta"):
        assert list_files(db, scope.users[user], scope.course.id)["total"] == 1
    with pytest.raises(ApiError, match="No published"):
        get_file(db, scope.users["author"], scope.course.id, UUID(first["id"]))
    for purpose in ("preview", "download"):
        with pytest.raises(ApiError) as error:
            get_signed_link(
                db,
                scope.users["author"],
                scope.course.id,
                UUID(first["id"]),
                UUID(first["versions"][0]["id"]),
                purpose,
                storage,
            )
        assert error.value.status_code == 404
    first = publish(db, scope, first)
    original = first["versions"][0]
    scope.plan.snapshot_json = {**scope.plan.snapshot_json, "sourceFileIds": [original["id"]]}
    db.commit()
    second = append(db, scope, storage, first)
    assert (
        second["name"] == "brief.pdf" and second["versions"][0]["original_name"] == "brief-v2.pdf"
    )
    visible = get_file(db, scope.users["author"], scope.course.id, UUID(first["id"]))
    assert visible["versions"] == [original] and visible["latest_version_no"] == 1
    assert [d["action"] for d in visible["decisions"]] == ["published"]
    assert list_files(db, scope.users["author"], scope.course.id, q="brief-v2")["total"] == 0
    second = publish(db, scope, second, key="publish-v2")
    assert second["versions"][-1]["status"] == "superseded"
    old = get_signed_link(
        db,
        scope.users["author"],
        scope.course.id,
        UUID(first["id"]),
        UUID(original["id"]),
        "download",
        storage,
    )
    assert old["version_id"] == original["id"]
    assert scope.plan.snapshot_json["sourceFileIds"] == [original["id"]]
    assert scope.project.lock_version == 0 and scope.course.lock_version == 0
    assert counts(db) == [1, 2, 4, 4, 4]
    assert all(item.delivered_at is None for item in db.scalars(select(CourseFileOutbox)))
    assert all(
        "project_id" not in item.payload_json for item in db.scalars(select(CourseFileOutbox))
    )


@pytest.mark.parametrize("actor", ["author", "ta", "other_teacher", "outsider", "admin"])
@pytest.mark.parametrize("action", ["create", "append", "publish"])
def test_only_owner_teacher_can_write_every_command(db, scope, storage, actor, action):
    first = create(db, scope, storage)
    before = counts(db)
    operation = {
        "create": lambda: create(db, scope, storage, key="denied", actor=actor),
        "append": lambda: append(db, scope, storage, first, actor=actor),
        "publish": lambda: publish(db, scope, first, actor=actor),
    }[action]
    with pytest.raises(ApiError) as error:
        operation()
    assert error.value.status_code == 403 and counts(db) == before


@pytest.mark.parametrize("actor", ["outsider", "leader", "other_teacher", "admin"])
def test_project_membership_or_global_role_does_not_grant_course_read(db, scope, storage, actor):
    first = publish(db, scope, create(db, scope, storage))
    with pytest.raises(ApiError) as error:
        get_file(db, scope.users[actor], scope.course.id, UUID(first["id"]))
    assert error.value.status_code == 403


def test_staff_teacher_is_read_only_and_active_student_enrollment_required(db, scope, storage):
    first = create(db, scope, storage)
    db.add(
        CourseStaff(
            course_id=scope.course.id, user_id=scope.users["other_teacher"].id, role="teacher"
        )
    )
    db.commit()
    assert list_files(db, scope.users["other_teacher"], scope.course.id)["total"] == 1
    with pytest.raises(ApiError):
        publish(db, scope, first, actor="other_teacher")
    membership = db.scalar(
        select(CourseMember).where(CourseMember.user_id == scope.users["author"].id)
    )
    membership.status = "left"
    db.commit()
    with pytest.raises(ApiError):
        list_files(db, scope.users["author"], scope.course.id)


@pytest.mark.parametrize("state", ["ended", "disabled", "unverified", "owner_changed"])
def test_authority_is_rechecked_before_idempotent_replay(db, scope, storage, state):
    receipt = storage.receipt()
    create(db, scope, storage, receipt=receipt)
    if state == "ended":
        scope.course.status = "ended"
    elif state == "disabled":
        scope.users["teacher"].status = "disabled"
    elif state == "unverified":
        scope.users["teacher"].email_binding.verified_at = None
    else:
        scope.course.owner_id = scope.users["other_teacher"].id
    db.commit()
    with pytest.raises(ApiError) as error:
        create(db, scope, storage, receipt=receipt)
    assert error.value.status_code == 403 and counts(db) == [1, 1, 1, 1, 1]


def test_course_draft_allows_owner_preparation_and_ended_keeps_published_readable(
    db, scope, storage
):
    scope.course.status = "draft"
    db.commit()
    row = publish(db, scope, create(db, scope, storage))
    scope.course.status = "ended"
    db.commit()
    assert (
        get_file(db, scope.users["author"], scope.course.id, UUID(row["id"]))["official_version_no"]
        == 1
    )
    assert not list_files(db, scope.users["teacher"], scope.course.id)["can_write"]


@pytest.mark.parametrize(
    "patch",
    [
        {"course_id": uuid4()},
        {"actor_id": uuid4()},
        {"receipt_id": uuid4()},
        {"status": "pending"},
        {"scan_status": "infected"},
        {"content_hash": "browser"},
        {"size_bytes": -1},
        {"size_bytes": 52428801},
        {"size_bytes": True},
        {"mime_type": "text/html"},
        {"filename": "../brief.pdf"},
        {"filename": "bad\x00.pdf"},
        {"filename": "brief.exe"},
        {"filename": "ß" * 200 + ".pdf"},
        {"object_id": ""},
        {"expires_at": datetime(2020, 1, 1, tzinfo=UTC)},
        {"expires_at": datetime(2099, 1, 1)},
    ],
)
def test_receipt_binding_and_output_validation_roll_back_every_row(db, scope, storage, patch):
    storage.receipt_patch = patch
    with pytest.raises(ApiError) as error:
        create(db, scope, storage)
    assert error.value.code == "INVALID_COURSE_STORAGE_RECEIPT" and counts(db) == [0] * 5


def test_default_storage_503_and_recovery_do_not_poison_key(db, scope, storage):
    receipt = storage.receipt()
    command = RegisterCourseFile(receipt_id=receipt.receipt_id, reason="Receipt")
    with pytest.raises(ApiError) as error:
        commit_command(
            db,
            lambda: register_file(
                db,
                scope.users["teacher"],
                scope.course.id,
                command,
                "retry",
                UnavailableCourseStoragePort(),
            ),
        )
    assert error.value.code == "COURSE_FILE_STORAGE_UNAVAILABLE" and counts(db) == [0] * 5
    assert (
        commit_command(
            db,
            lambda: register_file(
                db, scope.users["teacher"], scope.course.id, command, "retry", storage
            ),
        )["latest_version_no"]
        == 1
    )


def test_idempotent_retry_conflicts_and_old_publication_replay(db, scope, storage):
    receipt = storage.receipt()
    first = create(db, scope, storage, receipt=receipt)
    assert create(db, scope, storage, receipt=receipt) == first and storage.resolve_calls == 1
    published = publish(db, scope, first)
    second = append(db, scope, storage, published)
    publish(db, scope, second, key="second-publish")
    assert publish(db, scope, first)["official_version_no"] == 2
    before = counts(db)
    for operation, code in [
        (lambda: create(db, scope, storage), "IDEMPOTENCY_CONFLICT"),
        (lambda: create(db, scope, storage, key="duplicate-name"), "FILE_NAME_EXISTS"),
        (lambda: append(db, scope, storage, first, expected=99, key="stale"), "VERSION_CONFLICT"),
        (lambda: publish(db, scope, second, expected=0, key="stale-publish"), "VERSION_CONFLICT"),
    ]:
        with pytest.raises(ApiError) as error:
            operation()
        assert error.value.code == code and counts(db) == before


def test_unknown_course_cross_course_and_foreign_version_fail_before_storage(db, scope, storage):
    first = create(db, scope, storage)
    for course_id, code in (
        (uuid4(), "COURSE_NOT_FOUND"),
        (scope.other_course.id, "FILE_NOT_FOUND"),
    ):
        with pytest.raises(ApiError) as error:
            get_signed_link(
                db,
                scope.users["teacher"],
                course_id,
                UUID(first["id"]),
                UUID(first["versions"][0]["id"]),
                "download",
                storage,
            )
        assert error.value.code == code
    assert storage.sign_calls == 0


@pytest.mark.parametrize(
    "patch",
    [
        {"course_id": uuid4()},
        {"actor_id": uuid4()},
        {"revision": "mutable-latest"},
        {"url": "javascript:alert(1)"},
        {"url": "http://storage.example.test/file"},
        {"url": "https://user:password@storage.example.test/file"},
        {"url": "https://evil.example/file"},
        {"url": "https://storage.example.test/file#fragment"},
        {"purpose": "preview"},
        {"expires_at": datetime.now(UTC) + timedelta(hours=1)},
    ],
)
def test_signed_link_output_is_defensively_validated(scope, storage, patch):
    storage.link_patch = patch
    with pytest.raises(ApiError) as error:
        signed_link(
            storage,
            course_id=scope.course.id,
            actor_id=scope.users["teacher"].id,
            provider="course-port",
            object_id="object",
            revision="r1",
            purpose="download",
        )
    assert error.value.code == "INVALID_COURSE_STORAGE_LINK"


def test_query_filters_and_page_do_not_count_unpublished_student_versions(db, scope, storage):
    first = publish(db, scope, create(db, scope, storage))
    append(db, scope, storage, first)
    create(db, scope, storage, receipt=storage.receipt(filename="new-secret.pdf"), key="new-file")
    assert (
        list_files(db, scope.users["teacher"], scope.course.id, page_size=2, page=99)["total"] == 3
    )
    result = list_files(
        db,
        scope.users["author"],
        scope.course.id,
        category="documents",
        file_type="PDF",
        status="current",
        q="brief",
        page=99,
        page_size=1,
    )
    assert result["total"] == 1 and result["page"] == 1 and not result["can_write"]
    assert list_files(db, scope.users["author"], scope.course.id, status="draft")["total"] == 0


def test_commit_failure_leaves_no_partial_files_or_event(db, scope, storage, monkeypatch):
    def fail():
        raise RuntimeError("commit failed")

    monkeypatch.setattr(db, "commit", fail)
    with pytest.raises(RuntimeError):
        create(db, scope, storage)
    assert counts(db) == [0] * 5


def test_browser_cannot_supply_provenance_or_blank_reason():
    for patch in (
        {"project_id": str(uuid4())},
        {"url": "https://example.test"},
        {"content_hash": "a" * 64},
        {"object_id": "path"},
        {"reason": " "},
    ):
        with pytest.raises(ValidationError):
            RegisterCourseFile.model_validate(
                {"receipt_id": str(uuid4()), "reason": "Upload", **patch}
            )


def test_never_published_superseded_draft_stays_hidden_from_student_history_and_links(
    db, scope, storage
):
    original = create(db, scope, storage)
    latest = append(db, scope, storage, original)
    publish(db, scope, latest)
    view = get_file(db, scope.users["author"], scope.course.id, UUID(original["id"]))
    assert [v["version_no"] for v in view["versions"]] == [2]
    assert list_files(db, scope.users["author"], scope.course.id, category="archived")["total"] == 0
    with pytest.raises(ApiError) as error:
        get_signed_link(
            db,
            scope.users["author"],
            scope.course.id,
            UUID(original["id"]),
            UUID(original["versions"][0]["id"]),
            "download",
            storage,
        )
    assert error.value.status_code == 404 and storage.sign_calls == 0


def test_receipt_cannot_be_reused_and_stale_publication_has_no_side_effects(db, scope, storage):
    receipt = storage.receipt()
    original = create(db, scope, storage, receipt=receipt)
    with pytest.raises(ApiError) as error:
        append(db, scope, storage, original, receipt=receipt)
    assert error.value.code == "RECEIPT_ALREADY_USED" and counts(db) == [1] * 5
    latest = append(db, scope, storage, original)
    with pytest.raises(ApiError) as error:
        publish(db, scope, latest, version_id=UUID(original["versions"][0]["id"]))
    assert error.value.code == "FILE_NOT_DRAFT"
    assert counts(db) == [1, 2, 2, 2, 2]


def test_download_rechecks_enrollment_and_ta_membership_every_request(db, scope, storage):
    original = publish(db, scope, create(db, scope, storage))
    membership = db.scalar(
        select(CourseMember).where(CourseMember.user_id == scope.users["author"].id)
    )
    membership.left_at = datetime.now(UTC)
    staff = db.scalar(select(CourseStaff).where(CourseStaff.user_id == scope.users["ta"].id))
    staff.left_at = datetime.now(UTC)
    db.commit()
    for name in ("author", "ta"):
        with pytest.raises(ApiError) as error:
            get_signed_link(
                db,
                scope.users[name],
                scope.course.id,
                UUID(original["id"]),
                UUID(original["versions"][0]["id"]),
                "download",
                storage,
            )
        assert error.value.status_code == 403
    assert storage.sign_calls == 0
