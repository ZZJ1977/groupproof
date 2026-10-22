"""邮件发送适配器（注册/学校验证/密码恢复三类用途 + 三语模板）。

- smtp：真实投递；支持 STARTTLS(587)、隐式 TLS/SSL(465)、none（仅隔离环境）；
  只有 SMTP 服务接受发送请求才返回成功。
- resend：通过 Resend HTTPS API 投递（Railway Free 可用）；同一逻辑邮件的网络重试使用相同幂等键，
  用户主动重发新验证码使用新的发送标识（PLAN 三、4）。
- capture：隔离开发/测试邮件捕获器（写 email_outbox 供测试读取）；APP_MODE=real 禁止。
- 邮件发送失败只关闭依赖邮件的操作（返回 MAIL_UNAVAILABLE），不跳过验证、不伪造发送成功。
- 日志只记录请求标识/邮件用途/服务商消息 ID，不记录验证码、恢复令牌或 API Key。
"""

from __future__ import annotations

import hashlib
import logging
import smtplib
import time
from email.message import EmailMessage

import httpx

from ..config import get_settings
from ..db import get_session_factory
from ..models import EmailOutbox, utcnow

logger = logging.getLogger("groupproof.auth.mail")

# 有限重试：仅临时网络/服务端错误；密钥/域名/额度/限流错误停止重试并记录原因
RESEND_MAX_ATTEMPTS = 3

_sleep = time.sleep


def _resend_post(url: str, payload: dict, headers: dict, timeout: int):
    """测试可替换的发送缝隙（不暴露密钥/正文到日志）。"""
    with httpx.Client(timeout=timeout) as client:
        return client.post(url, json=payload, headers=headers)


PURPOSES = (
    "registration_code",
    "school_verification_code",
    "password_recovery_link",
    "login_email_code",
    "password_changed_notice",
)


class MailSendError(Exception):
    pass


def _templates(purpose: str, locale: str, **params: object) -> tuple[str, str]:
    """邮件模板随语言偏好变化；不包含内部部署细节。"""
    url = params.get("resetUrl", "")
    code = params.get("code", "")
    email = params.get("email", "")
    table: dict[str, dict[str, tuple[str, str]]] = {
        "registration_code": {
            "zh-Hans": (
                "GroupProof 注册验证码",
                f"你正在注册 GroupProof 账户。验证码：{code}"
                f"（10 分钟内有效）。若非本人操作请忽略。",
            ),
            "zh-Hant": (
                "GroupProof 註冊驗證碼",
                f"你正在註冊 GroupProof 帳戶。驗證碼：{code}"
                f"（10 分鐘內有效）。若非本人操作請忽略。",
            ),
            "en": (
                "GroupProof registration code",
                f"You are registering a GroupProof account. Code: {code} "
                f"(valid for 10 minutes). If this wasn't you, ignore this email.",
            ),
        },
        "login_email_code": {
            "zh-Hans": (
                "GroupProof 登录邮箱验证码",
                f"你正在验证登录邮箱 {email}。验证码：{code}（10 分钟内有效）。",
            ),
            "zh-Hant": (
                "GroupProof 登入信箱驗證碼",
                f"你正在驗證登入信箱 {email}。驗證碼：{code}（10 分鐘內有效）。",
            ),
            "en": (
                "GroupProof login email code",
                f"You are verifying the login email {email}. Code: {code} (valid for 10 minutes).",
            ),
        },
        "school_verification_code": {
            "zh-Hans": (
                "GroupProof 学校邮箱验证码",
                f"你的学校邮箱验证码是 {code}，10 分钟内有效。若非本人操作请忽略。",
            ),
            "zh-Hant": (
                "GroupProof 學校信箱驗證碼",
                f"你的學校信箱驗證碼是 {code}，10 分鐘內有效。若非本人操作請忽略。",
            ),
            "en": (
                "GroupProof school email code",
                f"Your school email verification code is {code}, valid for 10 minutes.",
            ),
        },
        "password_recovery_link": {
            "zh-Hans": (
                "GroupProof 密码重置",
                f"点击下面的链接重置密码（20 分钟内有效，仅可使用一次）：{url}。"
                f"若非本人操作请忽略，你的密码不会被更改。",
            ),
            "zh-Hant": (
                "GroupProof 密碼重置",
                f"點擊下面的連結重設密碼（20 分鐘內有效，僅可使用一次）：{url}。"
                f"若非本人操作請忽略，你的密碼不會被更改。",
            ),
            "en": (
                "GroupProof password reset",
                f"Use this link to reset your password (valid 20 minutes, single use): {url}. "
                f"If this wasn't you, ignore it — your password stays unchanged.",
            ),
        },
        "password_changed_notice": {
            "zh-Hans": (
                "GroupProof 密码已更改",
                "你的账户密码刚刚被更改。若非本人操作，请立即通过“忘记密码”恢复并联系管理员。",
            ),
            "zh-Hant": (
                "GroupProof 密碼已更改",
                "你的帳戶密碼剛剛被更改。若非本人操作，請立即透過「忘記密碼」恢復並聯絡管理員。",
            ),
            "en": (
                "GroupProof password changed",
                "Your account password was just changed. If this wasn't you, "
                "recover access via “Forgot password” and contact an administrator.",
            ),
        },
    }
    localized = table.get(purpose, {}).get(locale) or table[purpose]["zh-Hans"]
    return localized


def send_template(
    purpose: str, to_email: str, locale: str | None = "zh-Hans", **params: object
) -> None:
    if purpose not in PURPOSES:
        raise ValueError(f"unknown purpose: {purpose}")
    subject, body = _templates(purpose, locale or "zh-Hans", **params)
    send_email(to_email, subject, body, purpose=purpose)


def send_email(to_email: str, subject: str, body: str, purpose: str | None = None) -> None:
    settings = get_settings()
    if settings.mail_mode == "capture":
        if settings.is_real:
            raise RuntimeError("APP_MODE=real 禁止使用邮件捕获器")
        db = get_session_factory()()
        try:
            db.add(EmailOutbox(to_email=to_email, subject=subject, body=body, created_at=utcnow()))
            db.commit()
        finally:
            db.close()
        return

    if settings.mail_mode == "resend":
        _send_via_resend(to_email, subject, body, purpose)
        return

    msg = EmailMessage()
    msg["From"] = settings.mail_from
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.set_content(body)
    try:
        if settings.smtp_tls_mode == "implicit":
            with smtplib.SMTP_SSL(
                settings.smtp_host, settings.smtp_port, timeout=settings.smtp_timeout_seconds
            ) as smtp:
                if settings.smtp_user:
                    smtp.login(settings.smtp_user, settings.smtp_password)
                smtp.send_message(msg)
        else:
            with smtplib.SMTP(
                settings.smtp_host, settings.smtp_port, timeout=settings.smtp_timeout_seconds
            ) as smtp:
                if settings.smtp_tls_mode == "starttls":
                    smtp.starttls()
                if settings.smtp_user:
                    smtp.login(settings.smtp_user, settings.smtp_password)
                smtp.send_message(msg)
    except Exception as exc:  # noqa: BLE001 - 统一转换为发送失败（不静默回退）
        raise MailSendError(f"{type(exc).__name__}: {str(exc)[:160]}") from exc


def _send_via_resend(to_email: str, subject: str, body: str, purpose: str | None) -> None:
    """Resend HTTPS API 投递（PLAN 三、4）。

    - 幂等键由同一逻辑邮件内容推导：同码重试同键；用户重发新验证码/新链接为新键；
    - 临时网络/5xx 有限重试；429 限流与密钥/域名/额度类错误停止重试并记录原因；
    - 服务端接受发送 ≠ 用户已收到；能力判断见 config.mail_publicly_available。
    """
    settings = get_settings()
    idempotency_key = hashlib.sha256(f"{to_email}|{subject}|{body}".encode()).hexdigest()
    payload = {"from": settings.mail_from, "to": [to_email], "subject": subject, "text": body}
    headers = {
        "Authorization": f"Bearer {settings.resend_api_key}",
        "Idempotency-Key": idempotency_key,
    }
    last_error = ""
    for attempt in range(1, RESEND_MAX_ATTEMPTS + 1):
        try:
            response = _resend_post(
                settings.resend_api_url, payload, headers, settings.resend_timeout_seconds
            )
        except Exception as exc:  # noqa: BLE001 - 网络/超时类临时错误，有限重试
            last_error = f"{type(exc).__name__}: {str(exc)[:160]}"
            logger.warning(
                "resend attempt=%s purpose=%s network_error=%s", attempt, purpose, last_error
            )
            if attempt < RESEND_MAX_ATTEMPTS:
                _sleep(min(2**attempt, 5))
                continue
            raise MailSendError(last_error) from exc

        status = getattr(response, "status_code", 0)
        if 200 <= status < 300:
            message_id = ""
            try:
                message_id = str((response.json() or {}).get("id", ""))
            except Exception:  # noqa: BLE001 - 消息 ID 仅用于日志，解析失败不影响成功判断
                message_id = ""
            logger.info(
                "resend accepted purpose=%s message_id=%s", purpose, message_id or "(unknown)"
            )
            return
        if status == 429 or 400 <= status < 500:
            # 密钥/域名/额度/限流错误：停止重试并记录原因（不记录 API Key）
            logger.error("resend rejected purpose=%s status=%s（停止重试）", purpose, status)
            raise MailSendError(f"resend_http_{status}")
        last_error = f"resend_http_{status}"
        logger.warning("resend attempt=%s purpose=%s status=%s", attempt, purpose, status)
        if attempt < RESEND_MAX_ATTEMPTS:
            _sleep(min(2**attempt, 5))
            continue
    raise MailSendError(last_error or "resend_failed")


# 兼容旧调用（学校邮箱验证码）；新代码使用 send_template
def send_code_email(to_email: str, code: str, locale: str | None = "zh-Hans") -> None:
    send_template("school_verification_code", to_email, locale, code=code)
