"""AI 一键解析项目规划蓝图与 GitHub 代码提交-任务进度联动回归测试。"""

from __future__ import annotations

import os
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from sqlalchemy import JSON, DefaultClause, MetaData, create_engine, event, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapper, Session
from sqlalchemy.pool import StaticPool

from app.api.errors import ApiError
from app.db.base import Base
from app.db.models import Milestone, Project, ProjectMember, Task, User
from app.modules.a.ai.functions import _normalize_weights_to_100
from app.modules.a.models import GithubActivity, GithubRepoLink
from app.modules.b import ai_blueprint_service, code_progress_service, tasks_view_service
from app.modules.b.models import BModuleMeta, BProjectMaterial, BRequirementMeta, BTaskMeta
from app.modules.b.ports import get_verification_port
from tests.b_fixtures import _user, b_postgres_schema, b_test_database_url


@pytest.fixture
def bp_db(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("APP_MODE", "dev")
    monkeypatch.setenv("AI_PROVIDER", "fake")
    if os.getenv("B_TEST_DATABASE_URL"):
        with b_postgres_schema(b_test_database_url()) as pg_engine:
            with Session(pg_engine) as session:
                yield session
        return

    engine = create_engine(
        "sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False}
    )

    @event.listens_for(engine, "connect")
    def enforce_fk(conn, _):
        conn.execute("PRAGMA foreign_keys=ON")
        conn.create_function("gen_random_uuid", 0, lambda: uuid4().hex)

    @event.listens_for(Mapper, "before_insert")
    def fill_defaults(_, __, target):
        now = datetime.now(UTC)
        for column in target.__table__.columns:
            if getattr(target, column.key, None) is not None:
                continue
            if column.primary_key and column.type.python_type is type(uuid4()):
                setattr(target, column.key, uuid4())
            elif column.key in {
                "created_at",
                "updated_at",
                "joined_at",
                "linked_at",
                "occurred_at",
            }:
                setattr(target, column.key, now)

    meta = MetaData()
    for table in Base.metadata.tables.values():
        clone = table.to_metadata(meta)
        for col in clone.columns:
            if isinstance(col.type, JSONB):
                col.type = JSON()
            if isinstance(col.server_default, DefaultClause):
                raw = str(col.server_default.arg)
                if "gen_random_uuid" in raw or "::jsonb" in raw or "now()" in raw:
                    col.server_default = None
    meta.create_all(engine)
    with Session(engine) as session:
        yield session
    engine.dispose()


def _seed_independent_project(session: Session) -> tuple[User, User, Project]:
    now = datetime.now(UTC)
    tag = uuid4().hex[:6]
    leader = _user(session, tag=f"lead_{tag}", role="student", index=1, now=now)
    leader.name = "卓子杰"
    leader.github_username = "ZZJ1977"
    member = _user(session, tag=f"mem_{tag}", role="student", index=2, now=now)
    member.name = "杨凯景"
    member.github_username = "ProgramingGod-ykj"
    session.flush()

    project = Project(
        id=uuid4(),
        name="GroupProof",
        lifecycle="active",
        setup_status="draft",
    )
    session.add(project)
    session.flush()
    session.add(ProjectMember(id=uuid4(), project_id=project.id, user_id=leader.id, role="leader"))
    session.add(ProjectMember(id=uuid4(), project_id=project.id, user_id=member.id, role="member"))
    session.flush()
    return leader, member, project


def test_normalize_weights_sums_to_100():
    assert sum(_normalize_weights_to_100([10, 10, 10])) == 100
    assert sum(_normalize_weights_to_100([1] * 28)) == 100
    assert sum(_normalize_weights_to_100([50, 50, 50, 50])) == 100
    assert _normalize_weights_to_100([7]) == [100]


def test_generate_blueprint_creates_ai_requirements_milestones_and_tasks(bp_db):
    leader, member, project = _seed_independent_project(bp_db)
    mat = BProjectMaterial(
        id=uuid4(),
        project_id=project.id,
        kind="text",
        title="四人分工计划.pdf",
        text_content="A5 负责 GitHub 接入和同步；B3 负责项目初始化和需求基线；第1周完成底座。",
        extract_status="ready",
        created_by=leader.id,
    )
    bp_db.add(mat)
    bp_db.flush()

    class MultiModuleProvider:
        name = "test-llm"
        is_placeholder = False
        model = "test-model"
        last_usage = None

        def generate(self, feature, payload, *, timeout):
            assert feature == "generate_project_blueprint"
            return {
                "modules": [
                    {
                        "name": "模块 A：GitHub 集成",
                        "description": "同步提交与统计",
                        "owner_id": str(leader.id),
                    },
                    {
                        "name": "模块 B：需求与规划",
                        "description": "需求与任务规划",
                        "owner_id": str(member.id),
                    },
                ],
                "requirements": [
                    {
                        "title": "A5 GitHub 多分支同步与统计",
                        "description": "支持同步 commit 并按成员统计代码增减。",
                        "module": "模块 A：GitHub 集成",
                        "priority": "high",
                        "material_id": str(mat.id),
                        "quote": "A5 负责 GitHub 接入和同步",
                    },
                    {
                        "title": "B3 需求基线与分工初始化",
                        "description": "上传资料后由 AI 自动梳理需求与任务。",
                        "module": "模块 B：需求与规划",
                        "priority": "medium",
                        "material_id": str(mat.id),
                        "quote": "B3 负责项目初始化和需求基线",
                    },
                ],
                "milestones": [
                    {
                        "title": "第 1 周：核心能力落地",
                        "description": "完成 GitHub 接入和需求基线闭环",
                        "deadline": "2026-11-30",
                        "deliverables": ["GitHub 同步接口通过测试"],
                    }
                ],
                "tasks": [
                    {
                        "title": "A5 实现 GitHub 多分支同步与可视化",
                        "description": "对应 A5-01 ~ A5-07",
                        "module": "模块 A：GitHub 集成",
                        "requirement_titles": ["A5 GitHub 多分支同步与统计"],
                        "milestone_titles": ["第 1 周：核心能力落地"],
                        "assignee_ids": [str(leader.id)],
                        "priority": "high",
                        "weight": 60,
                        "acceptance_criteria": ["支持多分支并发同步 commit"],
                    },
                    {
                        "title": "B3 实现资料上传与 AI 需求解析",
                        "description": "对应 B3-01 ~ B3-08",
                        "module": "模块 B：需求与规划",
                        "requirement_titles": ["B3 需求基线与分工初始化"],
                        "milestone_titles": ["第 1 周：核心能力落地"],
                        "assignee_ids": [str(member.id)],
                        "priority": "medium",
                        "weight": 40,
                        "acceptance_criteria": ["点击生成即可出需求与任务"],
                    },
                ],
                "in_scope": "覆盖 GitHub 同步与需求规划",
                "out_of_scope": "不含商业计费",
            }

    res = ai_blueprint_service.generate_and_apply_blueprint(
        bp_db, leader, project.id, get_verification_port(), provider=MultiModuleProvider()
    )
    assert res.modules_added == 2
    assert res.requirements_added == 2
    assert res.milestones_added == 1
    assert res.tasks_added == 2
    assert res.needs_human_review is True

    mod_origins = set(
        bp_db.scalars(select(BModuleMeta.origin).where(BModuleMeta.project_id == project.id))
    )
    req_origins = set(
        bp_db.scalars(
            select(BRequirementMeta.origin).where(BRequirementMeta.project_id == project.id)
        )
    )
    task_origins = set(
        bp_db.scalars(select(BTaskMeta.origin).where(BTaskMeta.project_id == project.id))
    )
    assert mod_origins == {"ai"}
    assert req_origins == {"ai"}
    assert task_origins == {"ai"}

    tasks = list(bp_db.scalars(select(Task).where(Task.project_id == project.id)))
    assert sum(int(t.weight) for t in tasks) == 100

    # 基线冻结后不可再用 AI 覆盖生成
    project.setup_status = "frozen"
    bp_db.flush()
    with pytest.raises(ApiError) as exc:
        ai_blueprint_service.generate_and_apply_blueprint(
            bp_db, leader, project.id, get_verification_port(), provider=MultiModuleProvider()
        )
    assert exc.value.code == "BASELINE_FROZEN"


def test_code_progress_sync_matches_commits_and_caps_at_90_percent(bp_db):
    leader, _member, project = _seed_independent_project(bp_db)
    mat = BProjectMaterial(
        id=uuid4(),
        project_id=project.id,
        kind="text",
        title="规划.txt",
        text_content="A5 GitHub 集成",
        extract_status="ready",
        created_by=leader.id,
    )
    bp_db.add(mat)
    bp_db.flush()

    ai_blueprint_service.generate_and_apply_blueprint(
        bp_db, leader, project.id, get_verification_port()
    )
    task = bp_db.scalar(select(Task).where(Task.project_id == project.id))
    assert task is not None
    milestone = bp_db.scalar(select(Milestone).where(Milestone.project_id == project.id))
    assert milestone is not None
    assert task.progress_percent == 0
    assert task.status == "not_started"

    link = GithubRepoLink(
        id=uuid4(),
        project_id=project.id,
        owner="acme",
        repo="demo",
        installation_id=123,
        default_branch="main",
        linked_by_id=leader.id,
    )
    bp_db.add(link)
    bp_db.flush()

    # 写入 22 条真实成员提交 + 5 条 Claude 机器人提交
    for idx in range(22):
        bp_db.add(
            GithubActivity(
                id=uuid4(),
                project_id=project.id,
                link_id=link.id,
                kind="commit",
                external_id=f"sha-{idx:02d}",
                revision=f"sha-{idx:02d}",
                title=f"feat(#T-001): iterate feature {idx}",
                summary="Added test coverage",
                author_login="ZZJ1977",
                author_name="卓子杰",
                author_user_id=leader.id,
                detail={"sha": f"sha-{idx:02d}", "files": [{"path": "tests/test_a.py"}]},
                occurred_at=datetime(2026, 11, 20, idx % 24, 0, tzinfo=UTC),
                synced_at=datetime(2026, 11, 20, 23, 0, tzinfo=UTC),
            )
        )
    for idx in range(5):
        bp_db.add(
            GithubActivity(
                id=uuid4(),
                project_id=project.id,
                link_id=link.id,
                kind="commit",
                external_id=f"bot-{idx:02d}",
                revision=f"bot-{idx:02d}",
                title="chore: automated edit",
                summary="#T-001",
                author_login="claude[bot]",
                author_name="Claude",
                author_email="noreply@anthropic.com",
                detail={"sha": f"bot-{idx:02d}"},
                occurred_at=datetime(2026, 11, 21, idx, 0, tzinfo=UTC),
                synced_at=datetime(2026, 11, 21, 23, 0, tzinfo=UTC),
            )
        )
    bp_db.flush()

    sync_res = code_progress_service.sync_task_code_progress(
        bp_db, project.id, actor=leader, require_member_auth=True
    )
    assert sync_res.commits_scanned == 22  # Claude 5 条被完全过滤
    assert sync_res.commits_matched == 22
    assert sync_res.tasks_updated == 1
    assert sync_res.milestones_updated == 1

    bp_db.refresh(task)
    bp_db.refresh(milestone)
    # 推进为进行中且最高 90%，绝不会自动变为 completed 或 100%
    assert task.status == "in_progress"
    assert task.progress_percent == 90
    assert milestone.status == "in_progress"

    page = tasks_view_service.list_tasks(bp_db, leader, project.id, view="list")
    assert page.items[0].matched_commits == 22
    assert page.items[0].progress_percent == 90
