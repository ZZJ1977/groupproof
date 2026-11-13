"""A 临时只读授权：目标可见性、批准后生效的回执、到期与撤销检查。

C 的访问申请流程通过 ``AuthorizationPort`` 调用本模块：

1. ``visible_target``：申请人能不能“看到”这个目标。只有同课程的学生（目标项目对课程公开时）
   或本课老师/助教能看到；其他人一律返回和“不存在”一样的 404，不暴露目标是否存在；
2. ``activate``：批准时在同一个事务里生效，返回的回执原样包含申请人、范围和到期时间；
   同一个 ``command_id`` 重复调用得到同一份授权；
3. 每次真正读取内容时检查：``permissions.require_project_member(write=False)`` 会承认
   项目范围的有效授权；任务或证据范围的授权由 C 在读取时调用 :func:`has_read_grant`。

授权只读：不能写、不能做组长操作，也不能触发附件核验这类会写数据的动作。到期（``expires_at``）
或撤销（:func:`revoke_grant`）后下一次读取立即失效，不需要任何清理任务。
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import Project, User
from app.modules.a import permissions
from app.modules.a.audit import record_audit
from app.modules.a.models import AccessGrant
from app.modules.c.governance_ports import AuthorizationReceipt, VisibleAccessTarget
from app.modules.c.governance_schemas import AccessScope


def _not_found() -> ApiError:
    return ApiError(404, "ACCESS_TARGET_NOT_FOUND", "The authorized target does not exist.")


def _scope(grant: AccessGrant) -> AccessScope:
    return AccessScope(
        project_id=grant.project_id,
        resource_type=grant.resource_type,
        resource_id=grant.resource_id,
    )


def _receipt(grant: AccessGrant) -> AuthorizationReceipt:
    return AuthorizationReceipt(
        grant_id=grant.id,
        request_id=grant.request_id,
        applicant_id=grant.applicant_id,
        scope=_scope(grant),
        expires_at=grant.expires_at,
    )


def _active_conditions(user_id: UUID, project_id: UUID, now: datetime) -> list:
    return [
        AccessGrant.applicant_id == user_id,
        AccessGrant.project_id == project_id,
        AccessGrant.revoked_at.is_(None),
        AccessGrant.expires_at > now,
    ]


def has_read_grant(
    session: Session,
    user_id: UUID,
    project_id: UUID,
    resource_type: str = "project",
    resource_id: UUID | None = None,
    *,
    now: datetime | None = None,
) -> bool:
    """这个人现在是否有读取该资源的有效临时授权（项目范围的授权覆盖项目里的所有资源）。"""
    now = now or datetime.now(UTC)
    conditions = _active_conditions(user_id, project_id, now)
    if resource_type != "project":
        conditions.append(
            (AccessGrant.resource_type == "project")
            | (
                (AccessGrant.resource_type == resource_type)
                & (AccessGrant.resource_id == resource_id)
            )
        )
    else:
        conditions.append(AccessGrant.resource_type == "project")
    return session.scalar(select(AccessGrant.id).where(*conditions).limit(1)) is not None


def revoke_grant(session: Session, admin: User, grant_id: UUID, reason: str) -> AccessGrant:
    """管理员撤销授权；已撤销的重复撤销保持原记录不变。"""
    permissions.require_admin(admin)
    if not reason.strip():
        raise ApiError(422, "REASON_REQUIRED", "撤销授权必须填写原因。")
    grant = session.scalar(select(AccessGrant).where(AccessGrant.id == grant_id).with_for_update())
    if grant is None:
        raise ApiError(404, "ACCESS_GRANT_NOT_FOUND", "授权不存在。")
    if grant.revoked_at is not None:
        return grant
    grant.revoked_at = datetime.now(UTC)
    grant.revoked_by_id = admin.id
    grant.revoke_reason = reason.strip()
    session.flush()
    record_audit(
        session,
        actor=admin,
        action="access.grant.revoked",
        target=("access_grant", grant.id),
        project_id=grant.project_id,
        reason=reason.strip(),
    )
    return grant


class DatabaseAuthorizationPort:
    """C 的 ``AuthorizationPort`` 的 A 实现（只用调用方传入的会话，不提交）。"""

    def visible_target(
        self, session: Session, *, applicant_id: UUID, scope: AccessScope
    ) -> VisibleAccessTarget:
        applicant = session.get(User, applicant_id)
        project = session.get(Project, scope.project_id)
        if applicant is None or not permissions.is_active(applicant) or project is None:
            raise _not_found()
        if project.course_id is None:
            raise _not_found()
        staff = permissions.is_course_staff(session, applicant, project.course_id)
        peer = project.visibility == "course" and permissions.is_course_member(
            session, applicant, project.course_id
        )
        if not (staff or peer):
            raise _not_found()  # 和目标不存在一个样，不暴露它是否存在
        return VisibleAccessTarget(applicant_id=applicant_id, scope=scope)

    def activate(
        self,
        session: Session,
        *,
        request_id: UUID,
        applicant_id: UUID,
        reviewer_id: UUID,
        scope: AccessScope,
        expires_at: datetime,
        command_id: UUID,
    ) -> AuthorizationReceipt:
        if expires_at.utcoffset() is None or expires_at <= datetime.now(UTC):
            raise ApiError(422, "ACCESS_EXPIRY_INVALID", "授权到期时间必须是将来的带时区时间。")
        existing = session.scalar(
            select(AccessGrant)
            .where((AccessGrant.command_id == command_id) | (AccessGrant.request_id == request_id))
            .with_for_update()
        )
        if existing is not None:
            if existing.command_id != command_id:
                raise ApiError(409, "ACCESS_GRANT_CONFLICT", "这个申请已经生效过另一份授权。")
            return _receipt(existing)  # 同一个批准动作重复调用：返回同一份授权
        grant = AccessGrant(
            id=uuid4(),
            request_id=request_id,
            command_id=command_id,
            applicant_id=applicant_id,
            reviewer_id=reviewer_id,
            project_id=scope.project_id,
            resource_type=scope.resource_type,
            resource_id=scope.resource_id,
            expires_at=expires_at,
        )
        session.add(grant)
        session.flush()
        record_audit(
            session,
            actor=reviewer_id,
            action="access.grant.activated",
            target=("access_grant", grant.id),
            project_id=scope.project_id,
            after={
                "applicant_id": str(applicant_id),
                "resource_type": scope.resource_type,
                "resource_id": str(scope.resource_id),
                "expires_at": expires_at.isoformat(),
            },
        )
        return _receipt(grant)
