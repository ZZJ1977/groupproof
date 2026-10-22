"""通道能力入口（自独立 server/app/main.py 迁移）：

只返回各入口 enabled/available，不暴露密钥或内部地址。"""

from __future__ import annotations

from fastapi import APIRouter

from ..config import get_settings
from ..envelope import EnvelopeRoute, JSONResponse
from ..services import acceptance

router = APIRouter(tags=["auth"], route_class=EnvelopeRoute)


@router.get("/api/v1/auth/capabilities")
def capabilities() -> JSONResponse:
    settings = get_settings()
    return JSONResponse(
        {
            "google": {
                "enabled": settings.auth_google_enabled,
                "available": settings.google_available,
            },
            "password": {
                "enabled": settings.auth_password_enabled,
                "available": settings.auth_password_enabled,
            },
            "emailSignup": {
                "enabled": settings.auth_email_signup_enabled,
                "available": settings.email_signup_available,
            },
            "passwordReset": {
                "enabled": settings.auth_password_reset_enabled,
                "available": settings.password_reset_available,
            },
            "schoolEmailVerification": {
                "enabled": True,
                "available": settings.mail_publicly_available,
            },
            # 验收密令（仅非 real）：告知前端测试入口/测试验证码是否可用
            "acceptanceTest": {"enabled": acceptance.enabled()},
        },
        headers={"Cache-Control": "private, no-store"},
    )
