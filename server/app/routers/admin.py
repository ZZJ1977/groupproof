"""管理员治理接口：教师审核、账号停用（§7.6）。真实管理员由受控初始化流程开通。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from ..db import get_db
from ..errors import AppError
from ..guard import AuthContext, check_csrf, require_admin
from ..models import TeacherApplication
from ..services import accounts

router = APIRouter(prefix="/api/v1/admin", tags=["admin"])


class ReviewIn(BaseModel):
    decision: str  # approve | reject
    reason: str | None = None
    expectedVersion: int


class DisableIn(BaseModel):
    reason: str | None = None
    expectedVersion: int


@router.get("/teacher-applications")
def list_teacher_applications(request: Request, context: AuthContext = Depends(require_admin), db: DbSession = Depends(get_db)) -> JSONResponse:
    rows = list(db.execute(select(TeacherApplication).where(TeacherApplication.status == "pending")).scalars())
    return JSONResponse(
        {
            "items": [
                {
                    "id": row.id,
                    "userId": row.user_id,
                    "applicationVersion": row.application_version,
                    "status": row.status,
                    "createdAt": row.created_at.isoformat(),
                    # 审核页面只返回必要记录，不含会话凭据/验证码/完整用户库
                    "basis": {"name": row.snapshot.get("name"), "schoolEmailDomain": (row.snapshot.get("schoolEmailNormalized") or "").rsplit("@", 1)[-1]},
                }
                for row in rows
            ]
        },
        headers={"Cache-Control": "private, no-store"},
    )


@router.post("/teacher-applications/{application_id}/review")
def review(application_id: str, body: ReviewIn, request: Request, context: AuthContext = Depends(require_admin), db: DbSession = Depends(get_db)) -> JSONResponse:
    check_csrf(request, context)
    if body.decision not in ("approve", "reject"):
        raise AppError("VALIDATION_ERROR", 400, field_errors={"decision": "invalid_decision"})
    app = db.get(TeacherApplication, application_id)
    if app is None:
        raise AppError("NOT_FOUND", 404)
    accounts.review_teacher_application(
        db, app, reviewer=context.user, decision=body.decision, reason=body.reason, expected_version=body.expectedVersion
    )
    db.commit()
    return JSONResponse({"id": app.id, "status": app.status}, headers={"Cache-Control": "private, no-store"})


@router.post("/users/{user_id}/disable")
def disable_user(user_id: str, body: DisableIn, request: Request, context: AuthContext = Depends(require_admin), db: DbSession = Depends(get_db)) -> JSONResponse:
    check_csrf(request, context)
    from ..models import User

    user = db.get(User, user_id)
    if user is None:
        raise AppError("NOT_FOUND", 404)
    accounts.disable_user(db, user, admin=context.user, reason=body.reason, expected_version=body.expectedVersion)
    db.commit()
    return JSONResponse({"id": user.id, "accountState": "disabled"}, headers={"Cache-Control": "private, no-store"})
