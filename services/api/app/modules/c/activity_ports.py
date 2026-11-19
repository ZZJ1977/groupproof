"""A-owned authorized source reads. No credentials or browser source payloads.

The adapter must query its canonical, authorized ingestion store, apply the exact
filters before pagination, and order by occurred_at DESC then id ASC. Failures or
partial upstream results must raise 503, not return an apparently empty page.
"""

from dataclasses import dataclass, replace
from datetime import UTC, datetime
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
    searched_full_text: bool = False


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


def github_record(record: ActivitySourceRecord) -> ActivitySourceRecord:
    # A returns its activity row ID as a source reference. Shared SourceReference
    # is a different table; evidence keeps the activity UUID as its source_id.
    source = record.source
    return replace(
        record,
        occurred_at=record.occurred_at
        if record.occurred_at.tzinfo
        else record.occurred_at.replace(tzinfo=UTC),
        source=replace(source, source_reference_id=None)
        if source.source_reference_id == record.id
        else source,
    )


class GithubActivityPort:
    def __init__(self, upstream: ActivitySourcePort):
        self.upstream = upstream

    def get(self, **kwargs):
        return github_record(self.upstream.get(**kwargs))

    def query(self, **kwargs):
        page = self.upstream.query(**kwargs)
        return replace(page, items=tuple(github_record(row) for row in page.items))


def get_activity_source_port() -> ActivitySourcePort:
    """飞书和 GitHub 来源都由 A 的只读快照提供，按来源类型分发。"""
    from app.db.session import SessionLocal
    from app.modules.a.feishu import feishu_activity_port
    from app.modules.a.github_activity import CompositeActivityPort, DatabaseGithubActivityPort
    from app.modules.c.feishu_activity import FeishuActivityPort

    return CompositeActivityPort(
        FeishuActivityPort(feishu_activity_port(SessionLocal)),
        GithubActivityPort(DatabaseGithubActivityPort(SessionLocal)),
    )
