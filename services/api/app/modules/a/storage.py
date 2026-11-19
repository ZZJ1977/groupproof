"""A4-04 文件存储：Supabase Storage 适配，组员上传文件时不需要接触存储密钥。

流程（前端只拿到一次性上传链接，密钥只在后端）：

1. ``create_upload(...)`` / ``POST /api/v1/storage/uploads``：检查权限、文件类型和大小，
   返回 receipt_id + Supabase 签名上传链接（前端直接 PUT 文件）；
2. ``complete_upload(...)`` / ``POST /api/v1/storage/uploads/{id}/complete``：后端从存储桶
   把文件读回来，重新计算 SHA-256、实际大小和文件头，通过后才标记 completed；
3. B/C/D 把 receipt_id 交给自己的业务接口；C 的文件接口通过 ``SupabaseProjectStoragePort`` /
   ``SupabaseCourseStoragePort`` 核对凭证并生成限时下载链接（10 分钟）。

测试和正式环境用不同的 Supabase 项目或存储桶，靠 Railway 变量区分：
``SUPABASE_URL``、``SUPABASE_SERVICE_ROLE_KEY``、``SUPABASE_STORAGE_BUCKET``。
三个变量不全时存储视为“未接入”，C 的文件接口继续返回 503，不会假装上传成功。

关于 ``scan_status='clean'``：目前做的是基础内容检查（文件头必须和扩展名一致，拒绝可执行
文件、压缩包里的可执行文件和压缩炸弹），不是杀毒软件。接入杀毒服务时实现 ``ContentScanner``。
"""

from __future__ import annotations

import hashlib
import io
import os
import re
import zipfile
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import PurePosixPath
from typing import Literal, Protocol
from urllib.parse import quote, urlsplit
from uuid import UUID, uuid4

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import User
from app.modules.a import permissions
from app.modules.a.models import UploadReceipt as UploadReceiptRow
from app.modules.c.course_files_storage import CourseStorageLink, CourseUploadReceipt
from app.modules.c.files_storage import ALLOWED_MIME, MAX_FILE_BYTES, StorageLink, UploadReceipt

Scope = Literal["project", "course"]
PROVIDER = "supabase"
UPLOAD_URL_TTL = timedelta(hours=2)  # Supabase 签名上传链接固定 2 小时有效
RECEIPT_TTL = timedelta(hours=24)  # 上传完成后 24 小时内要交给业务接口
DOWNLOAD_URL_TTL_SECONDS = 600  # 限时下载链接 10 分钟（C 要求不超过 15 分钟）
MAX_ZIP_UNCOMPRESSED = 500 * 1024 * 1024
BLOCKED_ARCHIVE_SUFFIXES = {
    ".exe", ".dll", ".bat", ".cmd", ".com", ".scr", ".msi", ".ps1", ".vbs", ".js",
    ".jar", ".sh", ".app", ".apk",
}  # fmt: skip
_FILENAME_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


# ------------------------------------------------------------------ 配置与客户端


@dataclass(frozen=True)
class StorageSettings:
    url: str
    service_key: str
    bucket: str

    @property
    def host(self) -> str:
        return urlsplit(self.url).hostname or ""


def storage_settings() -> StorageSettings | None:
    url = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    bucket = os.getenv("SUPABASE_STORAGE_BUCKET", "").strip()
    if not (url and key and bucket):
        return None
    if urlsplit(url).scheme != "https":
        raise RuntimeError("SUPABASE_URL must use https.")
    return StorageSettings(url=url, service_key=key, bucket=bucket)


class StorageClient(Protocol):
    host: str
    bucket: str

    def create_signed_upload_url(self, object_id: str) -> str: ...

    def download(self, object_id: str, *, max_bytes: int) -> bytes: ...

    def create_signed_download_url(self, object_id: str, expires_in: int) -> str: ...


class SupabaseStorageClient:
    """Supabase Storage REST API（只在后端使用 service role key）。"""

    def __init__(self, settings: StorageSettings, *, timeout: float = 20.0) -> None:
        self.settings = settings
        self.host = settings.host
        self.bucket = settings.bucket
        self._timeout = timeout

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.settings.service_key}",
            "apikey": self.settings.service_key,
        }

    def _object_path(self, object_id: str) -> str:
        return f"{quote(self.bucket, safe='')}/{quote(object_id, safe='/')}"

    def create_signed_upload_url(self, object_id: str) -> str:
        response = httpx.post(
            f"{self.settings.url}/storage/v1/object/upload/sign/{self._object_path(object_id)}",
            headers=self._headers(),
            timeout=self._timeout,
        )
        response.raise_for_status()
        return f"{self.settings.url}/storage/v1{response.json()['url']}"

    def download(self, object_id: str, *, max_bytes: int) -> bytes:
        chunks: list[bytes] = []
        size = 0
        with httpx.stream(
            "GET",
            f"{self.settings.url}/storage/v1/object/authenticated/{self._object_path(object_id)}",
            headers=self._headers(),
            timeout=self._timeout,
        ) as response:
            if response.status_code in (400, 404):
                raise FileNotFoundError(object_id)
            response.raise_for_status()
            for chunk in response.iter_bytes():
                size += len(chunk)
                if size > max_bytes:
                    raise ValueError("object exceeds the declared size")
                chunks.append(chunk)
        return b"".join(chunks)

    def create_signed_download_url(self, object_id: str, expires_in: int) -> str:
        response = httpx.post(
            f"{self.settings.url}/storage/v1/object/sign/{self._object_path(object_id)}",
            headers=self._headers(),
            json={"expiresIn": expires_in},
            timeout=self._timeout,
        )
        response.raise_for_status()
        return f"{self.settings.url}/storage/v1{response.json()['signedURL']}"


def get_storage_client() -> StorageClient | None:
    settings = storage_settings()
    return SupabaseStorageClient(settings) if settings else None


def _require_client(client: StorageClient | None) -> StorageClient:
    if client is None:
        raise ApiError(503, "FILE_STORAGE_UNAVAILABLE", "文件存储尚未配置，暂时无法上传或下载。")
    return client


# ------------------------------------------------------------------ 内容检查


class ContentScanner(Protocol):
    def scan(self, data: bytes, *, extension: str) -> str | None:
        """返回 None 表示通过，否则返回拒绝原因。"""


_OLE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
_SIGNATURES = {
    "pdf": (b"%PDF-",),
    "png": (b"\x89PNG\r\n\x1a\n",),
    "jpg": (b"\xff\xd8\xff",),
    "jpeg": (b"\xff\xd8\xff",),
    "doc": (_OLE,),
    "ppt": (_OLE,),
    "xls": (_OLE,),
    "zip": (b"PK\x03\x04", b"PK\x05\x06"),
    "docx": (b"PK\x03\x04",),
    "pptx": (b"PK\x03\x04",),
    "xlsx": (b"PK\x03\x04",),
}
_OFFICE_DIR = {"docx": "word/", "pptx": "ppt/", "xlsx": "xl/"}
_EXECUTABLE_HEADERS = (b"MZ", b"\x7fELF", b"\xca\xfe\xba\xbe", b"\xcf\xfa\xed\xfe")


class BasicContentScanner:
    """基础检查：文件头与扩展名一致、文本是 UTF-8、压缩包不含可执行文件且不是压缩炸弹。"""

    def scan(self, data: bytes, *, extension: str) -> str | None:
        if any(data.startswith(header) for header in _EXECUTABLE_HEADERS):
            return "executable_content"
        if extension in {"md", "txt"}:
            if b"\x00" in data:
                return "binary_text_file"
            try:
                data.decode("utf-8")
            except UnicodeDecodeError:
                return "text_not_utf8"
            return None
        signatures = _SIGNATURES.get(extension)
        if not signatures or not any(data.startswith(sig) for sig in signatures):
            return "content_does_not_match_extension"
        if extension in {"zip", "docx", "pptx", "xlsx"}:
            return self._scan_zip(data, extension)
        return None

    def _scan_zip(self, data: bytes, extension: str) -> str | None:
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                entries = archive.infolist()
        except zipfile.BadZipFile:
            return "corrupt_archive"
        if sum(entry.file_size for entry in entries) > MAX_ZIP_UNCOMPRESSED:
            return "archive_too_large_when_extracted"
        names = [entry.filename for entry in entries]
        if any(PurePosixPath(n).suffix.lower() in BLOCKED_ARCHIVE_SUFFIXES for n in names):
            return "archive_contains_executable"
        if extension in _OFFICE_DIR and (
            "[Content_Types].xml" not in names
            or not any(n.startswith(_OFFICE_DIR[extension]) for n in names)
        ):
            return "content_does_not_match_extension"
        return None


# ------------------------------------------------------------------ 上传


def _extension(filename: str) -> str:
    return PurePosixPath(filename).suffix.removeprefix(".").lower()


def validate_file(filename: str, mime_type: str, size_bytes: int) -> str:
    """检查文件名、类型、大小（与 C 的 ALLOWED_MIME / 50MB 上限一致），返回扩展名。"""
    if (
        not filename
        or filename != filename.strip()
        or len(filename) > 255
        or any(c in filename for c in ("/", "\\"))
        or any(ord(c) < 32 or ord(c) == 127 for c in filename)
    ):
        raise ApiError(422, "INVALID_FILENAME", "文件名无效。")
    extension = _extension(filename)
    if mime_type not in ALLOWED_MIME.get(extension, set()):
        raise ApiError(415, "FILE_TYPE_NOT_ALLOWED", "不支持这种文件类型。")
    if not 0 < size_bytes <= MAX_FILE_BYTES:
        raise ApiError(413, "FILE_TOO_LARGE", "文件不能为空，且不能超过 50MB。")
    return extension


def _authorize_upload(session: Session, user: User, scope: Scope, scope_id: UUID) -> None:
    if scope == "project":
        permissions.require_project_member(session, user, scope_id, write=True)
    else:
        if not (
            permissions.is_course_staff(session, user, scope_id)
            or permissions.is_course_member(session, user, scope_id)
        ):
            raise ApiError(403, "COURSE_ACCESS_DENIED", "只有本课程成员可以上传课程文件。")


@dataclass(frozen=True)
class UploadTicket:
    receipt_id: UUID
    upload_url: str
    method: str
    expires_at: datetime
    object_id: str


def create_upload(
    session: Session,
    user: User,
    *,
    scope: Scope,
    scope_id: UUID,
    filename: str,
    mime_type: str,
    size_bytes: int,
    client: StorageClient | None = None,
) -> UploadTicket:
    """“拿上传链接”：检查权限和文件，登记 pending 凭证，返回签名上传链接。"""
    client = _require_client(client if client is not None else get_storage_client())
    permissions.require_active(user)
    validate_file(filename, mime_type, size_bytes)
    _authorize_upload(session, user, scope, scope_id)
    receipt_id = uuid4()
    safe_name = _FILENAME_SAFE.sub("_", filename)[-120:] or "file"
    object_id = f"{scope}/{scope_id}/{receipt_id}/{safe_name}"
    try:
        upload_url = client.create_signed_upload_url(object_id)
    except Exception as exc:  # noqa: BLE001 - 远端失败统一为不可用
        raise ApiError(503, "FILE_STORAGE_UNAVAILABLE", "文件存储暂时不可用。") from exc
    now = datetime.now(UTC)
    session.add(
        UploadReceiptRow(
            id=receipt_id,
            scope=scope,
            scope_id=scope_id,
            actor_id=user.id,
            provider=PROVIDER,
            bucket=client.bucket,
            object_id=object_id,
            filename=filename,
            declared_mime=mime_type,
            declared_size=size_bytes,
            status="pending",
            scan_status="pending",
            created_at=now,
            upload_expires_at=now + UPLOAD_URL_TTL,
        )
    )
    session.flush()
    return UploadTicket(receipt_id, upload_url, "PUT", now + UPLOAD_URL_TTL, object_id)


def complete_upload(
    session: Session,
    user: User,
    receipt_id: UUID,
    *,
    client: StorageClient | None = None,
    scanner: ContentScanner | None = None,
) -> UploadReceiptRow:
    """上传完成后由后端读回文件，重新算指纹和大小、检查内容，通过才标为 completed。"""
    client = _require_client(client if client is not None else get_storage_client())
    row = session.scalar(
        select(UploadReceiptRow)
        .where(UploadReceiptRow.id == receipt_id, UploadReceiptRow.actor_id == user.id)
        .with_for_update()
    )
    if row is None:
        raise ApiError(404, "UPLOAD_NOT_FOUND", "上传记录不存在。")
    if row.status != "pending":
        return row
    _authorize_upload(session, user, row.scope, row.scope_id)
    now = datetime.now(UTC)
    if now > row.upload_expires_at:
        return _reject(session, row, "upload_expired")
    try:
        data = client.download(row.object_id, max_bytes=MAX_FILE_BYTES)
    except FileNotFoundError as exc:
        raise ApiError(409, "UPLOAD_NOT_RECEIVED", "还没有收到文件，请先完成上传。") from exc
    except ValueError:
        return _reject(session, row, "file_too_large")
    except Exception as exc:  # noqa: BLE001
        raise ApiError(503, "FILE_STORAGE_UNAVAILABLE", "文件存储暂时不可用。") from exc
    if len(data) != row.declared_size:
        return _reject(session, row, "size_mismatch")
    reason = (scanner or BasicContentScanner()).scan(data, extension=_extension(row.filename))
    if reason:
        return _reject(session, row, reason)
    digest = hashlib.sha256(data).hexdigest()
    row.status = "completed"
    row.scan_status = "clean"
    row.content_hash = digest
    row.size_bytes = len(data)
    row.mime_type = row.declared_mime
    # 每个凭证的对象路径唯一且只写一次，用内容指纹作为不可变版本号。
    row.revision = f"sha256:{digest}"
    row.completed_at = now
    session.flush()
    return row


def _reject(session: Session, row: UploadReceiptRow, reason: str) -> UploadReceiptRow:
    row.status = "rejected"
    row.scan_status = "rejected"
    row.rejection_reason = reason
    session.flush()
    raise ApiError(422, "UPLOAD_REJECTED", "文件未通过检查。", details={"reason": reason})


def signed_download_url(
    session: Session,
    *,
    scope: Scope,
    scope_id: UUID,
    object_id: str,
    revision: str,
    purpose: Literal["preview", "download"] = "preview",
    client: StorageClient | None = None,
) -> tuple[str, datetime]:
    """“拿限时下载链接”：只对已完成、属于该项目/课程且版本一致的文件签名。权限由调用方先查。"""
    client = _require_client(client if client is not None else get_storage_client())
    row = session.scalar(
        select(UploadReceiptRow).where(
            UploadReceiptRow.object_id == object_id,
            UploadReceiptRow.scope == scope,
            UploadReceiptRow.scope_id == scope_id,
            UploadReceiptRow.status == "completed",
            UploadReceiptRow.revision == revision,
        )
    )
    if row is None:
        raise ApiError(404, "FILE_NOT_FOUND", "文件不存在。")
    expires_at = datetime.now(UTC) + timedelta(seconds=DOWNLOAD_URL_TTL_SECONDS)
    try:
        url = client.create_signed_download_url(object_id, DOWNLOAD_URL_TTL_SECONDS)
    except Exception as exc:  # noqa: BLE001
        raise ApiError(503, "FILE_STORAGE_UNAVAILABLE", "文件存储暂时不可用。") from exc
    if purpose == "download":
        # Supabase sets Content-Disposition from this query parameter. Preserve
        # the signed path and query verbatim; only encode the original filename.
        separator = "&" if "?" in url else "?"
        url += f"{separator}download={quote(row.filename, safe='')}"
    return url, expires_at


# ------------------------------------------------------------------ C 的存储接口实现


def _completed_receipt(session: Session, scope: Scope, scope_id, actor_id, receipt_id):
    row = session.scalar(
        select(UploadReceiptRow).where(
            UploadReceiptRow.id == receipt_id,
            UploadReceiptRow.scope == scope,
            UploadReceiptRow.scope_id == scope_id,
            UploadReceiptRow.actor_id == actor_id,
            UploadReceiptRow.status == "completed",
        )
    )
    if row is None or row.completed_at is None:
        raise ApiError(409, "UPLOAD_RECEIPT_INVALID", "上传凭证无效或尚未完成。")
    expires_at = row.completed_at + RECEIPT_TTL
    if expires_at <= datetime.now(UTC):
        raise ApiError(409, "UPLOAD_RECEIPT_EXPIRED", "上传凭证已过期，请重新上传。")
    return row, expires_at


class _SupabasePortBase:
    def __init__(self, session_factory, client: StorageClient) -> None:
        self._session_factory = session_factory
        self._client = client
        self.allowed_download_hosts = frozenset({client.host})

    def _with_session(self, fn):
        with self._session_factory() as session:
            return fn(session)


class SupabaseProjectStoragePort(_SupabasePortBase):
    """C 项目资料（files_storage.StoragePort）的正式实现。"""

    def resolve_receipt(self, *, project_id: UUID, actor_id: UUID, receipt_id: UUID):
        def run(session):
            row, expires_at = _completed_receipt(
                session, "project", project_id, actor_id, receipt_id
            )
            return UploadReceipt(
                receipt_id=row.id,
                project_id=project_id,
                actor_id=actor_id,
                provider=row.provider,
                object_id=row.object_id,
                revision=row.revision,
                filename=row.filename,
                content_hash=row.content_hash,
                size_bytes=row.size_bytes,
                mime_type=row.mime_type,
                status="completed",
                scan_status="clean",
                expires_at=expires_at,
            )

        return self._with_session(run)

    def sign_version(self, *, project_id, actor_id, provider, object_id, revision, purpose):
        def run(session):
            url, expires_at = signed_download_url(
                session,
                scope="project",
                scope_id=project_id,
                object_id=object_id,
                revision=revision,
                purpose=purpose,
                client=self._client,
            )
            return StorageLink(
                project_id=project_id,
                actor_id=actor_id,
                provider=provider,
                object_id=object_id,
                revision=revision,
                purpose=purpose,
                url=url,
                expires_at=expires_at,
            )

        if provider != PROVIDER:
            raise ApiError(404, "FILE_NOT_FOUND", "文件不存在。")
        return self._with_session(run)


class SupabaseCourseStoragePort(_SupabasePortBase):
    """C 课程文件（course_files_storage.CourseStoragePort）的正式实现。"""

    def resolve_receipt(self, *, course_id: UUID, actor_id: UUID, receipt_id: UUID):
        def run(session):
            row, expires_at = _completed_receipt(session, "course", course_id, actor_id, receipt_id)
            return CourseUploadReceipt(
                receipt_id=row.id,
                course_id=course_id,
                actor_id=actor_id,
                provider=row.provider,
                object_id=row.object_id,
                revision=row.revision,
                filename=row.filename,
                content_hash=row.content_hash,
                size_bytes=row.size_bytes,
                mime_type=row.mime_type,
                status="completed",
                scan_status="clean",
                expires_at=expires_at,
            )

        return self._with_session(run)

    def sign_version(self, *, course_id, actor_id, provider, object_id, revision, purpose):
        def run(session):
            url, expires_at = signed_download_url(
                session,
                scope="course",
                scope_id=course_id,
                object_id=object_id,
                revision=revision,
                purpose=purpose,
                client=self._client,
            )
            return CourseStorageLink(
                course_id=course_id,
                actor_id=actor_id,
                provider=provider,
                object_id=object_id,
                revision=revision,
                purpose=purpose,
                url=url,
                expires_at=expires_at,
            )

        if provider != PROVIDER:
            raise ApiError(404, "FILE_NOT_FOUND", "文件不存在。")
        return self._with_session(run)


def project_storage_port():
    """未配置 Supabase 时返回 None，由 C 的工厂退回到“不可用”。"""
    client = get_storage_client()
    if client is None:
        return None
    from app.db.session import SessionLocal

    return SupabaseProjectStoragePort(SessionLocal, client)


def course_storage_port():
    client = get_storage_client()
    if client is None:
        return None
    from app.db.session import SessionLocal

    return SupabaseCourseStoragePort(SessionLocal, client)
