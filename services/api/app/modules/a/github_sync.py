"""A5 GitHub 绑定与只读同步：项目负责人绑定仓库，同步文本文件快照。

边界（V1）：
- 只有项目负责人可以绑定和触发同步，项目成员可以查看已绑定的仓库；
- 只同步默认分支的文本文件，并限制文件数量和大小，跳过依赖目录和二进制文件；
- 文件树被 GitHub 截断或任何读取失败都整体失败（503），不做部分提交，也不把没读到的文件当成已删除；
- 写操作只 flush，由调用方提交事务。
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import PurePosixPath
from uuid import UUID, uuid4

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import User
from app.modules.a import github, github_activity, permissions
from app.modules.a.audit import record_audit
from app.modules.a.models import GithubFile, GithubRepoLink

MAX_FILES = 500
MAX_FILE_BYTES = 200_000
MAX_TOTAL_BYTES = 8_000_000
TEXT_EXTENSIONS = {
    "py", "js", "jsx", "ts", "tsx", "java", "kt", "go", "rs", "rb", "php", "c", "h", "cpp", "cs",
    "swift", "sql", "sh", "html", "css", "scss", "vue", "md", "txt", "json", "yml", "yaml", "toml",
}  # fmt: skip
SKIP_DIRS = {"node_modules", "vendor", "dist", "build", ".git", ".next", "__pycache__", "venv"}
SKIP_NAMES = {"package-lock.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock"}


def _wanted(path: str, size: int) -> bool:
    parts = PurePosixPath(path).parts
    if any(part in SKIP_DIRS for part in parts[:-1]) or parts[-1] in SKIP_NAMES:
        return False
    extension = parts[-1].rsplit(".", 1)[-1].lower() if "." in parts[-1] else ""
    return extension in TEXT_EXTENSIONS and 0 < size <= MAX_FILE_BYTES


def link_repo(
    session: Session,
    actor: User,
    project_id: UUID,
    repo_url: str,
    client: github.GithubClient | None,
) -> GithubRepoLink:
    permissions.require_project_leader(session, actor, project_id, write=True)
    owner, repo = github.parse_repo_url(repo_url)
    existing = session.scalar(
        select(GithubRepoLink).where(
            GithubRepoLink.project_id == project_id,
            GithubRepoLink.owner == owner,
            GithubRepoLink.repo == repo,
        )
    )
    if existing is not None:
        return existing
    if client is None:
        raise ApiError(503, "GITHUB_UNAVAILABLE", "GitHub 尚未接入（缺少应用凭证变量）。")
    installation_id = client.installation_for_repo(owner, repo)
    info = client.repo_info(owner, repo, installation_id)
    link = GithubRepoLink(
        id=uuid4(),
        project_id=project_id,
        owner=owner,
        repo=repo,
        installation_id=installation_id,
        default_branch=info["default_branch"],
        linked_by_id=actor.id,
    )
    session.add(link)
    session.flush()
    record_audit(
        session,
        actor=actor,
        action="github.repo.linked",
        target=("github_repo_link", link.id),
        project_id=project_id,
        after={"repo": f"{owner}/{repo}"},
    )
    return link


def list_linked_repos(session: Session, actor: User, project_id: UUID) -> list[GithubRepoLink]:
    permissions.require_project_member(session, actor, project_id, write=False)
    return list(
        session.scalars(
            select(GithubRepoLink)
            .where(GithubRepoLink.project_id == project_id)
            .order_by(GithubRepoLink.linked_at.asc())
        ).all()
    )


def sync_project_repos(
    session: Session, actor: User, project_id: UUID, client: github.GithubClient | None
) -> dict[str, int]:
    permissions.require_project_leader(session, actor, project_id, write=True)
    if client is None:
        raise ApiError(503, "GITHUB_UNAVAILABLE", "GitHub 尚未接入（缺少应用凭证变量）。")
    links = session.scalars(
        select(GithubRepoLink).where(GithubRepoLink.project_id == project_id)
    ).all()
    totals = {
        "repos": len(links),
        "files": 0,
        "fetched": 0,
        "removed": 0,
        "skipped": 0,
        "commits": 0,
        "pulls": 0,
        "ci_runs": 0,
        "deleted_sources": 0,
        "associated": 0,
    }
    now = datetime.now(UTC)
    resolver = github_activity.AuthorResolver(session, project_id)
    new_commits = []
    for link in links:
        _sync_link(session, client, link, totals, now)
        new_commits += github_activity.sync_activity(session, client, link, totals, now, resolver)
        link.last_synced_at = now
    session.flush()
    # 新提交里写了任务号（如 #T-012）的，调用 C 的匹配函数自动关联。
    totals["associated"] = github_activity.associate_new_commits(
        session, actor, project_id, new_commits
    )
    from app.modules.c.github_evidence import reconcile_github_evidence

    reconcile_github_evidence(session, actor, project_id)
    record_audit(
        session,
        actor=actor,
        action="github.sync.completed",
        target=("project", project_id),
        project_id=project_id,
        after=totals,
    )
    return totals


def _sync_link(session, client, link: GithubRepoLink, totals: dict[str, int], now) -> None:
    tree = client.tree(link.owner, link.repo, link.default_branch, link.installation_id)
    if tree.get("truncated"):
        raise ApiError(503, "GITHUB_UNAVAILABLE", "仓库文件过多，暂时无法完整同步。")
    entries = [
        e
        for e in tree.get("tree", [])
        if e.get("type") == "blob" and _wanted(e["path"], e.get("size", 0))
    ]
    entries.sort(key=lambda e: e["path"])
    if len(entries) > MAX_FILES:
        totals["skipped"] += len(entries) - MAX_FILES
        entries = entries[:MAX_FILES]
    existing = {
        f.path: f for f in session.scalars(select(GithubFile).where(GithubFile.link_id == link.id))
    }
    total_bytes = 0
    keep: set[str] = set()
    for entry in entries:
        path, sha, size = entry["path"], entry["sha"], entry.get("size", 0)
        total_bytes += size
        if total_bytes > MAX_TOTAL_BYTES:
            totals["skipped"] += 1
            continue
        keep.add(path)
        row = existing.get(path)
        if row is not None and row.blob_sha == sha:
            continue
        raw = client.blob(link.owner, link.repo, sha, link.installation_id)
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            totals["skipped"] += 1
            keep.discard(path)
            continue
        totals["fetched"] += 1
        if row is None:
            session.add(
                GithubFile(
                    id=uuid4(),
                    project_id=link.project_id,
                    link_id=link.id,
                    path=path,
                    blob_sha=sha,
                    size_bytes=len(raw),
                    text=text,
                    synced_at=now,
                )  # fmt: skip
            )
        else:
            row.blob_sha, row.size_bytes, row.text, row.synced_at = sha, len(raw), text, now
    # 文件树是完整的（未截断），所以不在树里的文件才是真正被删除。
    stale = [p for p in existing if p not in keep]
    if stale:
        session.execute(
            delete(GithubFile).where(GithubFile.link_id == link.id, GithubFile.path.in_(stale))
        )
        totals["removed"] += len(stale)
    totals["files"] += len(keep)
