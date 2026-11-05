"""C7 治理 UI 的身份目录/停用/审核接口（基于统一认证服务，无 UUID 转译）。"""

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session as DbSession
from sqlalchemy.orm import aliased

from app.modules.c.school_email import has_verified_school_email, school_email_binding_verified

from ..db import get_db
from ..envelope import EnvelopeRoute, JSONResponse
from ..errors import AppError
from ..guard import AuthContext, check_csrf, require_admin
from ..models import SchoolEmailBinding, TeacherApplication, User
from ..services import accounts

router = APIRouter(prefix="/api/v1/c-admin", tags=["c-admin"], route_class=EnvelopeRoute)


def response(data):
    return JSONResponse(data, headers={"Cache-Control": "private, no-store"})


class IdentityDecision(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    reason: str = Field(min_length=1, max_length=2000)
    expectedVersion: int = Field(ge=1, strict=True)


class TeacherDecision(IdentityDecision):
    decision: str = Field(pattern="^(approve|reject)$")


class DisableDecision(IdentityDecision):
    # Canonical accounts start at lock_version=0. Teacher application versions
    # keep their independent positive-version contract above.
    expectedVersion: int = Field(ge=0, strict=True)


def directory_row(user, binding, actor):
    return {
        "id": user.id,
        "name": user.name or "",
        "studentId": user.student_id,
        "college": user.college or "",
        "roles": user.roles or [],
        "status": user.account_status,
        "version": user.version,
        "schoolEmail": binding.school_email if binding else None,
        "schoolEmailVerified": school_email_binding_verified(binding),
        "canDisable": user.id != actor.id and user.account_status != "disabled",
    }


def check_admin_write(request: Request, context: AuthContext, db: DbSession) -> None:
    check_csrf(request, context)
    if not has_verified_school_email(db, context.user, lock=True):
        raise AppError("REGISTRATION_REQUIRED", 403, params={"accountState": "email_required"})


@router.get("/users")
def users(
    request: Request,
    q: str = Query(default="", max_length=200),
    role: str = Query(default="", pattern="^(|student|teacher|ta|admin)$"),
    status: str = Query(default="", pattern="^(|enabled|disabled)$"),
    college: str = Query(default="", max_length=120),
    page: int = Query(default=1, ge=1, le=1_000_000),
    context: AuthContext = Depends(require_admin),
    db: DbSession = Depends(get_db),
):
    query = select(User, SchoolEmailBinding).outerjoin(
        SchoolEmailBinding, SchoolEmailBinding.user_id == User.id
    )
    if q.strip():
        term = "%" + q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        query = query.where(
            or_(
                User.name.ilike(term, escape="\\"),
                User.student_id.ilike(term, escape="\\"),
                SchoolEmailBinding.school_email.ilike(term, escape="\\"),
            )
        )
    if role:
        # 统一身份后角色存于 users.global_role（单一全局角色），不做子串搜索
        query = query.where(User.global_role == role)
    if status:
        # account_status is an instance property; comparing it in SQL yields false.
        query = query.where(
            User.status == "disabled" if status == "disabled" else User.status != "disabled"
        )
    if college.strip():
        query = query.where(User.college == college.strip())
    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    rows = db.execute(
        query.order_by(User.created_at.desc(), User.id).offset((page - 1) * 10).limit(10)
    )
    return response(
        {
            "items": [directory_row(u, b, context.user) for u, b in rows],
            "total": total,
            "page": page,
            "pageSize": 10,
        }
    )


@router.post("/users/{user_id}/disable")
def disable(
    user_id: str,
    body: DisableDecision,
    request: Request,
    context: AuthContext = Depends(require_admin),
    db: DbSession = Depends(get_db),
):
    check_admin_write(request, context, db)
    try:
        target_id = UUID(user_id)
    except ValueError:
        raise AppError("NOT_FOUND", 404) from None
    if target_id == context.user.id:
        raise AppError("FORBIDDEN", 403, params={"reason": "cannot_disable_self"})
    user = db.scalar(
        select(User)
        .where(User.id == target_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if user is None:
        raise AppError("NOT_FOUND", 404)
    if user.account_status == "disabled":
        raise AppError("INVALID_STATE", 409)
    accounts.disable_user(
        db,
        user,
        admin=context.user,
        reason=body.reason,
        expected_version=body.expectedVersion,
    )
    db.commit()
    return response({"id": user.id, "status": user.account_status, "version": user.version})


@router.get("/teacher-applications")
def applications(
    request: Request,
    page: int = Query(default=1, ge=1, le=1_000_000),
    status: Literal["pending", "approved", "rejected", "all"] = "pending",
    context: AuthContext = Depends(require_admin),
    db: DbSession = Depends(get_db),
):
    reviewer = aliased(User)
    query = (
        select(TeacherApplication, User, SchoolEmailBinding, reviewer.name)
        .join(User, User.id == TeacherApplication.user_id)
        .outerjoin(SchoolEmailBinding, SchoolEmailBinding.user_id == User.id)
        .outerjoin(reviewer, reviewer.id == TeacherApplication.reviewer_id)
    )
    if status != "all":
        query = query.where(TeacherApplication.status == status)
    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    items = [
        {
            "id": row.id,
            "userId": user.id,
            "name": user.name or "",
            "college": user.college or "",
            "applicationVersion": row.application_version,
            "status": row.status,
            "createdAt": row.created_at.isoformat(),
            "emailVerified": school_email_binding_verified(binding),
            "emailDomain": (binding.school_email or "").rsplit("@", 1)[-1] if binding else "",
            # Only the saved review-basis allowlist is projected. Current user
            # data must never be substituted for missing historical fields.
            "submittedName": snapshot_text(row, "name"),
            "submittedIdentity": snapshot_text(row, "requestedIdentity"),
            "submittedEmailDomain": snapshot_email_domain(row),
            "reviewedAt": row.reviewed_at.isoformat() if row.reviewed_at else None,
            "reviewerName": reviewer_name,
            "reviewReason": row.reason,
        }
        for row, user, binding, reviewer_name in db.execute(
            query.order_by(TeacherApplication.created_at, TeacherApplication.id)
            .offset((page - 1) * 10)
            .limit(10)
            .execution_options(populate_existing=True)
        )
    ]
    return response({"items": items, "total": total, "page": page, "pageSize": 10})


def snapshot_text(row: TeacherApplication, key: str) -> str | None:
    value = row.snapshot.get(key) if isinstance(row.snapshot, dict) else None
    return value if isinstance(value, str) else None


def snapshot_email_domain(row: TeacherApplication) -> str | None:
    email = snapshot_text(row, "schoolEmailNormalized")
    return email.rsplit("@", 1)[-1] if email and "@" in email else None


@router.post("/teacher-applications/{application_id}/review")
def review(
    application_id: str,
    body: TeacherDecision,
    request: Request,
    context: AuthContext = Depends(require_admin),
    db: DbSession = Depends(get_db),
):
    check_admin_write(request, context, db)
    row = db.scalar(
        select(TeacherApplication)
        .where(TeacherApplication.id == application_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None:
        raise AppError("NOT_FOUND", 404)
    user = db.scalar(
        select(User)
        .where(User.id == row.user_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if user is None:
        raise AppError("NOT_FOUND", 404)
    binding = db.scalar(
        select(SchoolEmailBinding)
        .where(SchoolEmailBinding.user_id == user.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if user.account_status == "disabled":
        raise AppError("INVALID_STATE", 409)
    if body.decision == "approve" and not school_email_binding_verified(binding):
        raise AppError("VALIDATION_ERROR", 422, field_errors={"email": "email_not_verified"})
    accounts.review_teacher_application(
        db,
        row,
        reviewer=context.user,
        decision=body.decision,
        reason=body.reason,
        expected_version=body.expectedVersion,
    )
    db.commit()
    return response({"id": row.id, "status": row.status})
