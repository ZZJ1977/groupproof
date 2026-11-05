"""Ports B calls on other modules' behalf, with safe defaults until they land.

See docs/B_INTERFACES.md for the agreed signatures.

* ``MaterialTextPort`` — A4-05 (file text extraction). Used by B3-04 to show the
  text of an uploaded project material. Nothing implements it yet, so the default
  reports ``unavailable`` and B shows "正文提取不可用"; it never invents text.
* ``VerificationPort`` — D. Used by B5-02 (invalidate old criterion results when
  an accepted task's criteria change, D1-07) and B7-03 (are a milestone's tasks
  verified?). D exposes no API yet, so the default refuses: B must never treat
  "unknown" as "verified".
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Literal, Protocol
from uuid import UUID

from sqlalchemy.orm import Session

from app.api.errors import ApiError

ExtractStatus = Literal["ready", "pending", "failed", "unavailable"]
VerificationState = Literal["not_submitted", "in_review", "passed", "failed", "invalidated"]


# ---------------------------------------------------------------------------
# A4-05: material text
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TextSegment:
    """One addressable paragraph; ``segment_id`` is stable for a given receipt."""

    segment_id: str
    text: str


@dataclass(frozen=True)
class MaterialText:
    receipt_id: UUID
    status: ExtractStatus
    segments: tuple[TextSegment, ...] = ()
    # Human-readable reason for failed/unavailable, safe to show in the page.
    reason: str | None = None

    @property
    def text(self) -> str:
        return "\n\n".join(segment.text for segment in self.segments)


class MaterialTextPort(Protocol):
    def get_text(self, session: Session, *, receipt_id: UUID, actor_id: UUID) -> MaterialText:
        """Return extracted text for a completed A4-04 upload receipt.

        Must authorize ``actor_id`` against the receipt's scope and raise
        ``ApiError(404, "NOT_FOUND")`` for receipts the actor cannot read.
        """
        ...


class UnavailableMaterialTextPort:
    def get_text(self, session: Session, *, receipt_id: UUID, actor_id: UUID) -> MaterialText:
        return MaterialText(
            receipt_id=receipt_id,
            status="unavailable",
            reason="正文提取服务暂未接入",
        )


# ---------------------------------------------------------------------------
# D: verification
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class InvalidationOutcome:
    """Whether D accepted the invalidation. ``accepted=False`` means B must keep
    the request pending (outbox) and must not report the old result as void."""

    task_id: UUID
    accepted: bool
    invalidated_result_ids: tuple[UUID, ...] = ()
    reason: str | None = None


@dataclass(frozen=True)
class TaskVerificationStatus:
    task_id: UUID
    state: VerificationState
    # Criterion IDs still lacking a passing result; empty when state == "passed".
    missing_criterion_ids: tuple[UUID, ...] = field(default_factory=tuple)


def verification_unavailable() -> ApiError:
    return ApiError(503, "VERIFICATION_UNAVAILABLE", "验收服务暂不可用，请稍后重试。")


class VerificationPort(Protocol):
    def invalidate_criterion_results(
        self,
        session: Session,
        *,
        task_id: UUID,
        criterion_ids: Sequence[UUID],
        reason: str,
        actor_id: UUID,
    ) -> InvalidationOutcome:
        """D1-07: void results for the given criteria because the task changed.

        Runs in the caller's transaction; must be idempotent per
        (task_id, criterion_id, task content_version).
        """
        ...

    def task_verification_status(
        self, session: Session, *, task_ids: Sequence[UUID]
    ) -> Mapping[UUID, TaskVerificationStatus]:
        """Return one status for every requested task, or raise
        ``verification_unavailable()``; never omit a task silently."""
        ...


class UnavailableVerificationPort:
    def invalidate_criterion_results(
        self,
        session: Session,
        *,
        task_id: UUID,
        criterion_ids: Sequence[UUID],
        reason: str,
        actor_id: UUID,
    ) -> InvalidationOutcome:
        return InvalidationOutcome(task_id=task_id, accepted=False, reason="验收服务暂不可用")

    def task_verification_status(
        self, session: Session, *, task_ids: Sequence[UUID]
    ) -> Mapping[UUID, TaskVerificationStatus]:
        raise verification_unavailable()


def get_material_text_port() -> MaterialTextPort:
    """FastAPI dependency; A replaces the default once A4-05 exists."""
    return UnavailableMaterialTextPort()


def get_verification_port() -> VerificationPort:
    """FastAPI dependency; D replaces the default once its API exists."""
    return UnavailableVerificationPort()
