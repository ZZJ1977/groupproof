"""把后端当前的 OpenAPI 导出到 packages/domain/openapi.json（前端接口客户端的来源）。

用法（在 services/api 目录）：python scripts/export_openapi.py
改了接口后运行它，再在仓库根目录运行 npm run api:generate。
"""

from __future__ import annotations

import json
from pathlib import Path

from app.main import app

SNAPSHOT = Path(__file__).resolve().parents[3] / "packages" / "domain" / "openapi.json"


def render() -> str:
    return json.dumps(app.openapi(), indent=2, sort_keys=True, ensure_ascii=False) + "\n"


if __name__ == "__main__":
    SNAPSHOT.write_text(render(), encoding="utf-8")
    print(f"Wrote {SNAPSHOT}")
