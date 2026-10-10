"""CLI：受控初始化初始管理员（服务端执行；真实凭据经环境/命令行提供，不写入代码或文档）。

用法（部署负责人）：
    DATABASE_URL=... ./.venv/bin/python -m scripts.bootstrap_admin \
        --google-sub <Google sub> --name "管理员" --username admin1 --school-email admin@must.edu.mo
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db import get_session_factory  # noqa: E402
from app.services.bootstrap import bootstrap_admin  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="受控初始化 GroupProof 初始管理员")
    parser.add_argument("--google-sub", required=True, help="Google OIDC sub（不是邮箱）")
    parser.add_argument("--google-issuer", default="https://accounts.google.com")
    parser.add_argument("--name", required=True)
    parser.add_argument("--username", required=True)
    parser.add_argument("--school-email", required=True)
    args = parser.parse_args()
    db = get_session_factory()()
    try:
        user = bootstrap_admin(
            db,
            google_subject=args.google_sub,
            google_issuer=args.google_issuer,
            name=args.name,
            username=args.username,
            school_email=args.school_email,
        )
    finally:
        db.close()
    print(f"已开通初始管理员：{user.id}（事件已写入 auth_audit_events）")


if __name__ == "__main__":
    main()
