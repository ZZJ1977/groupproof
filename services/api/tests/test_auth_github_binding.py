"""Personal GitHub OAuth with real GroupProof sessions and a stubbed GitHub transport."""

from __future__ import annotations

import base64
import hashlib
from datetime import timedelta
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
import test_auth_flows
from fastapi.testclient import TestClient
from sqlalchemy import update
from test_auth_flows import _register_account

from app.auth.config import Settings, get_settings
from app.auth.models import GithubLinkTransaction, OAuthTransaction, Session, utcnow
from app.auth.security import token_digest
from app.auth.services import github_oauth, google_oidc
from app.db.session import SessionLocal

client = test_auth_flows.client

ORIGIN = "http://localhost:3000"
IDENTITY = "/api/v1/me/identities/github"
CALLBACK = "/api/v1/auth/github/callback"


def _registered_client(client: TestClient) -> tuple[str, str, dict]:
    email, password = _register_account(client)
    session = client.get("/api/v1/auth/session").json()["data"]
    return email, password, {"Origin": ORIGIN, "X-CSRF-Token": session["csrfToken"]}


def test_github_binding_is_unavailable_without_provider_credentials(
    client: TestClient, monkeypatch
):
    monkeypatch.setenv("GITHUB_OAUTH_CLIENT_ID", "")
    monkeypatch.setenv("GITHUB_OAUTH_CLIENT_SECRET", "")
    assert client.get(IDENTITY).status_code == 401
    _, _, headers = _registered_client(client)
    response = client.get(IDENTITY)
    assert response.status_code == 200
    assert response.json()["data"] == {"available": False, "login": None, "verifiedAt": None}
    assert client.post(f"{IDENTITY}/link", headers=headers).status_code == 503
    assert client.get("/api/v1/auth/session").json()["data"]["authMethod"] == "password"


@pytest.mark.parametrize(
    ("origin", "available"),
    [
        (ORIGIN, True),
        ("https://staging.example.edu", True),
        ("http://staging.example.edu", False),
        ("https://staging.example.edu/path", False),
    ],
)
def test_github_callback_uses_only_the_configured_web_origin(origin, available):
    settings = Settings(
        _env_file=None,
        app_origin=origin,
        github_oauth_client_id="test-github-client",
        github_oauth_client_secret="test-github-secret",
    )
    assert github_oauth.callback_url(settings) == (origin + CALLBACK if available else None)


@pytest.fixture()
def github(monkeypatch):
    monkeypatch.setenv("GITHUB_OAUTH_CLIENT_ID", "test-github-client")
    monkeypatch.setenv("GITHUB_OAUTH_CLIENT_SECRET", "test-github-secret")
    get_settings.cache_clear()
    calls = []
    identity = {"id": 987654321, "login": "Campus-Student"}
    expected_challenge = []

    def respond(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url == "https://github.com/login/oauth/access_token":
            assert request.method == "POST"
            posted = parse_qs(request.content.decode())
            assert posted["client_id"] == ["test-github-client"]
            assert posted["client_secret"] == ["test-github-secret"]
            assert posted["redirect_uri"] == [ORIGIN + CALLBACK]
            assert posted["code"] == ["test-code"]
            digest = hashlib.sha256(posted["code_verifier"][0].encode()).digest()
            challenge = base64.urlsafe_b64encode(digest).decode().rstrip("=")
            assert challenge == expected_challenge[-1]
            return httpx.Response(
                200, json={"access_token": "test-user-token", "token_type": "bearer", "scope": ""}
            )
        assert request.method == "GET" and request.url == "https://api.github.com/user"
        assert request.headers["authorization"] == "Bearer test-user-token"
        return httpx.Response(200, json=identity)

    monkeypatch.setattr(
        github_oauth, "_client", lambda: httpx.Client(transport=httpx.MockTransport(respond))
    )
    try:
        yield expected_challenge, calls, identity
    finally:
        get_settings.cache_clear()


def _begin(client: TestClient, headers: dict, challenges: list) -> str:
    response = client.post(f"{IDENTITY}/link", headers=headers)
    assert response.status_code == 200, response.text
    authorization = urlsplit(response.json()["data"]["authorizeUrl"])
    assert (authorization.scheme, authorization.netloc, authorization.path) == (
        "https",
        "github.com",
        "/login/oauth/authorize",
    )
    query = parse_qs(authorization.query, keep_blank_values=True)
    assert query["redirect_uri"] == [ORIGIN + CALLBACK]
    assert query["code_challenge_method"] == ["S256"]
    assert query.get("scope", [""]) == [""]
    challenges.append(query["code_challenge"][0])
    return query["state"][0]


def _finish(client: TestClient, state: str, **parameters: str) -> str:
    response = client.get(CALLBACK, params={"state": state, **parameters}, follow_redirects=False)
    assert response.status_code == 302
    assert response.headers.get("Cache-Control") == "private, no-store"
    return response.headers["location"]


def test_github_oauth_binds_provider_identity_once_and_can_unlink(client: TestClient, github):
    challenges, calls, _ = github
    _, _, headers = _registered_client(client)
    assert client.post(f"{IDENTITY}/link").status_code == 403
    assert (
        client.post(
            f"{IDENTITY}/link", headers={**headers, "Origin": "https://example.test"}
        ).status_code
        == 403
    )
    state = _begin(client, headers, challenges)
    assert _finish(client, state, code="test-code") == "/account/security?github=linked"
    binding = client.get(IDENTITY).json()["data"]
    assert binding["login"] == "campus-student" and binding["verifiedAt"]
    assert client.get("/api/v1/auth/session").json()["data"]["authMethod"] == "password"
    assert _finish(client, state, code="test-code") == "/account/security?github=failed"
    assert len(calls) == 2
    assert client.delete(IDENTITY).status_code == 403
    assert client.delete(IDENTITY, headers=headers).status_code == 204
    assert client.get(IDENTITY).json()["data"]["login"] is None


def test_github_state_only_works_in_initiating_session_and_can_be_cancelled(
    client: TestClient, github
):
    challenges, calls, _ = github
    email, password, headers = _registered_client(client)
    state = _begin(client, headers, challenges)
    with TestClient(client.app) as other_session:
        assert (
            other_session.post(
                "/api/v1/auth/password/login", json={"identifier": email, "password": password}
            ).status_code
            == 200
        )
        assert _finish(other_session, state, code="test-code") == "/account/security?github=failed"
    assert _finish(client, state, error="access_denied") == "/account/security?github=cancelled"
    assert _finish(client, state, code="test-code") == "/account/security?github=failed"
    assert not calls


def test_same_verified_github_id_cannot_bind_to_a_second_group_proof_user(
    client: TestClient, github
):
    challenges, _, _ = github
    _, _, headers = _registered_client(client)
    assert (
        _finish(client, _begin(client, headers, challenges), code="test-code")
        == "/account/security?github=linked"
    )
    with TestClient(client.app) as second:
        _, _, other_headers = _registered_client(second)
        assert (
            _finish(second, _begin(second, other_headers, challenges), code="test-code")
            == "/account/security?github=conflict"
        )
        assert second.get(IDENTITY).json()["data"]["login"] is None
    assert client.get(IDENTITY).json()["data"]["login"] == "campus-student"
    assert client.delete(IDENTITY, headers=headers).status_code == 204


def test_github_rejects_google_and_expired_state_without_calling_provider(
    client: TestClient, github
):
    challenges, calls, _ = github
    _, _, headers = _registered_client(client)
    github_state = _begin(client, headers, challenges)
    with SessionLocal.begin() as db:
        google_state, _ = google_oidc.create_transaction(db, None)
        assert google_oidc.transaction_purpose(db, github_state) is None
        db.execute(
            update(GithubLinkTransaction)
            .where(GithubLinkTransaction.state_digest == token_digest(github_state))
            .values(expires_at=utcnow() - timedelta(seconds=1))
        )

    assert _finish(client, google_state, code="test-code") == "/account/security?github=failed"
    with SessionLocal() as db:
        assert db.get(OAuthTransaction, token_digest(google_state)).consumed_at is None
    assert _finish(client, github_state, code="test-code") == "/account/security?github=failed"
    assert not calls


def test_github_mutations_require_recent_authentication(client: TestClient, github):
    _, _, headers = _registered_client(client)
    with SessionLocal.begin() as db:
        db.execute(
            update(Session)
            .where(Session.csrf_token == headers["X-CSRF-Token"])
            .values(authenticated_at=utcnow() - timedelta(hours=1))
        )
    for response in (
        client.post(f"{IDENTITY}/link", headers=headers),
        client.delete(IDENTITY, headers=headers),
    ):
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "REAUTH_REQUIRED"


def test_unlink_wins_while_github_identity_exchange_is_in_flight(
    client: TestClient, github, monkeypatch
):
    challenges, _, _ = github
    _, _, headers = _registered_client(client)
    state = _begin(client, headers, challenges)

    def unlink_during_exchange(*args, **kwargs):
        assert client.delete(IDENTITY, headers=headers).status_code == 204
        return 987654321, "campus-student"

    monkeypatch.setattr(github_oauth, "fetch_verified_identity", unlink_during_exchange)
    assert _finish(client, state, code="test-code") == "/account/security?github=failed"
    assert client.get(IDENTITY).json()["data"]["login"] is None


def test_invalid_github_profile_does_not_bind_and_can_retry(client: TestClient, github):
    challenges, calls, profile = github
    _, _, headers = _registered_client(client)
    profile["id"] = True
    state = _begin(client, headers, challenges)
    assert _finish(client, state, code="test-code") == "/account/security?github=failed"
    assert _finish(client, state, code="test-code") == "/account/security?github=failed"
    assert len(calls) == 2
    assert client.get(IDENTITY).json()["data"]["login"] is None
    profile["id"] = 987654321
    state = _begin(client, headers, challenges)
    assert _finish(client, state, code="test-code") == "/account/security?github=linked"
    assert client.delete(IDENTITY, headers=headers).status_code == 204
