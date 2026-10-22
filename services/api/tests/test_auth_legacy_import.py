"""旧认证数据导入测试（PLAN 二、2：映射幂等、冲突暂停、凭据保留）。"""

from __future__ import annotations

import os
import uuid
from collections.abc import Generator
from datetime import UTC, datetime

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

os.environ.setdefault("APP_MODE", "dev")

from app.auth.legacy_import import LegacyUserRow, import_legacy_users  # noqa: E402
from app.auth.models import AuthLegacyIdMap, PasswordCredential, SchoolEmailBinding  # noqa: E402
from app.db.models import User  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402


@pytest.fixture()
def db() -> Generator[Session, None, None]:
    if not os.getenv("DATABASE_URL"):
        pytest.skip("set DATABASE_URL to run PostgreSQL integration tests")
    session = SessionLocal()
    yield session
    session.rollback()
    session.close()


def _legacy_row(suffix: str) -> LegacyUserRow:
    now = datetime.now(UTC)
    email = f"legacy-{suffix}@test.example"
    return LegacyUserRow(
        user={
            "id": f"legacy-{suffix}",
            "name": "Legacy User",
            "username": f"legacy-{suffix}",
            "username_normalized": f"legacy-{suffix}",
            "email": email,
            "student_id": f"L-{suffix}",
            "college": "FST",
            "requested_identity": "student",
            "roles": ["student", "teacher"],
            "account_status": "enabled",
            "auth_version": 2,
            "last_login_at": now,
        },
        credential={
            "user_id": f"legacy-{suffix}",
            "login_email": email,
            "login_email_normalized": email,
            "login_email_verified_at": now,
            "credential_version": 3,
            "password_hash": "$argon2id$v=19$m=19456,t=2,p=1$legacy-hash",
            "password_algo": "argon2id",
        },
        email_binding={
            "user_id": f"legacy-{suffix}",
            "school_email": f"{suffix}@student.must.edu.mo",
            "school_email_normalized": f"{suffix}@student.must.edu.mo",
            "verified_at": now,
            "verification_method": "email_code",
        },
        audit_events=[{"event_type": "auth.password_login", "result": "success"}],
    )


def test_import_preserves_credentials_roles_and_is_idempotent(db: Session) -> None:
    suffix = uuid.uuid4().hex[:8]
    row = _legacy_row(suffix)

    preview = import_legacy_users(db, source="test-legacy", rows=[row], dry_run=True)
    assert preview.created == [f"legacy-{suffix}"]
    assert db.execute(select(User).where(User.username == f"legacy-{suffix}")).first() is None

    report = import_legacy_users(db, source="test-legacy", rows=[row], dry_run=False)
    db.commit()
    assert report.created == [f"legacy-{suffix}"]

    user = db.execute(select(User).where(User.username == f"legacy-{suffix}")).scalar_one()
    # 旧 roles 数组映射到单一 global_role（优先级 admin > ta > teacher > student）
    assert user.global_role == "teacher"
    assert user.status == "active"
    assert user.auth_version == 2

    credential = db.get(PasswordCredential, user.id)
    assert credential is not None
    assert credential.password_hash == "$argon2id$v=19$m=19456,t=2,p=1$legacy-hash"
    assert credential.credential_version == 3

    binding = db.get(SchoolEmailBinding, user.id)
    assert binding is not None
    assert binding.school_email_normalized == f"{suffix}@student.must.edu.mo"

    mapping = db.execute(
        select(AuthLegacyIdMap).where(AuthLegacyIdMap.legacy_id == f"legacy-{suffix}")
    ).scalar_one()
    assert mapping.user_id == user.id

    # 幂等：重复导入跳过，不重复建档
    again = import_legacy_users(db, source="test-legacy", rows=[row], dry_run=False)
    db.commit()
    assert again.created == []
    assert again.skipped_existing == [f"legacy-{suffix}"]


def test_conflicting_account_is_paused_not_merged(db: Session) -> None:
    suffix = uuid.uuid4().hex[:8]
    row = _legacy_row(suffix)
    import_legacy_users(db, source="test-legacy", rows=[row], dry_run=False)
    db.commit()

    duplicate = _legacy_row(uuid.uuid4().hex[:8])
    # 与已导入账号共用同一规范用户名 → 冲突，暂停该账号导入
    duplicate.user["username_normalized"] = row.user["username_normalized"]
    report = import_legacy_users(db, source="test-legacy", rows=[duplicate], dry_run=False)
    db.commit()

    assert report.created == []
    assert report.conflicts and report.conflicts[0]["field"] == "username_normalized"
    assert (
        db.execute(select(User).where(User.username == duplicate.user["username"])).first() is None
    )
