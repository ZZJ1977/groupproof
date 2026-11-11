"""A5 绑定与同步：权限、重复绑定、增量同步、删除、失败不删除。"""

from __future__ import annotations

import a_fixtures as fixtures
import pytest
from sqlalchemy import select

from app.api.errors import ApiError
from app.modules.a import github_sync
from app.modules.a.models import GithubFile

db = fixtures.db
scope = fixtures.scope

URL = "https://github.com/acme/demo"


class FakeGithub:
    def __init__(self, files: dict[str, bytes], *, installed=True, truncated=False):
        self.files = files
        self.installed = installed
        self.truncated = truncated
        self.blob_calls: list[str] = []
        self.fail_blob = False

    def installation_for_repo(self, owner, repo):
        if not self.installed:
            raise ApiError(422, "GITHUB_APP_NOT_INSTALLED", "install")
        return 7

    def repo_info(self, owner, repo, installation_id):
        return {"full_name": f"{owner}/{repo}", "default_branch": "main", "private": True}

    def tree(self, owner, repo, ref, installation_id):
        entries = [
            {"path": p, "type": "blob", "sha": f"sha-{hash(d) & 0xFFFFFF}", "size": len(d)}
            for p, d in self.files.items()
        ]
        return {"tree": entries, "truncated": self.truncated}

    def blob(self, owner, repo, sha, installation_id):
        if self.fail_blob:
            raise ApiError(503, "GITHUB_UNAVAILABLE", "boom")
        self.blob_calls.append(sha)
        for d in self.files.values():
            if f"sha-{hash(d) & 0xFFFFFF}" == sha:
                return d
        raise AssertionError(sha)


def _link(db, scope, client):
    return github_sync.link_repo(db, scope.users["leader"], scope.project.id, URL, client)


def test_only_leader_binds_and_binding_is_idempotent(db, scope):
    client = FakeGithub({})
    with pytest.raises(ApiError) as exc:
        github_sync.link_repo(db, scope.users["member"], scope.project.id, URL, client)
    assert exc.value.status_code == 403
    with pytest.raises(ApiError) as exc:
        github_sync.link_repo(db, scope.users["outsider"], scope.project.id, URL, client)
    assert exc.value.status_code == 404

    first = _link(db, scope, client)
    second = _link(db, scope, client)
    assert first.id == second.id and first.default_branch == "main"


def test_not_installed_and_missing_credentials(db, scope):
    with pytest.raises(ApiError) as exc:
        _link(db, scope, FakeGithub({}, installed=False))
    assert exc.value.code == "GITHUB_APP_NOT_INSTALLED"
    with pytest.raises(ApiError) as exc:
        _link(db, scope, None)
    assert exc.value.status_code == 503


def test_sync_filters_files_and_is_incremental(db, scope):
    leader = scope.users["leader"]
    client = FakeGithub(
        {
            "src/app.py": b"print('login')\n",
            "README.md": "# 说明".encode(),
            "node_modules/x/index.js": b"skip",
            "logo.png": b"\x89PNG",
            "package-lock.json": b"{}",
        }
    )
    _link(db, scope, client)
    totals = github_sync.sync_project_repos(db, leader, scope.project.id, client)
    assert totals["files"] == 2 and totals["fetched"] == 2
    paths = {f.path for f in db.scalars(select(GithubFile))}
    assert paths == {"src/app.py", "README.md"}

    again = github_sync.sync_project_repos(db, leader, scope.project.id, client)
    assert again["fetched"] == 0 and again["removed"] == 0  # 没变化就不重新下载


def test_changed_and_deleted_files_are_updated(db, scope):
    leader = scope.users["leader"]
    client = FakeGithub({"a.py": b"v1", "b.py": b"keep"})
    _link(db, scope, client)
    github_sync.sync_project_repos(db, leader, scope.project.id, client)

    client.files = {"a.py": b"v2-longer"}
    totals = github_sync.sync_project_repos(db, leader, scope.project.id, client)
    assert totals["fetched"] == 1 and totals["removed"] == 1
    rows = {f.path: f.text for f in db.scalars(select(GithubFile))}
    assert rows == {"a.py": "v2-longer"}


def test_failures_never_delete_existing_files(db, scope):
    leader = scope.users["leader"]
    client = FakeGithub({"a.py": b"v1"})
    _link(db, scope, client)
    github_sync.sync_project_repos(db, leader, scope.project.id, client)

    client.truncated = True
    with pytest.raises(ApiError) as exc:
        github_sync.sync_project_repos(db, leader, scope.project.id, client)
    assert exc.value.status_code == 503
    client.truncated = False
    client.files = {"a.py": b"v2"}
    client.fail_blob = True
    with pytest.raises(ApiError):
        github_sync.sync_project_repos(db, leader, scope.project.id, client)
    assert {f.path for f in db.scalars(select(GithubFile))} == {"a.py"}


def test_sync_is_leader_only_and_members_can_list(db, scope):
    client = FakeGithub({})
    _link(db, scope, client)
    with pytest.raises(ApiError) as exc:
        github_sync.sync_project_repos(db, scope.users["member"], scope.project.id, client)
    assert exc.value.status_code == 403
    links = github_sync.list_linked_repos(db, scope.users["member"], scope.project.id)
    assert [(link.owner, link.repo) for link in links] == [("acme", "demo")]
    with pytest.raises(ApiError) as exc:
        github_sync.list_linked_repos(db, scope.users["outsider"], scope.project.id)
    assert exc.value.status_code == 404
