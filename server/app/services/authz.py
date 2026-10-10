"""业务资源授权：服务端复刻 lib/access/policy.ts 权限矩阵（阶段 01）。

前端 can() 只能作为展示依据；每个业务请求在此独立鉴权。
Python 不能 import TS 函数，矩阵一致性由同一组用例核对（server/tests/test_authz_matrix.py
与 scripts/check-access.mjs 的用例描述保持一致）。
"""
from __future__ import annotations

from typing import Any, Iterable

ACTIONS = {
    "course.settings.update",
    "course.rules.edit",
    "course.rules.publish",
    "project.summary.read",
    "project.content.read",
    "project.create",
    "project.draft.edit",
    "project.confirm.self",
    "project.publish",
    "project.publish.override",
    "project.plan.unlock",
    "project.files.write",
    "project.settings.update",
    "project.archive",
    "project.reopen",
    "project.rules.apply",
    "course.read",
    "course.staff.manage",
}

Target = dict[str, str]


def _user(data: dict[str, Any], actor_id: str) -> dict[str, Any] | None:
    return next((item for item in data.get("users", []) if item["id"] == actor_id), None)


def _course(data: dict[str, Any], course_id: str) -> dict[str, Any] | None:
    return next((item for item in data.get("courses", []) if item["id"] == course_id), None)


def _group(data: dict[str, Any], group_id: str) -> dict[str, Any] | None:
    return next((item for item in data.get("groups", []) if item["id"] == group_id), None)


def _project(data: dict[str, Any], project_id: str) -> dict[str, Any] | None:
    return next((item for item in data.get("projects", []) if item["id"] == project_id), None)


def assistant_grant(course: dict[str, Any] | None, actor_id: str) -> dict[str, Any] | None:
    for item in (course or {}).get("assistantGrants", []) or []:
        if item["userId"] == actor_id:
            return item
    return None


def is_course_staff(data: dict[str, Any], actor_id: str, course_id: str) -> bool:
    course = _course(data, course_id)
    if not course:
        return False
    user = _user(data, actor_id)
    teacher_here = bool(user and user.get("role") == "teacher" and user.get("teacherStatus") == "approved" and course.get("teacherId") == user["id"])
    return teacher_here or assistant_grant(course, actor_id) is not None


def can(data: dict[str, Any], actor: dict[str, Any], action: str, target: Target) -> bool:
    """资格判断；actor 为服务端会话对应的真实用户事实（含角色/状态），不接受客户端自报角色。

    业务快照（data）只提供资源关系（成员/组长/归属）；身份事实一律来自 actor。
    """
    if action not in ACTIONS:
        return False
    if actor.get("status") != "active":
        return False
    user = actor
    student = user.get("role") in ("student", "leader")

    def teacher_of(course: dict[str, Any] | None) -> bool:
        return bool(
            course
            and user.get("role") == "teacher"
            and user.get("teacherStatus") == "approved"
            and course.get("teacherId") == user["id"]
        )

    def assistant_of(course: dict[str, Any] | None) -> dict[str, Any] | None:
        return assistant_grant(course, user["id"]) if user.get("role") == "ta" else None

    if target["kind"] == "course":
        course = _course(data, target["id"])
        if not course:
            return False
        teacher_here = teacher_of(course)
        assistant = assistant_of(course)
        if action == "course.read":
            return teacher_here or assistant is not None or (student and user["id"] in course.get("memberIds", []))
        if action == "course.staff.manage":
            return teacher_here
        if action in ("course.settings.update", "course.rules.edit", "course.rules.publish"):
            return teacher_here or (assistant is not None and action in assistant.get("permissions", []))
        return False

    if target["kind"] == "group":
        group = _group(data, target["id"])
        course = _course(data, group["courseId"]) if group else None
        return bool(
            group
            and course
            and action == "project.create"
            and student
            and user["id"] in group.get("memberIds", [])
            and user["id"] in course.get("memberIds", [])
            and group.get("leaderId") == user["id"]
        )

    if target["kind"] != "project":
        return False
    project = _project(data, target["id"])
    if not project:
        return False
    course = _course(data, project["courseId"]) if project.get("courseId") else None
    group = _group(data, project["groupId"]) if project.get("groupId") else None
    if project.get("courseId") and not course:
        return False
    if project.get("groupId") and (not group or group.get("courseId") != project.get("courseId")):
        return False

    member = student and user["id"] in project.get("memberIds", [])
    leader_id = group.get("leaderId") if project.get("groupId") else project.get("ownerId")
    leader = member and leader_id == user["id"]
    staff = teacher_of(course) or assistant_of(course) is not None
    course_peer = student and bool(course and user["id"] in course.get("memberIds", []))

    if action == "project.summary.read":
        return member or staff or (project.get("visibility") == "course" and course_peer)
    if action == "project.content.read":
        return member or staff
    if action in ("project.draft.edit", "project.confirm.self", "project.files.write"):
        return member
    if action in (
        "project.publish",
        "project.publish.override",
        "project.plan.unlock",
        "project.settings.update",
        "project.archive",
        "project.reopen",
        "project.rules.apply",
    ):
        return leader
    return False


def project_summary(project: dict[str, Any]) -> dict[str, Any]:
    """跨组公开总览只允许五字段 DTO，绝不下发全量数据再由客户端裁剪。"""
    return {
        "id": project["id"],
        "name": project["name"],
        "description": project.get("description", ""),
        "progress": project.get("progress", 0),
        "lifecycle": project.get("lifecycle", "active"),
    }


def can_any(data: dict[str, Any], actor: dict[str, Any], actions: Iterable[str], target: Target) -> bool:
    return any(can(data, actor, action, target) for action in actions)
