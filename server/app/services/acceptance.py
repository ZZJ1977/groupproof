"""验收用临时测试入口（仅非 real 模式）。

`ACCEPTANCE_TEST_TOKEN` 配置后（且 APP_MODE != real）：
- 注册弹窗“登录邮箱”输入该密令：直接开通全新测试账户并返回会话，前端进入信息完善页（/account/profile）；
- 学校邮箱验证码输入该密令：跳过发码/消费，直接确认当前待验证学校邮箱。

安全边界：
- APP_MODE=real 配置该密令会在启动时直接失败（config.Settings._check）；
- 未配置（默认）时本模块整体失效，一切走真实发码/验证流程；
- 建档与绑定都走真实落库路径（users/password_credentials/school_email_bindings），
  之后的注册资格、门禁与资源权限与真实用户完全一致；
- 每次进入都是全新账户；用户名在资料页可见（testXXXXXX），密码=密令，便于退出重登验收。
验收结束后应删除 .env 中的 ACCEPTANCE_TEST_TOKEN。
"""
from __future__ import annotations

import secrets

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from ..config import get_settings
from ..models import PasswordCredential, User, utcnow
from ..security import hash_password, new_token, normalize_username
from .sessions import IssuedSession


def enabled() -> bool:
    settings = get_settings()
    return bool(settings.acceptance_test_token) and not settings.is_real


def token_ok(value: str | None) -> bool:
    settings = get_settings()
    return enabled() and (value or "").strip() == settings.acceptance_test_token


def _unique_username(db: DbSession) -> str:
    for _ in range(8):
        candidate = f"test{secrets.randbelow(1_000_000):06d}"
        exists = db.execute(select(User).where(User.username_normalized == normalize_username(candidate))).scalar_one_or_none()
        if exists is None:
            return candidate
    raise RuntimeError("无法为验收账户分配唯一用户名")


def create_test_account(db: DbSession) -> tuple[User, IssuedSession]:
    """开通全新测试账户并签发受限会话（与真实建档同一落库路径）。"""
    from .pre_registration import issue_onboarding_session
    from .sessions import current_facts

    settings = get_settings()
    now = utcnow()
    username = _unique_username(db)
    login_email = f"acceptance-{new_token()[:10].lower()}@acceptance.test"
    user = User(
        id=new_token()[:32],
        username=username,
        username_normalized=normalize_username(username),
        account_status="enabled",
    )
    credential = PasswordCredential(
        user_id=user.id,
        login_email=login_email,
        login_email_normalized=login_email.lower(),
        login_email_verified_at=now,  # 测试账户登录邮箱视为已验证（账号安全可选项在注册时即满足）
        verification_evidence_ref="acceptance-test-entry",
        credential_version=1,
        password_hash=hash_password(settings.acceptance_test_token),
        password_algo="argon2id",
    )
    db.add(user)
    db.add(credential)
    db.flush()
    facts = current_facts(db, user)
    issued = issue_onboarding_session(db, user, facts)
    from . import audit

    audit.record(db, "auth.acceptance_test_entry", actor_id=user.id, changed_fields=["users", "password_credentials"])
    return user, issued
