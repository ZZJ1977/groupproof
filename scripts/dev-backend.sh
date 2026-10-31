#!/usr/bin/env bash
# npm run dev 前置脚本：同步拉起后端依赖（PostgreSQL/Redis/API），并保证 3000 端口留给 next dev。
# - 已经在跑的容器不会重建（幂等）；--wait 等健康检查通过再启动前端
# - 没有 Docker 时跳过（可使用本地后端，如 uvicorn + 本地 PostgreSQL）
set -uo pipefail

if [[ "${GROUPPROOF_SKIP_BACKEND:-0}" == "1" ]]; then
  echo "[dev-backend] 使用显式配置的测试/外部后端，跳过本地容器启动"
  exit 0
fi

if ! docker info >/dev/null 2>&1; then
  echo "[dev-backend] 未检测到 Docker：跳过后端自动启动（可自行运行 uvicorn 或先启动 Docker）"
  exit 0
fi

if ! docker compose up -d --wait postgres redis api; then
  echo "[dev-backend] docker 后端启动失败；如你在使用本地后端可忽略此提示"
  exit 0
fi

# 数据库迁移（幂等）：结构对齐 head，首次启动或迁移变更后自动执行
if ! docker compose exec -T api alembic upgrade head >/dev/null; then
  echo "[dev-backend] 迁移执行失败：请查看 docker compose logs api"
  exit 0
fi

# docker web 与 next dev 争用 3000 端口：停掉 web 让位（如需 docker 前端请用 docker compose up -d web）
docker compose stop web >/dev/null 2>&1 || true

echo "[dev-backend] 后端就绪：postgres/redis/api 已启动（http://localhost:8000）"
