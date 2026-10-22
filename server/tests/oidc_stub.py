"""隔离测试 OIDC 提供方（仅 pytest 使用，禁止出现在生产配置）。

提供 discovery / JWKS / token 端点，签发可控的 ID token，用于确定性验证
state/nonce/PKCE/重放/验签等 OAuth 事务行为。真实 Google 联调另行记录。
"""
from __future__ import annotations

import base64
import hashlib
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs

from authlib.jose import JsonWebKey, jwt

KEY = JsonWebKey.generate_key("RSA", 2048, is_private=True)
KID = "test-key-1"
PUBLIC_JWK = {**KEY.as_dict(), "kid": KID, "alg": "RS256", "use": "sig"}
PUBLIC_JWK.pop("d", None)
PUBLIC_JWK.pop("p", None)
PUBLIC_JWK.pop("q", None)
PUBLIC_JWK.pop("dp", None)
PUBLIC_JWK.pop("dq", None)
PUBLIC_JWK.pop("qi", None)

ISSUER = ""  # 启动后填充
CLIENT_ID = "test-client-id"


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # 静音
        pass

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path.startswith("/.well-known/openid-configuration"):
            self._send(
                200,
                {
                    "issuer": ISSUER,
                    "authorization_endpoint": f"{ISSUER}/authorize",
                    "token_endpoint": f"{ISSUER}/token",
                    "jwks_uri": f"{ISSUER}/jwks.json",
                },
            )
        elif self.path.startswith("/jwks.json"):
            self._send(200, {"keys": [PUBLIC_JWK]})
        else:
            self._send(404, {})

    def do_POST(self):  # noqa: N802
        if not self.path.startswith("/token"):
            self._send(404, {})
            return
        length = int(self.headers.get("Content-Length", 0))
        form = parse_qs(self.rfile.read(length).decode())
        code = (form.get("code") or [""])[0]
        try:
            payload = json.loads(base64.urlsafe_b64decode(code + "=" * (-len(code) % 4)))
        except Exception:  # noqa: BLE001
            self._send(400, {"error": "invalid_grant"})
            return
        verifier = (form.get("code_verifier") or [""])[0]
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        if payload.get("code_challenge") and payload.get("code_challenge") != challenge:
            self._send(400, {"error": "invalid_grant", "error_description": "pkce_failed"})
            return
        now = int(time.time())
        id_token = jwt.encode(
            {"alg": "RS256", "kid": KID},
            {
                "iss": ISSUER,
                "sub": payload.get("sub", "google-sub-1"),
                "aud": CLIENT_ID,
                "exp": now + 300,
                "iat": now,
                "nonce": payload.get("nonce"),
                "email": payload.get("email", "student1@student.must.edu.mo"),
                "email_verified": payload.get("email_verified", True),
                "name": payload.get("name", "测试用户"),
            },
            KEY,
        )
        self._send(200, {"access_token": "stub-access", "id_token": id_token.decode() if isinstance(id_token, bytes) else id_token, "token_type": "Bearer"})


class StubProvider:
    def __init__(self) -> None:
        self.server = HTTPServer(("127.0.0.1", 0), _Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def start(self) -> None:
        global ISSUER
        ISSUER = f"http://127.0.0.1:{self.port}"
        self.thread.start()

    def stop(self) -> None:
        self.server.shutdown()

    @property
    def issuer(self) -> str:
        return ISSUER

    @property
    def discovery_url(self) -> str:
        return f"{ISSUER}/.well-known/openid-configuration"

    @staticmethod
    def mint_code(*, state: str, nonce: str, code_verifier: str, sub: str = "google-sub-1", email: str = "student1@student.must.edu.mo", email_verified: bool = True, name: str = "测试用户", wrong_challenge: bool = False) -> str:
        """测试代码：将 stub 想签发的身份打包进 code（等价于 stub 的授权结果）。"""
        challenge = base64.urlsafe_b64encode(hashlib.sha256(code_verifier.encode()).digest()).rstrip(b"=").decode()
        payload = {
            "sub": sub,
            "email": email,
            "email_verified": email_verified,
            "name": name,
            "nonce": nonce,
            "code_challenge": "wrong" if wrong_challenge else challenge,
        }
        raw = json.dumps(payload).encode()
        return base64.urlsafe_b64encode(raw).decode().rstrip("=")
