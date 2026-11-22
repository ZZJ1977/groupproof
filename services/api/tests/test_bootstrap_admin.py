"""Tests for controlled admin provisioning (password, Google OIDC, idempotent promotion)."""

from __future__ import annotations

import os
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from sqlalchemy import JSON, DefaultClause, MetaData, create_engine, event, select, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapper, Session
from sqlalchemy.pool import StaticPool

from app.auth.models import AuthAuditEvent, AuthIdentity, PasswordCredential, SchoolEmailBinding
from app.auth.security import verify_password
from app.auth.services.bootstrap import bootstrap_admin
from app.auth.services.registration import can_enter_workspace, derive_facts
from app.db.base import Base
from app.db.models import User
from tests.b_fixtures import b_postgres_schema, b_test_database_url

_MODELS = (AuthAuditEvent, AuthIdentity, PasswordCredential, SchoolEmailBinding, User)


@pytest.fixture
def engine(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("TEACHER_EMAIL_DOMAIN", "must.edu.mo")
    if os.getenv("B_TEST_DATABASE_URL"):
        with b_postgres_schema(b_test_database_url()) as pg_engine:
            yield pg_engine
        return

    sqlite_engine = create_engine(
        "sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False}
    )

    @event.listens_for(sqlite_engine, "connect")
    def enforce_fk(conn, _):
        conn.execute("PRAGMA foreign_keys=ON")
        conn.create_function("gen_random_uuid", 0, lambda: uuid4().hex)
        conn.create_function("to_regclass", 1, lambda _name: None)

    def ensure_tz(target, *_args):
        for key, val in list(vars(target).items()):
            if isinstance(val, datetime) and val.tzinfo is None:
                setattr(target, key, val.replace(tzinfo=UTC))

    event.listen(Mapper, "load", ensure_tz)
    event.listen(Mapper, "refresh", ensure_tz)

    metadata = MetaData()
    for table in Base.metadata.sorted_tables:
        portable = table.to_metadata(metadata)
        for column in portable.columns:
            if isinstance(column.type, JSONB):
                column.type = JSON()
            if (
                column.server_default is not None
                and str(column.server_default.arg) == "gen_random_uuid()"
            ):
                column.server_default = DefaultClause(text("(gen_random_uuid())"))
    metadata.create_all(sqlite_engine)
    try:
        yield sqlite_engine
    finally:
        event.remove(Mapper, "load", ensure_tz)
        event.remove(Mapper, "refresh", ensure_tz)
        sqlite_engine.dispose()


def test_bootstrap_admin_with_password_and_idempotent_promotion(engine):
    with Session(engine) as session:
        admin = bootstrap_admin(
            session,
            name="系统管理员",
            username="sysadmin",
            school_email="sysadmin@must.edu.mo",
            password="Admin-Strong-Password-2026!",
        )
        assert admin.global_role == "admin"
        assert admin.status == "active"

        cred = session.get(PasswordCredential, admin.id)
        binding = session.get(SchoolEmailBinding, admin.id)
        assert cred is not None
        assert cred.login_email_verified_at is not None
        assert verify_password("Admin-Strong-Password-2026!", cred.password_hash)
        assert binding is not None and binding.verified_at is not None

        facts = derive_facts(admin, binding, [], [], credential=cred)
        assert facts["accountState"] == "active"
        assert can_enter_workspace(facts, "password") is True

        # Idempotent re-run updates password and links Google OIDC without duplicating user
        promoted = bootstrap_admin(
            session,
            name="系统管理员（更新）",
            username="sysadmin",
            school_email="sysadmin@must.edu.mo",
            password="Admin-Rotated-Password-2026!",
            google_subject="google-sub-admin-01",
        )
        assert promoted.id == admin.id
        assert promoted.name == "系统管理员（更新）"
        cred_after = session.get(PasswordCredential, admin.id)
        assert cred_after is not None and cred_after.credential_version == 2
        assert verify_password("Admin-Rotated-Password-2026!", cred_after.password_hash)
        ident = session.scalar(select(AuthIdentity).where(AuthIdentity.user_id == admin.id))
        assert ident is not None and ident.subject == "google-sub-admin-01"
