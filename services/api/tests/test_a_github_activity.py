"""A5 GitHub 活动：同步、作者识别、来源删除、给 C 活动页读取。"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

import a_fixtures as fixtures
import pytest
from sqlalchemy import select

from app.api.errors import ApiError
from app.auth.models import VerifiedGithubIdentity
from app.db.models import ProjectMember
from app.modules.a import github_activity, github_sync
from app.modules.a.models import GithubActivity
from app.modules.c.activity_ports import ActivitySourceQuery

db = fixtures.db
scope = fixtures.scope

URL = "https://github.com/acme/demo"


def commit(
    sha,
    message,
    *,
    login=None,
    github_user_id=None,
    email="x@example.com",
    date="2026-11-10T08:00:00Z",
):
    return {
        "sha": sha,
        "html_url": f"https://github.com/acme/demo/commit/{sha}",
        "author": {"login": login, "id": github_user_id} if login else None,
        "commit": {"message": message, "author": {"name": "Dev", "email": email, "date": date}},
    }


def pull(number, title, *, state="open", merged=False, login="dev1", github_user_id=None):
    return {
        "number": number,
        "title": title,
        "body": "说明",
        "state": state,
        "merged_at": "2026-11-10T09:00:00Z" if merged else None,
        "user": {"login": login, "id": github_user_id},
        "html_url": f"https://github.com/acme/demo/pull/{number}",
        "head": {"ref": "feat"},
        "base": {"ref": "main"},
        "updated_at": "2026-11-10T09:00:00Z",
        "created_at": "2026-11-10T08:00:00Z",
    }


def run(run_id, *, conclusion="success", github_user_id=None):
    return {
        "id": run_id,
        "name": "CI",
        "run_number": 7,
        "status": "completed",
        "conclusion": conclusion,
        "event": "push",
        "head_branch": "main",
        "head_sha": "abcdef1234567",
        "actor": {"login": "dev1", "id": github_user_id},
        "html_url": f"https://github.com/acme/demo/actions/runs/{run_id}",
        "created_at": "2026-11-10T08:30:00Z",
    }


class FakeGithub:
    def __init__(self, commits=(), pulls=(), runs=()):
        self._commits, self._pulls, self._runs = list(commits), list(pulls), list(runs)
        self.alive: dict[str, bool] = {}
        self.exists_error = False
        self.checked: list[str] = []

    def installation_for_repo(self, owner, repo):
        return 7

    def repo_info(self, owner, repo, installation_id):
        return {"full_name": f"{owner}/{repo}", "default_branch": "main", "private": True}

    def tree(self, owner, repo, ref, installation_id):
        return {"tree": [], "truncated": False}

    def blob(self, *args):
        raise AssertionError

    def commits(self, owner, repo, branch, installation_id):
        return self._commits

    def pulls(self, owner, repo, installation_id):
        return self._pulls

    def workflow_runs(self, owner, repo, installation_id):
        return self._runs

    def commit_exists(self, owner, repo, sha, installation_id):
        if self.exists_error:
            raise ApiError(503, "GITHUB_UNAVAILABLE", "boom")
        self.checked.append(sha)
        return self.alive.get(sha, False)

    def run_exists(self, owner, repo, run_id, installation_id):
        if self.exists_error:
            raise ApiError(503, "GITHUB_UNAVAILABLE", "boom")
        self.checked.append(run_id)
        return self.alive.get(run_id, False)


def sync(db, scope, client):
    leader = scope.users["leader"]
    github_sync.link_repo(db, leader, scope.project.id, URL, client)
    return github_sync.sync_project_repos(db, leader, scope.project.id, client)


def rows(db, scope):
    return {
        (r.kind, r.external_id): r
        for r in db.scalars(
            select(GithubActivity).where(GithubActivity.project_id == scope.project.id)
        )
    }


def verify_account(db, user, github_user_id, login="dev1"):
    identity = VerifiedGithubIdentity(
        user_id=user.id, github_user_id=github_user_id, login=login, verified_at=datetime.now(UTC)
    )
    db.add(identity)
    db.flush()
    return identity


def test_sync_stores_commits_pulls_and_runs_and_is_idempotent(db, scope):
    client = FakeGithub(
        [commit("a" * 40, "T-001 登录页\n\n详细说明")],
        [pull(3, "加登录", merged=True, state="closed")],
        [run(99)],
    )
    totals = sync(db, scope, client)
    assert (totals["commits"], totals["pulls"], totals["ci_runs"]) == (1, 1, 1)
    stored = rows(db, scope)
    c = stored[("commit", "a" * 40)]
    assert c.title == "T-001 登录页" and "详细说明" in c.summary
    assert stored[("pull_request", "3")].state == "merged"
    assert stored[("ci_run", "99")].state == "success"
    revisions = {k: r.revision for k, r in stored.items()}

    again = github_sync.sync_project_repos(db, scope.users["leader"], scope.project.id, client)
    assert (again["commits"], again["pulls"], again["ci_runs"]) == (0, 0, 0)
    assert {k: r.revision for k, r in rows(db, scope).items()} == revisions
    assert len(rows(db, scope)) == 3


def test_commit_detail_is_bounded_and_redacts_common_secrets():
    files, truncated, stats = github_activity._commit_detail(
        {
            "files": [
                {
                    "filename": "config.ts",
                    "status": ["modified"],
                    "additions": -4,
                    "deletions": 7,
                    "patch": "const api_token = super-secret;\nconst keep = true;",
                },
                {"filename": "README.md", "status": "added", "patch": "+docs"},
            ],
            "stats": {"additions": 4, "deletions": 7, "total": 11},
            "changed_files": 2,
        }
    )
    assert files[0]["status"] == "unknown"
    assert "[REDACTED]" in files[0]["patch"]
    assert files[0]["additions"] == 0
    assert stats == {"additions": 4, "deletions": 7, "total": 11, "changed_files": 2}
    assert truncated is False


def test_changed_pull_request_gets_a_new_revision(db, scope):
    client = FakeGithub(pulls=[pull(3, "加登录")])
    sync(db, scope, client)
    before = rows(db, scope)[("pull_request", "3")].revision
    client._pulls = [pull(3, "加登录", merged=True, state="closed")]
    github_sync.sync_project_repos(db, scope.users["leader"], scope.project.id, client)
    after = rows(db, scope)[("pull_request", "3")]
    assert after.revision != before and after.state == "merged"


def test_declared_login_and_commit_email_do_not_attribute_to_a_member(db, scope):
    member, outsider = scope.users["member"], scope.users["outsider"]
    github_activity.set_github_login(db, member, "@Dev-Member")
    client = FakeGithub(
        [
            commit("1" * 40, "by login", login="dev-member"),
            commit("2" * 40, "by email", email=member.email),
            commit("3" * 40, "by noreply", email="123+dev-member@users.noreply.github.com"),
            commit("4" * 40, "outsider email", email=outsider.email),
            commit("5" * 40, "stranger", login="nobody", email="n@example.com"),
        ]
    )
    sync(db, scope, client)
    stored = rows(db, scope)
    assert all(row.author_user_id is None for row in stored.values())
    assert stored[("commit", "1" * 40)].author_login == "dev-member"
    assert stored[("commit", "2" * 40)].author_name == "Dev"


def test_structured_account_id_matches_active_verified_members_for_each_activity(db, scope):
    member = scope.users["member"]
    verify_account(db, member, 101)
    verify_account(db, scope.users["peer"], 102, "peer")
    verify_account(db, scope.users["disabled"], 103, "disabled")
    sync(
        db,
        scope,
        FakeGithub(
            [
                commit("a" * 40, "Renamed", login="newname", github_user_id=101),
                commit("b" * 40, "Wrong ID", login="dev1", email=member.email, github_user_id=102),
                commit("c" * 40, "Inactive", login="disabled", github_user_id=103),
                commit("d" * 40, "Malformed ID", login="dev1", github_user_id="101"),
            ],
            [pull(1, "Feature", github_user_id=101)],
            [run(4, github_user_id=101)],
        ),
    )
    stored = rows(db, scope)
    assert {key for key, row in stored.items() if row.author_user_id == member.id} == {
        ("commit", "a" * 40),
        ("pull_request", "1"),
        ("ci_run", "4"),
    }
    assert all(row.author_user_id in (member.id, None) for row in stored.values())
    assert stored[("commit", "a" * 40)].author_login == "newname"


@pytest.mark.parametrize("change", ["unlink", "replace", "leave"])
def test_attribution_disappears_from_a_and_c_reads_without_resync(db, scope, change):
    member, leader = scope.users["member"], scope.users["leader"]
    identity = verify_account(db, member, 101)
    sync(db, scope, FakeGithub([commit("a" * 40, "Feature", login="dev1", github_user_id=101)]))
    row = rows(db, scope)[("commit", "a" * 40)]
    port = github_activity.DatabaseGithubActivityPort(lambda: github_activity._Reuse(db))
    base = dict(project_id=scope.project.id, actor_id=leader.id, source_type="github")
    query = ActivitySourceQuery(author_id=member.id)
    before = port.get(**base, source_id=row.id)
    assert before.author_id == member.id
    assert port.query(**base, query=query).total == 1
    assert github_activity.list_activity(db, leader, scope.project.id) == ([(row, member.id)], 1)

    if change == "unlink":
        db.delete(identity)
    elif change == "replace":
        identity.github_user_id = 202
    else:
        membership = db.scalar(
            select(ProjectMember).where(
                ProjectMember.project_id == scope.project.id, ProjectMember.user_id == member.id
            )
        )
        membership.left_at = datetime.now(UTC)
    db.flush()

    assert port.query(**base, query=query).total == 0
    filtered = github_activity.list_activity(db, leader, scope.project.id, author_id=member.id)
    assert filtered == ([], 0)
    assert github_activity.list_activity(db, leader, scope.project.id) == ([(row, None)], 1)
    after = port.get(**base, source_id=row.id)
    assert after.author_id is None
    assert after.title == before.title and after.source == before.source


def test_legacy_attribution_stays_hidden_until_verified_resync_without_new_revision(db, scope):
    member, leader = scope.users["member"], scope.users["leader"]
    original = commit("a" * 40, "Feature", login="dev1", email=member.email)
    client = FakeGithub([original])
    sync(db, scope, client)
    row = rows(db, scope)[("commit", "a" * 40)]
    row.author_user_id = member.id
    row.revision = "f" * 64  # Earlier revisions included the local author ID.
    db.flush()
    verify_account(db, member, 101)
    assert github_activity.list_activity(db, leader, scope.project.id) == ([(row, None)], 1)

    client._commits = [
        commit("a" * 40, "Feature", login="dev1", email=member.email, github_user_id=101)
    ]
    totals = github_sync.sync_project_repos(db, leader, scope.project.id, client)
    assert totals["commits"] == totals["associated"] == 0
    assert row.revision == "f" * 64
    assert github_activity.list_activity(db, leader, scope.project.id) == ([(row, member.id)], 1)


def test_github_login_is_unique_and_validated(db, scope):
    github_activity.set_github_login(db, scope.users["member"], "dev1")
    with pytest.raises(ApiError) as taken:
        github_activity.set_github_login(db, scope.users["leader"], "DEV1")
    assert taken.value.code == "GITHUB_LOGIN_TAKEN"
    with pytest.raises(ApiError) as bad:
        github_activity.set_github_login(db, scope.users["leader"], "not valid!")
    assert bad.value.code == "INVALID_GITHUB_LOGIN"
    assert github_activity.set_github_login(db, scope.users["member"], "") is None


def test_missing_source_is_deleted_only_when_github_says_it_is_gone(db, scope):
    newest, gone, ghost, anchor = "c" * 40, "a" * 40, "d" * 40, "b" * 40
    all_commits = [
        commit(newest, "new", date="2026-11-11T08:00:00Z"),
        commit(ghost, "off-branch but exists", date="2026-11-10T09:30:00Z"),
        commit(gone, "will vanish", date="2026-11-10T09:00:00Z"),
        commit(anchor, "old", date="2026-11-10T08:00:00Z"),
    ]
    client = FakeGithub(all_commits, runs=[run(1), run(2)])
    sync(db, scope, client)
    client._commits = [all_commits[0], all_commits[3]]
    client._runs = [run(2)]
    client.alive = {ghost: True}
    totals = github_sync.sync_project_repos(db, scope.users["leader"], scope.project.id, client)
    stored = rows(db, scope)
    assert stored[("commit", gone)].deleted
    assert stored[("commit", gone)].revision.startswith("deleted:")
    assert not stored[("commit", ghost)].deleted  # GitHub 仍能查到
    assert stored[("ci_run", "1")].deleted and not stored[("ci_run", "2")].deleted
    assert totals["deleted_sources"] == 2


def test_verification_failure_is_not_treated_as_deletion(db, scope):
    new, mid, old = "c" * 40, "d" * 40, "e" * 40
    commits = [
        commit(new, "new", date="2026-11-11T08:00:00Z"),
        commit(mid, "mid", date="2026-11-10T09:00:00Z"),
        commit(old, "old", date="2026-11-10T08:00:00Z"),
    ]
    client = FakeGithub(commits)
    sync(db, scope, client)
    client._commits = [commits[0], commits[2]]
    client.exists_error = True
    with pytest.raises(ApiError) as error:
        github_sync.sync_project_repos(db, scope.users["leader"], scope.project.id, client)
    assert error.value.status_code == 503
    assert not rows(db, scope)[("commit", mid)].deleted


def test_new_commits_are_offered_to_c_task_matching_once(db, scope, monkeypatch):
    seen = []

    def fake_associate(session, user, project_id, source_id, port):
        item = port.get(
            project_id=project_id, actor_id=user.id, source_type="github", source_id=source_id
        )
        seen.append(item.title)
        return {"task_id": str(uuid4())}

    monkeypatch.setattr(
        "app.modules.c.activity_service.auto_associate_github_commit", fake_associate
    )
    client = FakeGithub([commit("a" * 40, "T-001 #T-001 做完登录")])
    totals = sync(db, scope, client)
    assert seen == ["T-001 #T-001 做完登录"] and totals["associated"] == 1
    github_sync.sync_project_repos(db, scope.users["leader"], scope.project.id, client)
    assert len(seen) == 1  # 第二次同步没有新提交


def test_port_filters_authorizes_and_reports_deleted(db, scope):
    member = scope.users["member"]
    verify_account(db, member, 101, "dev-member")
    gone = "9" * 40
    first = commit(
        "1" * 40,
        "T-001 登录页",
        login="dev-member",
        date="2026-11-11T08:00:00Z",
        github_user_id=101,
    )
    anchor = commit("8" * 40, "anchor", login="other", date="2026-11-10T08:00:00Z")
    client = FakeGithub(
        [first, commit(gone, "later removed", login="other", date="2026-11-10T09:00:00Z"), anchor],
        [pull(3, "加登录")],
        [run(5)],
    )
    sync(db, scope, client)
    client._commits = [first, anchor]
    github_sync.sync_project_repos(db, scope.users["leader"], scope.project.id, client)

    port = github_activity.DatabaseGithubActivityPort(lambda: github_activity._Reuse(db))
    base = dict(project_id=scope.project.id, actor_id=member.id, source_type="github")
    everything = port.query(**base, query=ActivitySourceQuery())
    assert everything.total == 5
    assert [
        i.kind for i in port.query(**base, query=ActivitySourceQuery(record_kind="ci_run")).items
    ] == ["ci_run"]
    mine = port.query(**base, query=ActivitySourceQuery(author_id=member.id))
    assert [i.title for i in mine.items] == ["T-001 登录页"]
    assert port.query(**base, query=ActivitySourceQuery(q="登录")).total == 2
    assert port.query(**base, query=ActivitySourceQuery(include_ids=())).total == 0

    deleted = next(i for i in everything.items if i.source.availability == "deleted")
    assert deleted.source.identity == f"commit:{gone}" and deleted.source.revision.startswith(
        "deleted:"
    )
    available = next(i for i in everything.items if i.kind == "commit" and i is not deleted)
    assert available.source.source_url.startswith("https://github.com/")
    fetched = port.get(**base, source_id=available.id)
    assert fetched.source.revision == available.source.revision

    with pytest.raises(ApiError) as denied:
        port.query(
            project_id=scope.project.id,
            actor_id=scope.users["outsider"].id,
            source_type="github",
            query=ActivitySourceQuery(),
        )
    assert denied.value.status_code in (403, 404)
    with pytest.raises(ApiError) as missing:
        port.get(**base, source_id=uuid4())
    assert missing.value.status_code == 404


def test_composite_port_routes_by_source_type():
    calls = []

    class Stub:
        def __init__(self, name):
            self.name = name

        def query(self, **kwargs):
            calls.append((self.name, "query", kwargs["source_type"]))

        def get(self, **kwargs):
            calls.append((self.name, "get", kwargs["source_type"]))

    port = github_activity.CompositeActivityPort(Stub("feishu"), Stub("github"))
    port.query(source_type="github", project_id=1)
    port.get(source_type="feishu", project_id=1)
    assert calls == [("github", "query", "github"), ("feishu", "get", "feishu")]


def test_port_displays_real_member_names_and_filters_across_kinds_without_resync(db, scope):
    leader, member = scope.users["leader"], scope.users["member"]
    leader.name = "卓子杰"
    member.name = "郑元泰"
    member.github_username = "M0tasy"
    db.flush()

    client = FakeGithub(
        [
            {
                "sha": "1" * 40,
                "html_url": f"https://github.com/acme/demo/commit/{'1' * 40}",
                "author": {"login": "ZZJ1977", "id": 182423636},
                "commit": {
                    "message": "feat: unify names",
                    "author": {
                        "name": "ZZJ1977",
                        "email": "182423636+ZZJ1977@users.noreply.github.com",
                        "date": "2026-11-11T09:00:00Z",
                    },
                },
            },
            {
                "sha": "2" * 40,
                "html_url": f"https://github.com/acme/demo/commit/{'2' * 40}",
                "author": None,
                "commit": {
                    "message": "fix: alias commit",
                    "author": {
                        "name": "Motasy",
                        "email": "motasy@local",
                        "date": "2026-11-11T08:00:00Z",
                    },
                },
            },
        ],
        [pull(11, "Fix names", login="ZZJ1977", github_user_id=182423636)],
        [
            {
                "id": 701,
                "name": "CI",
                "run_number": 9,
                "status": "completed",
                "conclusion": "success",
                "event": "push",
                "head_branch": "develop",
                "head_sha": "1" * 40,
                "actor": {"login": "ZZJ1977", "id": 182423636},
                "html_url": "https://github.com/acme/demo/actions/runs/701",
                "created_at": "2026-11-11T09:05:00Z",
            }
        ],
    )
    # 同步发生在 leader 绑定 GitHub OAuth 之前，detail 已记录 _github_actor_account_id
    sync(db, scope, client)
    verify_account(db, leader, 182423636, "ZZJ1977")

    port = github_activity.DatabaseGithubActivityPort(lambda: github_activity._Reuse(db))
    base = dict(project_id=scope.project.id, actor_id=leader.id, source_type="github")

    # 无需重新同步，按 leader.id 筛选立即命中 commit / PR / CI，且 author_name 全部展示真实姓名
    filtered = port.query(**base, query=ActivitySourceQuery(author_id=leader.id))
    assert filtered.total == 3
    assert {item.kind for item in filtered.items} == {"commit", "pull_request", "ci_run"}
    assert all(item.author_id == leader.id for item in filtered.items)
    assert all(item.author_name == "卓子杰" for item in filtered.items)
    assert all(item.source.content["author_login"] == "ZZJ1977" for item in filtered.items)

    # 单条详情与全量列表均展示真实成员姓名（含未走 OAuth 但匹配 github_username/同形别名的成员）
    everything = port.query(**base, query=ActivitySourceQuery())
    by_identity = {item.source.identity: item for item in everything.items}
    assert by_identity[f"commit:{'1' * 40}"].author_name == "卓子杰"
    assert by_identity[f"commit:{'2' * 40}"].author_name == "郑元泰"
    assert by_identity[f"commit:{'2' * 40}"].author_id is None
    detail = port.get(**base, source_id=by_identity["ci_run:701"].id)
    assert detail.author_id == leader.id
    assert detail.author_name == "卓子杰"
    assert detail.source.content["author_login"] == "ZZJ1977"
