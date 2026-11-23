"""C7 治理 UI 的身份目录/停用/审核接口（基于统一认证服务，无 UUID 转译）。"""

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session as DbSession
from sqlalchemy.orm import aliased

from app.modules.c.notification_delivery import NotificationWriter
from app.modules.c.school_email import has_verified_school_email, school_email_binding_verified

from ..db import get_db
from ..envelope import EnvelopeRoute, JSONResponse
from ..errors import DEFAULT_MESSAGES, AppError
from ..guard import AuthContext, check_csrf, require_admin
from ..models import SchoolEmailBinding, TeacherApplication, User
from ..security import check_email_format, normalize_username
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
        "createdAt": user.created_at.isoformat() if getattr(user, "created_at", None) else None,
        "lastLoginAt": (
            user.last_login_at.isoformat() if getattr(user, "last_login_at", None) else None
        ),
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
    emailVerified: str = Query(default="", pattern="^(|true|false)$"),
    page: int = Query(default=1, ge=1, le=1_000_000),
    pageSize: int = Query(default=10, ge=1, le=100),
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
    if emailVerified == "true":
        query = query.where(SchoolEmailBinding.verified_at.is_not(None))
    elif emailVerified == "false":
        query = query.where(
            or_(SchoolEmailBinding.user_id.is_(None), SchoolEmailBinding.verified_at.is_(None))
        )
    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    rows = db.execute(
        query.order_by(User.created_at.desc(), User.id)
        .offset((page - 1) * pageSize)
        .limit(pageSize)
    )
    return response(
        {
            "items": [directory_row(u, b, context.user) for u, b in rows],
            "total": total,
            "page": page,
            "pageSize": pageSize,
        }
    )


@router.post("/users/{user_id}/disable")
def disable(
    user_id: str,
    body: DisableDecision,
    request: Request,
    writer: NotificationWriter,
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
    if writer is not None:
        writer(
            db,
            recipient=user.id,
            category="system",
            title="账号已停用",
            description=body.reason,
            dedupe_key=f"c:account-disabled:{user.id}:{user.version}",
        )
    db.commit()
    return response(
        {
            "id": user.id,
            "status": user.account_status,
            "version": user.version,
            "inboxNotified": writer is not None,
        }
    )


@router.post("/users/{user_id}/enable")
def enable(
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
    user = db.scalar(
        select(User)
        .where(User.id == target_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if user is None:
        raise AppError("NOT_FOUND", 404)
    accounts.enable_user(
        db, user, admin=context.user, reason=body.reason, expected_version=body.expectedVersion
    )
    db.commit()
    return response({"id": user.id, "status": user.account_status, "version": user.version})


class CreateAccount(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    identity: Literal["student", "teacher"]
    name: str = Field(min_length=1, max_length=120)
    username: str = Field(min_length=1, max_length=80)
    schoolEmail: str = Field(min_length=3, max_length=255)
    studentId: str | None = Field(default=None, max_length=80)
    college: str | None = Field(default=None, max_length=160)
    submitForReview: bool = Field(default=False, strict=True)


@router.post("/users", status_code=201)
def create_account(
    body: CreateAccount,
    request: Request,
    context: AuthContext = Depends(require_admin),
    db: DbSession = Depends(get_db),
):
    check_admin_write(request, context, db)
    user = accounts.admin_create_account(
        db,
        admin=context.user,
        identity=body.identity,
        name=body.name,
        username=body.username,
        school_email=body.schoolEmail,
        student_id=body.studentId,
        college=body.college,
        submit_for_review=body.submitForReview,
    )
    db.commit()
    return JSONResponse(
        {
            "id": user.id,
            "status": user.account_status,
            "roles": user.roles,
            "version": user.version,
            # 不返回密码：本人通过「忘记密码」用该邮箱设置自己的密码。
            "passwordSetup": "forgot_password",
        },
        status_code=201,
        headers={"Cache-Control": "private, no-store"},
    )


class BulkImportRowInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    identity: str = Field(default="student", max_length=32)
    name: str = Field(default="", max_length=120)
    username: str = Field(default="", max_length=80)
    schoolEmail: str = Field(default="", max_length=255)
    studentId: str | None = Field(default=None, max_length=80)
    college: str | None = Field(default=None, max_length=160)
    submitForReview: bool = Field(default=False, strict=True)


class BulkImportAccountsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    dryRun: bool = Field(default=True, strict=True)
    rows: list[BulkImportRowInput] = Field(min_length=1, max_length=200)


@router.post("/users/bulk-import")
def bulk_import_accounts(
    body: BulkImportAccountsRequest,
    request: Request,
    context: AuthContext = Depends(require_admin),
    db: DbSession = Depends(get_db),
):
    check_admin_write(request, context, db)
    results = []
    valid_count = 0
    invalid_count = 0
    created_count = 0
    seen_usernames: set[str] = set()
    seen_emails: set[str] = set()

    for index, raw_row in enumerate(body.rows):
        row_payload = raw_row.model_dump()
        row_payload["studentId"] = (row_payload.get("studentId") or "").strip() or None
        row_payload["college"] = (row_payload.get("college") or "").strip() or None
        try:
            validated = CreateAccount.model_validate(row_payload)
        except ValidationError as exc:
            invalid_count += 1
            field_errors = {
                str(err["loc"][0]) if err.get("loc") else "row": "validation_error"
                for err in exc.errors()
            }
            results.append(
                {
                    "index": index,
                    "name": raw_row.name,
                    "username": raw_row.username,
                    "schoolEmail": raw_row.schoolEmail,
                    "identity": raw_row.identity,
                    "status": "error",
                    "userId": None,
                    "errorCode": "VALIDATION_ERROR",
                    "fieldErrors": field_errors,
                    "message": DEFAULT_MESSAGES["VALIDATION_ERROR"],
                }
            )
            continue

        norm_username = normalize_username(validated.username)
        if norm_username in seen_usernames:
            invalid_count += 1
            results.append(
                {
                    "index": index,
                    "name": validated.name,
                    "username": validated.username,
                    "schoolEmail": validated.schoolEmail,
                    "identity": validated.identity,
                    "status": "error",
                    "userId": None,
                    "errorCode": "USERNAME_CONFLICT",
                    "fieldErrors": {"username": "username_taken"},
                    "message": DEFAULT_MESSAGES["USERNAME_CONFLICT"],
                }
            )
            continue

        try:
            norm_email = check_email_format(validated.schoolEmail)
        except ValueError:
            norm_email = validated.schoolEmail.strip().lower()
        if norm_email in seen_emails:
            invalid_count += 1
            results.append(
                {
                    "index": index,
                    "name": validated.name,
                    "username": validated.username,
                    "schoolEmail": validated.schoolEmail,
                    "identity": validated.identity,
                    "status": "error",
                    "userId": None,
                    "errorCode": "EMAIL_CONFLICT",
                    "fieldErrors": {"schoolEmail": "email_taken"},
                    "message": DEFAULT_MESSAGES["EMAIL_CONFLICT"],
                }
            )
            continue

        sp = db.begin_nested()
        try:
            created = accounts.admin_create_account(
                db,
                admin=context.user,
                identity=validated.identity,
                name=validated.name,
                username=validated.username,
                school_email=validated.schoolEmail,
                student_id=validated.studentId,
                college=validated.college,
                submit_for_review=validated.submitForReview,
            )
            seen_usernames.add(norm_username)
            seen_emails.add(norm_email)
            valid_count += 1
            if body.dryRun:
                sp.rollback()
                results.append(
                    {
                        "index": index,
                        "name": validated.name,
                        "username": validated.username,
                        "schoolEmail": validated.schoolEmail,
                        "identity": validated.identity,
                        "status": "valid",
                        "userId": None,
                        "errorCode": None,
                        "fieldErrors": None,
                        "message": "OK",
                    }
                )
            else:
                sp.commit()
                created_count += 1
                results.append(
                    {
                        "index": index,
                        "name": validated.name,
                        "username": validated.username,
                        "schoolEmail": validated.schoolEmail,
                        "identity": validated.identity,
                        "status": "created",
                        "userId": str(created.id),
                        "errorCode": None,
                        "fieldErrors": None,
                        "message": "Created",
                    }
                )
        except AppError as exc:
            sp.rollback()
            invalid_count += 1
            results.append(
                {
                    "index": index,
                    "name": validated.name,
                    "username": validated.username,
                    "schoolEmail": validated.schoolEmail,
                    "identity": validated.identity,
                    "status": "error",
                    "userId": None,
                    "errorCode": exc.code,
                    "fieldErrors": exc.field_errors or None,
                    "message": DEFAULT_MESSAGES.get(exc.code, exc.code),
                }
            )

    if not body.dryRun:
        db.commit()

    return response(
        {
            "dryRun": body.dryRun,
            "total": len(body.rows),
            "validCount": valid_count,
            "invalidCount": invalid_count,
            "createdCount": created_count,
            "results": results,
        }
    )


@router.get("/teacher-applications")
def applications(
    request: Request,
    page: int = Query(default=1, ge=1, le=1_000_000),
    pageSize: int = Query(default=10, ge=1, le=100),
    status: Literal["pending", "approved", "rejected", "all"] = "pending",
    q: str = Query(default="", max_length=200),
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
    if q.strip():
        term = "%" + q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        query = query.where(
            or_(
                User.name.ilike(term, escape="\\"),
                User.college.ilike(term, escape="\\"),
                SchoolEmailBinding.school_email.ilike(term, escape="\\"),
            )
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
            .offset((page - 1) * pageSize)
            .limit(pageSize)
            .execution_options(populate_existing=True)
        )
    ]
    return response({"items": items, "total": total, "page": page, "pageSize": pageSize})


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
