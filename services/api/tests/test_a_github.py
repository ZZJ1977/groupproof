"""A5 GitHub 只读接入：仓库地址解析、App 令牌、安装检查、文件读取的错误处理。"""

from __future__ import annotations

import base64
from datetime import UTC, datetime

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from app.api.errors import ApiError
from app.modules.a import github

APP_ID = "5621553"
NOW = datetime(2026, 11, 11, 12, 0, tzinfo=UTC)


@pytest.fixture(scope="module")
def private_pem() -> str:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()


def _settings(pem: str) -> github.GithubSettings:
    return github.GithubSettings(
        app_id=APP_ID,
        private_key=pem,
        base_url="https://api.github.test",
        app_slug="groupproof-staging",
    )


def test_repo_url_forms_are_accepted_and_bad_ones_rejected():
    assert github.parse_repo_url("https://github.com/acme/demo") == ("acme", "demo")
    assert github.parse_repo_url("https://github.com/acme/demo.git/") == ("acme", "demo")
    assert github.parse_repo_url("acme/demo") == ("acme", "demo")
    for bad in ("", "https://gitlab.com/acme/demo", "acme", "acme/demo/extra", "a b/c"):
        with pytest.raises(ApiError) as exc:
            github.parse_repo_url(bad)
        assert exc.value.code == "INVALID_GITHUB_REPO"


def test_settings_missing_means_not_connected(monkeypatch):
    monkeypatch.delenv("GITHUB_APP_ID", raising=False)
    monkeypatch.delenv("GITHUB_APP_PRIVATE_KEY", raising=False)
    assert github.github_settings() is None


def test_app_jwt_is_rs256_signed_with_app_id(private_pem):
    client = github.GithubClient(_settings(private_pem), now=lambda: NOW)
    token = client._app_jwt()
    public = rsa.generate_private_key(public_exponent=65537, key_size=2048)  # 不同的钥匙不能验证
    with pytest.raises(jwt.InvalidSignatureError):
        jwt.decode(token, public.public_key(), algorithms=["RS256"])
    key = serialization.load_pem_private_key(private_pem.encode(), password=None).public_key()
    claims = jwt.decode(token, key, algorithms=["RS256"], options={"verify_iat": False})
    assert claims["iss"] == APP_ID and claims["exp"] - claims["iat"] <= 600


def test_escaped_newlines_in_env_key_are_restored(monkeypatch, private_pem):
    monkeypatch.setenv("GITHUB_APP_ID", APP_ID)
    monkeypatch.setenv("GITHUB_APP_PRIVATE_KEY", private_pem.replace("\n", "\\n"))
    settings = github.github_settings()
    assert settings is not None and "\n" in settings.private_key


def test_uninstalled_repo_returns_install_link(private_pem):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/repos/acme/demo/installation"
        return httpx.Response(404, json={"message": "Not Found"})

    client = github.GithubClient(
        _settings(private_pem), transport=httpx.MockTransport(handler), now=lambda: NOW
    )
    with pytest.raises(ApiError) as exc:
        client.installation_for_repo("acme", "demo")
    assert exc.value.code == "GITHUB_APP_NOT_INSTALLED"
    assert exc.value.details["install_url"] == (
        "https://github.com/apps/groupproof-staging/installations/new"
    )


def test_installation_token_is_cached_until_near_expiry(private_pem):
    calls = {"token": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/app/installations/77/access_tokens":
            calls["token"] += 1
            return httpx.Response(
                201, json={"token": "ghs_test", "expires_at": "2026-11-11T13:00:00Z"}
            )
        if request.url.path == "/repos/acme/demo":
            assert request.headers["Authorization"] == "Bearer ghs_test"
            return httpx.Response(
                200,
                json={"full_name": "acme/demo", "default_branch": "main", "private": True},
            )
        raise AssertionError(request.url.path)

    clock = {"now": NOW}
    client = github.GithubClient(
        _settings(private_pem), transport=httpx.MockTransport(handler), now=lambda: clock["now"]
    )
    info = client.repo_info("acme", "demo", 77)
    assert info["default_branch"] == "main"
    client.repo_info("acme", "demo", 77)
    assert calls["token"] == 1  # 缓存命中
    clock["now"] = datetime(2026, 11, 11, 12, 58, tzinfo=UTC)  # 距离过期不足 5 分钟，重新获取
    client.repo_info("acme", "demo", 77)
    assert calls["token"] == 2


def test_blob_is_decoded_and_failures_are_503(private_pem):
    content = base64.b64encode("需求文档".encode()).decode()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/access_tokens"):
            return httpx.Response(201, json={"token": "t", "expires_at": "2026-11-11T13:00:00Z"})
        if request.url.path.endswith("/git/blobs/ok"):
            return httpx.Response(200, json={"encoding": "base64", "content": content})
        return httpx.Response(500, json={"message": "boom"})

    client = github.GithubClient(
        _settings(private_pem), transport=httpx.MockTransport(handler), now=lambda: NOW
    )
    assert client.blob("acme", "demo", "ok", 1).decode() == "需求文档"
    with pytest.raises(ApiError) as exc:
        client.blob("acme", "demo", "bad", 1)
    assert exc.value.status_code == 503


def test_token_failure_is_503_not_empty_result(private_pem):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"message": "Bad credentials"})

    client = github.GithubClient(
        _settings(private_pem), transport=httpx.MockTransport(handler), now=lambda: NOW
    )
    with pytest.raises(ApiError) as exc:
        client.installation_token(9)
    assert exc.value.status_code == 503
