"""A7-01 AI 调用中间层：以后换 AI 厂商只改这里。

- ``AI_PROVIDER`` 选择实现：``fake``（固定假结果）或 ``openrouter``（真实模型，需要 AI_API_KEY，
  可选 AI_MODEL）；未设置、``none`` 或未知名称 → AI 不可用；
- 正式环境（``APP_ENV=production``）禁止 ``fake``，避免假数据出现在正式网站；
- 密钥只从环境变量（Railway 变量）读取：``AI_API_KEY``；
- 调用失败或超时自动重试，最终失败时抛 ``AIUnavailable``，由函数层统一转成
  “AI 暂不可用，请改为人工处理”，网站其他功能不受影响。
"""

from __future__ import annotations

import logging
import os
import time
from collections.abc import Callable
from typing import Any, Protocol

logger = logging.getLogger("groupproof.a.ai")

DEFAULT_TIMEOUT_SECONDS = 30.0
DEFAULT_ATTEMPTS = 3


class AIUnavailable(Exception):
    """AI 没配置、被关闭或多次重试后仍失败。"""


class AIProvider(Protocol):
    name: str
    is_placeholder: bool

    def generate(self, feature: str, payload: dict[str, Any], *, timeout: float) -> dict:
        """按功能名生成结构化结果（字典），由函数层校验字段。"""


class FakeProvider:
    """返回固定假结果；结果按输入生成，保证字段和真实版本一致。"""

    name = "fake"
    is_placeholder = True

    def generate(self, feature: str, payload: dict[str, Any], *, timeout: float) -> dict:
        from app.modules.a.ai import fake_results

        builder = getattr(fake_results, feature, None)
        if builder is None:
            raise AIUnavailable(f"fake provider has no result for {feature}")
        return builder(payload)


def get_provider() -> AIProvider:
    name = os.getenv("AI_PROVIDER", "").strip().lower()
    environment = os.getenv("APP_ENV", "production").strip().lower()
    if name == "fake":
        if environment == "production":
            raise AIUnavailable("fake AI provider is disabled in production")
        return FakeProvider()
    if name == "openrouter":
        key = os.getenv("AI_API_KEY", "").strip()
        if not key:
            raise AIUnavailable("AI_API_KEY is not set")
        from app.modules.a.ai.openrouter import DEFAULT_MODEL, OpenRouterProvider

        return OpenRouterProvider(key, os.getenv("AI_MODEL", "").strip() or DEFAULT_MODEL)
    raise AIUnavailable("AI provider is not configured")


def call_with_retry(
    fn: Callable[[], dict],
    *,
    attempts: int = DEFAULT_ATTEMPTS,
    base_delay: float = 0.5,
    sleep: Callable[[float], None] = time.sleep,
) -> dict:
    """失败自动重试（指数退避）；AIUnavailable 表示配置问题，不重试。"""
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            return fn()
        except AIUnavailable:
            raise
        except Exception as exc:  # noqa: BLE001 - 厂商错误统一重试
            last_error = exc
            logger.warning("AI call failed (attempt %s/%s): %s", attempt + 1, attempts, exc)
            if attempt + 1 < attempts:
                sleep(base_delay * (2**attempt))
    raise AIUnavailable("AI call failed after retries") from last_error
