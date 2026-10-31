"""A-owned authorized source reads. No credentials or browser source payloads.

The adapter must query its canonical, authorized ingestion store, apply the exact
filters before pagination, and order by occurred_at DESC then id ASC. Failures or
partial upstream results must raise 503, not return an apparently empty page.
"""

from dataclasses import dataclass
from datetime import datetime
from typing import Literal, Protocol
from uuid import UUID

from app.api.errors import ApiError
from app.modules.c.source_ports import VerifiedSource

ActivityKind = Literal["github", "feishu"]


@dataclass(frozen=True)
class ActivitySourceRecord:
    id: UUID
    title: str
    summary: str
    author_id: UUID | None
    author_name: str
    occurred_at: datetime
    kind: str
    source: VerifiedSource
    group_id: str | None = None


@dataclass(frozen=True)
class ActivitySourceQuery:
    page: int = 1
    page_size: int = 20
    author_id: UUID | None = None
    since: datetime | None = None
    until: datetime | None = None
    q: str | None = None
    # None means unrestricted. Empty tuple explicitly means match nothing.
    include_ids: tuple[UUID, ...] | None = None
    exclude_ids: tuple[UUID, ...] = ()
    group_id: str | None = None
    record_kind: str | None = None


@dataclass(frozen=True)
class ActivitySourcePage:
    items: tuple[ActivitySourceRecord, ...]
    total: int


class ActivitySourcePort(Protocol):
    def query(
        self,
        *,
        project_id: UUID,
        actor_id: UUID,
        source_type: ActivityKind,
        query: ActivitySourceQuery,
    ) -> ActivitySourcePage: ...

    def get(
        self,
        *,
        project_id: UUID,
        actor_id: UUID,
        source_type: ActivityKind,
        source_id: UUID,
    ) -> ActivitySourceRecord: ...


class UnavailableActivitySourcePort:
    def query(self, **_) -> ActivitySourcePage:
        raise ApiError(
            503, "ACTIVITY_SOURCE_UNAVAILABLE", "Authorized A activity reads are not connected."
        )

    def get(self, **_) -> ActivitySourceRecord:
        raise ApiError(
            503, "ACTIVITY_SOURCE_UNAVAILABLE", "Authorized A activity reads are not connected."
        )


def get_activity_source_port() -> ActivitySourcePort:
    return UnavailableActivitySourcePort()
