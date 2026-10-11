"""pytest 夹具：隔离 PostgreSQL（真实迁移/约束/事务）+ 测试 OIDC + 邮件捕获。

只使用隔离测试库与测试提供方；不连接任何真实 Google/学校邮件服务。
"""
from __future__ import annotations

import os
import re
import sys
import uuid
from pathlib import Path

import psycopg
import pytest

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))

TEST_PG = "postgresql+psycopg://gp:gp_test_pw@localhost:55432"
TEST_DB = f"gp_test_{uuid.uuid4().hex[:8]}"

os.environ["APP_MODE"] = "dev"
os.environ["DATABASE_URL"] = f"{TEST_PG}/{TEST_DB}"
os.environ["MAIL_MODE"] = "capture"
os.environ["EMAIL_CHALLENGE_HMAC_KEY"] = "test-hmac-key"
os.environ["GOOGLE_CLIENT_ID"] = "test-client-id"
os.environ["GOOGLE_CLIENT_SECRET"] = "test-client-secret"
os.environ["GOOGLE_REDIRECT_URI"] = "http://localhost:8000/api/v1/auth/google/callback"
os.environ["BUSINESS_DATA_FILE"] = str(BASE / "tests" / "data" / "workspace.json")
os.environ["APP_ORIGIN"] = "http://localhost:3000"

from tests import oidc_stub  # noqa: E402

_stub: oidc_stub.StubProvider | None = None


@pytest.fixture(scope="session", autouse=True)
def _database():
    with psycopg.connect("postgresql://gp:gp_test_pw@localhost:55432/gp_test", autocommit=True) as conn:
        conn.execute(f'CREATE DATABASE "{TEST_DB}"')
    from alembic import command
    from alembic.config import Config

    os.environ["DATABASE_URL"] = f"{TEST_PG}/{TEST_DB}"
    cfg = Config(str(BASE / "alembic.ini"))
    command.upgrade(cfg, "head")
    yield
    from app.db import reset_engine

    reset_engine()  # 释放连接后再删除测试库
    with psycopg.connect("postgresql://gp:gp_test_pw@localhost:55432/gp_test", autocommit=True) as conn:
        conn.execute(f'DROP DATABASE IF EXISTS "{TEST_DB}"')


@pytest.fixture(scope="session", autouse=True)
def _oidc_stub():
    global _stub
    _stub = oidc_stub.StubProvider()
    _stub.start()
    from app.config import get_settings

    settings = get_settings()
    settings.google_discovery_url = _stub.discovery_url
    settings.google_expected_issuer = _stub.issuer
    # 测试默认放开发码频率限制（限流验收在 test_a20 内单独恢复）
    settings.resend_cooldown_seconds = 0
    settings.code_send_per_hour = 10_000
    settings.code_send_per_day = 10_000
    os.environ["GOOGLE_EXPECTED_ISSUER"] = _stub.issuer
    yield _stub
    _stub.stop()


@pytest.fixture()
def stub() -> oidc_stub.StubProvider:
    return _stub


@pytest.fixture(autouse=True)
def _clean_tables():
    from app.db import get_engine

    yield
    with get_engine().begin() as conn:
        tables = [
            "auth_audit_events",
            "auth_rate_limits",
            "email_outbox",
            "oauth_transactions",
            "academic_identity_checks",
            "auth_identities",
            "email_challenges",
            "school_email_bindings",
            "sessions",
            "teacher_applications",
            "password_credentials",
            "pre_registration_requests",
            "users",
        ]
        conn.exec_driver_sql(f"TRUNCATE {', '.join(tables)} RESTART IDENTITY CASCADE")
    from app.services.business import reset_business_cache

    reset_business_cache()


@pytest.fixture()
def db_session():
    from app.db import get_session_factory

    session = get_session_factory()()
    yield session
    session.rollback()
    session.close()


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app, base_url="http://localhost:8000", raise_server_exceptions=False) as test_client:
        yield test_client


def csrf_headers(context_csrf: str) -> dict[str, str]:
    return {"X-CSRF-Token": context_csrf, "Origin": "http://localhost:3000"}


def session_csrf(client) -> str:
    response = client.get("/api/v1/auth/session")
    body = response.json()
    assert body.get("authenticated") is True
    return body["csrfToken"]


def complete_oauth(client, stub, *, sub="google-sub-1", email="student1@student.must.edu.mo", name="测试用户", return_to=None, email_verified=True):
    """走真实 OAuth 协议路径（start → 签发 code → callback），返回 callback 响应。"""
    from urllib.parse import parse_qs, urlparse

    from app.db import get_session_factory
    from app.models import OAuthTransaction
    from app.security import token_digest
    from sqlalchemy import select

    params = {"returnTo": return_to} if return_to else {}
    start = client.get("/api/v1/auth/google/start", params=params, follow_redirects=False)
    assert start.status_code == 302, start.text
    location = start.headers["location"]
    query = parse_qs(urlparse(location).query)
    state = query["state"][0]

    db = get_session_factory()()
    try:
        transaction = db.execute(select(OAuthTransaction).where(OAuthTransaction.state_digest == token_digest(state))).scalar_one()
        code = stub.mint_code(
            state=state,
            nonce=transaction.nonce,
            code_verifier=transaction.code_verifier,
            sub=sub,
            email=email,
            email_verified=email_verified,
            name=name,
        )
    finally:
        db.close()
    return client.get("/api/v1/auth/google/callback", params={"code": code, "state": state}, follow_redirects=False)


def latest_code(to_email: str) -> str:
    from app.db import get_session_factory
    from app.models import EmailOutbox
    from sqlalchemy import select

    db = get_session_factory()()
    try:
        row = db.execute(
            select(EmailOutbox).where(EmailOutbox.to_email == to_email).order_by(EmailOutbox.id.desc())
        ).scalars().first()
        assert row is not None, f"未捕获发往 {to_email} 的邮件"
        match = re.search(r"验证码是 (\d{6})|驗證碼：(\d{6})|Code: (\d{6})|：(\d{6})（", row.body)
        assert match, f"邮件正文未找到验证码：{row.subject}"
        return next(g for g in match.groups() if g)
    finally:
        db.close()


def latest_email(to_email: str):
    """返回 (subject, body)；仅测试捕获器可读。"""
    from app.db import get_session_factory
    from app.models import EmailOutbox
    from sqlalchemy import select

    db = get_session_factory()()
    try:
        row = db.execute(
            select(EmailOutbox).where(EmailOutbox.to_email == to_email).order_by(EmailOutbox.id.desc())
        ).scalars().first()
        assert row is not None, f"未捕获发往 {to_email} 的邮件"
        return row.subject, row.body
    finally:
        db.close()


def latest_reset_token(to_email: str) -> str:
    _subject, body = latest_email(to_email)
    match = re.search(r"reset-password#token=([A-Za-z0-9_\-]+)", body)
    assert match, f"恢复邮件未找到令牌链接：{body[:80]}"
    return match.group(1)
