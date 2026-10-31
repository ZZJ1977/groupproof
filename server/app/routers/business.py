"""受保护业务读取接口（P2 数据保护样板）。

每个请求独立执行：有效会话 → 注册资格（active）→ 目标资源权限。
公开总览只返回五字段 DTO；数据来源边界见 services/business.py。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session as DbSession

from ..db import get_db
from ..errors import AppError
from ..guard import AuthContext, require_active_user
from ..services import authz
from ..services.business import load_business_data

router = APIRouter(prefix="/api/v1", tags=["business"])


def actor_of(context: AuthContext) -> dict:
    roles = context.user.roles or []
    role = "admin" if "admin" in roles else "teacher" if "teacher" in roles else "ta" if "ta" in roles else "student"
    return {
        "id": context.user.id,
        "role": role,
        "status": "active",  # require_active_user 已校验 accountState=active
        "teacherStatus": "approved" if "teacher" in roles else None,
    }


@router.get("/home/summary")
def home_summary(request: Request, context: AuthContext = Depends(require_active_user), db: DbSession = Depends(get_db)) -> JSONResponse:
    data = load_business_data()
    actor = actor_of(context)
    projects = [
        authz.project_summary(project)
        for project in data.get("projects", [])
        if authz.can(data, actor, "project.content.read", {"kind": "project", "id": project["id"]})
        or authz.can(data, actor, "project.summary.read", {"kind": "project", "id": project["id"]})
    ]
    courses = [
        {"id": course["id"], "name": course["name"]}
        for course in data.get("courses", [])
        if authz.can(data, actor, "course.read", {"kind": "course", "id": course["id"]})
    ]
    return JSONResponse({"projects": projects, "courses": courses}, headers={"Cache-Control": "private, no-store"})


@router.get("/projects/{project_id}/summary")
def project_summary_view(project_id: str, request: Request, context: AuthContext = Depends(require_active_user), db: DbSession = Depends(get_db)) -> JSONResponse:
    data = load_business_data()
    actor = actor_of(context)
    target = {"kind": "project", "id": project_id}
    project = next((item for item in data.get("projects", []) if item["id"] == project_id), None)
    if project is None:
        raise AppError("NOT_FOUND", 404)
    if not (authz.can(data, actor, "project.summary.read", target) or authz.can(data, actor, "project.content.read", target)):
        raise AppError("NOT_FOUND", 404)  # 无权资源统一 404，不泄露存在性
    return JSONResponse(authz.project_summary(project), headers={"Cache-Control": "private, no-store"})


@router.get("/projects/{project_id}/content")
def project_content(project_id: str, request: Request, context: AuthContext = Depends(require_active_user), db: DbSession = Depends(get_db)) -> JSONResponse:
    data = load_business_data()
    actor = actor_of(context)
    target = {"kind": "project", "id": project_id}
    project = next((item for item in data.get("projects", []) if item["id"] == project_id), None)
    if project is None:
        raise AppError("NOT_FOUND", 404)
    if not authz.can(data, actor, "project.content.read", target):
        raise AppError("NOT_FOUND", 404)
    content = {
        **authz.project_summary(project),
        "requirementIds": project.get("requirementIds", []),
        "taskIds": project.get("taskIds", []),
        "memberIds": project.get("memberIds", []),
        "visibility": project.get("visibility"),
    }
    return JSONResponse(content, headers={"Cache-Control": "private, no-store"})
