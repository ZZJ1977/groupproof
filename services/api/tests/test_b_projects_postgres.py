"""B-3 (B3-01~B3-04): create project, overview, basic info, materials — HTTP over PostgreSQL."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, date, datetime, timedelta
from threading import Barrier
from uuid import uuid4

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import (
    Course,
    FunctionalModule,
    Milestone,
    Project,
    ProjectMember,
    Task,
)
from app.modules.a.models import AuditEvent, UploadReceipt
from app.modules.b.models import BProjectDraft, BProjectMaterial
from app.modules.b.ports import MaterialText, TextSegment, get_material_text_port
from tests.b_fixtures import (
    add_course_student,
    b_api,
    b_postgres_schema,
    b_test_database_url,
    build_b_world,
)


@pytest.fixture
def b_engine(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    with b_postgres_schema(b_test_database_url()) as engine:
        yield engine


@pytest.fixture
def setup(b_engine):
    with Session(b_engine) as session:
        world = build_b_world(session)
        other = build_b_world(session)
        loose = [add_course_student(session, world) for _ in range(3)]
        session.commit()
    with b_api(b_engine) as api:
        yield api, world, other, loose


def error(response):
    return response.json()["error"]["code"]


def new_group(api, world, loose):
    """A fresh group (no project yet): loose[0] leads, loose[1] joins."""
    created = api.as_user(loose[0]).post(
        f"/api/v1/courses/{world.course_id}/groups", {"name": "新组", "direction": "方向"}
    )
    assert created.status_code == 201, created.text
    group_id = created.json()["data"]["id"]
    assert api.post_as(loose[1], f"/api/v1/groups/{group_id}/join").status_code == 200
    api.as_user(loose[0])
    return group_id


def create(api, group_id, name="课程项目"):
    return api.post(
        f"/api/v1/groups/{group_id}/projects",
        {"name": name, "description": "做一个小系统", "project_type": "软件开发"},
    )


def set_template(api, world, milestones):
    api.as_user(world.teacher_id)
    current = api.get(f"/api/v1/courses/{world.course_id}/project-template").json()["data"]
    return api.put(
        f"/api/v1/courses/{world.course_id}/project-template",
        {"milestones": milestones, "expected_version": current["lock_version"]},
    )


# ---------------------------------------------------------------- B3-01


def test_create_copies_members_deadline_and_template(setup, b_engine):
    api, world, other, loose = setup
    deadline = (datetime.now(UTC) + timedelta(days=30)).isoformat()
    response = set_template(
        api, world, [{"title": "开题", "deadline": deadline}, {"title": "中期检查"}]
    )
    assert response.status_code == 200, response.text
    group_id = new_group(api, world, loose)
    response = create(api, group_id)
    assert response.status_code == 201, response.text
    data = response.json()["data"]
    assert data["href"] == f"/projects/{data['project_id']}/setup"
    with Session(b_engine) as session:
        project = session.get(Project, data["project_id"])
        course = session.get(Course, world.course_id)
        assert project.group_id == group_id or str(project.group_id) == group_id
        assert project.final_deadline == course.project_deadline
        assert project.setup_status == "draft"
        roles = dict(
            session.execute(
                select(ProjectMember.user_id, ProjectMember.role).where(
                    ProjectMember.project_id == project.id
                )
            ).all()
        )
        assert roles == {loose[0]: "leader", loose[1]: "member"}
        titles = session.scalars(
            select(Milestone.title)
            .where(Milestone.project_id == project.id)
            .order_by(Milestone.sort_order)
        ).all()
        assert titles == ["开题", "中期检查"]
        assert session.scalar(
            select(func.count())
            .select_from(AuditEvent)
            .where(AuditEvent.action == "project.created", AuditEvent.project_id == project.id)
        )


def test_only_leader_creates_and_only_once(setup, b_engine):
    api, world, other, loose = setup
    group_id = new_group(api, world, loose)
    api.as_user(loose[1])
    assert create(api, group_id).status_code == 403
    api.as_user(loose[2])
    assert error(create(api, group_id)) == "GROUP_NOT_FOUND"
    api.as_user(loose[0])
    assert create(api, group_id).status_code == 201
    second = create(api, group_id, name="另一个")
    assert second.status_code == 409 and error(second) == "PROJECT_ALREADY_EXISTS"
    # The fixture group already has a project.
    api.as_user(world.leader_id)
    assert error(create(api, world.group_id)) == "PROJECT_ALREADY_EXISTS"


def test_concurrent_create_makes_one_project(setup, b_engine):
    api, world, other, loose = setup
    group_id = new_group(api, world, loose)
    barrier = Barrier(2)

    def race(name):
        barrier.wait()
        return api.post_as(
            loose[0], f"/api/v1/groups/{group_id}/projects", {"name": name, "project_type": None}
        )

    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(race, ["甲", "乙"]))
    assert sorted(r.status_code for r in results) == [201, 409]
    assert {error(r) for r in results if r.status_code == 409} == {"PROJECT_ALREADY_EXISTS"}
    with Session(b_engine) as session:
        assert (
            session.scalar(
                select(func.count()).select_from(Project).where(Project.group_id == group_id)
            )
            == 1
        )


def test_draft_persists_and_is_removed_on_create(setup, b_engine):
    api, world, other, loose = setup
    group_id = new_group(api, world, loose)
    path = f"/api/v1/groups/{group_id}/project-draft"
    assert api.get(path).json()["data"]["lock_version"] == 0
    saved = api.put(path, {"payload": {"name": "草稿名"}, "step": 1, "expected_version": 0})
    assert saved.status_code == 200, saved.text
    stale = api.put(path, {"payload": {"name": "x"}, "step": 1, "expected_version": 0})
    assert error(stale) == "VERSION_CONFLICT"
    # A teammate sees the same draft after "refresh".
    api.as_user(loose[1])
    draft = api.get(path).json()["data"]
    assert draft["payload"] == {"name": "草稿名"} and draft["lock_version"] == 1
    api.as_user(loose[2])
    assert api.get(path).status_code == 404
    api.as_user(loose[0])
    project_id = create(api, group_id).json()["data"]["project_id"]
    after = api.get(path).json()["data"]
    assert after["project_id"] == project_id and after["payload"] == {}
    assert error(api.put(path, {"payload": {}, "step": 1, "expected_version": 0})) == (
        "PROJECT_ALREADY_EXISTS"
    )
    with Session(b_engine) as session:
        assert session.get(BProjectDraft, group_id) is None


def test_template_is_teacher_only(setup):
    api, world, other, loose = setup
    api.as_user(world.leader_id)
    assert api.get(f"/api/v1/courses/{world.course_id}/project-template").status_code == 200
    denied = api.put(
        f"/api/v1/courses/{world.course_id}/project-template",
        {"milestones": [], "expected_version": 0},
    )
    assert denied.status_code == 403
    api.as_user(world.leader_id)
    assert api.get(f"/api/v1/courses/{other.course_id}/project-template").status_code == 404


# ---------------------------------------------------------------- B3-02


def add_tasks(engine, project_id, values):
    with Session(engine) as session:
        module = FunctionalModule(id=uuid4(), project_id=project_id, name=f"模块{uuid4().hex[:6]}")
        session.add(module)
        session.flush()
        for progress, status in values:
            session.add(
                Task(
                    id=uuid4(),
                    project_id=project_id,
                    module_id=module.id,
                    title=f"任务{progress}",
                    status=status,
                    progress_percent=progress,
                )
            )
        session.commit()


def test_overview_entry_follows_setup_and_lifecycle(setup, b_engine):
    api, world, other, loose = setup
    path = f"/api/v1/projects/{world.project_id}/overview"
    api.as_user(world.leader_id)
    data = api.get(path).json()["data"]
    assert data["entry"] == "setup" and data["is_leader"] and data["can_edit"]
    assert data["stats"]["progress_status"] == "no_weighted_tasks"
    assert data["stats"]["member_count"] == 4
    with Session(b_engine) as session:
        session.get(Project, world.project_id).setup_status = "frozen"
        session.commit()
    assert api.get(path).json()["data"]["entry"] == "baseline"
    with Session(b_engine) as session:
        session.get(Project, world.project_id).lifecycle = "archived"
        session.commit()
    data = api.get(path).json()["data"]
    assert data["entry"] == "readonly" and data["can_edit"] is False


def test_overview_stats_follow_tasks(setup, b_engine):
    api, world, other, loose = setup
    path = f"/api/v1/projects/{world.project_id}/overview"
    api.as_user(world.member_ids[0])
    add_tasks(b_engine, world.project_id, [(100, "completed"), (0, "not_started")])
    stats = api.get(path).json()["data"]["stats"]
    assert stats["task_count"] == 2 and stats["completed_count"] == 1
    assert stats["progress"] == 50 and stats["progress_status"] == "available"
    add_tasks(b_engine, world.project_id, [(100, "completed")])
    stats = api.get(path).json()["data"]["stats"]
    assert stats["task_count"] == 3 and stats["completed_count"] == 2


def test_overview_scope(setup):
    api, world, other, loose = setup
    path = f"/api/v1/projects/{world.project_id}/overview"
    api.as_user(world.teacher_id)
    data = api.get(path).json()["data"]
    assert data["can_edit"] is False and data["is_leader"] is False
    api.as_user(other.leader_id)
    assert error(api.get(path)) == "PROJECT_NOT_FOUND"
    api.as_user(loose[0])
    assert api.get(path).status_code == 404
    api.as_user(None)
    assert api.get(path).status_code == 401


# ---------------------------------------------------------------- B3-03


def basic(api, project_id, **values):
    if "expected_version" not in values:
        current = api.get(f"/api/v1/projects/{project_id}/setup").json()["data"]
        values["expected_version"] = current["lock_version"]
    body = {
        "name": "新名字",
        "project_type": "软件开发",
        "description": "简介",
        "start_date": date.today().isoformat(),
        "end_date": (date.today() + timedelta(days=30)).isoformat(),
    }
    body.update(values)
    return api.patch(f"/api/v1/projects/{project_id}/setup/basic", body)


def test_basic_info_saves_and_survives_refresh(setup, b_engine):
    api, world, other, loose = setup
    api.as_user(world.member_ids[0])
    response = basic(api, world.project_id)
    assert response.status_code == 200, response.text
    data = api.get(f"/api/v1/projects/{world.project_id}/setup").json()["data"]
    assert data["name"] == "新名字" and data["setup_step"] == 2
    assert data["end_date"] == (date.today() + timedelta(days=30)).isoformat()
    assert data["setup_status"] == "draft"


def test_basic_info_date_rules(setup):
    api, world, other, loose = setup
    api.as_user(world.leader_id)
    today = date.today()
    bad = basic(
        api,
        world.project_id,
        start_date=today.isoformat(),
        end_date=(today - timedelta(days=1)).isoformat(),
    )
    assert bad.status_code == 422 and error(bad) == "END_BEFORE_START"
    assert bad.json()["error"]["details"]["field"] == "end_date"
    late = basic(api, world.project_id, end_date=(today + timedelta(days=400)).isoformat())
    assert late.status_code == 422 and error(late) == "END_AFTER_COURSE_DEADLINE"
    blank = basic(api, world.project_id, name="   ")
    assert error(blank) == "PROJECT_NAME_REQUIRED"


def test_basic_info_version_and_scope(setup, b_engine):
    api, world, other, loose = setup
    api.as_user(world.leader_id)
    stale = basic(api, world.project_id, expected_version=99)
    assert error(stale) == "VERSION_CONFLICT"
    api.as_user(world.teacher_id)
    assert basic(api, world.project_id).status_code == 403
    api.as_user(other.leader_id)
    assert basic(api, world.project_id, expected_version=0).status_code == 404
    with Session(b_engine) as session:
        session.get(Project, world.project_id).setup_status = "frozen"
        session.commit()
    api.as_user(world.leader_id)
    assert error(basic(api, world.project_id)) == "BASELINE_FROZEN"


# ---------------------------------------------------------------- B3-04


def add_receipt(engine, project_id, actor_id, *, status="completed"):
    with Session(engine) as session:
        receipt = UploadReceipt(
            id=uuid4(),
            scope="project",
            scope_id=project_id,
            actor_id=actor_id,
            provider="local",
            bucket="test",
            object_id=f"obj-{uuid4().hex}",
            filename="需求说明.pdf",
            declared_mime="application/pdf",
            declared_size=100,
            status=status,
            created_at=datetime.now(UTC),
            upload_expires_at=datetime.now(UTC) + timedelta(hours=1),
        )
        session.add(receipt)
        session.commit()
        return receipt.id


def test_text_material_keeps_full_text(setup):
    api, world, other, loose = setup
    api.as_user(world.leader_id)
    body = "第一行标题\n" + "很长的需求正文。" * 2000
    response = api.post(
        f"/api/v1/projects/{world.project_id}/materials", {"kind": "text", "text": body}
    )
    assert response.status_code == 201, response.text
    data = response.json()["data"]
    assert data["title"] == "第一行标题" and data["extract_status"] == "ready"
    full = api.get(f"/api/v1/projects/{world.project_id}/materials/{data['id']}").json()["data"]
    assert full["text"] == body.strip() and full["text_length"] == len(body.strip())
    listing = api.get(f"/api/v1/projects/{world.project_id}/setup").json()["data"]["materials"]
    assert listing[0]["text"] is None and listing[0]["text_length"] == len(body.strip())
    empty = api.post(
        f"/api/v1/projects/{world.project_id}/materials", {"kind": "text", "text": "  "}
    )
    assert error(empty) == "MATERIAL_TEXT_REQUIRED"


def test_file_material_without_extraction_says_unavailable(setup, b_engine):
    api, world, other, loose = setup
    api.as_user(world.leader_id)
    receipt_id = add_receipt(b_engine, world.project_id, world.leader_id)
    response = api.post(
        f"/api/v1/projects/{world.project_id}/materials",
        {"kind": "file", "receipt_id": str(receipt_id)},
    )
    assert response.status_code == 201, response.text
    data = response.json()["data"]
    assert data["extract_status"] == "unavailable" and data["text"] is None
    assert data["title"] == "需求说明.pdf" and data["extract_reason"]
    again = api.post(
        f"/api/v1/projects/{world.project_id}/materials",
        {"kind": "file", "receipt_id": str(receipt_id)},
    )
    assert error(again) == "MATERIAL_ALREADY_ADDED"


def test_file_material_uses_extracted_text_when_ready(setup, b_engine):
    api, world, other, loose = setup

    class Ready:
        def get_text(self, session, *, receipt_id, actor_id):
            return MaterialText(
                receipt_id=receipt_id,
                status="ready",
                segments=(TextSegment(segment_id="s1", text="抽取出的正文"),),
            )

    api._app.dependency_overrides[get_material_text_port] = Ready
    api.as_user(world.leader_id)
    receipt_id = add_receipt(b_engine, world.project_id, world.leader_id)
    data = api.post(
        f"/api/v1/projects/{world.project_id}/materials",
        {"kind": "file", "receipt_id": str(receipt_id)},
    ).json()["data"]
    assert data["extract_status"] == "ready" and data["text"] == "抽取出的正文"


def test_file_material_rejects_foreign_or_unfinished_receipts(setup, b_engine):
    api, world, other, loose = setup
    api.as_user(world.leader_id)
    pending = add_receipt(b_engine, world.project_id, world.leader_id, status="pending")
    foreign = add_receipt(b_engine, other.project_id, world.leader_id)
    someone_else = add_receipt(b_engine, world.project_id, world.member_ids[0])
    for receipt_id in (pending, foreign, someone_else, uuid4()):
        response = api.post(
            f"/api/v1/projects/{world.project_id}/materials",
            {"kind": "file", "receipt_id": str(receipt_id)},
        )
        assert error(response) == "UPLOAD_RECEIPT_INVALID", receipt_id
    with Session(b_engine) as session:
        assert session.scalar(select(func.count()).select_from(BProjectMaterial)) == 0


def test_material_scope(setup):
    api, world, other, loose = setup
    api.as_user(world.leader_id)
    material_id = api.post(
        f"/api/v1/projects/{world.project_id}/materials", {"kind": "text", "text": "正文"}
    ).json()["data"]["id"]
    api.as_user(other.leader_id)
    assert (
        api.get(f"/api/v1/projects/{world.project_id}/materials/{material_id}").status_code == 404
    )
    assert (
        api.get(f"/api/v1/projects/{other.project_id}/materials/{material_id}").status_code == 404
    )
    api.as_user(world.teacher_id)
    assert (
        api.post(
            f"/api/v1/projects/{world.project_id}/materials", {"kind": "text", "text": "x"}
        ).status_code
        == 403
    )
