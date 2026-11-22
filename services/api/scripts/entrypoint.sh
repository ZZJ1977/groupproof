#!/bin/sh
set -eu

if [ "${RUN_MIGRATIONS_ON_STARTUP:-1}" = "1" ] || [ "${RUN_MIGRATIONS_ON_STARTUP:-1}" = "true" ]; then
  python -m alembic upgrade head
fi

exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}"
