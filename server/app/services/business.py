"""业务数据来源边界（P2）。

本轮业务数据尚未迁入数据库：dev/test 通过 BUSINESS_DATA_FILE 提供隔离演示数据集，
授权管线（会话 + 注册资格 + 资源权限）是真实实现并被测试覆盖。
APP_MODE=real 且未接入真实业务存储时返回 SERVICE_UNAVAILABLE，绝不回退 Mock 数据。
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from ..config import get_settings
from ..errors import AppError

_cache: dict[str, Any] | None = None


def load_business_data() -> dict[str, Any]:
    global _cache
    settings = get_settings()
    # 环境变量优先（测试夹具）；否则用 .env 的 BUSINESS_DATA_FILE
    path = os.environ.get("BUSINESS_DATA_FILE") or settings.business_data_file
    if settings.is_real and not os.environ.get("BUSINESS_STORE") == "db":
        raise AppError("SERVICE_UNAVAILABLE", 503, params={"service": "business_store"})
    if not path:
        if settings.is_real:
            raise AppError("SERVICE_UNAVAILABLE", 503, params={"service": "business_store"})
        raise AppError("SERVICE_UNAVAILABLE", 503, params={"service": "business_store"})
    if _cache is None:
        _cache = json.loads(Path(path).read_text(encoding="utf-8"))
    return _cache


def reset_business_cache() -> None:
    global _cache
    _cache = None
