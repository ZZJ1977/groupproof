"""认证路由响应封装：适配团队统一响应契约（PLAN 二、3）。

成功响应：{"data": <载荷>, "meta": {"request_id": ...}}
错误响应由 app.auth.errors 渲染为 {"error": {...}, "meta": {"request_id": ...}}。

通过 APIRoute 包装统一处理，保留状态码、Cookie 与缓存头；已经是统一封装的响应不重复包装。
"""

from __future__ import annotations

import json

from fastapi import Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse as BaseJSONResponse
from fastapi.routing import APIRoute


class JSONResponse(BaseJSONResponse):
    """支持 UUID 等领域类型的 JSON 响应（统一身份后 user.id 为 UUID）。"""

    def render(self, content: object) -> bytes:
        return json.dumps(
            jsonable_encoder(content),
            ensure_ascii=False,
            allow_nan=False,
            indent=None,
            separators=(",", ":"),
        ).encode("utf-8")


def is_envelope(body: object) -> bool:
    return isinstance(body, dict) and "meta" in body and ("data" in body or "error" in body)


def envelope_response(response: Response, request: Request) -> Response:
    if response.status_code == 204 or response.status_code >= 300:
        return response
    content_type = response.headers.get("content-type", "")
    if "application/json" not in content_type:
        return response
    try:
        body = json.loads(bytes(response.body).decode("utf-8") or "null")
    except (ValueError, TypeError):
        return response
    if body is None or is_envelope(body):
        return response
    payload = {
        "data": body,
        "meta": {"request_id": getattr(request.state, "request_id", None)},
    }
    headers = {
        key: value
        for key, value in response.headers.items()
        if key.lower() not in {"content-length", "content-type"}
    }
    return JSONResponse(
        content=payload,
        status_code=response.status_code,
        headers=headers,
    )


class EnvelopeRoute(APIRoute):
    def get_route_handler(self):
        original_route_handler = super().get_route_handler()

        async def route_handler(request: Request) -> Response:
            response = await original_route_handler(request)
            return envelope_response(response, request)

        return route_handler
