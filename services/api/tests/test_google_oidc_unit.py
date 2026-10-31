from __future__ import annotations

import httpx
import pytest

from app.auth.config import get_settings
from app.auth.errors import AppError
from app.auth.services import google_oidc


@pytest.fixture(autouse=True)
def google_settings(monkeypatch):
    monkeypatch.setenv("APP_MODE", "dev")
    monkeypatch.setenv("APP_ORIGIN", "http://localhost:3000")
    monkeypatch.setenv("DATABASE_URL", "postgresql://test:test@localhost/test")
    monkeypatch.setenv("EMAIL_CHALLENGE_HMAC_KEY", "test-key")
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "test-client")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "test-secret")
    monkeypatch.setenv("GOOGLE_REDIRECT_URI", "http://localhost:3000/api/v1/auth/google/callback")
    monkeypatch.setenv(
        "GOOGLE_DISCOVERY_URL", "https://accounts.google.invalid/.well-known/openid-configuration"
    )
    monkeypatch.setenv("GOOGLE_EXPECTED_ISSUER", "https://accounts.google.invalid")
    get_settings.cache_clear()
    google_oidc.reset_discovery_cache()
    yield
    google_oidc.reset_discovery_cache()
    get_settings.cache_clear()


def test_discovery_network_failure_is_auth_unavailable(monkeypatch):
    def fail(*_args, **_kwargs):
        raise httpx.ConnectError("provider offline")

    monkeypatch.setattr(google_oidc.httpx, "get", fail)

    with pytest.raises(AppError) as error:
        google_oidc._discovery()

    assert error.value.code == "AUTH_UNAVAILABLE"
    assert error.value.status == 503


def test_token_exchange_network_failure_is_auth_unavailable(monkeypatch):
    class OfflineClient:
        token = {}

        def __init__(self, **_kwargs):
            pass

        def fetch_token(self, *_args, **_kwargs):
            raise httpx.ConnectError("provider offline")

    monkeypatch.setattr(google_oidc, "OAuth2Client", OfflineClient)
    monkeypatch.setattr(google_oidc, "_discovery", lambda: {"token_endpoint": "https://token.test"})

    with pytest.raises(AppError) as error:
        google_oidc.exchange_and_verify(
            type("Transaction", (), {"code_verifier": "verifier", "nonce": "nonce"})(),
            "authorization-code",
        )

    assert error.value.code == "AUTH_UNAVAILABLE"
    assert error.value.status == 503


def test_jwks_network_failure_is_auth_unavailable(monkeypatch):
    monkeypatch.setattr(google_oidc, "_discovery", lambda: {"jwks_uri": "https://jwks.test"})

    def fail(*_args, **_kwargs):
        raise httpx.ConnectError("provider offline")

    monkeypatch.setattr(google_oidc.httpx, "get", fail)

    with pytest.raises(AppError) as error:
        google_oidc.verify_id_token("not-a-token", "expected-nonce")

    assert error.value.code == "AUTH_UNAVAILABLE"
    assert error.value.status == 503


@pytest.mark.parametrize(
    ("audience", "authorized_party", "expected"),
    [
        ("test-client", None, True),
        (["test-client"], None, True),
        (["test-client", "other-client"], "test-client", True),
        (["test-client", "other-client"], None, False),
        (["test-client", "other-client"], "other-client", False),
        ("test-client", "other-client", False),
        (["other-client"], "test-client", False),
    ],
)
def test_audience_and_authorized_party_validation(audience, authorized_party, expected):
    audience_valid = google_oidc._valid_audience(audience, "test-client")
    authorized_party_valid = google_oidc._valid_authorized_party(
        audience, authorized_party, "test-client"
    )

    assert (audience_valid and authorized_party_valid) is expected
