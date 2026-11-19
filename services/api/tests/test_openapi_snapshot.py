"""A8：前端接口客户端的来源快照必须和后端当前接口一致。

不一致时运行（在 services/api）：PYTHONPATH=. python scripts/export_openapi.py，
再在仓库根目录运行 npm run api:generate，并一起提交。
"""

from __future__ import annotations

from scripts.export_openapi import SNAPSHOT, render


def test_openapi_snapshot_matches_backend():
    assert SNAPSHOT.read_text(encoding="utf-8") == render(), (
        "openapi.json 已过期：运行 scripts/export_openapi.py 和 npm run api:generate"
    )
