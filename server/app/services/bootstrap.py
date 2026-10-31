"""受控初始化：初始管理员开通（可审计，不提供公开的管理员注册入口）。

仅限部署负责人在服务端执行；绑定指定 Google 身份并完成资料/学校邮箱验证记录。
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy.orm import Session as DbSession

from ..models import SchoolEmailBinding, User, utcnow
from ..security import check_email_format, normalize_username, validate_name, validate_username
from ..services import audit
from ..security import new_token


def bootstrap_admin(
    db: DbSession,
    *,
    google_subject: str,
    google_issuer: str = "https://accounts.google.com",
    name: str,
    username: str,
    school_email: str,
) -> User:
    from ..models import AuthIdentity

    normalized_email = check_email_format(school_email)
    user = User(
        id=new_token()[:32],
        name=validate_name(name),
        username=validate_username(username),
        username_normalized=normalize_username(username),
        roles=["admin"],
        account_status="enabled",
    )
    db.add(user)
    db.add(
        AuthIdentity(
            id=new_token()[:32],
            provider="google",
            issuer=google_issuer,
            subject=google_subject,
            user_id=user.id,
            created_at=utcnow(),
        )
    )
    db.add(
        SchoolEmailBinding(
            user_id=user.id,
            school_email=school_email.strip(),
            school_email_normalized=normalized_email,
            verified_at=utcnow(),
            verification_method="documented_manual_review",  # 受控初始化的人工确认依据
        )
    )
    audit.record(db, "admin.bootstrapped", actor_id="system", target_user_id=user.id, changed_fields=["roles"])
    db.commit()
    return user
