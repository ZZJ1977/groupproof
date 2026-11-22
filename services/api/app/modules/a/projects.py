"""项目创建与个人项目组长转让。

- 任何注册用户都可以新建“个人项目”（不属于任何课程和组）；创建者自动成为组长；
- 课程项目仍然由课程流程创建，这里不处理（需要先确定组长与组的关系，见说明）；
- 个人项目的组长可以转让给项目内的其他成员，旧组长保留成员身份，写入操作记录。

写操作只 flush，由调用方提交事务。
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.auth.models import SchoolEmailBinding
from app.db.models import Project, ProjectMember, User
from app.modules.a import inbox, permissions
from app.modules.a.audit import record_audit


def create_personal_project(
    session: Session, actor: User, *, name: str, description: str | None = None
) -> Project:
    if not permissions.is_active(actor):
        raise ApiError(403, "ACCOUNT_DISABLED", "账号不可用。")
    project = Project(
        id=uuid4(),
        course_id=None,
        group_id=None,
        name=name.strip(),
        description=description,
        visibility="members",
    )
    session.add(project)
    session.flush()
    session.add(ProjectMember(id=uuid4(), project_id=project.id, user_id=actor.id, role="leader"))
    session.flush()
    record_audit(
        session,
        actor=actor,
        action="project.created",
        target=("project", project.id),
        project_id=project.id,
        after={"name": project.name, "kind": "personal"},
    )
    return project


def transfer_personal_leadership(
    session: Session, actor: User, project_id: UUID, *, new_leader_id: UUID
) -> None:
    relation = permissions.require_project_leader(session, actor, project_id)
    project = relation.project
    if project.course_id is not None or project.group_id is not None:
        raise ApiError(
            409,
            "LEADERSHIP_NOT_TRANSFERABLE_HERE",
            "课程项目的组长由课程小组决定，不能在这里转让。",
        )
    if new_leader_id == actor.id:
        raise ApiError(422, "SAME_LEADER", "新组长不能是当前组长本人。")
    target = session.scalar(
        select(ProjectMember).where(
            ProjectMember.project_id == project_id,
            ProjectMember.user_id == new_leader_id,
            ProjectMember.left_at.is_(None),
        )
    )
    if target is None:
        raise ApiError(422, "NOT_A_MEMBER", "只能转让给本项目的现有成员。")
    current = session.scalar(
        select(ProjectMember).where(
            ProjectMember.project_id == project_id,
            ProjectMember.user_id == actor.id,
            ProjectMember.left_at.is_(None),
        )
    )
    current.role = "member"
    target.role = "leader"
    session.flush()
    record_audit(
        session,
        actor=actor,
        action="project.leader.transferred",
        target=("project", project_id),
        project_id=project_id,
        before={"leader_id": str(actor.id)},
        after={"leader_id": str(new_leader_id)},
    )


def _find_active_user_by_identifier(session: Session, raw: str) -> User | None:
    ident = raw.strip()
    if not ident:
        return None
    lowered = ident.lower()
    user = session.scalar(
        select(User).where(
            User.status == "active",
            (User.student_id == ident)
            | (func.lower(User.email) == lowered)
            | (User.username_normalized == lowered)
            | (func.lower(User.username) == lowered),
        )
    )
    if user is not None:
        return user
    binding = session.scalar(
        select(SchoolEmailBinding).where(
            SchoolEmailBinding.school_email_normalized == lowered,
            SchoolEmailBinding.verified_at.is_not(None),
        )
    )
    if binding is None:
        return None
    candidate = session.get(User, binding.user_id)
    return candidate if candidate is not None and candidate.status == "active" else None


def add_personal_member(
    session: Session, actor: User, project_id: UUID, *, identifier: str
) -> ProjectMember:
    """独立项目组长按学号、用户名或邮箱添加协作队友。"""
    relation = permissions.require_project_leader(session, actor, project_id, write=True)
    project = relation.project
    if project.course_id is not None or project.group_id is not None:
        raise ApiError(
            409,
            "MEMBERSHIP_MANAGED_BY_COURSE_GROUP",
            "课程项目的成员由课程小组统一管理，请前往小组页面邀请成员。",
        )
    target = _find_active_user_by_identifier(session, identifier)
    if target is None:
        raise ApiError(
            404,
            "USER_NOT_FOUND",
            "未找到对应的已启用账号，请核对学号、用户名或邮箱后重试。",
        )
    existing = session.scalar(
        select(ProjectMember).where(
            ProjectMember.project_id == project_id,
            ProjectMember.user_id == target.id,
        )
    )
    if existing is not None and existing.left_at is None:
        raise ApiError(409, "ALREADY_A_MEMBER", "该用户已经是项目成员。")
    if existing is not None:
        existing.left_at = None
        existing.role = "member"
        row = existing
    else:
        row = ProjectMember(id=uuid4(), project_id=project_id, user_id=target.id, role="member")
        session.add(row)
    session.flush()
    record_audit(
        session,
        actor=actor,
        action="project.member.added",
        target=("project", project_id),
        project_id=project_id,
        after={"user_id": str(target.id), "role": "member"},
    )
    inbox.notify(
        session,
        recipient=target.id,
        category="project",
        title=f"你已被加入项目「{project.name}」",
        description=(
            f"{actor.name or '项目组长'} 将你添加为项目成员，现在可以协作规划任务和同步进展。"
        ),
        target={"kind": "project", "id": str(project_id), "href": f"/projects/{project_id}"},
    )
    return row


def remove_personal_member(
    session: Session, actor: User, project_id: UUID, *, member_user_id: UUID
) -> None:
    """独立项目移除非组长成员，或非组长成员主动退出。"""
    relation = permissions.require_project_member(session, actor, project_id, write=True)
    project = relation.project
    if project.course_id is not None or project.group_id is not None:
        raise ApiError(
            409,
            "MEMBERSHIP_MANAGED_BY_COURSE_GROUP",
            "课程项目的成员由课程小组统一管理，不能在这里移除。",
        )
    is_self = member_user_id == actor.id
    if not is_self and not relation.is_leader:
        raise ApiError(403, "FORBIDDEN", "只有项目组长可以移除其他成员。")
    target = session.scalar(
        select(ProjectMember).where(
            ProjectMember.project_id == project_id,
            ProjectMember.user_id == member_user_id,
            ProjectMember.left_at.is_(None),
        )
    )
    if target is None:
        raise ApiError(404, "NOT_A_MEMBER", "该用户不是当前项目的有效成员。")
    if target.role == "leader":
        raise ApiError(409, "LEADER_CANNOT_LEAVE", "请先转让组长身份后再退出或移除。")
    target.left_at = datetime.now(UTC)
    session.flush()
    record_audit(
        session,
        actor=actor,
        action="project.member.removed",
        target=("project", project_id),
        project_id=project_id,
        before={"user_id": str(member_user_id), "role": target.role},
    )
