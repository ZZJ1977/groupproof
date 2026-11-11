"""项目创建与个人项目组长转让。

- 任何注册用户都可以新建“个人项目”（不属于任何课程和组）；创建者自动成为组长；
- 课程项目仍然由课程流程创建，这里不处理（需要先确定组长与组的关系，见说明）；
- 个人项目的组长可以转让给项目内的其他成员，旧组长保留成员身份，写入操作记录。

写操作只 flush，由调用方提交事务。
"""

from __future__ import annotations

from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import Project, ProjectMember, User
from app.modules.a import permissions
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
