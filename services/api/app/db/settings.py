from __future__ import annotations

import os

DEFAULT_DATABASE_URL = "postgresql+psycopg://groupproof:groupproof-local@localhost:5432/groupproof"
DEFAULT_DATABASE_TIMEZONE = "Asia/Shanghai"


def normalize_database_url(url: str) -> str:
    """Make Compose's generic PostgreSQL URL explicit for psycopg 3."""

    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+psycopg://", 1)
    return url


def get_database_url(raw_url: str | None = None) -> str:
    url = raw_url or os.getenv("DATABASE_URL") or DEFAULT_DATABASE_URL
    return normalize_database_url(url)


def get_database_timezone() -> str:
    return os.getenv("DATABASE_TIMEZONE", DEFAULT_DATABASE_TIMEZONE)
