"""A8 错误监控（Sentry）：配置了 SENTRY_DSN 才启用，没配置时什么都不做。

隐私边界：不发送用户信息、Cookie、请求头和请求正文（可能含上传内容、令牌和飞书消息），
只发送错误类型、堆栈和请求路径。
"""

from __future__ import annotations

import os
from typing import Any

_SCRUB_KEYS = ("headers", "cookies", "data", "query_string", "env")


def scrub_event(event: dict[str, Any], _hint: Any = None) -> dict[str, Any] | None:
    request = event.get("request")
    if isinstance(request, dict):
        for key in _SCRUB_KEYS:
            request.pop(key, None)
    event.pop("user", None)
    return event


def init_sentry() -> bool:
    dsn = os.getenv("SENTRY_DSN", "").strip()
    if not dsn:
        return False
    import sentry_sdk

    try:
        rate = float(os.getenv("SENTRY_TRACES_SAMPLE_RATE", "0") or 0)
    except ValueError:
        rate = 0.0
    sentry_sdk.init(
        dsn=dsn,
        environment=os.getenv("APP_ENV", "production"),
        send_default_pii=False,
        traces_sample_rate=min(max(rate, 0.0), 1.0),
        before_send=scrub_event,
    )
    return True
