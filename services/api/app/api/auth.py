from __future__ import annotations

import os
from uuid import UUID

from fastapi import Depends, Header
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import User
from app.db.session import get_session


def demo_auth_enabled() -> bool:
    """Keep the temporary identity header unavailable outside explicit local runs."""

    return (
        os.getenv("APP_ENV", "production").lower() in {"development", "test"}
        and os.getenv("ENABLE_DEMO_AUTH", "false").lower() == "true"
    )


def get_current_user(
    demo_user_id: UUID | None = Header(default=None, alias="X-Demo-User-Id"),
    session: Session = Depends(get_session),
) -> User:
    """Temporary A2 actor dependency; A3 replaces this with verified sessions."""

    if not demo_auth_enabled() or demo_user_id is None:
        raise ApiError(401, "UNAUTHENTICATED", "Authentication is required.")

    user = session.get(User, demo_user_id)
    if user is None:
        raise ApiError(401, "UNAUTHENTICATED", "Authentication is required.")
    if user.status != "active":
        raise ApiError(403, "ACCOUNT_INACTIVE", "The account is not active.")
    return user
