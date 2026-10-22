"""统一错误契约：code + 可翻译参数 + fieldErrors + requestId + retryAfterSeconds。

前端按 code 翻译，不匹配后端文案；服务端错误按层级分类记录，内部堆栈不回传。
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
    "SERVICE_UNAVAILABLE",
    "INVALID_CREDENTIALS",
    "INTERNAL_ERROR",
    "REGISTRATION_CLOSED",
    "MAIL_UNAVAILABLE",
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
    body: dict[str, Any] = {
        "code": exc.code,
        "params": exc.params,
        "requestId": getattr(request.state, "request_id", None),
    }
    if exc.field_errors:
        body["fieldErrors"] = exc.field_errors
    if exc.retry_after_seconds is not None:
        body["retryAfterSeconds"] = exc.retry_after_seconds
    return body


async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
    headers = {"Cache-Control": "private, no-store"}
    if exc.retry_after_seconds is not None:
        headers["Retry-After"] = str(exc.retry_after_seconds)
    return JSONResponse(error_payload(exc, request), status_code=exc.status, headers=headers)
