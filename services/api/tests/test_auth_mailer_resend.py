"""Resend 发信适配器测试（PLAN 三、4：成功/拒绝/限流/超时/重复请求覆盖）。

不连接任何真实邮件服务：发送缝隙 _resend_post 使用测试替身。
"""

from __future__ import annotations

import hashlib
import logging

import pytest

from app.auth import security
from app.auth.config import Settings
from app.auth.services import mailer
from app.auth.services.registration import profile_field_errors


class FakeResponse:
    def __init__(self, status_code: int, payload: dict | None = None) -> None:
        self.status_code = status_code
        self._payload = payload or {}

    def json(self) -> dict:
        return self._payload


class FakePoster:
    """记录调用并按脚本返回；可模拟网络异常。"""

    def __init__(self, *script: object) -> None:
        self.script = list(script)
        self.calls: list[dict] = []

    def __call__(self, url: str, payload: dict, headers: dict, timeout: int):
        self.calls.append({"url": url, "payload": payload, "headers": headers, "timeout": timeout})
        item = self.script.pop(0) if self.script else FakeResponse(200, {"id": "msg_ok"})
        if isinstance(item, Exception):
            raise item
        return item


@pytest.fixture()
def resend_env(monkeypatch):
    settings = Settings(
        app_mode="dev",
        mail_mode="resend",
        resend_api_key="test-key",
        mail_from="no-reply@test.example",
        mail_public_enabled=False,
        auth_email_signup_enabled=True,
        auth_password_reset_enabled=True,
    )
    sleeps: list[float] = []
    monkeypatch.setattr(mailer, "get_settings", lambda: settings)
    monkeypatch.setattr(mailer, "_sleep", sleeps.append)
    return settings, sleeps


def test_resend_success_uses_stable_idempotency_key_per_logical_email(resend_env, monkeypatch):
    poster = FakePoster()
    monkeypatch.setattr(mailer, "_resend_post", poster)

    mailer.send_email("user@test.example", "Code mail", "code 123456", purpose="registration_code")
    mailer.send_email("user@test.example", "Code mail", "code 123456", purpose="registration_code")

    assert len(poster.calls) == 2
    first, second = poster.calls
    expected = hashlib.sha256(b"user@test.example|Code mail|code 123456").hexdigest()
    assert first["headers"]["Idempotency-Key"] == expected
    # 同一逻辑邮件（同验证码）网络重试/重复发送使用相同幂等键
    assert second["headers"]["Idempotency-Key"] == expected

    # 用户主动重发新验证码 → 新的发送标识（不同幂等键）
    poster2 = FakePoster()
    monkeypatch.setattr(mailer, "_resend_post", poster2)
    mailer.send_email("user@test.example", "Code mail", "code 654321", purpose="registration_code")
    assert poster2.calls[0]["headers"]["Idempotency-Key"] != expected


def test_resend_client_error_stops_retry_and_records_reason(resend_env, monkeypatch):
    poster = FakePoster(FakeResponse(403, {"message": "domain not verified"}))
    monkeypatch.setattr(mailer, "_resend_post", poster)

    with pytest.raises(mailer.MailSendError) as excinfo:
        mailer.send_email("user@test.example", "subject", "body", purpose="registration_code")

    assert "403" in str(excinfo.value)
    assert len(poster.calls) == 1  # 密钥/域名类错误停止重试


def test_resend_rate_limit_stops_retry(resend_env, monkeypatch):
    poster = FakePoster(FakeResponse(429))
    monkeypatch.setattr(mailer, "_resend_post", poster)

    with pytest.raises(mailer.MailSendError):
        mailer.send_email("user@test.example", "subject", "body", purpose="registration_code")

    assert len(poster.calls) == 1


def test_resend_server_error_retries_then_fails(resend_env, monkeypatch):
    settings, sleeps = resend_env
    poster = FakePoster(FakeResponse(500), FakeResponse(500), FakeResponse(500))
    monkeypatch.setattr(mailer, "_resend_post", poster)

    with pytest.raises(mailer.MailSendError):
        mailer.send_email("user@test.example", "subject", "body", purpose="registration_code")

    assert len(poster.calls) == 3
    assert len(sleeps) == 2  # 有限重试


def test_resend_network_error_retries_then_fails(resend_env, monkeypatch):
    poster = FakePoster(TimeoutError("boom"), TimeoutError("boom"), TimeoutError("boom"))
    monkeypatch.setattr(mailer, "_resend_post", poster)

    with pytest.raises(mailer.MailSendError):
        mailer.send_email("user@test.example", "subject", "body", purpose="password_recovery_link")

    assert len(poster.calls) == 3


def test_public_mail_requires_explicit_enable() -> None:
    restricted = Settings(
        app_mode="dev",
        mail_mode="resend",
        resend_api_key="test-key",
        mail_from="no-reply@test.example",
        mail_public_enabled=False,
    )
    assert restricted.mail_configured is True
    assert restricted.mail_publicly_available is False
    assert restricted.email_signup_available is False
    assert restricted.password_reset_available is False

    opened = Settings(
        app_mode="dev",
        mail_mode="resend",
        resend_api_key="test-key",
        mail_from="no-reply@test.example",
        mail_public_enabled=True,
    )
    assert opened.mail_publicly_available is True
    assert opened.email_signup_available is True


def test_google_redirect_uri_matches_app_origin() -> None:
    settings = Settings(
        app_mode="dev",
        app_origin="http://localhost:3000",
        google_client_id="test-id",
        google_client_secret="test-secret",
        google_redirect_uri="http://localhost:3000/api/v1/auth/google/callback",
    )
    assert settings.google_configured is True


def test_real_mode_rejects_api_origin_google_redirect() -> None:
    with pytest.raises(RuntimeError, match="GOOGLE_REDIRECT_URI"):
        Settings(
            app_mode="real",
            database_url="postgresql+psycopg://u:p@db.example:5432/x",
            app_origin="https://app.example",
            email_challenge_hmac_key="test-key",
            auth_google_enabled=True,
            google_client_id="test-id",
            google_client_secret="test-secret",
            google_redirect_uri="https://api.example/api/v1/auth/google/callback",
            mail_mode="resend",
            resend_api_key="test-key",
            mail_from="no-reply@test.example",
            auth_email_signup_enabled=False,
            auth_password_reset_enabled=False,
        )


def test_dev_mode_only_warns_on_google_redirect_mismatch(caplog) -> None:
    with caplog.at_level(logging.WARNING):
        settings = Settings(
            app_mode="dev",
            app_origin="http://localhost:3000",
            google_client_id="test-id",
            google_client_secret="test-secret",
            google_redirect_uri="http://localhost:8000/api/v1/auth/google/callback",
        )
    assert settings.google_configured is True
    assert any("GOOGLE_REDIRECT_URI" in message for message in caplog.messages)


def test_env_file_defaults_to_repo_root() -> None:
    """回归：默认 .env 必须解析到仓库根目录（曾误指向 services/ 使 pydantic 读空配置）。"""
    from app.auth import config

    assert (config._REPO_ROOT / "services" / "api" / "app").is_dir()
    assert (config._REPO_ROOT / ".env.example").is_file()


def test_repo_root_handles_shallow_container_path() -> None:
    """回归：镜像内路径 /app/app/auth/config.py 上方不足 4 层，不得抛 IndexError。"""
    from pathlib import Path

    from app.auth import config

    assert config._repo_root(Path("/app/app/auth/config.py")) == Path("/")
    assert config._repo_root(Path("/r/services/api/app/auth/config.py")) == Path("/r")


def test_default_student_id_rules_accept_ten_digit_numeric(monkeypatch) -> None:
    """回归：默认学号规则（^\\S{4,20}$ / none）下，纯数字 10 位学号必须通过校验。"""
    monkeypatch.delenv("STUDENT_ID_PATTERN", raising=False)
    monkeypatch.delenv("STUDENT_ID_EMAIL_RULE", raising=False)
    settings = Settings(app_mode="dev")
    assert settings.student_id_pattern == r"^\S{4,20}$"
    assert settings.student_id_email_rule == "none"
    monkeypatch.setattr(security, "get_settings", lambda: settings)
    assert security.student_id_valid("1240025428", "1240025428@student.must.edu.mo") is True
    assert (
        profile_field_errors(
            name="测试同学",
            username="tester01",
            student_id="1240025428",
            requested_identity="student",
            school_email="1240025428@student.must.edu.mo",
        )
        == {}
    )


def test_real_mode_rejects_capture_mailer() -> None:
    with pytest.raises(RuntimeError):
        Settings(
            app_mode="real",
            database_url="postgresql+psycopg://u:p@db.example:5432/x",
            app_origin="https://app.example",
            email_challenge_hmac_key="test-key",
            mail_mode="capture",
            auth_google_enabled=False,
        )


def test_real_mode_resend_requires_key_and_from() -> None:
    with pytest.raises(RuntimeError):
        Settings(
            app_mode="real",
            database_url="postgresql+psycopg://u:p@db.example:5432/x",
            app_origin="https://app.example",
            email_challenge_hmac_key="test-key",
            mail_mode="resend",
            resend_api_key="",
            mail_from="no-reply@test.example",
            auth_google_enabled=False,
            auth_email_signup_enabled=False,
            auth_password_reset_enabled=False,
        )


# ---------------- Brevo（无需自有域名，只验证发件邮箱）----------------


@pytest.fixture()
def brevo_env(monkeypatch):
    settings = Settings(
        app_mode="dev",
        mail_mode="brevo",
        brevo_api_key="test-brevo-key",
        mail_from="GroupProof <sender@test.example>",
        mail_public_enabled=True,
    )
    sleeps: list[float] = []
    monkeypatch.setattr(mailer, "get_settings", lambda: settings)
    monkeypatch.setattr(mailer, "_sleep", sleeps.append)
    return settings, sleeps


def test_brevo_success_sends_expected_payload(brevo_env, monkeypatch):
    poster = FakePoster(FakeResponse(201, {"messageId": "<abc@smtp-relay>"}))
    monkeypatch.setattr(mailer, "_brevo_post", poster)

    mailer.send_email(
        "user@test.example", "subject", "body 123456", purpose="school_verification_code"
    )

    call = poster.calls[0]
    assert call["url"] == "https://api.brevo.com/v3/smtp/email"
    assert call["headers"]["api-key"] == "test-brevo-key"
    assert call["payload"]["sender"] == {"email": "sender@test.example", "name": "GroupProof"}
    assert call["payload"]["to"] == [{"email": "user@test.example"}]
    assert call["payload"]["textContent"] == "body 123456"


def test_brevo_client_error_stops_retry(brevo_env, monkeypatch):
    poster = FakePoster(FakeResponse(400, {"code": "invalid_parameter"}))
    monkeypatch.setattr(mailer, "_brevo_post", poster)

    with pytest.raises(mailer.MailSendError) as excinfo:
        mailer.send_email("user@test.example", "subject", "body", purpose="registration_code")

    assert "400" in str(excinfo.value)
    assert len(poster.calls) == 1


def test_brevo_server_error_retries_then_fails(brevo_env, monkeypatch):
    settings, sleeps = brevo_env
    poster = FakePoster(FakeResponse(500), FakeResponse(502), FakeResponse(503))
    monkeypatch.setattr(mailer, "_brevo_post", poster)

    with pytest.raises(mailer.MailSendError):
        mailer.send_email("user@test.example", "subject", "body", purpose="registration_code")

    assert len(poster.calls) == 3
    assert len(sleeps) == 2


def test_brevo_configuration_and_public_availability() -> None:
    incomplete = Settings(app_mode="dev", mail_mode="brevo", mail_from="a@test.example")
    assert not incomplete.mail_configured
    ready = Settings(
        app_mode="dev", mail_mode="brevo", brevo_api_key="k", mail_from="a@test.example"
    )
    assert ready.mail_configured
    assert not ready.mail_publicly_available
    public = Settings(
        app_mode="dev",
        mail_mode="brevo",
        brevo_api_key="k",
        mail_from="a@test.example",
        mail_public_enabled=True,
    )
    assert public.mail_publicly_available
