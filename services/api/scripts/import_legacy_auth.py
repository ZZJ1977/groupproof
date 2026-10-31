"""本地旧认证数据导入命令（PLAN 二、2 / 实施顺序 2）。

从独立 server/ 的旧数据库读取用户与认证附属数据，导入团队数据库（统一 UUID 身份）。

安全边界：
- APP_MODE=real 时拒绝执行（本地认证数据只导入测试环境）；
- 默认 --dry-run 预演，不写入任何数据；确认后再加 --apply；
- 执行前请备份目标数据库（PLAN：导入前备份、预演）；
- 旧会话不导入：切换认证实现时旧会话一律作废（撤销由 cutover 流程处理）；
- 账号冲突暂停该账号导入并输出报告，不自动合并。

用法：
    python scripts/import_legacy_auth.py --legacy-database-url postgresql+psycopg://... [--apply]
"""

from __future__ import annotations

import argparse
import sys
from typing import Any

from sqlalchemy import create_engine, text


def _fetch_rows(engine, query: str) -> list[dict[str, Any]]:
    with engine.connect() as connection:
        return [dict(row._mapping) for row in connection.execute(text(query))]


def load_legacy_rows(engine) -> list:
    from app.auth.legacy_import import LegacyUserRow

    users = _fetch_rows(engine, "SELECT * FROM users ORDER BY created_at")
    credentials = {
        row["user_id"]: row for row in _fetch_rows(engine, "SELECT * FROM password_credentials")
    }
    bindings = {
        row["user_id"]: row for row in _fetch_rows(engine, "SELECT * FROM school_email_bindings")
    }
    identities: dict[str, list[dict[str, Any]]] = {}
    for row in _fetch_rows(engine, "SELECT * FROM auth_identities"):
        identities.setdefault(row["user_id"], []).append(row)
    checks: dict[str, list[dict[str, Any]]] = {}
    for row in _fetch_rows(engine, "SELECT * FROM academic_identity_checks"):
        checks.setdefault(row["user_id"], []).append(row)
    applications: dict[str, list[dict[str, Any]]] = {}
    for row in _fetch_rows(engine, "SELECT * FROM teacher_applications"):
        applications.setdefault(row["user_id"], []).append(row)
    events: dict[str, list[dict[str, Any]]] = {}
    for row in _fetch_rows(engine, "SELECT * FROM auth_audit_events"):
        events.setdefault(row.get("target_user_id"), []).append(row)

    return [
        LegacyUserRow(
            user=user,
            credential=credentials.get(user["id"]),
            email_binding=bindings.get(user["id"]),
            identities=identities.get(user["id"], []),
            academic_checks=checks.get(user["id"], []),
            teacher_applications=applications.get(user["id"], []),
            audit_events=events.get(user["id"], []),
        )
        for user in users
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description="Import legacy standalone auth data.")
    parser.add_argument("--legacy-database-url", required=True)
    parser.add_argument(
        "--source", default="standalone-server", help="来源标识（写入 auth_legacy_id_map）"
    )
    parser.add_argument("--apply", action="store_true", help="真正写入（默认 dry-run 预演）")
    args = parser.parse_args()

    from app.auth.config import get_settings
    from app.auth.legacy_import import import_legacy_users
    from app.db.session import SessionLocal

    settings = get_settings()
    if settings.is_real:
        print("APP_MODE=real 拒绝导入本地旧数据（本地认证数据只导入测试环境）。")
        return 2

    legacy_engine = create_engine(args.legacy_database_url, pool_pre_ping=True)
    rows = load_legacy_rows(legacy_engine)
    dry_run = not args.apply
    print(f"loaded legacy users: {len(rows)} (dry_run={dry_run})")

    with SessionLocal() as session:
        report = import_legacy_users(session, source=args.source, rows=rows, dry_run=dry_run)
        if not dry_run:
            session.commit()

    print(f"summary: {report.summary()}")
    for conflict in report.conflicts:
        print(f"conflict (paused, not merged): {conflict}")
    if dry_run:
        print("dry-run：未写入任何数据。确认无误后加 --apply 执行（先备份目标数据库）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
