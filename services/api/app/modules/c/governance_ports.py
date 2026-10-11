"""A-owned visibility and enforcement ports. Defaults must never approve access.

Activation must use the supplied Session/transaction, honor its stable command ID,
and enforce expiry and revocation on every actual content access. Adapters must not
commit or perform irreversible remote side effects. Remote A services require a
separate durable coordination protocol before they can satisfy this contract.
"""

from dataclasses import dataclass
from datetime import datetime
from typing import Protocol
from uuid import UUID

from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.modules.c.governance_schemas import AccessScope


@dataclass(frozen=True)
class VisibleAccessTarget:
    applicant_id: UUID
    scope: AccessScope


@dataclass(frozen=True)
class AuthorizationReceipt:
    grant_id: UUID
    request_id: UUID
    applicant_id: UUID
    scope: AccessScope
    expires_at: datetime


class AuthorizationPort(Protocol):
    def visible_target(
        self, session: Session, *, applicant_id: UUID, scope: AccessScope
    ) -> VisibleAccessTarget: ...

    def activate(
        self,
        session: Session,
        *,
        request_id: UUID,
        applicant_id: UUID,
        reviewer_id: UUID,
        scope: AccessScope,
        expires_at: datetime,
        command_id: UUID,
    ) -> AuthorizationReceipt: ...


class UnavailableAuthorizationPort:
    def visible_target(self, session: Session, **_) -> VisibleAccessTarget:
        raise ApiError(
            503, "ACCESS_VISIBILITY_UNAVAILABLE", "Authorized target discovery is not connected."
        )

    def activate(self, session: Session, **_) -> AuthorizationReceipt:
        raise ApiError(
            503, "ACCESS_AUTHORIZATION_UNAVAILABLE", "A access enforcement is not connected."
        )


def get_authorization_port() -> AuthorizationPort:
    return UnavailableAuthorizationPort()
