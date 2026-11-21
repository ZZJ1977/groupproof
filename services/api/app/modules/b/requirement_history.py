"""B4-01/B4-02 numbering and versions shared by every place that writes requirements."""

from __future__ import annotations

from uuid import UUID, uuid4

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.db.models import Requirement
from app.modules.b.common import now
from app.modules.b.models import BProjectCounter, BRequirementCode, BRequirementVersion

FIELDS = {
    "title": "标题",
    "description": "说明",
    "priority": "优先级",
    "status": "状态",
    "module_id": "所属模块",
}


def code_of(seq: int | None) -> str | None:
    return f"R-{seq:03d}" if seq else None


def next_seq(session: Session, project_id: UUID) -> int:
    """Atomic per-project counter: concurrent writers never get the same number."""
    statement = (
        insert(BProjectCounter)
        .values(project_id=project_id, requirement_seq=1)
        .on_conflict_do_update(
            index_elements=[BProjectCounter.project_id],
            set_={"requirement_seq": BProjectCounter.requirement_seq + 1},
        )
        .returning(BProjectCounter.requirement_seq)
    )
    return session.execute(statement).scalar_one()


def snapshot(row: Requirement) -> dict:
    return {
        "title": row.title,
        "description": row.description,
        "priority": row.priority,
        "status": row.status,
        "module_id": str(row.module_id),
    }


def latest_version(session: Session, requirement_id: UUID) -> int:
    return (
        session.scalar(
            select(func.max(BRequirementVersion.version_no)).where(
                BRequirementVersion.requirement_id == requirement_id
            )
        )
        or 0
    )


def register(session: Session, row: Requirement, actor_id: UUID | None) -> None:
    """Give a new requirement its number and version 1 (same transaction)."""
    session.add(
        BRequirementCode(
            requirement_id=row.id, project_id=row.project_id, seq=next_seq(session, row.project_id)
        )
    )
    add_version(session, row, actor_id, reason=None, after_freeze=False)


def add_version(
    session: Session,
    row: Requirement,
    actor_id: UUID | None,
    *,
    reason: str | None,
    after_freeze: bool,
) -> int:
    version_no = latest_version(session, row.id) + 1
    session.add(
        BRequirementVersion(
            id=uuid4(),
            requirement_id=row.id,
            project_id=row.project_id,
            version_no=version_no,
            snapshot=snapshot(row),
            reason=reason,
            after_freeze=after_freeze,
            created_by=actor_id,
            created_at=now(),
        )
    )
    session.flush()
    return version_no


def diff(before: dict, after: dict) -> list[dict]:
    return [
        {"field": key, "label": label, "before": before.get(key), "after": after.get(key)}
        for key, label in FIELDS.items()
        if before.get(key) != after.get(key)
    ]
