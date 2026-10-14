"""C7-01: query canonical account metadata without altering A-owned identity state."""

from uuid import UUID

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.auth.models import SchoolEmailBinding
from app.db.models import User
from app.modules.c.admin_users_schemas import (
    AdminUserDetailDTO,
    AdminUserDTO,
    AdminUserFilters,
    AdminUserPageDTO,
)
from app.modules.c.school_email import school_email_binding_verified


def require_directory_admin(user: User) -> None:
    if user.status != "active":
        raise ApiError(403, "ACCOUNT_INACTIVE", "The account is not active.")
    if user.global_role != "admin":
        raise ApiError(403, "ADMIN_REQUIRED", "An administrator account is required.")


def directory_columns():
    # Explicit projection: adding fields/relationships to User cannot expand this API.
    return (
        User.id,
        User.name,
        User.username,
        User.email,
        User.student_id,
        User.college,
        User.global_role,
        User.status,
        SchoolEmailBinding,
    )


def directory_data(row):
    data = dict(row)
    data["email_verified"] = school_email_binding_verified(data.pop("SchoolEmailBinding"))
    return data


def list_admin_users(session: Session, user: User, filters: AdminUserFilters) -> AdminUserPageDTO:
    require_directory_admin(user)
    conditions = []
    if filters.q:
        conditions.append(
            or_(
                *[
                    column.icontains(filters.q, autoescape=True)
                    for column in (User.name, User.username, User.email, User.student_id)
                ]
            )
        )
    for column, value in (
        (User.name, filters.name),
        (User.email, filters.email),
        (User.student_id, filters.student_id),
    ):
        if value:
            conditions.append(column.icontains(value, autoescape=True))
    for column, value in (
        (User.global_role, filters.role),
        (User.status, filters.status),
        (User.college, filters.college),
    ):
        if value is not None:
            conditions.append(column == value)
    total = session.scalar(select(func.count()).select_from(User).where(*conditions)) or 0
    rows = session.execute(
        select(*directory_columns())
        .outerjoin(SchoolEmailBinding, SchoolEmailBinding.user_id == User.id)
        .where(*conditions)
        .order_by(User.created_at.desc(), User.id.asc())
        .offset((filters.page - 1) * 10)
        .limit(10)
        .execution_options(populate_existing=True)
    ).mappings()
    return AdminUserPageDTO(
        items=[AdminUserDTO.model_validate(directory_data(row)) for row in rows],
        page=filters.page,
        total=total,
    )


def get_admin_user(session: Session, user: User, user_id: UUID) -> AdminUserDetailDTO:
    require_directory_admin(user)
    row = (
        session.execute(
            select(*directory_columns(), User.created_at, User.updated_at, User.lock_version)
            .outerjoin(SchoolEmailBinding, SchoolEmailBinding.user_id == User.id)
            .where(User.id == user_id)
            .execution_options(populate_existing=True)
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        raise ApiError(404, "USER_NOT_FOUND", "The user was not found.")
    return AdminUserDetailDTO.model_validate(directory_data(row))
