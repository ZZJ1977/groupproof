"""C7 governance UI over A's existing identity services, without UUID translation."""

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session as DbSession

from ..db import get_db
from ..errors import AppError
from ..guard import AuthContext, check_csrf, require_admin
from ..models import SchoolEmailBinding, TeacherApplication, User
from ..services import accounts

router = APIRouter(prefix="/api/v1/c-admin", tags=["c-admin"])


def response(data):
    return JSONResponse(data, headers={"Cache-Control": "private, no-store"})


class IdentityDecision(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    reason: str = Field(min_length=1, max_length=2000)
    expectedVersion: int = Field(ge=1, strict=True)


class TeacherDecision(IdentityDecision):
    decision: str = Field(pattern="^(approve|reject)$")


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
        "schoolEmailVerified": bool(binding and binding.verified_at),
        "canDisable": user.id != actor.id and user.account_status != "disabled",
    }


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
        term = (
            "%"
            + q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            + "%"
        )
        query = query.where(
            or_(
                User.name.ilike(term, escape="\\"),
                User.student_id.ilike(term, escape="\\"),
                SchoolEmailBinding.school_email.ilike(term, escape="\\"),
            )
        )
    if role:
        # PostgreSQL JSON role membership; never search arbitrary substrings.
        from sqlalchemy import cast
        from sqlalchemy.dialects.postgresql import JSONB

        query = query.where(cast(User.roles, JSONB).contains([role]))
    if status:
        query = query.where(User.account_status == status)
    if college.strip():
        query = query.where(User.college == college.strip())
    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    rows = db.execute(
        query.order_by(User.created_at.desc(), User.id)
        .offset((page - 1) * 10)
        .limit(10)
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
    body: IdentityDecision,
    request: Request,
    context: AuthContext = Depends(require_admin),
    db: DbSession = Depends(get_db),
):
    check_csrf(request, context)
    if user_id == context.user.id:
        raise AppError("FORBIDDEN", 403, params={"reason": "cannot_disable_self"})
    user = db.scalar(
        select(User)
        .where(User.id == user_id)
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
    return response(
        {"id": user.id, "status": user.account_status, "version": user.version}
    )


@router.get("/teacher-applications")
def applications(
    request: Request,
    page: int = Query(default=1, ge=1, le=1_000_000),
    context: AuthContext = Depends(require_admin),
    db: DbSession = Depends(get_db),
):
    query = (
        select(TeacherApplication, User, SchoolEmailBinding)
        .join(User, User.id == TeacherApplication.user_id)
        .outerjoin(SchoolEmailBinding, SchoolEmailBinding.user_id == User.id)
        .where(TeacherApplication.status == "pending")
    )
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
            "emailVerified": bool(
                binding and binding.verified_at and binding.school_email_normalized
            ),
            "emailDomain": (binding.school_email or "").rsplit("@", 1)[-1]
            if binding
            else "",
        }
        for row, user, binding in db.execute(
            query.order_by(TeacherApplication.created_at, TeacherApplication.id)
            .offset((page - 1) * 10)
            .limit(10)
        )
    ]
    return response({"items": items, "total": total, "page": page, "pageSize": 10})


@router.post("/teacher-applications/{application_id}/review")
def review(
    application_id: str,
    body: TeacherDecision,
    request: Request,
    context: AuthContext = Depends(require_admin),
    db: DbSession = Depends(get_db),
):
    check_csrf(request, context)
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
    if body.decision == "approve" and not (
        binding and binding.verified_at and binding.school_email_normalized
    ):
        raise AppError(
            "VALIDATION_ERROR", 422, field_errors={"email": "email_not_verified"}
        )
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
