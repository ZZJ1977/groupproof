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
