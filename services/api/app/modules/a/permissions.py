"""A3-05 共享权限函数：B/C/D 写接口时直接调用，不再各自重写权限判断。

所有判断都基于数据库里的当前关系（不是前端传来的角色）：

- 全局角色来自 ``users.global_role``（student / teacher / ta / admin），只有 ``status='active'``
  的账号才有任何权限；
- “组长”“本课老师”“本课助教”都是相对某个小组 / 某门课的身份；
- Admin 只拥有治理权限，默认看不到项目内容（与前端 ``lib/access/policy.ts`` 一致）。

两种用法：

1. 只要真假：``is_project_member(session, user, project_id)``、
   ``can(session, user, action, target)``；
2. 直接拦截：``require_project_member(...)`` 等，失败抛出统一的 ``ApiError``（403/404/409）。

查询使用 ``populate_existing``，避免同一会话里缓存的旧关系让已被移出的成员继续通过。
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, replace
from typing import Literal
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import (
    Course,
    CourseMember,
    CourseStaff,
    GroupMember,
    Project,
    ProjectGroup,
    ProjectMember,
    User,
)

TargetKind = Literal["project", "course", "group"]

# 与 lib/access/policy.ts 的动作名保持一致；未列出的动作一律拒绝。
PROJECT_ACTIONS = {
    "project.summary.read",
    "project.content.read",
    "project.draft.edit",
    "project.confirm.self",
    "project.files.write",
    "project.publish",
    "project.publish.override",
    "project.plan.unlock",
    "project.settings.update",
    "project.archive",
    "project.reopen",
    "project.rules.apply",
}
COURSE_ACTIONS = {
    "course.read",
    "course.staff.manage",
    "course.settings.update",
    "course.rules.edit",
    "course.rules.publish",
}
GROUP_ACTIONS = {"project.create"}
ACTIONS = PROJECT_ACTIONS | COURSE_ACTIONS | GROUP_ACTIONS

# 只读状态下仍允许的项目动作（归档/定稿后只能看，组长可以重新打开）。
READ_ONLY_PROJECT_ACTIONS = {"project.summary.read", "project.content.read", "project.reopen"}
MEMBER_WRITE_ACTIONS = {"project.draft.edit", "project.confirm.self", "project.files.write"}
LEADER_ACTIONS = {
    "project.publish",
    "project.publish.override",
    "project.plan.unlock",
    "project.settings.update",
    "project.archive",
    "project.reopen",
    "project.rules.apply",
}


@dataclass(frozen=True)
class Target:
    kind: TargetKind
    id: UUID


def _fresh(session: Session, statement):
    return session.scalar(statement.execution_options(populate_existing=True))


def is_active(user: User | None) -> bool:
    return user is not None and user.status == "active"


def is_admin(user: User | None) -> bool:
    """平台管理员（治理用途）。不代表能看项目内容。"""
    return is_active(user) and user.global_role == "admin"


def is_student(user: User | None) -> bool:
    return is_active(user) and user.global_role == "student"


# ---------------------------------------------------------------- 课程身份


def _course_staff_role(session: Session, user: User, course_id: UUID) -> str | None:
    record = _fresh(
        session,
        select(CourseStaff).where(
            CourseStaff.course_id == course_id,
            CourseStaff.user_id == user.id,
            CourseStaff.left_at.is_(None),
        ),
    )
    return record.role if record else None


def is_course_teacher(session: Session, user: User | None, course_id: UUID) -> bool:
    """本课老师：教师账号，且是课程创建者或在课程教职表中登记为 teacher。"""
    if not is_active(user) or user.global_role != "teacher":
        return False
    course = _fresh(session, select(Course).where(Course.id == course_id))
    if course is None:
        return False
    return course.owner_id == user.id or _course_staff_role(session, user, course_id) == "teacher"


def is_course_ta(session: Session, user: User | None, course_id: UUID) -> bool:
    """本课助教：在课程教职表中登记为 ta 的教师/助教账号。"""
    if not is_active(user) or user.global_role not in {"teacher", "ta"}:
        return False
    return _course_staff_role(session, user, course_id) == "ta"


def is_course_staff(session: Session, user: User | None, course_id: UUID) -> bool:
    """本课老师或助教。"""
    return is_course_teacher(session, user, course_id) or is_course_ta(session, user, course_id)


def is_course_member(session: Session, user: User | None, course_id: UUID) -> bool:
    """已加入课程的学生（status=active 且未退出）。"""
    if not is_student(user):
        return False
    record = _fresh(
        session,
        select(CourseMember).where(
            CourseMember.course_id == course_id,
            CourseMember.user_id == user.id,
            CourseMember.status == "active",
            CourseMember.left_at.is_(None),
        ),
    )
    return record is not None


# ---------------------------------------------------------------- 小组身份


def is_group_member(session: Session, user: User | None, group_id: UUID) -> bool:
    """本组成员（学生，未退出）。"""
    if not is_student(user):
        return False
    record = _fresh(
        session,
        select(GroupMember).where(
            GroupMember.group_id == group_id,
            GroupMember.user_id == user.id,
            GroupMember.left_at.is_(None),
        ),
    )
    return record is not None


def is_group_leader(session: Session, user: User | None, group_id: UUID) -> bool:
    """本组组长：以 groups.leader_id 为准，且本人仍是本组成员。"""
    if not is_group_member(session, user, group_id):
        return False
    group = _fresh(session, select(ProjectGroup).where(ProjectGroup.id == group_id))
    return group is not None and group.leader_id == user.id


# ---------------------------------------------------------------- 项目身份


@dataclass(frozen=True)
class ProjectRelation:
    """一次查询得到的“我和这个项目的关系”，供需要多个判断的接口复用。"""

    project: Project
    course: Course | None
    group: ProjectGroup | None
    member: bool
    leader: bool
    teacher: bool
    ta: bool
    course_peer: bool
    # 有 C 批准的、现在仍有效的项目范围临时只读授权（只读，不等于成员）。
    granted_read: bool = False

    @property
    def staff(self) -> bool:
        return self.teacher or self.ta

    @property
    def read_only(self) -> bool:
        return self.project.lifecycle != "active" or (
            self.course is not None and self.course.status == "ended"
        )


def project_relation(session: Session, user: User | None, project_id: UUID) -> ProjectRelation:
    """读取当前用户与项目的真实关系。项目不存在或上下文不一致时抛 404/409。"""
    project = _fresh(session, select(Project).where(Project.id == project_id))
    if project is None:
        raise ApiError(404, "PROJECT_NOT_FOUND", "项目不存在。")
    course = (
        _fresh(session, select(Course).where(Course.id == project.course_id))
        if project.course_id
        else None
    )
    group = (
        _fresh(session, select(ProjectGroup).where(ProjectGroup.id == project.group_id))
        if project.group_id
        else None
    )
    if (project.course_id and course is None) or (
        project.group_id and (group is None or group.course_id != project.course_id)
    ):
        raise ApiError(409, "INVALID_PROJECT_CONTEXT", "项目所属课程或小组数据不一致。")

    membership = None
    if is_active(user):  # 个人项目的创建者可能是老师或管理员，成员关系对所有活跃账号生效
        membership = _fresh(
            session,
            select(ProjectMember).where(
                ProjectMember.project_id == project.id,
                ProjectMember.user_id == user.id,
                ProjectMember.left_at.is_(None),
            ),
        )
    member = membership is not None
    if group is not None:
        leader = member and group.leader_id == user.id
    else:
        leader = member and membership.role == "leader"
    teacher = course is not None and is_course_teacher(session, user, course.id)
    ta = course is not None and not teacher and is_course_ta(session, user, course.id)
    course_peer = course is not None and is_course_member(session, user, course.id)
    return ProjectRelation(project, course, group, member, leader, teacher, ta, course_peer)


def is_project_member(session: Session, user: User | None, project_id: UUID) -> bool:
    return _relation_or_none(session, user, project_id, lambda r: r.member)


def is_project_leader(session: Session, user: User | None, project_id: UUID) -> bool:
    return _relation_or_none(session, user, project_id, lambda r: r.leader)


def is_project_teacher(session: Session, user: User | None, project_id: UUID) -> bool:
    """是不是这个项目所在课程的老师。"""
    return _relation_or_none(session, user, project_id, lambda r: r.teacher)


def is_project_staff(session: Session, user: User | None, project_id: UUID) -> bool:
    """是不是这个项目所在课程的老师或助教。"""
    return _relation_or_none(session, user, project_id, lambda r: r.staff)


def is_project_writable(session: Session, project_id: UUID) -> bool:
    """项目处于 active 且课程未结束时才允许改数据（归档/定稿项目只读）。"""
    project = _fresh(session, select(Project).where(Project.id == project_id))
    if project is None or project.lifecycle != "active":
        return False
    if project.course_id:
        course = _fresh(session, select(Course).where(Course.id == project.course_id))
        return course is not None and course.status != "ended"
    return True


def _relation_or_none(session, user, project_id, predicate) -> bool:
    if not is_active(user):
        return False
    try:
        return bool(predicate(project_relation(session, user, project_id)))
    except ApiError:
        return False


# ---------------------------------------------------------------- 动作矩阵


def can(session: Session, user: User | None, action: str, target: Target) -> bool:
    """按动作判断（与 lib/access/policy.ts 同一张权限矩阵）。

    未知动作、未登录、停用账号一律 False。
    """
    if action not in ACTIONS or not is_active(user):
        return False
    if target.kind == "course":
        return action in COURSE_ACTIONS and _can_course(session, user, action, target.id)
    if target.kind == "group":
        return action in GROUP_ACTIONS and _can_group(session, user, target.id)
    if target.kind == "project" and action in PROJECT_ACTIONS:
        try:
            relation = project_relation(session, user, target.id)
        except ApiError:
            return False
        return _can_project(relation, action)
    return False


def can_any(session: Session, user: User | None, actions: Iterable[str], target: Target) -> bool:
    return any(can(session, user, action, target) for action in actions)


def _can_course(session: Session, user: User, action: str, course_id: UUID) -> bool:
    teacher = is_course_teacher(session, user, course_id)
    if action == "course.read":
        return (
            teacher
            or is_course_ta(session, user, course_id)
            or is_course_member(session, user, course_id)
        )
    # 课程设置、规则、教职管理只给本课老师；助教暂无按操作授权的数据，统一不放行。
    return teacher


def _can_group(session: Session, user: User, group_id: UUID) -> bool:
    group = _fresh(session, select(ProjectGroup).where(ProjectGroup.id == group_id))
    if group is None:
        return False
    return is_group_leader(session, user, group_id) and is_course_member(
        session, user, group.course_id
    )


def _can_project(relation: ProjectRelation, action: str) -> bool:
    if relation.read_only and action not in READ_ONLY_PROJECT_ACTIONS:
        return False
    if action == "project.summary.read":
        return (
            relation.member
            or relation.staff
            or (relation.project.visibility == "course" and relation.course_peer)
        )
    if action == "project.content.read":
        return relation.member or relation.staff
    if action in MEMBER_WRITE_ACTIONS:
        return relation.member
    if action == "project.reopen":
        course_open = relation.course is None or relation.course.status != "ended"
        return relation.leader and relation.project.lifecycle != "active" and course_open
    if action in LEADER_ACTIONS:
        return relation.leader
    return False


# ---------------------------------------------------------------- 直接拦截


def require_active(user: User | None) -> User:
    if user is None:
        raise ApiError(401, "UNAUTHENTICATED", "请先登录。")
    if not is_active(user):
        raise ApiError(403, "ACCOUNT_INACTIVE", "账号未启用或已停用。")
    return user


def require_admin(user: User | None) -> User:
    require_active(user)
    if not is_admin(user):
        raise ApiError(403, "FORBIDDEN", "需要管理员权限。")
    return user


def require_course_teacher(session: Session, user: User | None, course_id: UUID) -> User:
    require_active(user)
    if not is_course_teacher(session, user, course_id):
        raise ApiError(403, "COURSE_TEACHER_REQUIRED", "只有本课程老师可以执行此操作。")
    return user


def require_course_staff(session: Session, user: User | None, course_id: UUID) -> User:
    require_active(user)
    if not is_course_staff(session, user, course_id):
        raise ApiError(403, "COURSE_STAFF_REQUIRED", "只有本课程老师或助教可以执行此操作。")
    return user


def require_group_member(session: Session, user: User | None, group_id: UUID) -> User:
    require_active(user)
    if not is_group_member(session, user, group_id):
        raise ApiError(403, "GROUP_MEMBER_REQUIRED", "只有本组成员可以执行此操作。")
    return user


def require_group_leader(session: Session, user: User | None, group_id: UUID) -> User:
    require_active(user)
    if not is_group_leader(session, user, group_id):
        raise ApiError(403, "GROUP_LEADER_REQUIRED", "只有本组组长可以执行此操作。")
    return user


def require_project_read(session: Session, user: User | None, project_id: UUID) -> ProjectRelation:
    """项目成员或本课老师/助教可读。无权读时返回 404，不暴露项目是否存在。"""
    require_active(user)
    relation = project_relation(session, user, project_id)
    if not (relation.member or relation.staff):
        from app.modules.a.access_grants import has_read_grant

        if not has_read_grant(session, user.id, project_id):
            raise ApiError(404, "PROJECT_NOT_FOUND", "项目不存在。")
        return replace(relation, granted_read=True)  # 到期或撤销后下一次读取就会走上面的 404
    return relation


def require_project_member(
    session: Session, user: User | None, project_id: UUID, *, write: bool = True
) -> ProjectRelation:
    """本项目成员；``write=True`` 时还要求项目可写（未归档/定稿、课程未结束）。"""
    relation = require_project_read(session, user, project_id)
    if not relation.member:
        if write or not relation.granted_read:
            raise ApiError(403, "PROJECT_MEMBER_REQUIRED", "只有本项目成员可以执行此操作。")
        return relation  # 临时授权：只读
    if write:
        _require_writable(relation)
    return relation


def require_project_leader(
    session: Session, user: User | None, project_id: UUID, *, write: bool = True
) -> ProjectRelation:
    relation = require_project_member(session, user, project_id, write=False)
    if not relation.leader:
        raise ApiError(403, "PROJECT_LEADER_REQUIRED", "只有本组组长可以执行此操作。")
    if write:
        _require_writable(relation)
    return relation


def require_action(session: Session, user: User | None, action: str, target: Target) -> None:
    """按动作矩阵拦截；适合一个接口只对应一个动作的场景。"""
    require_active(user)
    if action not in ACTIONS:
        raise ApiError(403, "FORBIDDEN", "未知操作。")
    if not can(session, user, action, target):
        if target.kind == "project":
            relation = project_relation(session, user, target.id)
            visible = (
                relation.member
                or relation.staff
                or (relation.course_peer and relation.project.visibility == "course")
            )
            if not visible:
                raise ApiError(404, "PROJECT_NOT_FOUND", "项目不存在。")
            if relation.read_only and action not in READ_ONLY_PROJECT_ACTIONS:
                raise ApiError(403, "PROJECT_READ_ONLY", "项目已归档或定稿，只能查看。")
        raise ApiError(403, "FORBIDDEN", "没有权限执行此操作。")


def _require_writable(relation: ProjectRelation) -> None:
    if relation.read_only:
        raise ApiError(403, "PROJECT_READ_ONLY", "项目已归档或定稿，只能查看。")
