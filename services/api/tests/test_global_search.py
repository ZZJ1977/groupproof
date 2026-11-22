"""Global search authorization, summary-vs-content isolation, and wildcard safety tests."""

from __future__ import annotations

from uuid import uuid4

import pytest
import test_c_discussions as discussion_tests
from fastapi.testclient import TestClient

from app.api.auth import get_current_user
from app.api.errors import ApiError
from app.db.models import CourseMember, FunctionalModule, Project, Task, User
from app.db.session import get_session
from app.main import app
from app.modules.a.search import search_workspace
from app.modules.c.files_models import LogicalFile
from app.modules.c.models import Evidence

db = discussion_tests.db
scope = discussion_tests.scope


def test_student_sees_own_content_and_only_summary_of_course_visible_peer_project(db, scope):
    author = scope.users["author"]
    outsider = scope.users["outsider"]
    db.add(CourseMember(id=uuid4(), course_id=scope.course.id, user_id=author.id, status="active"))

    # Add evidence and logical file in author's own project
    evidence = Evidence(
        id=uuid4(),
        project_id=scope.project.id,
        task_id=scope.task.id,
        author_id=author.id,
        title="Alpha 验收截图证据",
        description="验收截图说明",
        source_type="manual",
        status="formal",
    )
    logical_file = LogicalFile(
        id=uuid4(),
        project_id=scope.project.id,
        name="Alpha 架构设计文档.pdf",
        name_key="alpha 架构设计文档.pdf",
        category="documents",
        latest_version_no=1,
        official_version_no=1,
        created_by=author.id,
    )
    db.add_all([evidence, logical_file])

    # Create a peer project in the same course with visibility='course'
    peer_project = Project(
        id=uuid4(),
        course_id=scope.course.id,
        name="Alpha 同课公开项目",
        visibility="course",
        lifecycle="active",
    )
    private_peer_project = Project(
        id=uuid4(),
        course_id=scope.course.id,
        name="Alpha 同课私有项目",
        visibility="members",
        lifecycle="active",
    )
    db.add_all([peer_project, private_peer_project])
    db.flush()

    peer_module = FunctionalModule(
        id=uuid4(),
        project_id=peer_project.id,
        name="Peer Module",
    )
    db.add(peer_module)
    db.flush()

    peer_task = Task(
        id=uuid4(),
        project_id=peer_project.id,
        module_id=peer_module.id,
        created_by=outsider.id,
        title="Alpha 友组内部任务",
    )
    db.add(peer_task)
    db.flush()

    result = search_workspace(db, author, "Alpha")
    titles = {(item.kind, item.title) for item in result.items}

    assert ("evidence", "Alpha 验收截图证据") in titles
    assert ("file", "Alpha 架构设计文档.pdf") in titles
    assert ("project", "Alpha 同课公开项目") in titles
    # Must NOT see private peer project or tasks inside summary-only peer project
    assert ("project", "Alpha 同课私有项目") not in titles
    assert ("task", "Alpha 友组内部任务") not in titles

    # Unrelated outsider sees nothing
    outsider_result = search_workspace(db, outsider, "Alpha")
    assert outsider_result.items == []


def test_teacher_and_admin_search_respect_role_boundaries(db, scope):
    teacher = scope.users["teacher"]
    admin = scope.users["admin"]

    scope.course.name = "软件工程检索课"
    scope.project.name = "检索测试项目"
    scope.task.title = "检索核心任务"
    db.flush()

    teacher_res = search_workspace(db, teacher, "检索")
    teacher_kinds = {item.kind: item.href for item in teacher_res.items}
    assert teacher_kinds.get("course") == f"/teacher/courses/{scope.course.id}"
    assert teacher_kinds.get("project") == f"/projects/{scope.project.id}"
    assert teacher_kinds.get("task") == f"/projects/{scope.project.id}/tasks/{scope.task.id}"

    # Admin only sees governance targets (courses / users), never project or task content
    admin_res = search_workspace(db, admin, "检索")
    admin_kinds = {item.kind for item in admin_res.items}
    assert "course" in admin_kinds
    assert "project" not in admin_kinds
    assert "task" not in admin_kinds
    assert "evidence" not in admin_kinds
    assert "file" not in admin_kinds


def test_wildcard_characters_are_escaped_and_disabled_user_rejected(db, scope):
    author = scope.users["author"]
    # '%' must match literal '%', not everything in the workspace
    wildcard_res = search_workspace(db, author, "%")
    assert wildcard_res.items == []

    disabled = User(
        id=uuid4(),
        name="Disabled User",
        email=f"disabled-{uuid4().hex[:6]}@student.must.edu.mo",
        global_role="student",
        status="disabled",
    )
    db.add(disabled)
    db.flush()

    with pytest.raises(ApiError) as exc:
        search_workspace(db, disabled, "软件")
    assert exc.value.status_code == 403


def test_http_search_endpoint_returns_envelope(db, scope):
    author = scope.users["author"]
    scope.project.name = "HTTP检索验证项目"
    db.flush()

    app.dependency_overrides[get_session] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: author
    try:
        with TestClient(app) as client:
            response = client.get("/api/v1/search", params={"q": "HTTP检索验证"})
        assert response.status_code == 200
        payload = response.json()["data"]
        assert payload["query"] == "HTTP检索验证"
        assert any(
            item["kind"] == "project" and item["title"] == "HTTP检索验证项目"
            for item in payload["items"]
        )
    finally:
        app.dependency_overrides.pop(get_session, None)
        app.dependency_overrides.pop(get_current_user, None)
