"""Evidence snapshots of registered project file versions. Signed URLs stay transient."""

from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import User
from app.modules.c.evidence_service import append_source_change
from app.modules.c.files_models import FileVersion, LogicalFile
from app.modules.c.files_storage import (
    StoragePort,
    UnavailableStoragePort,
    signed_link,
    unavailable,
)
from app.modules.c.models import Evidence, EvidenceSourceSnapshot
from app.modules.c.permissions import get_project_access
from app.modules.c.source_ports import VerifiedSource


def _snapshot(row: LogicalFile, version: FileVersion, kind: str) -> VerifiedSource:
    return VerifiedSource(
        project_id=row.project_id,
        source_type=kind,
        identity=str(row.id),
        revision=str(version.id),
        content={
            "provenance": "registered_project_file",
            "file_id": str(row.id),
            "version_id": str(version.id),
            "version_no": version.version_no,
            "title": version.original_name,
            "mime_type": version.mime_type,
            "size_bytes": version.size_bytes,
            "sha256": version.content_hash,
        },
    )


class FileEvidenceSourcePort:
    def __init__(self, session: Session, storage: StoragePort):
        self.session = session
        self.storage = storage

    def resolve(
        self, *, project_id: UUID, actor_id: UUID, source_type: str, source_id: UUID
    ) -> VerifiedSource:
        actor = self.session.get(User, actor_id)
        if actor is None:
            raise ApiError(403, "FILE_READ_DENIED", "Project file access required.")
        get_project_access(self.session, actor, project_id)
        if isinstance(self.storage, UnavailableStoragePort):
            raise unavailable()
        match = self.session.execute(
            select(LogicalFile, FileVersion)
            .join(FileVersion)
            .where(LogicalFile.project_id == project_id, FileVersion.id == source_id)
        ).one_or_none()
        if match is None:
            raise ApiError(404, "FILE_VERSION_NOT_FOUND", "File version not found in this project.")
        row, version = match
        if version.version_no not in (row.latest_version_no, row.official_version_no):
            raise ApiError(409, "SOURCE_NOT_CURRENT", "Select a current file version.")
        if source_type == "screenshot" and version.mime_type not in {"image/png", "image/jpeg"}:
            raise ApiError(422, "SCREENSHOT_REQUIRED", "Select a verified PNG or JPEG version.")
        signed_link(
            self.storage,
            project_id=project_id,
            actor_id=actor_id,
            provider=version.storage_provider,
            object_id=version.storage_object_id,
            revision=version.storage_revision,
            purpose="download",
        )
        return _snapshot(row, version, source_type)


def replace_file_evidence_source(
    session: Session,
    row: LogicalFile,
    previous_version_no: int,
    version: FileVersion,
    actor_id: UUID,
    reason: str,
) -> None:
    """Invoked under the project lock when a draft or official revision is superseded."""
    old_id = session.scalars(
        select(FileVersion.id).where(
            FileVersion.file_id == row.id, FileVersion.version_no == previous_version_no
        )
    ).one()
    latest_snapshot_no = (
        select(func.max(EvidenceSourceSnapshot.version_no))
        .where(EvidenceSourceSnapshot.evidence_id == Evidence.id)
        .correlate(Evidence)
        .scalar_subquery()
    )
    matches = session.execute(
        select(Evidence, EvidenceSourceSnapshot)
        .join(EvidenceSourceSnapshot, Evidence.id == EvidenceSourceSnapshot.evidence_id)
        .where(
            Evidence.project_id == row.project_id,
            Evidence.source_type.in_(("file", "screenshot")),
            EvidenceSourceSnapshot.source_identity == str(row.id),
            EvidenceSourceSnapshot.source_revision == str(old_id),
            EvidenceSourceSnapshot.version_no == latest_snapshot_no,
        )
    )
    for evidence, prior in matches:
        if not isinstance(prior.content_json, dict):
            continue
        payload = prior.content_json.get("source")
        if isinstance(payload, dict) and payload.get("provenance") == "registered_project_file":
            append_source_change(
                session, evidence, actor_id, _snapshot(row, version, evidence.source_type), reason
            )
