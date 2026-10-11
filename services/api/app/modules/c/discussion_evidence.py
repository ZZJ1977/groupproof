"""Keep C-owned discussion evidence consistent in the same write transaction."""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import User
from app.modules.c.discussion_service import resolve_discussion_source
from app.modules.c.evidence_service import append_source_change
from app.modules.c.models import Evidence, EvidenceSourceSnapshot


def invalidate_discussion_evidence(
    session: Session, user: User, project_id: UUID, discussion_id: UUID, reason: str
) -> None:
    """Retain captured sources and exclude outdated evidence before commit.

    The caller owns the Project lock and creates the new discussion snapshot.
    D's downstream invalidation remains a pending outbox event, not a sent message.
    """
    source = resolve_discussion_source(
        session, user, project_id, discussion_id, require_important=False
    )
    originals = session.execute(
        select(Evidence, EvidenceSourceSnapshot)
        .join(EvidenceSourceSnapshot, EvidenceSourceSnapshot.evidence_id == Evidence.id)
        .where(
            Evidence.project_id == project_id,
            Evidence.source_type == "discussion",
            EvidenceSourceSnapshot.version_no == 1,
        )
    )
    for evidence, snapshot in originals:
        if snapshot.content_json.get("source_id") == str(discussion_id):
            append_source_change(session, evidence, user.id, source, reason)
