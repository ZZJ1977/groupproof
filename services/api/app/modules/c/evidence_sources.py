"""Resolve evidence through the same authorized sources used on the C workspace pages."""

from typing import Annotated
from uuid import UUID

from fastapi import Depends
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.session import get_session
from app.modules.c.activity_ports import ActivitySourcePort, get_activity_source_port
from app.modules.c.activity_service import validate_record
from app.modules.c.file_evidence import FileEvidenceSourcePort
from app.modules.c.files_storage import StoragePort, get_storage_port
from app.modules.c.source_ports import SourcePort, VerifiedSource


class WorkspaceEvidenceSources:
    def __init__(self, session: Session, files: SourcePort, activities: ActivitySourcePort):
        self.session = session
        self.files = files
        self.activities = activities

    def resolve(
        self, *, project_id: UUID, actor_id: UUID, source_type: str, source_id: UUID
    ) -> VerifiedSource:
        if source_type in {"file", "screenshot"}:
            return self.files.resolve(
                project_id=project_id,
                actor_id=actor_id,
                source_type=source_type,
                source_id=source_id,
            )
        if source_type not in ("github", "feishu"):
            raise ApiError(422, "INVALID_ACTIVITY_SOURCE", "Unsupported evidence source.")
        record = self.activities.get(
            project_id=project_id, actor_id=actor_id, source_type=source_type, source_id=source_id
        )
        validate_record(self.session, record, project_id, source_type, source_id)
        return record.source


def get_source_port(
    session: Annotated[Session, Depends(get_session)],
    storage: Annotated[StoragePort, Depends(get_storage_port)],
    activities: Annotated[ActivitySourcePort, Depends(get_activity_source_port)],
) -> SourcePort:
    return WorkspaceEvidenceSources(session, FileEvidenceSourcePort(session, storage), activities)
