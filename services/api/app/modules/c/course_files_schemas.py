from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

FileCategory = Literal["documents", "images", "exports"]
FileStatus = Literal["draft", "current", "superseded"]
FileSort = Literal["updated_desc", "updated_asc", "name_asc", "size_desc"]
FilePurpose = Literal["preview", "download"]


class CourseFileCommand(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    reason: str = Field(min_length=1, max_length=4000)


class RegisterCourseFile(CourseFileCommand):
    receipt_id: UUID
    category: FileCategory = "documents"


class AppendCourseFileVersion(CourseFileCommand):
    receipt_id: UUID
    expected_version: int = Field(ge=0, strict=True)


class PublishCourseFileVersion(CourseFileCommand):
    version_id: UUID
    expected_version: int = Field(ge=0, strict=True)


class CourseFileVersionDTO(BaseModel):
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


class CourseFileDTO(BaseModel):
    id: UUID
    course_id: UUID
    name: str
    category: FileCategory
    latest_version_no: int
    official_version_no: int | None
    lock_version: int
    created_by: UUID
    created_at: datetime
    updated_at: datetime
    versions: list[CourseFileVersionDTO]


class CourseFileDecisionDTO(BaseModel):
    id: UUID
    version_id: UUID
    actor_id: UUID
    action: Literal["created", "appended", "published"]
    reason: str
    resulting_lock_version: int
    previous_official_version_no: int | None
    created_at: datetime


class CourseFileDetailDTO(CourseFileDTO):
    decisions: list[CourseFileDecisionDTO]


class CourseFileListItemDTO(CourseFileVersionDTO):
    course_id: UUID
    name: str
    category: FileCategory
    lock_version: int


class CourseFilePageDTO(BaseModel):
    items: list[CourseFileListItemDTO]
    total: int
    page: int
    page_size: int
    can_write: bool


class SignedCourseFileLinkDTO(BaseModel):
    version_id: UUID
    purpose: FilePurpose
    url: str
    expires_at: datetime
