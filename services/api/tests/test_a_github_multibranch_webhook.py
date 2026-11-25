"""A5 多分支提交同步与 GitHub Webhook 自动刷新回归测试。"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import JSON, DefaultClause, MetaData, create_engine, event, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapper, Session
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.models import Course, Project, ProjectMember, User
from app.db.session import get_session
from app.main import app
from app.modules.a import github, github_sync
from app.modules.a.models import GithubActivity
from tests.b_fixtures import _user, b_postgres_schema, b_test_database_url


@pytest.fixture
def github_db(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("APP_MODE", "dev")
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


def _seed_project(session: Session) -> tuple[User, Project]:
    now = datetime.now(UTC)
    tag = uuid4().hex[:6]
    teacher = _user(session, tag=f"t_{tag}", role="teacher", index=1, now=now)
    leader = _user(session, tag=f"s_{tag}", role="student", index=1, now=now)
    session.flush()
    course = Course(
        id=uuid4(),
        owner_id=teacher.id,
        name="SE Course",
        code=f"SE{uuid4().hex[:6]}",
        college="FIE",
        semester="2026 Fall",
        status="active",
    )
    session.add(course)
    session.flush()
    project = Project(
        id=uuid4(),
        name="Demo Project",
        course_id=course.id,
        visibility="members",
        lifecycle="active",
    )
    session.add(project)
    session.flush()
    session.add(
        ProjectMember(
            id=uuid4(),
            project_id=project.id,
            user_id=leader.id,
            role="leader",
        )
    )
    session.flush()
    return leader, project


class MultiBranchFakeGithub:
    def __init__(self, branch_commits: dict[str, list[dict]], *, pulls=None, runs=None):
        self.branch_commits = branch_commits
        self.pulls_data = pulls or []
        self.runs_data = runs or []

    def close(self):
        return None

    def installation_for_repo(self, owner, repo):
        return 42

    def repo_info(self, owner, repo, installation_id):
        return {"full_name": f"{owner}/{repo}", "default_branch": "main", "private": False}

    def tree(self, owner, repo, ref, installation_id):
        return {"tree": [], "truncated": False}

    def branches(self, owner, repo, installation_id):
        return [{"name": name} for name in self.branch_commits]

    def commits(self, owner, repo, branch, installation_id, *, per_page=100):
        return list(self.branch_commits.get(branch, []))[:per_page]

    def pulls(self, owner, repo, installation_id):
        return list(self.pulls_data)

    def workflow_runs(self, owner, repo, installation_id):
        return list(self.runs_data)

    def commit_exists(self, owner, repo, sha, installation_id):
        return any(item["sha"] == sha for items in self.branch_commits.values() for item in items)

    def run_exists(self, owner, repo, run_id, installation_id):
        return any(str(item["id"]) == str(run_id) for item in self.runs_data)


def _commit(sha: str, message: str, iso_date: str) -> dict:
    return {
        "sha": sha,
        "html_url": f"https://github.com/acme/demo/commit/{sha}",
        "commit": {
            "message": message,
            "author": {"name": "Alice", "email": "alice@example.com", "date": iso_date},
        },
        "author": {"id": 1001, "login": "alice"},
    }


def test_multibranch_sync_imports_develop_and_deduplicates_shared_commits(github_db):
    leader, project = _seed_project(github_db)
    shared = _commit("aaaa1111bbbb2222", "shared baseline commit", "2026-11-21T10:00:00Z")
    dev_only = _commit("cccc3333dddd4444", "feat: student workspace polish", "2026-11-22T12:00:00Z")
    client = MultiBranchFakeGithub(
        {
            "main": [shared],
            "develop": [dev_only, shared],
        }
    )
    github_sync.link_repo(github_db, leader, project.id, "https://github.com/acme/demo", client)
    totals = github_sync.sync_project_repos(github_db, leader, project.id, client)
    assert totals["commits"] == 2

    rows = {
        row.external_id: row
        for row in github_db.scalars(
            select(GithubActivity).where(
                GithubActivity.project_id == project.id,
                GithubActivity.kind == "commit",
            )
        )
    }
    assert set(rows) == {"aaaa1111bbbb2222", "cccc3333dddd4444"}
    assert rows["cccc3333dddd4444"].detail["branch"] == "develop"
    assert rows["aaaa1111bbbb2222"].detail["branches"] == ["main", "develop"]


def test_github_webhook_verifies_signature_and_syncs_linked_project(github_db, monkeypatch):
    leader, project = _seed_project(github_db)
    initial = MultiBranchFakeGithub({"main": [_commit("1111aaaa", "init", "2026-11-21T08:00:00Z")]})
    github_sync.link_repo(github_db, leader, project.id, "https://github.com/acme/demo", initial)
    github_db.commit()

    updated = MultiBranchFakeGithub(
        {
            "main": [_commit("1111aaaa", "init", "2026-11-21T08:00:00Z")],
            "develop": [_commit("2222bbbb", "push on develop", datetime.now(UTC).isoformat())],
        }
    )
    monkeypatch.setenv("GITHUB_WEBHOOK_SECRET", "test-webhook-secret")
    monkeypatch.setattr(github, "get_github_client", lambda: updated)

    def _override_session():
        yield github_db

    app.dependency_overrides[get_session] = _override_session
    try:
        http = TestClient(app)
        body = json.dumps({"repository": {"full_name": "acme/demo"}}).encode("utf-8")

        bad = http.post(
            "/api/v1/webhooks/github",
            content=body,
            headers={
                "X-GitHub-Event": "push",
                "X-Hub-Signature-256": "sha256=invalid",
            },
        )
        assert bad.status_code == 401

        sig = "sha256=" + hmac.new(b"test-webhook-secret", body, hashlib.sha256).hexdigest()
        res = http.post(
            "/api/v1/webhooks/github",
            content=body,
            headers={
                "X-GitHub-Event": "push",
                "X-Hub-Signature-256": sig,
            },
        )
        assert res.status_code == 200, res.text
        data = res.json()["data"]
        assert data["handled"] is True
        assert data["projects"] == 1
        assert data["commits"] == 2
    finally:
        app.dependency_overrides.pop(get_session, None)


def test_github_activity_stats_aggregates_commits_and_code_churn(github_db):
    from app.modules.a import github_activity

    leader, project = _seed_project(github_db)

    class StatsFakeGithub(MultiBranchFakeGithub):
        def commit_detail(self, owner, repo, sha, installation_id):
            mapping = {
                "aaaa1111": {
                    "stats": {"additions": 120, "deletions": 30, "total": 150},
                    "changed_files": 3,
                    "files": [
                        {
                            "filename": "a.py",
                            "status": "modified",
                            "additions": 120,
                            "deletions": 30,
                        }
                    ],
                },
                "bbbb2222": {
                    "stats": {"additions": 45, "deletions": 10, "total": 55},
                    "changed_files": 1,
                    "files": [
                        {"filename": "b.py", "status": "added", "additions": 45, "deletions": 10}
                    ],
                },
            }
            return mapping[sha]

    c1 = _commit("aaaa1111", "feat: chart api", "2026-11-22T10:00:00Z")
    c2 = {
        "sha": "bbbb2222",
        "html_url": "https://github.com/acme/demo/commit/bbbb2222",
        "commit": {
            "message": "fix: ui polish",
            "author": {"name": "Bob", "email": "bob@example.com", "date": "2026-11-23T09:00:00Z"},
        },
        "author": {"id": 2002, "login": "bob"},
    }
    client = StatsFakeGithub({"main": [c1, c2]})
    github_sync.link_repo(github_db, leader, project.id, "https://github.com/acme/demo", client)
    github_sync.sync_project_repos(github_db, leader, project.id, client)

    stats = github_activity.get_activity_stats(github_db, leader, project.id, days=14)
    assert stats["total_commits"] == 2
    assert stats["total_additions"] == 165
    assert stats["total_deletions"] == 40
    assert stats["commits_with_stats"] == 2
    assert len(stats["contributors"]) == 2
    assert stats["contributors"][0]["author_name"] == "Alice"
    assert stats["contributors"][0]["additions"] == 120
    assert stats["contributors"][1]["author_name"] == "Bob"
    assert stats["contributors"][1]["deletions"] == 10
    assert len(stats["daily"]) == 14


def test_auto_summaries_detect_and_analyze_new_commits(github_db, monkeypatch):
    from sqlalchemy.orm import sessionmaker

    from app.modules.a import activity_summary

    monkeypatch.setenv("AI_PROVIDER", "fake")
    monkeypatch.setenv("APP_ENV", "test")
    leader, project = _seed_project(github_db)
    client = MultiBranchFakeGithub(
        {"main": [_commit("eeee5555", "feat: auto analyze commit", "2026-11-23T08:00:00Z")]}
    )
    github_sync.link_repo(github_db, leader, project.id, "https://github.com/acme/demo", client)
    github_sync.sync_project_repos(github_db, leader, project.id, client)
    github_db.commit()

    pending = activity_summary.recent_unanalyzed_commit_ids(github_db, project.id)
    assert len(pending) == 1

    factory = sessionmaker(bind=github_db.get_bind(), autoflush=False, autocommit=False)
    done = activity_summary.run_auto_summaries(
        project.id, leader.id, pending, session_factory=factory
    )
    assert done == 1
    assert activity_summary.recent_unanalyzed_commit_ids(github_db, project.id) == []


def test_github_activity_stats_excludes_claude_bots_merges_member_aliases_and_filters_ranges(
    github_db,
):
    from datetime import UTC, date, datetime

    from app.auth.models import VerifiedGithubIdentity
    from app.modules.a import github_activity

    leader, project = _seed_project(github_db)
    leader.name = "Alice"
    github_db.add(
        VerifiedGithubIdentity(
            user_id=leader.id, github_user_id=1001, login="alice", verified_at=datetime.now(UTC)
        )
    )
    github_db.flush()
    # 同一成员用本地 Git 名称（无 GitHub author.id）提交 + Claude 机器人提交 + 较早日期提交
    c_old = _commit("old00001", "feat: early commit", "2026-10-15T10:00:00Z")
    c_alias = {
        "sha": "alias002",
        "html_url": "https://github.com/acme/demo/commit/alias002",
        "commit": {
            "message": "fix: local name commit",
            "author": {"name": "Alice", "email": "alice@local", "date": "2026-11-22T10:00:00Z"},
        },
        "author": None,
    }
    c_claude = {
        "sha": "bot00003",
        "html_url": "https://github.com/acme/demo/commit/bot00003",
        "commit": {
            "message": "chore: ai commit",
            "author": {
                "name": "Claude",
                "email": "noreply@anthropic.com",
                "date": "2026-11-23T08:00:00Z",
            },
        },
        "author": {"id": 99999, "login": "claude[bot]"},
    }
    c_dep = {
        "sha": "bot00004",
        "html_url": "https://github.com/acme/demo/commit/bot00004",
        "commit": {
            "message": "chore(deps): bump",
            "author": {
                "name": "dependabot[bot]",
                "email": "dependabot[bot]@users.noreply.github.com",
                "date": "2026-11-23T09:00:00Z",
            },
        },
        "author": {"id": 88888, "login": "dependabot[bot]"},
    }
    client = MultiBranchFakeGithub({"main": [c_old, c_alias, c_claude, c_dep]})
    github_sync.link_repo(github_db, leader, project.id, "https://github.com/acme/demo", client)
    github_sync.sync_project_repos(github_db, leader, project.id, client)

    # 1. range=all: 过滤 Claude 与 dependabot，且 Alice 的两条提交（验证账号 + 本地名称）合并为 1 人
    all_stats = github_activity.get_activity_stats(github_db, leader, project.id, range_key="all")
    assert all_stats["range"] == "all"
    assert all_stats["total_commits"] == 2
    assert all_stats["all_time_commits"] == 2
    assert len(all_stats["contributors"]) == 1
    assert all_stats["contributors"][0]["author_name"] == "Alice"
    assert all_stats["contributors"][0]["commits"] == 2
    assert all_stats["earliest_date"] == "2026-10-15"
    assert all_stats["latest_date"] == "2026-11-22"

    # 2. range=7d: 只保留近 7 天的提交（不含 10-15）
    week_stats = github_activity.get_activity_stats(github_db, leader, project.id, range_key="7d")
    assert week_stats["range"] == "7d"
    assert week_stats["total_commits"] == 1
    assert week_stats["all_time_commits"] == 2
    assert len(week_stats["daily"]) == 7

    # 3. custom date range: 仅查 2026-10-01 ~ 2026-10-31
    custom_stats = github_activity.get_activity_stats(
        github_db,
        leader,
        project.id,
        range_key="custom",
        date_from=date(2026, 10, 1),
        date_to=date(2026, 10, 31),
    )
    assert custom_stats["range"] == "custom"
    assert custom_stats["total_commits"] == 1
    assert custom_stats["date_from"] == "2026-10-01"
    assert custom_stats["date_to"] == "2026-10-31"


def test_github_auto_sync_run_once_syncs_new_commit_and_generates_summary(github_db, monkeypatch):
    from sqlalchemy.orm import sessionmaker

    from app.modules.a import activity_summary, github_auto_sync

    monkeypatch.setenv("AI_PROVIDER", "fake")
    monkeypatch.setenv("APP_ENV", "test")
    leader, project = _seed_project(github_db)
    client = MultiBranchFakeGithub(
        {"main": [_commit("auto9999", "feat: automatic push analysis", "2026-11-23T09:10:00Z")]}
    )
    github_sync.link_repo(github_db, leader, project.id, "https://github.com/acme/demo", client)
    github_db.commit()

    factory = sessionmaker(bind=github_db.get_bind(), autoflush=False, autocommit=False)
    result = github_auto_sync.run_once(session_factory=factory, client=client)
    assert result["repos_checked"] == 1
    assert result["repos_synced"] == 1
    assert result["summaries_generated"] == 1
    assert activity_summary.recent_unanalyzed_commit_ids(github_db, project.id) == []


def test_github_activity_stats_merges_homoglyph_and_typo_git_aliases(github_db):
    from datetime import UTC, datetime

    from app.auth.models import VerifiedGithubIdentity
    from app.modules.a import github_activity

    now = datetime.now(UTC)
    leader, project = _seed_project(github_db)
    leader.name = "郑元泰"

    teammate = _user(github_db, tag="ykj", role="student", index=2, now=now)
    teammate.name = "队友乙"
    ambig_a = _user(github_db, tag="amga", role="student", index=3, now=now)
    ambig_a.name = "成员A"
    ambig_b = _user(github_db, tag="amgb", role="student", index=4, now=now)
    ambig_b.name = "成员B"
    github_db.flush()

    github_db.add_all(
        [
            ProjectMember(id=uuid4(), project_id=project.id, user_id=teammate.id, role="member"),
            ProjectMember(id=uuid4(), project_id=project.id, user_id=ambig_a.id, role="member"),
            ProjectMember(id=uuid4(), project_id=project.id, user_id=ambig_b.id, role="member"),
            VerifiedGithubIdentity(
                user_id=leader.id,
                github_user_id=3001,
                login="M0tasy",
                verified_at=now,
            ),
            VerifiedGithubIdentity(
                user_id=teammate.id,
                github_user_id=3002,
                login="ProgramingGod-ykj",
                verified_at=now,
            ),
            VerifiedGithubIdentity(
                user_id=ambig_a.id,
                github_user_id=3003,
                login="alex01",
                verified_at=now,
            ),
            VerifiedGithubIdentity(
                user_id=ambig_b.id,
                github_user_id=3004,
                login="alex02",
                verified_at=now,
            ),
        ]
    )
    github_db.flush()

    class AliasStatsGithub(MultiBranchFakeGithub):
        def commit_detail(self, owner: str, repo: str, sha: str, installation_id: int) -> dict:
            stats_map = {
                "m0tasy01": (100, 20),
                "motasy02": (50, 10),
                "ykj00001": (40, 5),
                "ykj00002": (15, 3),
                "ambig001": (7, 1),
            }
            adds, dels = stats_map[sha]
            return {
                "sha": sha,
                "stats": {"additions": adds, "deletions": dels, "total": adds + dels},
                "files": [],
            }

    commits = [
        {
            "sha": "m0tasy01",
            "html_url": "https://github.com/acme/demo/commit/m0tasy01",
            "commit": {
                "message": "feat: verified commit",
                "author": {
                    "name": "M0tasy",
                    "email": "1240025428@student.must.edu.mo",
                    "date": "2026-11-22T09:00:00Z",
                },
            },
            "author": {"id": 3001, "login": "M0tasy"},
        },
        {
            "sha": "motasy02",
            "html_url": "https://github.com/acme/demo/commit/motasy02",
            "commit": {
                "message": "fix: local commit with homoglyph name",
                "author": {
                    "name": "Motasy",
                    "email": "motasy_delay@MotasydeMacBook-Pro.local",
                    "date": "2026-11-22T10:00:00Z",
                },
            },
            "author": None,
        },
        {
            "sha": "ykj00001",
            "html_url": "https://github.com/acme/demo/commit/ykj00001",
            "commit": {
                "message": "feat: verified teammate commit",
                "author": {
                    "name": "ProgramingGod-ykj",
                    "email": "ykj@example.com",
                    "date": "2026-11-22T11:00:00Z",
                },
            },
            "author": {"id": 3002, "login": "ProgramingGod-ykj"},
        },
        {
            "sha": "ykj00002",
            "html_url": "https://github.com/acme/demo/commit/ykj00002",
            "commit": {
                "message": "fix: typo local name commit",
                "author": {
                    "name": "ProgrammingGod-ykj",
                    "email": "ykj-local@mac.local",
                    "date": "2026-11-22T12:00:00Z",
                },
            },
            "author": None,
        },
        {
            "sha": "ambig001",
            "html_url": "https://github.com/acme/demo/commit/ambig001",
            "commit": {
                "message": "chore: ambiguous handle should not merge",
                "author": {
                    "name": "alex03",
                    "email": "alex03@example.com",
                    "date": "2026-11-22T13:00:00Z",
                },
            },
            "author": None,
        },
    ]

    client = AliasStatsGithub({"main": commits})
    github_sync.link_repo(github_db, leader, project.id, "https://github.com/acme/demo", client)
    github_sync.sync_project_repos(github_db, leader, project.id, client)

    stats = github_activity.get_activity_stats(github_db, leader, project.id, range_key="all")
    assert stats["total_commits"] == 5

    by_name = {c["author_name"]: c for c in stats["contributors"]}
    assert "Motasy" not in by_name
    assert "ProgrammingGod-ykj" not in by_name

    zheng = by_name["郑元泰"]
    assert zheng["author_login"] == "M0tasy"
    assert zheng["commits"] == 2
    assert zheng["additions"] == 150
    assert zheng["deletions"] == 30

    ykj = by_name["队友乙"]
    assert ykj["author_login"] == "ProgramingGod-ykj"
    assert ykj["commits"] == 2
    assert ykj["additions"] == 55
    assert ykj["deletions"] == 8

    # alex03 与 alex01、alex02 编辑距离均为 1，存在歧义时必须保持独立不误合并
    assert by_name["alex03"]["author_user_id"] is None
    assert by_name["alex03"]["commits"] == 1
    assert len(stats["contributors"]) == 3


def test_multibranch_sync_imports_all_branches_beyond_ten_and_deduplicates_commits(github_db):
    leader, project = _seed_project(github_db)
    shared = _commit("shared0000000001", "shared baseline", "2026-11-20T08:00:00Z")
    branch_commits = {"main": [shared]}
    for idx in range(1, 15):
        name = f"feat/branch-{idx:02d}"
        branch_commits[name] = [
            _commit(f"branch{idx:02d}commit001", f"work on {name}", f"2026-11-21T{idx:02d}:00:00Z"),
            shared,
        ]
    client = MultiBranchFakeGithub(branch_commits)
    github_sync.link_repo(github_db, leader, project.id, "https://github.com/acme/demo", client)
    totals = github_sync.sync_project_repos(github_db, leader, project.id, client)
    assert totals["commits"] == 15

    stored = {
        row.external_id: row
        for row in github_db.scalars(
            select(GithubActivity).where(
                GithubActivity.project_id == project.id,
                GithubActivity.kind == "commit",
            )
        )
    }
    assert len(stored) == 15
    assert "branch14commit001" in stored
    assert stored["branch14commit001"].detail["branch"] == "feat/branch-14"
    assert len(stored["shared0000000001"].detail["branches"]) == 15


def test_github_activity_port_unifies_real_member_names_and_filters_seamlessly(github_db):
    from app.auth.models import VerifiedGithubIdentity
    from app.modules.a import github_activity
    from app.modules.c.activity_ports import ActivitySourceQuery

    now = datetime.now(UTC)
    leader, project = _seed_project(github_db)
    leader.name = "卓子杰"
    teammate = _user(github_db, tag="zyt", role="student", index=2, now=now)
    teammate.name = "郑元泰"
    teammate.github_username = "M0tasy"
    github_db.add(
        ProjectMember(id=uuid4(), project_id=project.id, user_id=teammate.id, role="member")
    )
    github_db.flush()

    commit_zzj = {
        "sha": "1" * 40,
        "html_url": f"https://github.com/acme/demo/commit/{'1' * 40}",
        "commit": {
            "message": "feat: unify names",
            "author": {
                "name": "ZZJ1977",
                "email": "182423636+ZZJ1977@users.noreply.github.com",
                "date": "2026-11-22T09:00:00Z",
            },
        },
        "author": {"id": 182423636, "login": "ZZJ1977"},
    }
    commit_alias = {
        "sha": "2" * 40,
        "html_url": f"https://github.com/acme/demo/commit/{'2' * 40}",
        "commit": {
            "message": "fix: homoglyph alias",
            "author": {
                "name": "Motasy",
                "email": "motasy@local",
                "date": "2026-11-22T08:00:00Z",
            },
        },
        "author": None,
    }
    pr_zzj = {
        "number": 12,
        "title": "Unify author labels",
        "body": "desc",
        "state": "open",
        "merged_at": None,
        "user": {"id": 182423636, "login": "ZZJ1977"},
        "html_url": "https://github.com/acme/demo/pull/12",
        "head": {"ref": "feat"},
        "base": {"ref": "develop"},
        "updated_at": "2026-11-22T09:10:00Z",
        "created_at": "2026-11-22T09:05:00Z",
    }
    ci_zzj = {
        "id": 9001,
        "name": "CI",
        "run_number": 5,
        "status": "completed",
        "conclusion": "success",
        "event": "push",
        "head_branch": "develop",
        "head_sha": "1" * 40,
        "actor": {"id": 182423636, "login": "ZZJ1977"},
        "html_url": "https://github.com/acme/demo/actions/runs/9001",
        "created_at": "2026-11-22T09:15:00Z",
    }

    client = MultiBranchFakeGithub(
        {"main": [commit_zzj, commit_alias]}, pulls=[pr_zzj], runs=[ci_zzj]
    )
    github_sync.link_repo(github_db, leader, project.id, "https://github.com/acme/demo", client)
    # 同步在绑定 OAuth 之前执行，验证绑定后无需重新同步即可匹配与显示真实姓名
    github_sync.sync_project_repos(github_db, leader, project.id, client)
    identity = VerifiedGithubIdentity(
        user_id=leader.id,
        github_user_id=182423636,
        login="ZZJ1977",
        verified_at=now,
    )
    github_db.add(identity)
    github_db.flush()

    port = github_activity.DatabaseGithubActivityPort(lambda: github_activity._Reuse(github_db))
    base = dict(project_id=project.id, actor_id=leader.id, source_type="github")

    filtered = port.query(**base, query=ActivitySourceQuery(author_id=leader.id))
    assert filtered.total == 3
    assert {item.kind for item in filtered.items} == {"commit", "pull_request", "ci_run"}
    assert all(item.author_id == leader.id for item in filtered.items)
    assert all(item.author_name == "卓子杰" for item in filtered.items)
    assert all(item.source.content["author_login"] == "ZZJ1977" for item in filtered.items)

    everything = port.query(**base, query=ActivitySourceQuery())
    by_identity = {item.source.identity: item for item in everything.items}
    assert by_identity[f"commit:{'1' * 40}"].author_name == "卓子杰"
    assert by_identity[f"commit:{'2' * 40}"].author_name == "郑元泰"
    assert by_identity[f"commit:{'2' * 40}"].author_id is None
    assert port.get(**base, source_id=by_identity["ci_run:9001"].id).author_name == "卓子杰"

    # 替换 verified_github_identity 到另一账号后，原账号活动不再归属且不误显示为卓子杰
    identity.github_user_id = 999999
    github_db.flush()
    assert port.query(**base, query=ActivitySourceQuery(author_id=leader.id)).total == 0
    after_replace = port.get(**base, source_id=by_identity["ci_run:9001"].id)
    assert after_replace.author_id is None
    assert after_replace.author_name == "ZZJ1977"
