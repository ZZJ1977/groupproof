"""Request and response schemas for teacher course materials and folders."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

MaterialVisibility = Literal["all", "grouped", "staff"]
MaterialStatus = Literal["draft", "published"]
BatchMaterialAction = Literal["move", "set_visibility", "delete"]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class FolderRefDTO(BaseModel):
    id: UUID
    name: str
    parent_id: UUID | None = None


class FolderDTO(FolderRefDTO):
    course_id: UUID
    sort_order: int = 0
    item_count: int = 0
    created_at: datetime


class MaterialVersionDTO(BaseModel):
    id: UUID
    version_no: int
    original_name: str
    mime_type: str
    size_bytes: int
    checksum: str
    change_note: str | None = None
    uploaded_by: UUID
    uploader_name: str | None = None
    created_at: datetime
    has_content: bool = False


class MaterialItemDTO(BaseModel):
    id: UUID
    course_id: UUID
    folder_id: UUID | None = None
    name: str
    visibility: MaterialVisibility
    status: MaterialStatus
    latest_version_no: int
    mime_type: str
    size_bytes: int
    uploaded_by: UUID
    uploader_name: str | None = None
    created_at: datetime
    updated_at: datetime
    download_href: str


class MaterialDetailDTO(BaseModel):
    item: MaterialItemDTO
    versions: list[MaterialVersionDTO]


class TeacherFilesTreeDTO(BaseModel):
    course_id: UUID
    can_manage: bool
    current_folder_id: UUID | None = None
    breadcrumbs: list[FolderRefDTO]
    folders: list[FolderDTO]
    items: list[MaterialItemDTO]


class StudentMaterialsDTO(BaseModel):
    course_id: UUID
    is_grouped: bool
    items: list[MaterialItemDTO]


class CreateFolderRequest(Strict):
    name: str = Field(min_length=1, max_length=120)
    parent_id: UUID | None = None
    sort_order: int = Field(default=0, ge=0, le=10000)


class UpdateFolderRequest(Strict):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    parent_id: UUID | None = None
    move_to_root: bool = False
    sort_order: int | None = Field(default=None, ge=0, le=10000)


class UploadMaterialRequest(Strict):
    name: str = Field(min_length=1, max_length=255)
    folder_id: UUID | None = None
    visibility: MaterialVisibility = "all"
    status: MaterialStatus = "published"
    mime_type: str = Field(default="application/octet-stream", min_length=1, max_length=200)
    size_bytes: int | None = Field(default=None, ge=0, le=52428800)
    content_base64: str | None = None
    change_note: str | None = Field(default=None, max_length=500)


class AppendMaterialVersionRequest(Strict):
    original_name: str | None = Field(default=None, min_length=1, max_length=255)
    mime_type: str | None = Field(default=None, min_length=1, max_length=200)
    size_bytes: int | None = Field(default=None, ge=0, le=52428800)
    content_base64: str | None = None
    change_note: str | None = Field(default=None, max_length=500)


class UpdateMaterialRequest(Strict):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    folder_id: UUID | None = None
    move_to_root: bool = False
    visibility: MaterialVisibility | None = None
    status: MaterialStatus | None = None


class BatchMaterialRequest(Strict):
    ids: list[UUID] = Field(min_length=1, max_length=100)
    action: BatchMaterialAction
    folder_id: UUID | None = None
    visibility: MaterialVisibility | None = None


class BatchMaterialResultDTO(BaseModel):
    affected: int
    action: BatchMaterialAction


class DeleteResultDTO(BaseModel):
    deleted: bool
    id: UUID
