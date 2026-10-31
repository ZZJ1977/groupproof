"""Relational SQLite tests, also runnable on the disposable C_TEST_DATABASE_URL.

StorageFake is an explicit in-process A-port test double, never production wiring.
These tests do not claim to upload real bytes or verify PostgreSQL locking.
"""

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
from app.db.models import ProjectMember
from app.modules.c.evidence_router import commit_command
from app.modules.c.files_models import FileDecision, FileVersion, LogicalFile
from app.modules.c.files_schemas import AppendFileVersion, DesignateFileVersion, RegisterFile
from app.modules.c.files_service import (
    append_version,
    designate_version,
    file_data,
    file_in_project,
    get_signed_link,
    list_files,
    register_file,
)
from app.modules.c.files_storage import (
    StorageLink,
    UnavailableStoragePort,
    UploadReceipt,
    signed_link,
)
from app.modules.c.models import IntegrationOutbox, RequestIdempotency

scope = evidence_tests.scope


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


class StorageFake:
    allowed_download_hosts = frozenset({"storage.example.test"})

    def __init__(self, scope):
        self.scope = scope
        self.receipts = {}
        self.resolve_calls = 0
        self.sign_calls = 0
        self.receipt_patch = {}
        self.link_patch = {}

    def receipt(self, **fields):
        receipt = UploadReceipt(
            receipt_id=uuid4(),
            project_id=self.scope.project.id,
            actor_id=self.scope.users["author"].id,
            provider="test-port",
            object_id=str(uuid4()),
            revision="immutable-r1",
            filename="work.pdf",
            content_hash="a" * 64,
            size_bytes=10,
            mime_type="application/pdf",
            status="completed",
            scan_status="clean",
            expires_at=datetime.now(UTC) + timedelta(hours=1),
        ).model_copy(update=fields)
        self.receipts[receipt.receipt_id] = receipt
        return receipt

    def resolve_receipt(self, **kwargs):
        self.resolve_calls += 1
        return self.receipts[kwargs["receipt_id"]].model_copy(update=self.receipt_patch)

    def sign_version(self, **kwargs):
        self.sign_calls += 1
        return StorageLink(
            **kwargs,
            url="https://storage.example.test/object?signature=token",
            expires_at=datetime.now(UTC) + timedelta(minutes=5),
        ).model_copy(
            update=self.link_patch,
        )


@pytest.fixture()
def storage(scope):
    return StorageFake(scope)


def create(db, scope, storage, *, actor="author", key=None, receipt=None, category="documents"):
    receipt = receipt or storage.receipt(actor_id=scope.users[actor].id)
    return commit_command(
        db,
        lambda: register_file(
            db,
            scope.users[actor],
            scope.project.id,
            RegisterFile(
                receipt_id=receipt.receipt_id, reason="Uploaded verified bytes", category=category
            ),
            key or str(uuid4()),
            storage,
        ),
    )


def append(db, scope, storage, original, *, receipt=None, expected=None, key=None):
    receipt = receipt or storage.receipt()
    return commit_command(
        db,
        lambda: append_version(
            db,
            scope.users["author"],
            scope.project.id,
            UUID(original["id"]),
            AppendFileVersion(
                receipt_id=receipt.receipt_id,
                expected_version=original["lock_version"] if expected is None else expected,
                reason="Updated implementation",
            ),
            key or str(uuid4()),
            storage,
        ),
    )


def designate(db, scope, original, *, expected=None, version_id=None, key=None, actor="author"):
    return commit_command(
        db,
        lambda: designate_version(
            db,
            scope.users[actor],
            scope.project.id,
            UUID(original["id"]),
            DesignateFileVersion(
                expected_version=original["lock_version"] if expected is None else expected,
                version_id=version_id or UUID(original["versions"][0]["id"]),
                reason="Reviewed by project member",
            ),
            key or str(uuid4()),
        ),
    )


def count(db, model):
    return db.scalar(select(func.count()).select_from(model))


def test_versions_official_history_and_old_snapshot_are_retained(db, scope, storage):
    original = create(db, scope, storage)
    assert original["versions"][0]["status"] == "draft"
    first = designate(db, scope, original)
    pinned_id = UUID(first["versions"][0]["id"])
    before = {
        c.name: getattr(db.get(FileVersion, pinned_id), c.name)
        for c in FileVersion.__table__.columns
    }
    # Simulate B storing an immutable identifier; the C service must never edit it.
    scope.plan.snapshot_json = {**scope.plan.snapshot_json, "sourceFileIds": [str(pinned_id)]}
    db.commit()
    updated = append(db, scope, storage, first)
    assert [v["status"] for v in updated["versions"]] == ["draft", "current"]
    official = designate(db, scope, updated)
    assert [v["status"] for v in official["versions"]] == ["current", "superseded"]
    assert official["lock_version"] == 3 and official["official_version_no"] == 2
    after = {
        c.name: getattr(db.get(FileVersion, pinned_id), c.name)
        for c in FileVersion.__table__.columns
    }
    assert after == before
    assert scope.plan.snapshot_json["sourceFileIds"] == [str(pinned_id)]
    assert scope.project.lock_version == 0
    row = file_in_project(db, scope.project.id, UUID(original["id"]))
    history = file_data(db, row, history=True)["decisions"]
    assert [d["action"] for d in history] == ["created", "designated", "appended", "designated"]
    assert history[-1]["previous_official_version_no"] == 1
    assert count(db, IntegrationOutbox) == 4
    assert all(e.delivered_at is None for e in db.scalars(select(IntegrationOutbox)))
    assert "storage_object_id" not in str(official) and "receipt_id" not in str(official)


def test_retries_do_not_resolve_storage_again_or_restore_old_official(db, scope, storage):
    receipt = storage.receipt()
    original = create(db, scope, storage, receipt=receipt, key="register")
    assert create(db, scope, storage, receipt=receipt, key="register") == original
    assert storage.resolve_calls == 1
    first = designate(db, scope, original, key="official")
    updated = append(db, scope, storage, first, receipt=storage.receipt(), key="append")
    designate(db, scope, updated)
    replay = designate(db, scope, original, key="official")
    assert replay["official_version_no"] == 2 and replay["versions"][-1]["status"] == "superseded"
    assert count(db, FileVersion) == 2 and count(db, FileDecision) == 4


@pytest.mark.parametrize("actor", ["teacher", "ta", "other_teacher", "admin", "outsider"])
def test_nonmembers_cannot_write(db, scope, storage, actor):
    db.commit()
    with pytest.raises(ApiError) as error:
        create(db, scope, storage, actor=actor)
    assert error.value.status_code == 403
    assert count(db, LogicalFile) == 0 and storage.resolve_calls == 0


@pytest.mark.parametrize(
    "actor,allowed",
    [
        ("teacher", True),
        ("ta", True),
        ("author", True),
        ("other_teacher", False),
        ("admin", False),
        ("outsider", False),
    ],
)
def test_collection_read_scope(db, scope, storage, actor, allowed):
    create(db, scope, storage)
    if allowed:
        assert list_files(db, scope.users[actor], scope.project.id)["total"] == 1
    else:
        with pytest.raises(ApiError) as error:
            list_files(db, scope.users[actor], scope.project.id)
        assert error.value.status_code == 403


@pytest.mark.parametrize(
    "state", ["unverified", "disabled", "archived", "course_ended", "course_draft", "left"]
)
def test_write_state_is_rechecked_before_replay(db, scope, storage, state):
    receipt = storage.receipt()
    create(db, scope, storage, receipt=receipt, key="saved")
    if state == "unverified":
        scope.users["author"].email_binding.verified_at = None
    elif state == "disabled":
        scope.users["author"].status = "disabled"
    elif state == "archived":
        scope.project.lifecycle = "archived"
    elif state.startswith("course_"):
        scope.course.status = state.removeprefix("course_")
    else:
        db.scalar(
            select(ProjectMember).where(
                ProjectMember.project_id == scope.project.id,
                ProjectMember.user_id == scope.users["author"].id,
            )
        ).left_at = datetime.now(UTC)
    db.commit()
    with pytest.raises(ApiError) as error:
        create(db, scope, storage, receipt=receipt, key="saved")
    assert error.value.status_code == 403
    assert count(db, FileVersion) == 1 and count(db, FileDecision) == 1


def test_file_preparation_does_not_require_frozen_plan(db, scope, storage):
    scope.project.setup_status = "draft"
    scope.plan.status = "draft"
    db.commit()
    assert create(db, scope, storage)["latest_version_no"] == 1


@pytest.mark.parametrize(
    "patch",
    [
        {"project_id": uuid4()},
        {"actor_id": uuid4()},
        {"receipt_id": uuid4()},
        {"status": "pending"},
        {"scan_status": "infected"},
        {"size_bytes": -1},
        {"size_bytes": 52428801},
        {"size_bytes": True},
        {"size_bytes": "10"},
        {"content_hash": "browser-hash"},
        {"mime_type": "text/html"},
        {"filename": "../work.pdf"},
        {"filename": "foo\\work.pdf"},
        {"filename": "work.exe"},
        {"filename": "work\x00.pdf"},
        {"filename": " work.pdf"},
        {"provider": " "},
        {"object_id": ""},
        {"revision": ""},
        {"expires_at": datetime(2020, 1, 1, tzinfo=UTC)},
        {"expires_at": datetime(2099, 1, 1)},
    ],
)
def test_adapter_output_is_revalidated_and_no_partial_rows(db, scope, storage, patch):
    db.commit()
    storage.receipt_patch = patch
    with pytest.raises(ApiError) as error:
        create(db, scope, storage)
    assert error.value.status_code == 503 and error.value.code == "INVALID_STORAGE_RECEIPT"
    for model in (LogicalFile, FileVersion, FileDecision, IntegrationOutbox, RequestIdempotency):
        assert count(db, model) == 0


def test_default_storage_fails_closed_and_failure_does_not_poison_key(db, scope, storage):
    db.commit()
    receipt = storage.receipt()
    command = RegisterFile(receipt_id=receipt.receipt_id, reason="Store")
    with pytest.raises(ApiError) as error:
        commit_command(
            db,
            lambda: register_file(
                db,
                scope.users["author"],
                scope.project.id,
                command,
                "retry",
                UnavailableStoragePort(),
            ),
        )
    assert error.value.code == "FILE_STORAGE_UNAVAILABLE"
    assert count(db, RequestIdempotency) == 0
    assert (
        commit_command(
            db,
            lambda: register_file(
                db, scope.users["author"], scope.project.id, command, "retry", storage
            ),
        )["latest_version_no"]
        == 1
    )


def test_conflicts_rollback_name_receipt_version_and_key(db, scope, storage):
    receipt = storage.receipt()
    original = create(db, scope, storage, receipt=receipt, key="initial")
    for action, code in [
        (lambda: create(db, scope, storage), "FILE_NAME_EXISTS"),
        (
            lambda: create(
                db, scope, storage, receipt=storage.receipt(filename="other.pdf"), key="initial"
            ),
            "IDEMPOTENCY_CONFLICT",
        ),
        (lambda: append(db, scope, storage, original, receipt=receipt), "RECEIPT_ALREADY_USED"),
        (lambda: append(db, scope, storage, original, expected=99), "VERSION_CONFLICT"),
    ]:
        with pytest.raises(ApiError) as error:
            action()
        assert error.value.code == code
        assert count(db, FileVersion) == 1 and count(db, FileDecision) == 1
        assert db.get(LogicalFile, UUID(original["id"])).lock_version == 0


def test_stale_and_nonlatest_official_refused(db, scope, storage):
    original = create(db, scope, storage)
    newer = append(db, scope, storage, original)
    with pytest.raises(ApiError) as error:
        designate(db, scope, newer, version_id=UUID(original["versions"][0]["id"]))
    assert error.value.code == "FILE_NOT_DRAFT"
    with pytest.raises(ApiError) as error:
        designate(db, scope, newer, expected=0)
    assert error.value.code == "VERSION_CONFLICT"
    official = designate(db, scope, newer)
    with pytest.raises(ApiError) as error:
        designate(db, scope, official)
    assert error.value.code == "FILE_NOT_DRAFT"


def test_query_combines_filters_pagination_literal_search_and_archive(db, scope, storage):
    first = create(db, scope, storage, receipt=storage.receipt(filename="100%_work.pdf"))
    append(db, scope, storage, first, receipt=storage.receipt(filename="100%_work.pdf"))
    create(
        db,
        scope,
        storage,
        receipt=storage.receipt(filename="image.png", mime_type="image/png"),
        category="images",
    )
    create(
        db,
        scope,
        storage,
        receipt=storage.receipt(filename="report.zip", mime_type="application/zip"),
        category="exports",
    )
    page = list_files(
        db, scope.users["author"], scope.project.id, q="%_", file_type="pdf", category="documents"
    )
    assert page["total"] == 1 and page["items"][0]["version_no"] == 2
    archived = list_files(db, scope.users["author"], scope.project.id, category="archived")
    assert archived["total"] == 1 and archived["items"][0]["status"] == "superseded"
    page = list_files(
        db, scope.users["author"], scope.project.id, page=99, page_size=2, sort="name_asc"
    )
    assert page["page"] == 2 and len(page["items"]) == 1 and page["total"] == 3
    assert (
        list_files(db, scope.users["author"], scope.project.id, q="missing", page=99)["page"] == 1
    )


def test_detail_and_download_do_not_cross_file_or_project(db, scope, storage):
    first = create(db, scope, storage)
    second = create(db, scope, storage, receipt=storage.receipt(filename="second.pdf"))
    with pytest.raises(ApiError) as error:
        get_signed_link(
            db,
            scope.users["teacher"],
            scope.project.id,
            UUID(first["id"]),
            UUID(second["versions"][0]["id"]),
            "download",
            storage,
        )
    assert error.value.code == "FILE_VERSION_NOT_FOUND"
    with pytest.raises(ApiError) as error:
        get_signed_link(
            db,
            scope.users["teacher"],
            scope.other_project.id,
            UUID(first["id"]),
            UUID(first["versions"][0]["id"]),
            "download",
            storage,
        )
    assert error.value.code == "FILE_NOT_FOUND" and storage.sign_calls == 0


@pytest.mark.parametrize("purpose", ["preview", "download"])
def test_signed_link_is_authorized_and_historical_version_remains_accessible(
    db, scope, storage, purpose
):
    first = create(db, scope, storage)
    append(db, scope, storage, first)
    link = get_signed_link(
        db,
        scope.users["ta"],
        scope.project.id,
        UUID(first["id"]),
        UUID(first["versions"][0]["id"]),
        purpose,
        storage,
    )
    assert link["purpose"] == purpose and link["url"].startswith("https://storage.example.test/")
    assert "object_id" not in link
    member = db.scalar(
        select(ProjectMember).where(
            ProjectMember.project_id == scope.project.id,
            ProjectMember.user_id == scope.users["author"].id,
        )
    )
    member.left_at = datetime.now(UTC)
    db.flush()
    with pytest.raises(ApiError) as error:
        get_signed_link(
            db,
            scope.users["author"],
            scope.project.id,
            UUID(first["id"]),
            UUID(first["versions"][0]["id"]),
            purpose,
            storage,
        )
    assert error.value.status_code == 403 and storage.sign_calls == 1


@pytest.mark.parametrize(
    "patch",
    [
        {"url": "javascript:alert(1)"},
        {"url": "http://storage.example.test/file"},
        {"url": "https://attacker.example/file"},
        {"url": "https://u:p@storage.example.test/file"},
        {"url": "https://storage.example.test/file#token"},
        {"url": "https://storage.example.test:444/file"},
        {"url": "https://storage.example.test/\nfile"},
        {"project_id": uuid4()},
        {"actor_id": uuid4()},
        {"object_id": "other"},
        {"revision": "latest"},
        {"purpose": "preview"},
        {"expires_at": datetime.now(UTC) - timedelta(seconds=1)},
        {"expires_at": datetime.now(UTC) + timedelta(hours=1)},
        {"expires_at": datetime(2099, 1, 1)},
    ],
)
def test_signed_adapter_output_cannot_return_unsafe_links(scope, storage, patch):
    storage.link_patch = patch
    with pytest.raises(ApiError) as error:
        signed_link(
            storage,
            project_id=scope.project.id,
            actor_id=scope.users["author"].id,
            provider="test-port",
            object_id="object",
            revision="r1",
            purpose="download",
        )
    assert error.value.code == "INVALID_STORAGE_LINK" and error.value.status_code == 503


def test_browser_metadata_and_blank_reason_are_not_accepted():
    for patch in (
        {"content_hash": "a" * 64},
        {"object_id": "bucket/path"},
        {"url": "https://example.test"},
        {"actor_id": str(uuid4())},
        {"reason": " "},
    ):
        with pytest.raises(ValidationError):
            RegisterFile.model_validate({"receipt_id": str(uuid4()), "reason": "Upload", **patch})


def test_commit_failure_rolls_back_all_file_rows(db, scope, storage, monkeypatch):
    db.commit()
    original_commit = db.commit

    def fail_commit():
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(db, "commit", fail_commit)
    with pytest.raises(RuntimeError):
        create(db, scope, storage)
    for model in (LogicalFile, FileVersion, FileDecision, RequestIdempotency, IntegrationOutbox):
        assert count(db, model) == 0
    monkeypatch.setattr(db, "commit", original_commit)
    assert create(db, scope, storage)["latest_version_no"] == 1


def test_name_casefold_cannot_overflow_persisted_key(db, scope, storage):
    db.commit()
    receipt = storage.receipt(filename="ß" * 200 + ".pdf")
    with pytest.raises(ApiError) as error:
        create(db, scope, storage, receipt=receipt)
    assert error.value.code == "INVALID_STORAGE_RECEIPT"
    assert count(db, LogicalFile) == 0


def test_append_accepts_new_original_name_without_renaming_logical_file(db, scope, storage):
    first = designate(db, scope, create(db, scope, storage))
    second = append(db, scope, storage, first, receipt=storage.receipt(filename="work-v2.pdf"))
    assert second["id"] == first["id"] and second["name"] == "work.pdf"
    assert second["official_version_no"] == 1
    assert [v["original_name"] for v in second["versions"]] == ["work-v2.pdf", "work.pdf"]
    assert [v["status"] for v in second["versions"]] == ["draft", "current"]
    assert count(db, LogicalFile) == 1
    matching = list_files(db, scope.users["author"], scope.project.id, q="work-v2")
    assert matching["total"] == 1 and matching["items"][0]["file_id"] == first["id"]
