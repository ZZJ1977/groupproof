from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

FileCategory = Literal["documents", "images", "exports"]
FileStatus = Literal["draft", "current", "superseded"]
FileSort = Literal["updated_desc", "updated_asc", "name_asc", "size_desc"]
FilePurpose = Literal["preview", "download"]


class FileCommand(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    reason: str = Field(min_length=1, max_length=4000)


class RegisterFile(FileCommand):
    receipt_id: UUID
    category: FileCategory = "documents"


class AppendFileVersion(FileCommand):
    receipt_id: UUID
    expected_version: int = Field(ge=0, strict=True)


class DesignateFileVersion(FileCommand):
    version_id: UUID
    expected_version: int = Field(ge=0, strict=True)


class FileVersionDTO(BaseModel):
    id: UUID
    file_id: UUID
    version_no: int
    original_name: str
    extension: str
    mime_type: str
    size_bytes: int
    content_hash: str
    uploaded_by: UUID
    status: FileStatus
    created_at: datetime


class LogicalFileDTO(BaseModel):
    id: UUID
    project_id: UUID
    name: str
    category: FileCategory
    latest_version_no: int
    official_version_no: int | None
    lock_version: int
    created_by: UUID
    created_at: datetime
    updated_at: datetime
    versions: list[FileVersionDTO]


class FileDecisionDTO(BaseModel):
    id: UUID
    version_id: UUID
    actor_id: UUID
    action: Literal["created", "appended", "designated"]
    reason: str
    resulting_lock_version: int
    previous_official_version_no: int | None
    created_at: datetime


class FileDetailDTO(LogicalFileDTO):
    decisions: list[FileDecisionDTO]


class FileListItemDTO(FileVersionDTO):
    project_id: UUID
    name: str
    category: FileCategory
    lock_version: int


class FilePageDTO(BaseModel):
    items: list[FileListItemDTO]
    total: int
    page: int
    page_size: int


class SignedFileLinkDTO(BaseModel):
    version_id: UUID
    purpose: FilePurpose
    url: str
    expires_at: datetime
