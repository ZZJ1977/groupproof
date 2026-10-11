from __future__ import annotations

from fastapi import Request
from pydantic import BaseModel


class ResponseMeta(BaseModel):
    request_id: str


class SuccessResponse[DataT](BaseModel):
    data: DataT
    meta: ResponseMeta


class ErrorBody(BaseModel):
    code: str
    message: str
    details: dict[str, object] | None = None


class ErrorResponse(BaseModel):
    error: ErrorBody
    meta: ResponseMeta


def success[DataT](data: DataT, request: Request) -> SuccessResponse[DataT]:
    """Return the shared envelope while retaining the route's typed data model."""

    return SuccessResponse(data=data, meta=ResponseMeta(request_id=request.state.request_id))
