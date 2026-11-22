"""CLI entrypoint for controlled initial administrator provisioning.

Usage (from services/api):
  python -m scripts.bootstrap_admin \
    --name "系统管理员" \
    --username admin \
    --school-email admin@must.edu.mo \
    --password "<strong-password>" \
    [--login-email admin@example.com] \
    [--google-sub "<google-oidc-sub>"]
"""

from __future__ import annotations

import argparse
import json
import sys

from app.auth.services.bootstrap import bootstrap_admin
from app.db.session import SessionLocal


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Provision or promote a GroupProof administrator.")
    parser.add_argument("--name", required=True, help="Display name of the administrator")
    parser.add_argument("--username", required=True, help="Unique username (2-32 ASCII chars)")
    parser.add_argument(
        "--school-email",
        required=True,
        help="Institutional email matching TEACHER_EMAIL_DOMAIN",
    )
    parser.add_argument("--login-email", default=None, help="Optional password login email")
    parser.add_argument("--password", default=None, help="Initial password (>= 8 chars)")
    parser.add_argument("--google-sub", default=None, help="Google OIDC subject identifier")
    parser.add_argument(
        "--google-issuer",
        default="https://accounts.google.com",
        help="OIDC issuer URL",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if not args.password and not args.google_sub:
        print("Error: provide at least one of --password or --google-sub.", file=sys.stderr)
        return 2
    with SessionLocal() as session:
        user = bootstrap_admin(
            session,
            name=args.name,
            username=args.username,
            school_email=args.school_email,
            login_email=args.login_email,
            password=args.password,
            google_subject=args.google_sub,
            google_issuer=args.google_issuer,
        )
        print(
            json.dumps(
                {
                    "id": str(user.id),
                    "username": user.username,
                    "school_email": args.school_email.strip().lower(),
                    "global_role": user.global_role,
                    "status": user.status,
                },
                ensure_ascii=False,
            )
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
