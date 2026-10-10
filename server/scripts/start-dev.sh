#!/usr/bin/env bash
# 本地统一启动入口：加载稳定路径配置 → 检查数据库/迁移 → 启动服务（可重复执行）。
# 用法（仓库根目录）：npm run server:dev      或      bash server/scripts/start-dev.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(dirname "$SERVER_DIR")"
cd "$SERVER_DIR"

# 1) 配置来源：环境变量优先；本地 .env 使用仓库根目录稳定路径（可重复）
export GROUPPROOF_ENV_FILE="${GROUPPROOF_ENV_FILE:-$REPO_ROOT/.env}"
if [ -f "$GROUPPROOF_ENV_FILE" ]; then
  echo "[startup] 加载配置文件：$GROUPPROOF_ENV_FILE"
else
  echo "[startup] 未发现 ${GROUPPROOF_ENV_FILE}，使用环境变量与内置开发默认值"
fi

VENV="$SERVER_DIR/.venv/bin"
if [ ! -x "$VENV/python" ]; then
  echo "[startup] 缺少虚拟环境，先执行：python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt" >&2
  exit 1
fi

# 2) 打印脱敏配置来源与数据库标识
"$VENV/python" - <<'PY'
from app.config import config_source_summary
print("[startup] 配置（脱敏）：", config_source_summary())
PY

# 3) 数据库可达性与迁移检查；迁移可重复执行（alembic 幂等）
if ! "$VENV/python" - <<'PY'
import sys
from app.config import get_settings
from sqlalchemy import create_engine, text
try:
    engine = create_engine(get_settings().database_url)
    with engine.connect() as conn:
        conn.execute(text("SELECT 1"))
        version = conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one_or_none()
    print(f"[startup] 数据库可达，当前迁移版本：{version or '未迁移'}")
except Exception as exc:  # noqa: BLE001
    print(f"[startup] 数据库不可达：{type(exc).__name__}: {str(exc)[:160]}", file=sys.stderr)
    print("[startup] 请确认 PostgreSQL 已启动且 DATABASE_URL 正确（对照 .env.example），再重试。", file=sys.stderr)
    sys.exit(1)
PY
then
  exit 1
fi

echo "[startup] 执行迁移（幂等，可重复）…"
"$VENV/alembic" upgrade head

# 4) 启动服务
echo "[startup] 启动 FastAPI（默认 http://localhost:8000；readiness: /readyz）"
exec "$VENV/uvicorn" app.main:app --port "${SERVER_PORT:-8000}" "$@"
