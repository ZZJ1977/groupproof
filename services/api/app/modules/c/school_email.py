"""Read A's current school-email proof, never the legacy users timestamp.

A owns verification and domain approval. C validates the stored proof's shape and
current address; a pending replacement deliberately keeps A's existing verified
binding until A replaces or revokes it. There is no production legacy fallback.
"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.models import SchoolEmailBinding
from app.auth.security import check_email_format
from app.db.models import User


def school_email_binding_verified(binding: SchoolEmailBinding | None) -> bool:
    if binding is None or binding.verified_at is None or not binding.school_email:
        return False
    try:
        normalized = check_email_format(binding.school_email)
    except (TypeError, ValueError):
        return False
    return binding.school_email_normalized == normalized


def has_verified_school_email(session: Session, user: User, *, lock: bool = False) -> bool:
    # Fresh SELECT avoids a cached relationship surviving a revocation in another
    # transaction. SHARE prevents a verified binding changing during a C write.
    statement = select(SchoolEmailBinding).where(SchoolEmailBinding.user_id == user.id)
    if lock:
        statement = statement.with_for_update(read=True)
    binding = session.scalar(statement.execution_options(populate_existing=True))
    return school_email_binding_verified(binding)
