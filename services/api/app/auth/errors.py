"""统一错误契约（自独立 server/app/errors.py 迁移）：

code + 可翻译参数 + fieldErrors + retryAfterSeconds。

响应体适配团队统一封装（PLAN 二、3）：
{"error": {"code", "message", "details"}, "meta": {"request_id"}}
details 携带 params / fieldErrors / retryAfterSeconds，前端按 code 翻译，不匹配后端文案。
"""

from __future__ import annotations

from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse

ERROR_CODES = {
    "UNAUTHENTICATED",
    "REGISTRATION_REQUIRED",
    "TEACHER_REVIEW_PENDING",
    "TEACHER_REVIEW_REJECTED",
    "ACCOUNT_DISABLED",
    "FORBIDDEN",
    "INVALID_CODE",
    "CODE_EXPIRED",
    "RATE_LIMITED",
    "EMAIL_CONFLICT",
    "USERNAME_CONFLICT",
    "VERSION_CONFLICT",
    "AUTH_UNAVAILABLE",
    "VALIDATION_ERROR",
    "NOT_FOUND",
    "INVALID_STATE",
    "CHALLENGE_INVALID",
    "REAUTH_REQUIRED",
    "IDENTITY_ALREADY_LINKED",
    "LAST_SIGN_IN_METHOD",
    "SERVICE_UNAVAILABLE",
    "INVALID_CREDENTIALS",
    "INTERNAL_ERROR",
    "REGISTRATION_CLOSED",
    "MAIL_UNAVAILABLE",
}

DEFAULT_MESSAGES = {
    "UNAUTHENTICATED": "Authentication is required.",
    "REGISTRATION_REQUIRED": "Complete the required registration steps first.",
    "TEACHER_REVIEW_PENDING": "The teacher application is pending review.",
    "TEACHER_REVIEW_REJECTED": "The teacher application was rejected.",
    "ACCOUNT_DISABLED": "The account is disabled.",
    "FORBIDDEN": "You do not have permission for this action.",
    "INVALID_CODE": "The verification code is invalid.",
    "CODE_EXPIRED": "The verification code has expired.",
    "RATE_LIMITED": "Too many requests. Try again later.",
    "EMAIL_CONFLICT": "The email is already in use.",
    "USERNAME_CONFLICT": "The username is already in use.",
    "VERSION_CONFLICT": "The record changed. Reload and try again.",
    "AUTH_UNAVAILABLE": "Authentication service is unavailable.",
    "VALIDATION_ERROR": "The submitted data is invalid.",
    "NOT_FOUND": "The requested resource was not found.",
    "INVALID_STATE": "The current state does not allow this action.",
    "CHALLENGE_INVALID": "The verification challenge is invalid.",
    "REAUTH_REQUIRED": "Recent sign-in is required for this change.",
    "IDENTITY_ALREADY_LINKED": "A Google account is already linked to this user.",
    "LAST_SIGN_IN_METHOD": "Set a password with a verified login email before removing it.",
    "SERVICE_UNAVAILABLE": "The service is temporarily unavailable.",
    "INVALID_CREDENTIALS": "The credentials are invalid.",
    "INTERNAL_ERROR": "An internal error occurred.",
    "REGISTRATION_CLOSED": "Registration is currently closed.",
    "MAIL_UNAVAILABLE": "Mail delivery is unavailable.",
}


class AppError(Exception):
    def __init__(
        self,
        code: str,
        status: int = 400,
        params: dict[str, Any] | None = None,
        field_errors: dict[str, str] | None = None,
        retry_after_seconds: int | None = None,
    ) -> None:
        assert code in ERROR_CODES, f"未登记的错误码：{code}"
        self.code = code
        self.status = status
        self.params = params or {}
        self.field_errors = field_errors or {}
        self.retry_after_seconds = retry_after_seconds


def error_payload(exc: AppError, request: Request) -> dict[str, Any]:
    """渲染团队统一错误封装；params/fieldErrors/retryAfterSeconds 保留在 details 中。"""
    details: dict[str, Any] = {}
    if exc.params:
        details["params"] = exc.params
    if exc.field_errors:
        details["fieldErrors"] = exc.field_errors
    if exc.retry_after_seconds is not None:
        details["retryAfterSeconds"] = exc.retry_after_seconds
    return {
        "error": {
            "code": exc.code,
            "message": DEFAULT_MESSAGES.get(exc.code, "Request failed."),
            "details": details or None,
        },
        "meta": {"request_id": getattr(request.state, "request_id", None)},
    }


async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
    headers = {"Cache-Control": "private, no-store"}
    if exc.retry_after_seconds is not None:
        headers["Retry-After"] = str(exc.retry_after_seconds)
    return JSONResponse(error_payload(exc, request), status_code=exc.status, headers=headers)
