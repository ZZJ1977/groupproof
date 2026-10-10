"""Google OIDC（Authorization Code + PKCE S256 + state/nonce，§6.2）。

- 协议与签名验证使用 Authlib，不手写 JWT 验签；
- provider/issuer + sub 为外部身份唯一键，邮箱不是主键；Google email_verified 不等于学校邮箱已验证；
- 事务（state/nonce/code_verifier）持久化数据库，一次性消费 + 超时，可抗回调重放；
- 测试环境可将发现地址指向隔离测试 OIDC 提供方；APP_MODE=real 强制校验 issuer 为 Google。
"""
from __future__ import annotations

from datetime import timedelta

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

_discovery_cache: dict = {}


class GoogleIdentity:
    def __init__(self, issuer: str, subject: str, email: str | None, email_verified: bool, name: str | None) -> None:
        self.issuer = issuer
        self.subject = subject
        self.email = email
        self.email_verified = email_verified
        self.name = name


def _discovery() -> dict:
    settings = get_settings()
    if not _discovery_cache:
        response = httpx.get(settings.google_discovery_url, timeout=10)
        response.raise_for_status()
        _discovery_cache.update(response.json())
    return _discovery_cache


def reset_discovery_cache() -> None:
    _discovery_cache.clear()


def create_transaction(db: DbSession, return_to: str | None) -> tuple[str, OAuthTransaction]:
    settings = get_settings()
    nonce = new_token()
    state = new_token()
    record = OAuthTransaction(
        state_digest=token_digest(state),
        nonce=nonce,
        code_verifier=new_token(),
        return_to=safe_return_to(return_to),
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
    record = db.execute(select(OAuthTransaction).where(OAuthTransaction.state_digest == token_digest(state)).with_for_update()).scalar_one_or_none()
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
        session.fetch_token(
            _discovery()["token_endpoint"],
            code=code,
            grant_type="authorization_code",
            code_verifier=transaction.code_verifier,
        )
    except Exception as exc:  # noqa: BLE001
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
        jwks = JsonWebKey.import_key_set(jwks_response.json())
        claims = jwt.decode(id_token, jwks)
        claims.validate()  # exp/iat/aud（Authlib 校验）
    except Exception as exc:  # noqa: BLE001
        raise AppError("UNAUTHENTICATED", 401, params={"reason": "id_token_invalid"}) from exc
    if claims["iss"] != settings.google_expected_issuer or claims["iss"] != discovery.get("issuer"):
        raise AppError("UNAUTHENTICATED", 401, params={"reason": "issuer_mismatch"})
    audience = claims.get("aud")
    if isinstance(audience, list):
        aud_ok = settings.google_client_id in audience
    else:
        aud_ok = audience == settings.google_client_id
    if not aud_ok:
        raise AppError("UNAUTHENTICATED", 401, params={"reason": "audience_mismatch"})
    azp = claims.get("azp")
    if isinstance(audience, list) and azp and azp != settings.google_client_id:
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
