"""A audit/usage contracts: no speculative storage queries or synthetic rows."""

from dataclasses import dataclass
from datetime import datetime
from typing import Protocol
from uuid import UUID, uuid4

from fastapi import Depends
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.session import get_session
from app.modules.a.ai.usage import list_ai_usage
from app.modules.c.governance_common import utc
from app.modules.c.governance_read_schemas import (
    AuditFilters,
    AuditRecord,
    UsageFilters,
    UsageSample,
)


@dataclass(frozen=True)
class AuditPage:
    items: tuple[AuditRecord, ...]
    total: int


@dataclass(frozen=True)
class UsagePage:
    items: tuple[UsageSample, ...]
    total: int
    snapshot_id: str


class GovernanceReadPort(Protocol):
    def audit_page(self, *, actor_id: UUID, filters: AuditFilters) -> AuditPage:
        """Admin metadata; all actor/role/target/time filters before count/paging.

        actor_role is the role at event time, never a guessed current user role.
        Return the exact filtered total, newest timestamp then ID order.
        """
        ...

    def audit_detail(self, *, actor_id: UUID, record_id: UUID) -> AuditRecord: ...

    def usage_page(
        self,
        *,
        actor_id: UUID,
        filters: UsageFilters,
        since: datetime,
        until: datetime,
        page: int,
        page_size: int,
        snapshot_id: str | None,
    ) -> UsagePage:
        """Stable complete snapshot filtered before paging, [since, until).

        The first page creates a snapshot ID; subsequent pages must replay that
        snapshot and its unchanged total. No missing rows, duplicated IDs or
        partial upstream success. Unreported fees remain unknown.
        """
        ...


class UnavailableGovernanceReadPort:
    def audit_page(self, **_) -> AuditPage:
        raise ApiError(503, "AUDIT_SOURCE_UNAVAILABLE", "A audit query service is not connected.")

    def audit_detail(self, **_) -> AuditRecord:
        raise ApiError(503, "AUDIT_SOURCE_UNAVAILABLE", "A audit query service is not connected.")

    def usage_page(self, **_) -> UsagePage:
        raise ApiError(503, "USAGE_SOURCE_UNAVAILABLE", "A timestamped AI usage is not connected.")


class DatabaseUsagePort(UnavailableGovernanceReadPort):
    """Freeze A's immutable usage rows for one admin HTTP request."""

    def __init__(self, session: Session):
        self.session = session
        self.rows: tuple[UsageSample, ...] = ()
        self.snapshot_id = str(uuid4())

    def usage_page(self, *, actor_id, filters, since, until, page, page_size, snapshot_id):
        if page == 1 and snapshot_id is None:
            rows = []
            seen = set()
            source_page, total = 1, None
            while True:
                source = list_ai_usage(
                    self.session,
                    user_id=filters.user_id,
                    feature=filters.feature,
                    since=since,
                    until=until,
                    page=source_page,
                    page_size=100,
                )
                if source.total > 10000:
                    raise ApiError(503, "USAGE_WINDOW_TOO_LARGE", "Narrow the usage window.")
                if total is None:
                    total = source.total
                if total != source.total or len(source.items) != min(100, total - len(seen)):
                    raise ApiError(
                        503, "USAGE_PAGE_INVALID", "The usage snapshot changed; refresh."
                    )
                for row in source.items:
                    if row.id in seen:
                        raise ApiError(
                            503, "USAGE_PAGE_INVALID", "The usage snapshot changed; refresh."
                        )
                    seen.add(row.id)
                    if not filters.model or row.model == filters.model:
                        rows.append(
                            UsageSample(
                                id=row.id,
                                user_id=row.user_id,
                                occurred_at=utc(row.occurred_at),
                                feature=row.feature,
                                model=row.model,
                                success=row.success,
                                input_tokens=row.input_tokens,
                                output_tokens=row.output_tokens,
                                cost=row.cost,
                                currency=row.currency,
                            )
                        )
                if len(seen) == total:
                    break
                source_page += 1
            self.rows = tuple(rows)
        elif snapshot_id != self.snapshot_id:
            raise ApiError(503, "USAGE_PAGE_INVALID", "The usage snapshot changed; refresh.")
        offset = (page - 1) * page_size
        return UsagePage(self.rows[offset : offset + page_size], len(self.rows), self.snapshot_id)


def get_governance_read_port(session: Session = Depends(get_session)) -> GovernanceReadPort:
    return DatabaseUsagePort(session)
