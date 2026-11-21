"""Verify personal GitHub account ownership through a dedicated OAuth App."""

from __future__ import annotations

import base64
import hashlib
import re
from datetime import timedelta
from urllib.parse import urlencode, urlsplit
from uuid import UUID

import httpx
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session as DbSession

from ..config import Settings
from ..models import GithubLinkTransaction, VerifiedGithubIdentity, utcnow
from ..security import new_token, token_digest

CALLBACK_PATH = "/api/v1/auth/github/callback"
AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
TOKEN_URL = "https://github.com/login/oauth/access_token"
USER_URL = "https://api.github.com/user"
GITHUB_LOGIN = re.compile(r"[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*")
BEARER_TOKEN = re.compile(r"[A-Za-z0-9._~+/\-]+=*")
TRANSACTION_TTL = timedelta(minutes=5)


class GithubVerificationError(Exception):
    pass


def callback_url(settings: Settings) -> str | None:
    if not (
        settings.github_oauth_client_id.strip() and settings.github_oauth_client_secret.strip()
    ):
        return None
    origin = settings.app_origin
    try:
        parsed = urlsplit(origin)
        if not parsed.hostname or parsed.username is not None:
            return None
        if parsed.port == 0 or origin != f"{parsed.scheme}://{parsed.netloc}":
            return None
        if parsed.scheme == "https" or (
            parsed.scheme == "http"
            and not settings.is_real
            and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        ):
            return origin + CALLBACK_PATH
    except ValueError:
        return None
    return None


def begin_link(
    db: DbSession, *, user_id: UUID, session_id: str, client_id: str, redirect_uri: str
) -> str:
    state = new_token()
    code_verifier = new_token()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(code_verifier.encode()).digest())
    values = {
        "session_id": session_id,
        "state_digest": token_digest(state),
        "code_verifier": code_verifier,
        "expires_at": utcnow() + TRANSACTION_TTL,
    }
    db.execute(
        insert(GithubLinkTransaction)
        .values(user_id=user_id, **values)
        .on_conflict_do_update(index_elements=["user_id"], set_=values)
    )
    query = urlencode(
        {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "state": state,
            "scope": "",
            "code_challenge": challenge.decode().rstrip("="),
            "code_challenge_method": "S256",
        }
    )
    return f"{AUTHORIZE_URL}?{query}"


def lock_link(
    db: DbSession, *, user_id: UUID, session_id: str, state: str
) -> GithubLinkTransaction | None:
    return db.scalar(
        select(GithubLinkTransaction)
        .where(
            GithubLinkTransaction.user_id == user_id,
            GithubLinkTransaction.session_id == session_id,
            GithubLinkTransaction.state_digest == token_digest(state),
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )


def _client() -> httpx.Client:
    return httpx.Client(timeout=10.0, follow_redirects=False)


def fetch_verified_identity(
    settings: Settings, *, code: str, code_verifier: str, redirect_uri: str
) -> tuple[int, str]:
    try:
        with _client() as client:
            token_data = (
                client.post(
                    TOKEN_URL,
                    headers={"Accept": "application/json"},
                    data={
                        "client_id": settings.github_oauth_client_id,
                        "client_secret": settings.github_oauth_client_secret,
                        "code": code,
                        "redirect_uri": redirect_uri,
                        "code_verifier": code_verifier,
                    },
                )
                .raise_for_status()
                .json()
            )
            token = token_data.get("access_token") if isinstance(token_data, dict) else None
            if not isinstance(token, str) or not BEARER_TOKEN.fullmatch(token):
                raise GithubVerificationError
            if token_data.get("error") or token_data.get("scope"):
                raise GithubVerificationError
            profile = (
                client.get(
                    USER_URL,
                    headers={
                        "Accept": "application/vnd.github+json",
                        "Authorization": f"Bearer {token}",
                    },
                )
                .raise_for_status()
                .json()
            )
    except (httpx.HTTPError, ValueError):
        raise GithubVerificationError from None

    if not isinstance(profile, dict):
        raise GithubVerificationError
    account_id, login = profile.get("id"), profile.get("login")
    if type(account_id) is not int or not (1 <= account_id < 2**63):
        raise GithubVerificationError
    if not isinstance(login, str) or len(login) > 39 or not GITHUB_LOGIN.fullmatch(login):
        raise GithubVerificationError
    return account_id, login.lower()


def save_verified_identity(db: DbSession, user_id: UUID, account_id: int, login: str) -> bool:
    # Both the GroupProof user and the GitHub account can have only one binding.
    bound_user = db.scalar(
        insert(VerifiedGithubIdentity)
        .values(user_id=user_id, github_user_id=account_id, login=login, verified_at=utcnow())
        .on_conflict_do_nothing()
        .returning(VerifiedGithubIdentity.user_id)
    )
    return bound_user is not None
