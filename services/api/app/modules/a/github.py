"""A5 GitHub 只读接入：用 GitHub App 读取用户授权安装的仓库。

边界（V1）：
- 只使用 GitHub App 的只读权限（Contents、Metadata）；代码里没有任何写仓库的调用；
- 凭证只来自后端变量 ``GITHUB_APP_ID`` 和 ``GITHUB_APP_PRIVATE_KEY``，不进入数据库、日志或前端；
- 用 App 私钥签发 JWT，换取安装级别的短期访问令牌（约 1 小时），令牌只放在内存里；
- 仓库必须已经把本 App 安装到其所在账号上，否则明确返回需要安装的提示。
"""

from __future__ import annotations

import base64
import os
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import jwt

from app.api.errors import ApiError

GITHUB_API = "https://api.github.com"
TOKEN_REFRESH_MARGIN = 300
_NAME = re.compile(r"[A-Za-z0-9_.-]{1,100}")


def _unavailable(message: str = "GitHub 暂时不可用，请稍后重试。") -> ApiError:
    return ApiError(503, "GITHUB_UNAVAILABLE", message)


@dataclass(frozen=True)
class GithubSettings:
    app_id: str
    private_key: str
    base_url: str = GITHUB_API
    app_slug: str = ""  # GitHub App 的公开名称（链接里的 groupproof-staging），用于生成安装链接


def github_settings() -> GithubSettings | None:
    app_id = os.environ.get("GITHUB_APP_ID", "").strip()
    key = os.environ.get("GITHUB_APP_PRIVATE_KEY", "").strip()
    if not app_id or not key:
        return None  # 未接入：返回 503，不假装读取成功
    # Railway 变量里换行常被存成 \n 字面量，这里还原。
    slug = os.environ.get("GITHUB_APP_SLUG", "").strip()
    return GithubSettings(app_id=app_id, private_key=key.replace("\\n", "\n"), app_slug=slug)


def parse_repo_url(value: str) -> tuple[str, str]:
    """接受 https://github.com/owner/repo(.git) 或 owner/repo，返回 (owner, repo)。"""
    text = (value or "").strip().rstrip("/")
    match = re.fullmatch(r"(?:https?://github\.com/)?([^/\s]+)/([^/\s]+?)(?:\.git)?", text)
    if not match:
        raise ApiError(
            422,
            "INVALID_GITHUB_REPO",
            "请输入 GitHub 仓库地址，例如 https://github.com/owner/repo。",
        )
    owner, repo = match.group(1), match.group(2)
    if not (_NAME.fullmatch(owner) and _NAME.fullmatch(repo)):
        raise ApiError(422, "INVALID_GITHUB_REPO", "仓库地址格式不正确。")
    return owner, repo


class GithubClient:
    """只读客户端。令牌缓存只在内存中，按安装 ID 分开。"""

    def __init__(
        self, settings: GithubSettings, *, transport: httpx.BaseTransport | None = None, now=None
    ) -> None:
        self._settings = settings
        self._http = httpx.Client(
            base_url=settings.base_url,
            timeout=15.0,
            transport=transport,
            headers={"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"},
        )
        self._now = now or (lambda: datetime.now(UTC))
        self._tokens: dict[int, tuple[str, datetime]] = {}

    def close(self) -> None:
        self._http.close()

    def _app_jwt(self) -> str:
        issued = int(self._now().timestamp()) - 60
        payload = {"iat": issued, "exp": issued + 600, "iss": self._settings.app_id}
        try:
            return jwt.encode(payload, self._settings.private_key, algorithm="RS256")
        except Exception as exc:  # 私钥格式错误
            raise _unavailable("GitHub App 私钥格式不正确，请检查 Railway 变量。") from exc

    def _get(self, path: str, token: str, params: dict[str, Any] | None = None) -> httpx.Response:
        try:
            return self._http.get(path, params=params, headers={"Authorization": f"Bearer {token}"})
        except httpx.HTTPError as exc:
            raise _unavailable() from exc

    def installation_for_repo(self, owner: str, repo: str) -> int:
        response = self._get(f"/repos/{owner}/{repo}/installation", self._app_jwt())
        if response.status_code == 404:
            raise ApiError(
                422,
                "GITHUB_APP_NOT_INSTALLED",
                "请先把 GroupProof 的 GitHub App 安装到该仓库所在的账号，然后再绑定。",
                {"install_url": self._install_url()} if self._settings.app_slug else None,
            )
        if response.status_code != 200:
            raise _unavailable()
        return int(response.json()["id"])

    def _install_url(self) -> str:
        return f"https://github.com/apps/{self._settings.app_slug}/installations/new"

    def installation_token(self, installation_id: int) -> str:
        now = self._now()
        cached = self._tokens.get(installation_id)
        if cached and now < cached[1] - timedelta(seconds=TOKEN_REFRESH_MARGIN):
            return cached[0]
        try:
            response = self._http.post(
                f"/app/installations/{installation_id}/access_tokens",
                headers={"Authorization": f"Bearer {self._app_jwt()}"},
            )
        except httpx.HTTPError as exc:
            raise _unavailable() from exc
        if response.status_code != 201:
            raise _unavailable("无法获取 GitHub 访问令牌，请检查 GitHub App 配置。")
        body = response.json()
        expires = datetime.fromisoformat(body["expires_at"].replace("Z", "+00:00"))
        self._tokens[installation_id] = (body["token"], expires)
        return body["token"]

    def repo_info(self, owner: str, repo: str, installation_id: int) -> dict[str, Any]:
        response = self._get(f"/repos/{owner}/{repo}", self.installation_token(installation_id))
        if response.status_code != 200:
            raise _unavailable("无法读取该仓库，请确认仓库存在且 App 有权限访问。")
        data = response.json()
        return {
            "full_name": data["full_name"],
            "default_branch": data["default_branch"],
            "private": data["private"],
        }

    def tree(self, owner: str, repo: str, ref: str, installation_id: int) -> dict[str, Any]:
        response = self._get(
            f"/repos/{owner}/{repo}/git/trees/{ref}",
            self.installation_token(installation_id),
            params={"recursive": "1"},
        )
        if response.status_code != 200:
            raise _unavailable("无法读取仓库文件列表。")
        return response.json()

    def blob(self, owner: str, repo: str, sha: str, installation_id: int) -> bytes:
        response = self._get(
            f"/repos/{owner}/{repo}/git/blobs/{sha}", self.installation_token(installation_id)
        )
        if response.status_code != 200:
            raise _unavailable("无法读取文件内容。")
        body = response.json()
        return base64.b64decode(body["content"]) if body.get("encoding") == "base64" else b""


def get_github_client() -> GithubClient | None:
    settings = github_settings()
    return GithubClient(settings) if settings else None
