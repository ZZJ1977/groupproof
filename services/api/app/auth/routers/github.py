"""Account settings endpoints for optional personal GitHub verification."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy import delete
from sqlalchemy.orm import Session as DbSession

from ..config import get_settings
from ..db import get_db
from ..envelope import EnvelopeRoute
from ..errors import AppError
from ..guard import AuthContext, check_csrf, require_active_user
from ..models import GithubLinkTransaction, VerifiedGithubIdentity, utcnow
from ..security import within_recent_auth
from ..services import audit, github_oauth

IDENTITY_PATH = "/api/v1/me/identities/github"
PRIVATE_HEADERS = {"Cache-Control": "private, no-store"}
GithubLinkResult = Literal["linked", "cancelled", "conflict", "failed", "unavailable"]

router = APIRouter(tags=["me"], route_class=EnvelopeRoute)


class GithubIdentityStatus(BaseModel):
    available: bool
    login: str | None
    verifiedAt: datetime | None


class GithubLinkStart(BaseModel):
    authorizeUrl: str


def _require_recent_session(
    request: Request, context: AuthContext = Depends(require_active_user)
) -> AuthContext:
    check_csrf(request, context)
    if request.headers.get("origin") != get_settings().app_origin:
        raise AppError("FORBIDDEN", 403, params={"reason": "csrf"})
    session = context.session
    if not within_recent_auth(session.authenticated_at or session.created_at, utcnow()):
        raise AppError("REAUTH_REQUIRED", 403)
    return context


@router.get(IDENTITY_PATH)
def get_github_identity(
    response: Response,
    context: AuthContext = Depends(require_active_user),
    db: DbSession = Depends(get_db),
) -> GithubIdentityStatus:
    identity = db.get(VerifiedGithubIdentity, context.user.id)
    response.headers.update(PRIVATE_HEADERS)
    return GithubIdentityStatus(
        available=github_oauth.callback_url(get_settings()) is not None,
        login=identity.login if identity else None,
        verifiedAt=identity.verified_at if identity else None,
    )


@router.post(f"{IDENTITY_PATH}/link")
def link_github_identity(
    response: Response,
    context: AuthContext = Depends(_require_recent_session),
    db: DbSession = Depends(get_db),
) -> GithubLinkStart:
    settings = get_settings()
    redirect_uri = github_oauth.callback_url(settings)
    if redirect_uri is None:
        raise AppError("AUTH_UNAVAILABLE", 503, params={"service": "github"})
    if db.get(VerifiedGithubIdentity, context.user.id) is not None:
        raise AppError("INVALID_STATE", 409, params={"reason": "github_already_linked"})
    authorize_url = github_oauth.begin_link(
        db,
        user_id=context.user.id,
        session_id=context.session.id,
        client_id=settings.github_oauth_client_id,
        redirect_uri=redirect_uri,
    )
    db.commit()
    response.headers.update(PRIVATE_HEADERS)
    return GithubLinkStart(authorizeUrl=authorize_url)


@router.delete(IDENTITY_PATH, status_code=204, response_class=Response)
def unlink_github_identity(
    context: AuthContext = Depends(_require_recent_session),
    db: DbSession = Depends(get_db),
) -> Response:
    user_id = context.user.id
    # Remove any pending attempt so an exchange in flight cannot relink the account.
    db.execute(delete(GithubLinkTransaction).where(GithubLinkTransaction.user_id == user_id))
    if db.execute(
        delete(VerifiedGithubIdentity).where(VerifiedGithubIdentity.user_id == user_id)
    ).rowcount:
        audit.record(db, "auth.github.unlinked", actor_id=user_id)
    db.commit()
    return Response(status_code=204, headers=PRIVATE_HEADERS)


def _return_to_security(result: GithubLinkResult) -> RedirectResponse:
    return RedirectResponse(
        f"/account/security?github={result}",
        status_code=302,
        headers={**PRIVATE_HEADERS, "Referrer-Policy": "no-referrer"},
    )


@router.get(github_oauth.CALLBACK_PATH, status_code=302, response_class=RedirectResponse)
def github_callback(
    request: Request,
    state: str = "",
    code: str = "",
    error: str = "",
    db: DbSession = Depends(get_db),
) -> RedirectResponse:
    settings = get_settings()
    redirect_uri = github_oauth.callback_url(settings)
    if redirect_uri is None:
        return _return_to_security("unavailable")
    if len(state) != 43:
        return _return_to_security("failed")
    try:
        context = require_active_user(request, db)
    except AppError:
        return _return_to_security("failed")
    user_id, session_id = context.user.id, context.session.id
    transaction = github_oauth.lock_link(db, user_id=user_id, session_id=session_id, state=state)
    if transaction is None or transaction.code_verifier is None:
        return _return_to_security("failed")
    if transaction.expires_at <= utcnow():
        db.delete(transaction)
        db.commit()
        return _return_to_security("failed")
    if error or not code or len(code) > 512:
        db.delete(transaction)
        db.commit()
        return _return_to_security("cancelled" if error == "access_denied" else "failed")

    # Spend the verifier before reaching GitHub. Keep the row so unlinking or restarting
    # can invalidate the exchange while the network request is in flight.
    verifier = transaction.code_verifier
    transaction.code_verifier = None
    db.commit()
    return _complete_github_link(
        request, db, user_id, session_id, state, code, verifier, redirect_uri
    )


def _complete_github_link(
    request: Request,
    db: DbSession,
    user_id: UUID,
    session_id: str,
    state: str,
    code: str,
    verifier: str,
    redirect_uri: str,
) -> RedirectResponse:
    try:
        verified = github_oauth.fetch_verified_identity(
            get_settings(), code=code, code_verifier=verifier, redirect_uri=redirect_uri
        )
    except github_oauth.GithubVerificationError:
        verified = None

    db.expire_all()
    try:
        context = require_active_user(request, db)
    except AppError:
        context = None
    transaction = github_oauth.lock_link(db, user_id=user_id, session_id=session_id, state=state)
    if transaction is None:
        return _return_to_security("failed")
    db.delete(transaction)
    result: GithubLinkResult = "failed"
    if (
        verified is not None
        and context is not None
        and context.session.id == session_id
        and transaction.expires_at > utcnow()
    ):
        account_id, login = verified
        if github_oauth.save_verified_identity(db, user_id, account_id, login):
            audit.record(db, "auth.github.linked", actor_id=user_id)
            result = "linked"
        else:
            result = "conflict"
    db.commit()
    return _return_to_security(result)
