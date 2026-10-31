"""A audit/usage contracts: no speculative storage queries or synthetic rows."""

from dataclasses import dataclass
from datetime import datetime
from typing import Protocol
from uuid import UUID

from app.api.errors import ApiError
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
        partial upstream success. Unknown/missing cost must raise, not become zero.
        """
        ...


class UnavailableGovernanceReadPort:
    def audit_page(self, **_) -> AuditPage:
        raise ApiError(503, "AUDIT_SOURCE_UNAVAILABLE", "A audit query service is not connected.")

    def audit_detail(self, **_) -> AuditRecord:
        raise ApiError(503, "AUDIT_SOURCE_UNAVAILABLE", "A audit query service is not connected.")

    def usage_page(self, **_) -> UsagePage:
        raise ApiError(503, "USAGE_SOURCE_UNAVAILABLE", "A timestamped AI usage is not connected.")


def get_governance_read_port() -> GovernanceReadPort:
    return UnavailableGovernanceReadPort()
