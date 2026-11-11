"""A4-04 文件存储：上传链接、服务端核验、C 存储接口实现，以及上传接口的越权检查。"""

from __future__ import annotations

import hashlib
import io
import zipfile
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import a_fixtures as fixtures
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.auth import get_current_user
from app.api.errors import ApiError, install_exception_handlers
from app.db.session import get_session
from app.main import request_context
from app.modules.a import router as a_router
from app.modules.a import storage
from app.modules.c.course_files_storage import (
    UnavailableCourseStoragePort,
    get_course_storage_port,
)
from app.modules.c.files_storage import (
    UnavailableStoragePort,
    get_storage_port,
    resolve_receipt,
    signed_link,
)

db = fixtures.db
scope = fixtures.scope

PDF = b"%PDF-1.7\n" + b"x" * 100


class FakeStorageClient:
    host = "demo.supabase.co"
    bucket = "groupproof-test"

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    def create_signed_upload_url(self, object_id: str) -> str:
        return (
            f"https://{self.host}/storage/v1/object/upload/sign/{self.bucket}/{object_id}?token=t"
        )

    def download(self, object_id: str, *, max_bytes: int) -> bytes:
        if object_id not in self.objects:
            raise FileNotFoundError(object_id)
        data = self.objects[object_id]
        if len(data) > max_bytes:
            raise ValueError("too large")
        return data

    def create_signed_download_url(self, object_id: str, expires_in: int) -> str:
        return f"https://{self.host}/storage/v1/object/sign/{self.bucket}/{object_id}?token=d"


class SessionFactory:
    """让 C 接口的适配器复用测试事务里的会话。"""

    def __init__(self, session) -> None:
        self.session = session

    def __call__(self):
        return self

    def __enter__(self):
        return self.session

    def __exit__(self, *exc):
        return False


def upload(db, user, project_id, data=PDF, filename="spec.pdf", mime="application/pdf"):
    client = FakeStorageClient()
    ticket = storage.create_upload(
        db,
        user,
        scope="project",
        scope_id=project_id,
        filename=filename,
        mime_type=mime,
        size_bytes=len(data),
        client=client,
    )
    client.objects[ticket.object_id] = data
    return client, ticket


def test_upload_complete_resolve_and_sign(db, scope):
    leader = scope.users["leader"]
    client, ticket = upload(db, leader, scope.project.id)
    assert ticket.upload_url.startswith("https://demo.supabase.co/")
    row = storage.complete_upload(db, leader, ticket.receipt_id, client=client)
    assert row.status == "completed"
    assert row.content_hash == hashlib.sha256(PDF).hexdigest()
    assert row.revision == f"sha256:{row.content_hash}"

    port = storage.SupabaseProjectStoragePort(SessionFactory(db), client)
    receipt = resolve_receipt(
        port, project_id=scope.project.id, actor_id=leader.id, receipt_id=ticket.receipt_id
    )
    assert receipt.size_bytes == len(PDF) and receipt.scan_status == "clean"
    link = signed_link(
        port,
        project_id=scope.project.id,
        actor_id=leader.id,
        provider=receipt.provider,
        object_id=receipt.object_id,
        revision=receipt.revision,
        purpose="download",
    )
    assert link.url.startswith("https://demo.supabase.co/")
    assert link.expires_at <= datetime.now(UTC) + timedelta(minutes=15)


def test_receipt_is_bound_to_project_and_uploader(db, scope):
    leader = scope.users["leader"]
    client, ticket = upload(db, leader, scope.project.id)
    storage.complete_upload(db, leader, ticket.receipt_id, client=client)
    port = storage.SupabaseProjectStoragePort(SessionFactory(db), client)
    for project_id, actor_id in [
        (scope.other_project.id, leader.id),
        (scope.project.id, scope.users["member"].id),
    ]:
        with pytest.raises(ApiError):
            port.resolve_receipt(
                project_id=project_id, actor_id=actor_id, receipt_id=ticket.receipt_id
            )
    with pytest.raises(ApiError):
        port.sign_version(
            project_id=scope.other_project.id,
            actor_id=leader.id,
            provider="supabase",
            object_id=ticket.object_id,
            revision="sha256:" + "0" * 64,
            purpose="download",
        )


def _zip(names):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name in names:
            archive.writestr(name, "x")
    return buffer.getvalue()


@pytest.mark.parametrize(
    "data,filename,mime,reason",
    [
        (b"MZ\x90\x00" + b"x" * 20, "spec.pdf", "application/pdf", "executable_content"),
        (b"hello", "spec.pdf", "application/pdf", "content_does_not_match_extension"),
        (b"\xff\xfe\x00bad", "notes.txt", "text/plain", "binary_text_file"),
        (_zip(["run.exe"]), "code.zip", "application/zip", "archive_contains_executable"),
        (_zip(["a.txt"]), "report.docx",
         "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
         "content_does_not_match_extension"),
    ],
)  # fmt: skip
def test_content_checks_reject_bad_files(db, scope, data, filename, mime, reason):
    leader = scope.users["leader"]
    client, ticket = upload(db, leader, scope.project.id, data, filename, mime)
    with pytest.raises(ApiError) as error:
        storage.complete_upload(db, leader, ticket.receipt_id, client=client)
    assert error.value.details["reason"] == reason


def test_size_mismatch_and_missing_object(db, scope):
    leader = scope.users["leader"]
    client, ticket = upload(db, leader, scope.project.id)
    client.objects[ticket.object_id] = PDF + b"extra"
    with pytest.raises(ApiError) as error:
        storage.complete_upload(db, leader, ticket.receipt_id, client=client)
    assert error.value.details["reason"] == "size_mismatch"
    client, ticket = upload(db, leader, scope.project.id)
    del client.objects[ticket.object_id]
    with pytest.raises(ApiError) as error:
        storage.complete_upload(db, leader, ticket.receipt_id, client=client)
    assert error.value.code == "UPLOAD_NOT_RECEIVED"


@pytest.mark.parametrize(
    "filename,mime,size,code",
    [
        ("virus.exe", "application/octet-stream", 10, "FILE_TYPE_NOT_ALLOWED"),
        ("spec.pdf", "text/plain", 10, "FILE_TYPE_NOT_ALLOWED"),
        ("spec.pdf", "application/pdf", 51 * 1024 * 1024, "FILE_TOO_LARGE"),
        ("../spec.pdf", "application/pdf", 10, "INVALID_FILENAME"),
    ],
)
def test_upload_request_validation(db, scope, filename, mime, size, code):
    with pytest.raises(ApiError) as error:
        storage.create_upload(
            db,
            scope.users["leader"],
            scope="project",
            scope_id=scope.project.id,
            filename=filename,
            mime_type=mime,
            size_bytes=size,
            client=FakeStorageClient(),
        )
    assert error.value.code == code


def test_unconfigured_storage_keeps_c_ports_unavailable(monkeypatch):
    for name in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_STORAGE_BUCKET"):
        monkeypatch.delenv(name, raising=False)
    assert isinstance(get_storage_port(), UnavailableStoragePort)
    assert isinstance(get_course_storage_port(), UnavailableCourseStoragePort)


def test_configured_storage_uses_supabase_ports(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://demo.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-key")
    monkeypatch.setenv("SUPABASE_STORAGE_BUCKET", "groupproof-staging")
    port = get_storage_port()
    assert isinstance(port, storage.SupabaseProjectStoragePort)
    assert port.allowed_download_hosts == frozenset({"demo.supabase.co"})
    assert isinstance(get_course_storage_port(), storage.SupabaseCourseStoragePort)


# ---------------------------------------------------------------- HTTP + A3-06 越权


@pytest.fixture()
def http(db, scope, monkeypatch):
    fake = FakeStorageClient()
    monkeypatch.setattr(storage, "get_storage_client", lambda: fake)
    app = FastAPI()
    app.middleware("http")(request_context)
    install_exception_handlers(app)
    app.include_router(a_router.router)
    app.dependency_overrides[get_session] = lambda: db
    actor = {"user": scope.users["leader"]}
    app.dependency_overrides[get_current_user] = lambda: actor["user"]
    with TestClient(app) as client:
        yield client, actor, fake


def body(project_id, size=len(PDF)):
    return {
        "scope": "project",
        "scope_id": str(project_id),
        "filename": "spec.pdf",
        "mime_type": "application/pdf",
        "size_bytes": size,
    }


def test_http_upload_flow(http, scope, db, monkeypatch):
    client, _, fake = http
    monkeypatch.setattr(db, "commit", db.flush)
    created = client.post("/api/v1/storage/uploads", json=body(scope.project.id))
    assert created.status_code == 201, created.text
    assert created.headers["Cache-Control"] == "private, no-store"
    ticket = created.json()["data"]
    row = db.get(storage.UploadReceiptRow, ticket["receipt_id"])
    fake.objects[row.object_id] = PDF
    done = client.post(f"/api/v1/storage/uploads/{ticket['receipt_id']}/complete")
    assert done.status_code == 200 and done.json()["data"]["status"] == "completed"


@pytest.mark.parametrize(
    "who,which,status,code",
    [
        ("leader", "other_project", 404, "PROJECT_NOT_FOUND"),  # A 组改 B 组
        ("teacher", "project", 403, "PROJECT_MEMBER_REQUIRED"),  # 老师不能替学生交资料
        ("leader", "archived_project", 403, "PROJECT_READ_ONLY"),  # 改归档项目
        ("outsider", "project", 404, "PROJECT_NOT_FOUND"),
        ("admin", "project", 404, "PROJECT_NOT_FOUND"),
    ],
)
def test_http_upload_escalation_fails(http, scope, db, monkeypatch, who, which, status, code):
    client, actor, _ = http
    monkeypatch.setattr(db, "commit", db.flush)
    actor["user"] = scope.users[who]
    response = client.post("/api/v1/storage/uploads", json=body(getattr(scope, which).id))
    assert response.status_code == status and response.json()["error"]["code"] == code


def test_http_cannot_complete_someone_elses_upload(http, scope, db, monkeypatch):
    client, actor, _ = http
    monkeypatch.setattr(db, "commit", db.flush)
    ticket = client.post("/api/v1/storage/uploads", json=body(scope.project.id)).json()["data"]
    actor["user"] = scope.users["member"]
    response = client.post(f"/api/v1/storage/uploads/{ticket['receipt_id']}/complete")
    assert response.status_code == 404


def test_student_cannot_call_admin_endpoint(db, scope):
    """A3-06：学生账号调管理员接口必须失败（使用正式应用的路由）。"""
    from app.main import app

    app.dependency_overrides[get_session] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: scope.users["leader"]
    try:
        with TestClient(app) as client:
            assert client.get("/api/v1/admin/courses").status_code == 403
            assert client.get(f"/api/v1/admin/users/{uuid4()}").status_code == 403
    finally:
        app.dependency_overrides.pop(get_session, None)
        app.dependency_overrides.pop(get_current_user, None)
