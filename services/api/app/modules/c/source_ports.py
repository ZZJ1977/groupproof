"""Verified source boundary. Default external adapters fail closed with 503.

A must provide project-scoped, authorized, completed file versions. GitHub
and Feishu adapters must validate their connection/event ownership and return
immutable revisions. Browser-supplied hashes, titles or URLs are not proof.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol
from uuid import UUID

from app.api.errors import ApiError


@dataclass(frozen=True)
class VerifiedSource:
    project_id: UUID
    source_type: str
    identity: str
    revision: str
    content: dict
    source_url: str | None = None
    source_reference_id: UUID | None = None
    availability: Literal["available", "deleted"] = "available"


class SourcePort(Protocol):
    def resolve(
        self, *, project_id: UUID, actor_id: UUID, source_type: str, source_id: UUID
    ) -> VerifiedSource:
        """Return only an authorized source in this project.

        Verified deletion returns availability='deleted', unchanged identity and
        a trustworthy deletion revision. Network/access failures raise 503 and
        must never be represented as a deletion.
        """
        ...


class UnavailableSourcePort:
    def resolve(
        self, *, project_id: UUID, actor_id: UUID, source_type: str, source_id: UUID
    ) -> VerifiedSource:
        code = (
            "FILE_STORAGE_UNAVAILABLE"
            if source_type in {"file", "screenshot"}
            else ("EXTERNAL_SOURCE_UNAVAILABLE")
        )
        raise ApiError(
            503,
            code,
            "The verified source adapter is not connected.",
            {
                "source_type": source_type,
            },
        )


def get_source_port() -> SourcePort:
    """Replace through explicit application wiring when an adapter is available."""
    return UnavailableSourcePort()
