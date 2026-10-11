"""A4 storage boundary: verified receipts and expiring, authorized signed links.

HTTP clients can submit only opaque receipt IDs. An A adapter must independently
verify completed bytes, immutable object revision, checksum, size, media type,
malware scan and project/uploader binding. C revalidates every returned field.
The default adapter is deliberately unavailable, not a mock upload success.
"""

from datetime import UTC, datetime, timedelta
from pathlib import PurePosixPath
from typing import Literal, Protocol
from urllib.parse import urlsplit
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, TypeAdapter, ValidationError

from app.api.errors import ApiError
from app.modules.c.files_schemas import FilePurpose

MAX_FILE_BYTES = 50 * 1024 * 1024
ALLOWED_MIME = {
    "pdf": {"application/pdf"},
    "doc": {"application/msword"},
    "docx": {"application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
    "ppt": {"application/vnd.ms-powerpoint"},
    "pptx": {"application/vnd.openxmlformats-officedocument.presentationml.presentation"},
    "xls": {"application/vnd.ms-excel"},
    "xlsx": {"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
    "md": {"text/markdown", "text/plain"},
    "txt": {"text/plain"},
    "zip": {"application/zip", "application/x-zip-compressed"},
    "png": {"image/png"},
    "jpg": {"image/jpeg"},
    "jpeg": {"image/jpeg"},
}


class UploadReceipt(BaseModel):
    model_config = ConfigDict(
        frozen=True, strict=True, extra="forbid", revalidate_instances="always"
    )
    receipt_id: UUID
    project_id: UUID
    actor_id: UUID
    provider: str = Field(min_length=1, max_length=80)
    object_id: str = Field(min_length=1, max_length=255)
    revision: str = Field(min_length=1, max_length=255)
    filename: str = Field(min_length=1, max_length=255)
    content_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    size_bytes: int = Field(ge=0, le=MAX_FILE_BYTES)
    mime_type: str = Field(min_length=1, max_length=200)
    status: Literal["completed"]
    scan_status: Literal["clean"]
    expires_at: datetime


class StorageLink(BaseModel):
    model_config = ConfigDict(
        frozen=True, strict=True, extra="forbid", revalidate_instances="always"
    )
    project_id: UUID
    actor_id: UUID
    provider: str
    object_id: str
    revision: str
    purpose: FilePurpose
    url: str
    expires_at: datetime


class StoragePort(Protocol):
    allowed_download_hosts: frozenset[str]

    def resolve_receipt(
        self, *, project_id: UUID, actor_id: UUID, receipt_id: UUID
    ) -> UploadReceipt: ...

    def sign_version(
        self,
        *,
        project_id: UUID,
        actor_id: UUID,
        provider: str,
        object_id: str,
        revision: str,
        purpose: FilePurpose,
    ) -> StorageLink: ...


class UnavailableStoragePort:
    allowed_download_hosts: frozenset[str] = frozenset()

    def resolve_receipt(self, **kwargs) -> UploadReceipt:
        raise unavailable()

    def sign_version(self, **kwargs) -> StorageLink:
        raise unavailable()


def unavailable() -> ApiError:
    return ApiError(503, "FILE_STORAGE_UNAVAILABLE", "A verified storage adapter is not connected.")


def invalid_receipt() -> ApiError:
    return ApiError(503, "INVALID_STORAGE_RECEIPT", "Storage returned an invalid upload receipt.")


def get_storage_port() -> StoragePort:
    return UnavailableStoragePort()


def resolve_receipt(
    port: StoragePort, *, project_id: UUID, actor_id: UUID, receipt_id: UUID
) -> UploadReceipt:
    try:
        result = UploadReceipt.model_validate(
            port.resolve_receipt(
                project_id=project_id,
                actor_id=actor_id,
                receipt_id=receipt_id,
            )
        )
        now = datetime.now(UTC)
        extension = PurePosixPath(result.filename).suffix.removeprefix(".").lower()
        if (
            (result.project_id, result.actor_id, result.receipt_id)
            != (project_id, actor_id, receipt_id)
            or result.expires_at.tzinfo is None
            or result.expires_at <= now
            or result.filename != result.filename.strip()
            or len(result.filename.casefold()) > 255
            or any(c in result.filename for c in ("/", "\\"))
            or any(ord(c) < 32 or ord(c) == 127 for c in result.filename)
            or result.mime_type not in ALLOWED_MIME.get(extension, set())
            or any(
                not value.strip() for value in (result.provider, result.object_id, result.revision)
            )
        ):
            raise invalid_receipt()
        return result
    except ApiError:
        raise
    except (ValidationError, TypeError, ValueError, AttributeError) as exc:
        raise invalid_receipt() from exc
    except Exception as exc:
        raise unavailable() from exc


def signed_link(
    port: StoragePort,
    *,
    project_id: UUID,
    actor_id: UUID,
    provider: str,
    object_id: str,
    revision: str,
    purpose: FilePurpose,
) -> StorageLink:
    error = ApiError(503, "INVALID_STORAGE_LINK", "Storage returned an invalid signed link.")
    try:
        link = StorageLink.model_validate(
            port.sign_version(
                project_id=project_id,
                actor_id=actor_id,
                provider=provider,
                object_id=object_id,
                revision=revision,
                purpose=purpose,
            )
        )
        parsed = urlsplit(link.url)
        TypeAdapter(HttpUrl).validate_python(link.url)
        now = datetime.now(UTC)
        if (
            (
                link.project_id,
                link.actor_id,
                link.provider,
                link.object_id,
                link.revision,
                link.purpose,
            )
            != (project_id, actor_id, provider, object_id, revision, purpose)
            or parsed.scheme != "https"
            or parsed.username
            or parsed.password
            or parsed.fragment
            or parsed.hostname not in port.allowed_download_hosts
            or parsed.port not in (None, 443)
            or any(ord(c) < 33 or ord(c) == 127 for c in link.url)
            or link.expires_at.tzinfo is None
            or not now < link.expires_at <= now + timedelta(minutes=15)
        ):
            raise error
        return link
    except ApiError:
        raise
    except (ValidationError, TypeError, ValueError, AttributeError) as exc:
        raise error from exc
    except Exception as exc:
        raise unavailable() from exc
