"""Google OIDC（Authorization Code + PKCE S256 + state/nonce，§6.2）。

- 协议与签名验证使用 Authlib，不手写 JWT 验签；
- provider/issuer + sub 为外部身份唯一键，邮箱不是主键；Google email_verified 不等于学校邮箱已验证；
- 事务（state/nonce/code_verifier）持久化数据库，一次性消费 + 超时，可抗回调重放；
- 测试环境可将发现地址指向隔离测试 OIDC 提供方；APP_MODE=real 强制校验 issuer 为 Google。
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import httpx
from authlib.integrations.httpx_client import OAuth2Client
from authlib.jose import JsonWebKey, jwt
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from ..config import get_settings
from ..errors import AppError
from ..models import OAuthTransaction, utcnow
from ..security import new_token, safe_return_to, token_digest

SCOPES = "openid email profile"

_discovery_cache: dict[str, dict[str, Any]] = {}


class GoogleIdentity:
    def __init__(
        self, issuer: str, subject: str, email: str | None, email_verified: bool, name: str | None
    ) -> None:
        self.issuer = issuer
        self.subject = subject
        self.email = email
        self.email_verified = email_verified
        self.name = name


def _discovery() -> dict[str, Any]:
    settings = get_settings()
    url = settings.google_discovery_url
    if url not in _discovery_cache:
        try:
            response = httpx.get(url, timeout=10)
            response.raise_for_status()
            document = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise AppError("AUTH_UNAVAILABLE", 503, params={"service": "google"}) from exc
        required = ("issuer", "authorization_endpoint", "token_endpoint", "jwks_uri")
        if not isinstance(document, dict) or any(not document.get(key) for key in required):
            raise AppError("AUTH_UNAVAILABLE", 503, params={"service": "google"})
        _discovery_cache[url] = document
    return _discovery_cache[url]


def reset_discovery_cache() -> None:
    _discovery_cache.clear()


def create_transaction(
    db: DbSession,
    return_to: str | None,
    *,
    purpose: str = "login",
    user_id: Any | None = None,
) -> tuple[str, OAuthTransaction]:
    """创建 OAuth 事务；purpose=link 时必须带上发起关联的用户（回调只建绑定，不建用户）。"""
    settings = get_settings()
    nonce = new_token()
    state = new_token()
    record = OAuthTransaction(
        state_digest=token_digest(state),
        nonce=nonce,
        code_verifier=new_token(),
        return_to=safe_return_to(return_to),
        purpose=purpose,
        user_id=user_id,
        expires_at=utcnow() + timedelta(seconds=settings.oauth_transaction_ttl),
    )
    db.add(record)
    db.flush()
    return state, record


def consume_transaction(db: DbSession, state: str | None) -> OAuthTransaction:
    """一次性消费：重放、state 不匹配、过期均失败。"""
    now = utcnow()
    if not state:
        raise AppError("UNAUTHENTICATED", 401, params={"reason": "state_missing"})
    record = db.execute(
        select(OAuthTransaction)
        .where(OAuthTransaction.state_digest == token_digest(state))
        .with_for_update()
    ).scalar_one_or_none()
    if record is None or record.consumed_at is not None or record.expires_at <= now:
        raise AppError("UNAUTHENTICATED", 401, params={"reason": "state_invalid"})
    record.consumed_at = now
    db.flush()
    return record


def build_authorize_url(state: str, nonce: str, code_verifier: str) -> str:
    settings = get_settings()
    session = OAuth2Client(
        client_id=settings.google_client_id,
        redirect_uri=settings.google_redirect_uri,
        scope=SCOPES,
        code_challenge_method="S256",
    )
    uri, _ = session.create_authorization_url(
        _discovery()["authorization_endpoint"],
        state=state,
        code_verifier=code_verifier,
        nonce=nonce,
    )
    return uri


def exchange_and_verify(transaction: OAuthTransaction, code: str) -> GoogleIdentity:
    settings = get_settings()
    session = OAuth2Client(
        client_id=settings.google_client_id,
        client_secret=settings.google_client_secret,
        redirect_uri=settings.google_redirect_uri,
    )
    try:
        discovery = _discovery()
        session.fetch_token(
            discovery["token_endpoint"],
            code=code,
            grant_type="authorization_code",
            code_verifier=transaction.code_verifier,
        )
    except AppError:
        raise
    except Exception as exc:  # noqa: BLE001
        status_code = getattr(getattr(exc, "response", None), "status_code", None)
        if (
            isinstance(exc, httpx.HTTPError)
            or status_code == 429
            or (isinstance(status_code, int) and status_code >= 500)
        ):
            raise AppError("AUTH_UNAVAILABLE", 503, params={"service": "google"}) from exc
        raise AppError("UNAUTHENTICATED", 401, params={"reason": "token_exchange_failed"}) from exc
    id_token = session.token.get("id_token")
    if not id_token:
        raise AppError("UNAUTHENTICATED", 401, params={"reason": "id_token_missing"})
    return verify_id_token(id_token, transaction.nonce)


def verify_id_token(id_token: str, expected_nonce: str) -> GoogleIdentity:
    settings = get_settings()
    discovery = _discovery()
    try:
        jwks_response = httpx.get(discovery["jwks_uri"], timeout=10)
        jwks_response.raise_for_status()
        jwks_document = jwks_response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise AppError("AUTH_UNAVAILABLE", 503, params={"service": "google"}) from exc
    try:
        jwks = JsonWebKey.import_key_set(jwks_document)
        claims = jwt.decode(id_token, jwks)
        claims.validate()  # exp/iat/aud（Authlib 校验）
    except Exception as exc:  # noqa: BLE001
        raise AppError("UNAUTHENTICATED", 401, params={"reason": "id_token_invalid"}) from exc
    if claims["iss"] != settings.google_expected_issuer or claims["iss"] != discovery.get("issuer"):
        raise AppError("UNAUTHENTICATED", 401, params={"reason": "issuer_mismatch"})
    audience = claims.get("aud")
    if not _valid_audience(audience, settings.google_client_id):
        raise AppError("UNAUTHENTICATED", 401, params={"reason": "audience_mismatch"})
    authorized_party = claims.get("azp")
    if not _valid_authorized_party(audience, authorized_party, settings.google_client_id):
        raise AppError("UNAUTHENTICATED", 401, params={"reason": "azp_mismatch"})
    if claims.get("nonce") != expected_nonce:
        raise AppError("UNAUTHENTICATED", 401, params={"reason": "nonce_mismatch"})
    subject = claims.get("sub")
    if not subject:
        raise AppError("UNAUTHENTICATED", 401, params={"reason": "subject_missing"})
    return GoogleIdentity(
        issuer=claims["iss"],
        subject=subject,
        email=claims.get("email"),
        email_verified=bool(claims.get("email_verified")),
        name=claims.get("name"),
    )


def _valid_audience(audience: Any, client_id: str) -> bool:
    if isinstance(audience, list):
        return client_id in audience
    return audience == client_id


def _valid_authorized_party(audience: Any, authorized_party: Any, client_id: str) -> bool:
    if authorized_party is not None and authorized_party != client_id:
        return False
    return not (isinstance(audience, list) and len(audience) > 1) or authorized_party == client_id
