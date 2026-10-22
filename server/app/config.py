"""运行配置。

- 环境变量优先；本地 .env 使用明确的稳定路径（仓库根目录），不随启动目录漂移。
- 空环境变量视为未设置，不覆盖默认值。
- 提供方开关（Google / 密码登录 / 邮箱注册 / 密码重置）与核心依赖（数据库、HTTPS、核心密钥）分离：
  可选提供方缺失只关闭对应入口，不阻断整个后端，也不影响其他通道。
- APP_MODE=real 时核心依赖缺失直接启动失败；真实凭据只来自部署环境。
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

AppMode = Literal["real", "dev", "mock"]

# 仓库根目录 .env（稳定路径；可用 GROUPPROOF_ENV_FILE 覆盖）
_REPO_ROOT = Path(__file__).resolve().parents[2]
_DEFAULT_ENV_FILE = Path(__import__("os").environ.get("GROUPPROOF_ENV_FILE") or (_REPO_ROOT / ".env"))

# 本地隔离开发默认值（仅 dev/mock；real 模式必须显式配置）
_DEV_DATABASE_URL = "postgresql+psycopg://gp:gp_test_pw@localhost:55432/gp_dev"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=str(_DEFAULT_ENV_FILE), env_file_encoding="utf-8", extra="ignore")

    # --- 应用 ---
    app_mode: AppMode = "dev"
    app_origin: str = "http://localhost:3000"
    api_internal_url: str = "http://localhost:8000"
    debug_endpoints: bool = False  # 仅隔离测试环境可开启；real 模式强制关闭
    # --- 验收用临时密令（仅非 real）：注册直达资料页 / 验证码直通；验收后必须删除 ---
    acceptance_test_token: str = ""

    # --- 数据库（核心依赖）---
    database_url: str = _DEV_DATABASE_URL

    # --- 提供方开关（待新增配置；默认密码/邮箱通道开，Google 需配置后可用）---
    auth_google_enabled: bool = True
    auth_password_enabled: bool = True
    auth_email_signup_enabled: bool = True
    auth_password_reset_enabled: bool = True

    # --- Google OIDC（可选提供方）---
    google_client_id: str = ""
    google_client_secret: str = ""
    google_redirect_uri: str = ""
    google_discovery_url: str = "https://accounts.google.com/.well-known/openid-configuration"
    google_expected_issuer: str = "https://accounts.google.com"

    # --- 邮件（依赖邮件的操作：注册/学校验证/密码重置）---
    # smtp: 真实投递；capture: 仅隔离开发/测试环境的邮件捕获器（生产禁止）
    mail_mode: Literal["smtp", "capture"] = "capture"
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_tls_mode: Literal["starttls", "implicit", "none"] = "starttls"
    smtp_timeout_seconds: int = 15
    mail_from: str = ""
    capture_dir: str = ".mail-capture"

    # --- 验证码 / 会话密钥（核心依赖）---
    email_challenge_hmac_key: str = ""

    # --- 学校邮箱与学号规则（上线前须由学校确认）---
    student_email_domain: str = "student.must.edu.mo"
    teacher_email_domain: str = "must.edu.mo"
    student_id_pattern: str = r"^\S{4,20}$"
    student_id_email_rule: Literal["none", "match_prefix"] = "none"

    # --- 业务数据来源（P2 未完成项）---
    # dev/test：隔离演示数据集路径；real 未接入真实业务存储时业务接口返回 SERVICE_UNAVAILABLE
    business_data_file: str = ""

    # --- 会话期限（产品参数，秒）---
    session_onboarding_idle: int = 30 * 60
    session_onboarding_absolute: int = 12 * 3600
    session_full_idle: int = 2 * 3600
    session_full_absolute: int = 7 * 24 * 3600
    session_admin_idle: int = 30 * 60
    session_admin_absolute: int = 12 * 3600
    recent_auth_window: int = 10 * 60  # 敏感换绑要求的近期重新认证窗口

    # --- 邮箱验证码 / 注册事务 ---
    code_ttl_seconds: int = 10 * 60
    code_max_attempts: int = 5
    resend_cooldown_seconds: int = 60
    code_send_per_hour: int = 5
    code_send_per_day: int = 20
    pre_registration_ttl_seconds: int = 10 * 60  # 建档资格时限
    password_reset_ttl_seconds: int = 20 * 60  # 恢复凭据时限

    # --- OAuth 事务 ---
    oauth_transaction_ttl: int = 10 * 60

    public_prefixes: tuple[str, ...] = ("/api/v1/auth/google", "/api/v1/auth/session", "/api/v1/auth/logout")

    # --- 派生可用性（不入库）---

    @property
    def is_real(self) -> bool:
        return self.app_mode == "real"

    @property
    def google_available(self) -> bool:
        return self.auth_google_enabled and bool(self.google_client_id and self.google_client_secret and self.google_redirect_uri)

    @property
    def mail_configured(self) -> bool:
        return self.mail_mode == "capture" and not self.is_real or (self.mail_mode == "smtp" and bool(self.smtp_host and self.mail_from))

    @property
    def mail_available(self) -> bool:
        """运行期邮件能力：配置完整即认为可用；实际发送失败单独降级并记录。"""
        return self.mail_configured

    @property
    def email_signup_available(self) -> bool:
        return self.auth_email_signup_enabled and self.mail_available

    @property
    def password_reset_available(self) -> bool:
        return self.auth_password_reset_enabled and self.mail_available

    @property
    def session_cookie_name(self) -> str:
        # __Host- 前缀要求 Secure + Path=/ + 无 Domain（生产全站 HTTPS）
        return "__Host-gp_session" if self.is_real else "gp_session"

    @property
    def oauth_cookie_name(self) -> str:
        return "__Host-gp_oauth_state" if self.is_real else "gp_oauth_state"

    @property
    def pre_registration_cookie_name(self) -> str:
        return "__Host-gp_reg_tx" if self.is_real else "gp_reg_tx"

    @model_validator(mode="after")
    def _check(self) -> "Settings":
        # 空环境变量视为未设置（不覆盖默认值）
        if not self.database_url:
            self.database_url = _DEV_DATABASE_URL
        if not self.email_challenge_hmac_key:
            if self.is_real:
                raise RuntimeError("APP_MODE=real 必须配置 EMAIL_CHALLENGE_HMAC_KEY（生成：openssl rand -hex 32）")
            self.email_challenge_hmac_key = "dev-only-insecure-key"

        if self.is_real:
            # 核心依赖：数据库、HTTPS、核心密钥；缺失直接启动失败
            if not self.database_url or "localhost" in self.database_url and "5432" in self.database_url:
                raise RuntimeError("APP_MODE=real 必须配置真实 DATABASE_URL")
            if not self.app_origin.startswith("https://"):
                raise RuntimeError("APP_MODE=real 要求全站 HTTPS（APP_ORIGIN 必须是 https://）")
            if self.debug_endpoints:
                raise RuntimeError("APP_MODE=real 不允许开启 debug_endpoints")
            if self.acceptance_test_token:
                raise RuntimeError("APP_MODE=real 不允许配置 ACCEPTANCE_TEST_TOKEN（验收密令必须为空）")
            if self.mail_mode != "smtp":
                raise RuntimeError("APP_MODE=real 禁止邮件捕获器（MAIL_MODE 必须为 smtp）")

            # 可选提供方：仅在启用且配置不完整时拒绝启动（发布检查），不影响其他通道
            if self.auth_google_enabled and not self.google_available:
                raise RuntimeError(
                    "APP_MODE=real 且 AUTH_GOOGLE_ENABLED=true 时必须配置 GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI；"
                    "如暂不开放 Google，请设置 AUTH_GOOGLE_ENABLED=false"
                )
            if self.auth_google_enabled and (
                "accounts.google.com" not in self.google_discovery_url or self.google_expected_issuer != "https://accounts.google.com"
            ):
                raise RuntimeError("APP_MODE=real 的 OIDC 发现地址/issuer 必须指向 Google")
            if (self.auth_email_signup_enabled or self.auth_password_reset_enabled) and not self.mail_configured:
                raise RuntimeError(
                    "APP_MODE=real 且启用邮箱注册/密码重置时必须配置可用发件服务（MAIL_MODE=smtp 且 SMTP_HOST/MAIL_FROM 完整）；"
                    "如暂不开放，请设置 AUTH_EMAIL_SIGNUP_ENABLED=false / AUTH_PASSWORD_RESET_ENABLED=false"
                )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()


def config_source_summary() -> dict[str, str]:
    """启动时输出脱敏后的配置来源与数据库标识（不含凭据）。"""
    settings = get_settings()
    from urllib.parse import urlparse

    parsed = urlparse(settings.database_url.replace("postgresql+psycopg", "postgresql"))
    return {
        "envFile": str(_DEFAULT_ENV_FILE) if _DEFAULT_ENV_FILE.exists() else "(无，使用环境变量/默认值)",
        "appMode": settings.app_mode,
        "database": f"{parsed.username or '?'}@{parsed.hostname or '?'}:{parsed.port or 5432}{parsed.path or ''}",
        "mail": settings.mail_mode if settings.mail_configured else "未配置",
        "google": "可用" if settings.google_available else ("已启用但未配置" if settings.auth_google_enabled else "未启用"),
    }
