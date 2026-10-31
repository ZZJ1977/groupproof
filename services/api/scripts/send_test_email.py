"""受控测试发信命令（PLAN 三、3）：向 Resend 账号关联邮箱发送测试邮件。

用途：无域名阶段在测试环境做允许范围内的实际投递验证。
- 不提供公开的测试发信接口；本命令只在服务端手动执行；
- 收件地址必须来自显式参数（受控验证者），不得通过接口或参数篡改冒充给其他用户发信；
- 输出只包含发送结果与服务商消息 ID，不包含 API Key。

用法：
    python scripts/send_test_email.py --to you@example.com [--purpose registration_code]

MAIL_MODE=resend 且 RESEND_API_KEY/MAIL_FROM 配置完整时才会真正投递；
否则打印当前发信能力（configured/public）后退出，不伪造发送成功。
"""

from __future__ import annotations

import argparse
import logging
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description="Send a controlled test email (Resend).")
    parser.add_argument("--to", required=True, help="受控收件地址（须为 Resend 账号关联邮箱）")
    parser.add_argument(
        "--purpose",
        default="registration_code",
        choices=[
            "registration_code",
            "login_email_code",
            "school_verification_code",
            "password_recovery_link",
            "password_changed_notice",
        ],
    )
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    from app.auth.config import get_settings
    from app.auth.services.mailer import MailSendError, send_template

    settings = get_settings()
    print(f"mail_mode={settings.mail_mode}")
    print(f"mail_configured={settings.mail_configured}")
    print(f"mail_publicly_available={settings.mail_publicly_available}")
    if not settings.mail_configured:
        print("发信配置不完整，未发送。")
        return 2

    params: dict[str, object] = {}
    if settings.mail_mode == "resend":
        params["code"] = "000000"
        params["resetUrl"] = f"{settings.app_origin}/reset-password?token=test-only"
    try:
        send_template(args.purpose, args.to, "zh-Hans", **params)
    except MailSendError as exc:
        print(f"send failed: {exc}")
        return 1
    print("send accepted by provider（服务商接受 ≠ 收件人已收到；请在受控邮箱确认）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
