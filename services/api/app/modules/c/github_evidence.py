"""Reconcile original GitHub evidence references against A's synced activities."""

from collections import defaultdict
from contextlib import nullcontext
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Project, User
from app.modules.a.github_activity import DatabaseGithubActivityPort
from app.modules.c.activity_ports import ActivitySourceQuery, GithubActivityPort
from app.modules.c.evidence_service import append_source_change
from app.modules.c.models import Evidence, EvidenceSourceSnapshot


def reconcile_github_evidence(session: Session, actor: User, project_id: UUID) -> None:
    """Run within A's authorized sync transaction, after all source changes are flushed."""
    # Evidence submission and manual checks use this same project lock.
    session.execute(select(Project.id).where(Project.id == project_id).with_for_update())
    source_id = EvidenceSourceSnapshot.content_json["source_id"].as_string()
    originals = session.execute(
        select(Evidence, source_id)
        .join(EvidenceSourceSnapshot, EvidenceSourceSnapshot.evidence_id == Evidence.id)
        .where(
            Evidence.project_id == project_id,
            Evidence.source_type == "github",
            EvidenceSourceSnapshot.version_no == 1,
        )
        .order_by(Evidence.id)
        .execution_options(populate_existing=True)
    )
    by_source = defaultdict(list)
    for evidence, activity_id in originals:
        if not isinstance(activity_id, str):
            continue
        try:
            source_uuid = UUID(activity_id)
        except ValueError:
            # An unmapped legacy snapshot cannot establish an upstream deletion.
            continue
        by_source[source_uuid].append(evidence)
    ids = list(by_source)
    port = GithubActivityPort(DatabaseGithubActivityPort(lambda: nullcontext(session)))
    # Also reconcile older evidence when its upstream revision changed before
    # the consumer was deployed. An absent row is not proof of deletion.
    for start in range(0, len(ids), 100):
        batch = tuple(ids[start : start + 100])
        records = port.query(
            project_id=project_id,
            actor_id=actor.id,
            source_type="github",
            query=ActivitySourceQuery(include_ids=batch, page_size=len(batch)),
        )
        for item in records.items:
            for evidence in by_source[item.id]:
                append_source_change(
                    session, evidence, actor.id, item.source, "GitHub 同步确认来源发生变化。"
                )
