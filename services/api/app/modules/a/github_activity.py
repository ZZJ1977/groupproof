# ruff: noqa: E501
"""A5 GitHub 活动：同步提交 / 合并请求 / CI 运行，识别作者，给 C 的活动页和证据页读取。

规则：
- 只读：只调用 GitHub 的读取接口；每次同步读默认分支最近 100 条提交、100 个合并请求、100 次 CI 运行；
- 作者识别：先看本站用户自己声明的 GitHub 用户名，其次按提交邮箱（本站登录邮箱、已验证学校邮箱、
  ``id+用户名@users.noreply.github.com``）匹配；只会对应到本项目的成员，对应不上就只显示 GitHub 名字；
- 来源被删除：窗口内本该出现却没出现的提交/CI 运行，逐个向 GitHub 确认，GitHub 明确说查不到才标记
  deleted；网络或权限失败整体 503，绝不当作删除；
- 同步到新提交后，调用 C 的任务号匹配函数（commit 里写 ``#T-012`` 自动关联任务）。
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.auth.models import SchoolEmailBinding
from app.db.models import ProjectMember, User
from app.modules.a import permissions
from app.modules.a.models import GithubActivity, GithubRepoLink, GithubUserLink
from app.modules.c.activity_ports import (
    ActivitySourcePage,
    ActivitySourceQuery,
    ActivitySourceRecord,
)
from app.modules.c.source_ports import VerifiedSource

logger = logging.getLogger("groupproof.a.github_activity")

KINDS = ("commit", "pull_request", "ci_run")
MAX_VERIFY_PER_SYNC = 30
_NOREPLY = re.compile(r"^(?:\d+\+)?([A-Za-z0-9-]+)@users\.noreply\.github\.com$", re.IGNORECASE)
_LOGIN = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})")


def _parse_time(value: str | None) -> datetime:
    if not value:
        return datetime.now(UTC)
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _revision(payload: dict[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str).encode()
    ).hexdigest()


def _safe_url(value: Any) -> str | None:
    if isinstance(value, str) and value.startswith("https://github.com/") and len(value) <= 500:
        return value
    return None


def _line(text: str | None, limit: int = 240) -> str:
    first = (text or "").strip().splitlines()[0] if (text or "").strip() else ""
    return first[:limit]


# ---------------------------------------------------------------- 作者识别


class AuthorResolver:
    """把 GitHub 登录名/邮箱对应到本项目成员（一次同步建一个，避免重复查询）。"""

    def __init__(self, session: Session, project_id: UUID) -> None:
        member_ids = set(
            session.scalars(
                select(ProjectMember.user_id).where(ProjectMember.project_id == project_id)
            )
        )
        self.by_login: dict[str, UUID] = {}
        self.by_email: dict[str, UUID] = {}
        if not member_ids:
            return
        for user_id, login in session.execute(
            select(GithubUserLink.user_id, GithubUserLink.login).where(
                GithubUserLink.user_id.in_(member_ids)
            )
        ):
            self.by_login[login.lower()] = user_id
        for user_id, email in session.execute(
            select(User.id, User.email).where(User.id.in_(member_ids), User.email.is_not(None))
        ):
            self.by_email.setdefault(email.strip().lower(), user_id)
        for user_id, email in session.execute(
            select(SchoolEmailBinding.user_id, SchoolEmailBinding.school_email_normalized).where(
                SchoolEmailBinding.user_id.in_(member_ids),
                SchoolEmailBinding.verified_at.is_not(None),
                SchoolEmailBinding.school_email_normalized.is_not(None),
            )
        ):
            self.by_email.setdefault(email.strip().lower(), user_id)

    def resolve(self, login: str | None, email: str | None) -> UUID | None:
        candidates = []
        if login:
            candidates.append(login.lower())
        normalized = (email or "").strip().lower()
        match = _NOREPLY.match(normalized)
        if match:
            candidates.append(match.group(1).lower())
        for candidate in candidates:
            if candidate in self.by_login:
                return self.by_login[candidate]
        return self.by_email.get(normalized)


def set_github_login(session: Session, user: User, login: str | None) -> GithubUserLink | None:
    """本人声明（或清除）自己的 GitHub 用户名；一个用户名只能属于一个本站用户。"""
    permissions.require_active(user)
    existing = session.get(GithubUserLink, user.id)
    if login is None or not login.strip():
        if existing is not None:
            session.delete(existing)
            session.flush()
        return None
    value = login.strip().lstrip("@")
    if not _LOGIN.fullmatch(value):
        raise ApiError(422, "INVALID_GITHUB_LOGIN", "GitHub 用户名格式不正确。")
    owner = session.scalar(
        select(GithubUserLink).where(func.lower(GithubUserLink.login) == value.lower())
    )
    if owner is not None and owner.user_id != user.id:
        raise ApiError(409, "GITHUB_LOGIN_TAKEN", "这个 GitHub 用户名已经被其他账号使用。")
    if existing is None:
        existing = GithubUserLink(user_id=user.id, login=value.lower())
        session.add(existing)
    else:
        existing.login = value.lower()
    session.flush()
    return existing


# ---------------------------------------------------------------- 同步


def _upsert(
    session: Session,
    link: GithubRepoLink,
    existing: dict[tuple[str, str], GithubActivity],
    totals: dict[str, int],
    now: datetime,
    *,
    kind: str,
    external_id: str,
    values: dict[str, Any],
    new_commits: list[GithubActivity],
) -> None:
    revision = _revision({**values, "occurred_at": values["occurred_at"].isoformat()})
    row = existing.get((kind, external_id))
    if row is None:
        row = GithubActivity(
            id=uuid4(),
            project_id=link.project_id,
            link_id=link.id,
            kind=kind,
            external_id=external_id,
            revision=revision,
            synced_at=now,
            deleted=False,
            **values,
        )
        session.add(row)
        existing[(kind, external_id)] = row
        totals[{"commit": "commits", "pull_request": "pulls", "ci_run": "ci_runs"}[kind]] += 1
        if kind == "commit":
            new_commits.append(row)
        return
    if row.revision == revision and not row.deleted:
        return
    for key, value in values.items():
        setattr(row, key, value)
    row.revision, row.synced_at, row.deleted = revision, now, False


def sync_activity(
    session: Session,
    client,
    link: GithubRepoLink,
    totals: dict[str, int],
    now: datetime,
    resolver: AuthorResolver,
) -> list[GithubActivity]:
    """同步一个仓库的活动；返回这次新入库的提交（给任务号匹配用）。"""
    for key in ("commits", "pulls", "ci_runs", "deleted_sources"):
        totals.setdefault(key, 0)
    owner, repo, inst = link.owner, link.repo, link.installation_id
    commits = client.commits(owner, repo, link.default_branch, inst)
    pulls = client.pulls(owner, repo, inst)
    runs = client.workflow_runs(owner, repo, inst)

    existing = {
        (row.kind, row.external_id): row
        for row in session.scalars(select(GithubActivity).where(GithubActivity.link_id == link.id))
    }
    new_commits: list[GithubActivity] = []

    for item in commits:
        sha = item["sha"]
        info = item.get("commit") or {}
        author = info.get("author") or {}
        message = info.get("message") or ""
        login = (item.get("author") or {}).get("login")
        email = author.get("email")
        _upsert(
            session, link, existing, totals, now, kind="commit", external_id=sha,
            values={
                "title": _line(message) or f"提交 {sha[:7]}",
                "summary": message[:30000],
                "state": None,
                "author_login": login,
                "author_name": (author.get("name") or login or "未知作者")[:240],
                "author_email": email,
                "author_user_id": resolver.resolve(login, email),
                "url": _safe_url(item.get("html_url")),
                "detail": {"sha": sha, "branch": link.default_branch},
                "occurred_at": _parse_time(author.get("date")),
            },
            new_commits=new_commits,
        )  # fmt: skip

    for item in pulls:
        number = str(item["number"])
        login = (item.get("user") or {}).get("login")
        state = "merged" if item.get("merged_at") else item.get("state", "open")
        _upsert(
            session, link, existing, totals, now, kind="pull_request", external_id=number,
            values={
                "title": f"#{number} {item.get('title') or ''}".strip()[:240],
                "summary": (item.get("body") or "")[:30000],
                "state": state,
                "author_login": login,
                "author_name": (login or "未知作者")[:240],
                "author_email": None,
                "author_user_id": resolver.resolve(login, None),
                "url": _safe_url(item.get("html_url")),
                "detail": {
                    "number": item["number"],
                    "head": (item.get("head") or {}).get("ref"),
                    "base": (item.get("base") or {}).get("ref"),
                    "draft": bool(item.get("draft")),
                },
                "occurred_at": _parse_time(item.get("updated_at") or item.get("created_at")),
            },
            new_commits=new_commits,
        )  # fmt: skip

    for item in runs:
        run_id = str(item["id"])
        login = (item.get("actor") or {}).get("login")
        state = item.get("conclusion") or item.get("status") or "unknown"
        _upsert(
            session, link, existing, totals, now, kind="ci_run", external_id=run_id,
            values={
                "title": f"{item.get('name') or 'CI'} #{item.get('run_number', '')}: {state}"[:240],
                "summary": (
                    f"{item.get('head_branch') or ''} {str(item.get('head_sha') or '')[:7]} "
                    f"{item.get('event') or ''}"
                ).strip(),
                "state": state,
                "author_login": login,
                "author_name": (login or "GitHub Actions")[:240],
                "author_email": None,
                "author_user_id": resolver.resolve(login, None),
                "url": _safe_url(item.get("html_url")),
                "detail": {
                    "run_number": item.get("run_number"),
                    "head_sha": item.get("head_sha"),
                    "head_branch": item.get("head_branch"),
                    "event": item.get("event"),
                },
                "occurred_at": _parse_time(item.get("created_at")),
            },
            new_commits=new_commits,
        )  # fmt: skip

    session.flush()
    _mark_deleted(session, client, link, existing, commits, runs, totals, now)
    return new_commits


def _mark_deleted(session, client, link, existing, commits, runs, totals, now) -> None:
    """窗口内本该出现却没出现的提交/CI 运行：向 GitHub 逐个确认后才标记删除。"""
    verified = 0
    for kind, fetched, checker in (
        ("commit", commits, "commit_exists"),
        ("ci_run", runs, "run_exists"),
    ):
        if not fetched:
            continue  # 没读到任何数据时没有可比较的窗口，不判断
        seen = {str(i["sha"] if kind == "commit" else i["id"]) for i in fetched}
        times = [
            _parse_time(
                ((i.get("commit") or {}).get("author") or {}).get("date")
                if kind == "commit"
                else i.get("created_at")
            )
            for i in fetched
        ]
        oldest = min(times)
        for (row_kind, external_id), row in list(existing.items()):
            if row_kind != kind or row.deleted or external_id in seen or row.occurred_at < oldest:
                continue
            if verified >= MAX_VERIFY_PER_SYNC:
                return
            verified += 1
            if getattr(client, checker)(link.owner, link.repo, external_id, link.installation_id):
                continue  # 还在（例如不在默认分支的窗口里），保持原样
            row.deleted, row.revision, row.synced_at = True, f"deleted:{external_id}", now
            totals["deleted_sources"] += 1
    session.flush()


def associate_new_commits(
    session: Session, actor: User, project_id: UUID, commits: list[GithubActivity]
) -> int:
    """对新入库的提交调用 C 的任务号匹配；单个失败只跳过，不影响同步。"""
    if not commits:
        return 0
    from app.modules.c.activity_service import auto_associate_github_commit

    port = DatabaseGithubActivityPort(lambda: _Reuse(session))
    associated = 0
    for commit in commits:
        try:
            with session.begin_nested():
                state = auto_associate_github_commit(session, actor, project_id, commit.id, port)
            associated += 1 if state and state.get("task_id") else 0
        except ApiError as exc:
            logger.info("skip auto-associate for %s: %s", commit.external_id[:7], exc.code)
    return associated


class _Reuse:
    """让端口复用调用方的会话（同一事务内能读到刚写入的行），退出时不关闭。"""

    def __init__(self, session: Session) -> None:
        self._session = session

    def __enter__(self) -> Session:
        return self._session

    def __exit__(self, *exc) -> bool:
        return False


# ---------------------------------------------------------------- C 的活动页读取


def _record(row: GithubActivity) -> ActivitySourceRecord:
    if row.deleted:
        title, summary = f"[已删除] {row.kind} {row.external_id[:12]}", ""
        content = {"deleted": True, "kind": row.kind, "external_id": row.external_id}
    else:
        title, summary = row.title, row.summary
        content = {
            "kind": row.kind,
            "external_id": row.external_id,
            "title": row.title,
            "state": row.state,
            "author_login": row.author_login,
            **(row.detail or {}),
        }
        if row.kind == "commit":
            content["message"] = row.summary
    return ActivitySourceRecord(
        id=row.id,
        title=title or f"{row.kind} {row.external_id[:12]}",
        summary=summary,
        author_id=row.author_user_id,
        author_name=row.author_name or row.author_login or "未知作者",
        occurred_at=row.occurred_at,
        kind=row.kind,
        source=VerifiedSource(
            project_id=row.project_id,
            source_type="github",
            identity=f"{row.kind}:{row.external_id}",
            revision=row.revision,
            content=content,
            source_url=None if row.deleted else row.url,
            source_reference_id=row.id,
            availability="deleted" if row.deleted else "available",
        ),
        group_id=None,
    )


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def github_filters(project_id: UUID, query: ActivitySourceQuery) -> list:
    filters = [GithubActivity.project_id == project_id]
    if query.author_id is not None:
        filters.append(GithubActivity.author_user_id == query.author_id)
    if query.record_kind:
        filters.append(GithubActivity.kind == query.record_kind)
    if query.since is not None:
        filters.append(GithubActivity.occurred_at >= query.since)
    if query.until is not None:
        filters.append(GithubActivity.occurred_at <= query.until)
    if query.q:
        pattern = f"%{_escape_like(query.q)}%"
        filters.append(
            GithubActivity.title.ilike(pattern, escape="\\")
            | GithubActivity.summary.ilike(pattern, escape="\\")
        )
    if query.include_ids is not None:
        filters.append(GithubActivity.id.in_(query.include_ids))
    if query.exclude_ids:
        filters.append(GithubActivity.id.notin_(query.exclude_ids))
    return filters


class DatabaseGithubActivityPort:
    """C 活动页和证据页的 GitHub 实现：读本地快照，权限按项目成员检查。"""

    def __init__(self, session_factory) -> None:
        self._session_factory = session_factory

    def _check(self, session: Session, project_id: UUID, actor_id: UUID, source_type: str) -> None:
        if source_type != "github":
            raise ApiError(503, "ACTIVITY_SOURCE_UNAVAILABLE", "该来源尚未接入。")
        permissions.require_project_member(
            session, session.get(User, actor_id), project_id, write=False
        )

    def query(
        self, *, project_id: UUID, actor_id: UUID, source_type: str, query: ActivitySourceQuery
    ) -> ActivitySourcePage:
        with self._session_factory() as session:
            self._check(session, project_id, actor_id, source_type)
            if query.group_id:
                return ActivitySourcePage(items=(), total=0)  # GitHub 记录没有分组
            if query.include_ids is not None and len(query.include_ids) == 0:
                return ActivitySourcePage(items=(), total=0)
            filters = github_filters(project_id, query)
            total = session.scalar(select(func.count()).select_from(GithubActivity).where(*filters))
            rows = session.scalars(
                select(GithubActivity)
                .where(*filters)
                .order_by(GithubActivity.occurred_at.desc(), GithubActivity.id.asc())
                .offset((query.page - 1) * query.page_size)
                .limit(query.page_size)
            ).all()
            return ActivitySourcePage(items=tuple(_record(r) for r in rows), total=total or 0)

    def get(
        self, *, project_id: UUID, actor_id: UUID, source_type: str, source_id: UUID
    ) -> ActivitySourceRecord:
        with self._session_factory() as session:
            self._check(session, project_id, actor_id, source_type)
            row = session.scalar(
                select(GithubActivity).where(
                    GithubActivity.id == source_id, GithubActivity.project_id == project_id
                )
            )
            if row is None:
                raise ApiError(404, "ACTIVITY_NOT_FOUND", "记录不存在。")
            return _record(row)


class CompositeActivityPort:
    """按来源类型把 C 的读取分给飞书或 GitHub 的实现。"""

    def __init__(self, feishu, github) -> None:
        self._ports = {"feishu": feishu, "github": github}

    def query(self, *, source_type: str, **kwargs):
        return self._ports[source_type].query(source_type=source_type, **kwargs)

    def get(self, *, source_type: str, **kwargs):
        return self._ports[source_type].get(source_type=source_type, **kwargs)


def list_activity(
    session: Session,
    actor: User,
    project_id: UUID,
    *,
    kind: str | None = None,
    author_id: UUID | None = None,
    page: int = 1,
    page_size: int = 20,
) -> tuple[list[GithubActivity], int]:
    """项目成员查看本项目的 GitHub 活动（新的在前）。"""
    permissions.require_project_member(session, actor, project_id, write=False)
    if kind is not None and kind not in KINDS:
        raise ApiError(422, "INVALID_ACTIVITY_KIND", "kind 只能是 commit、pull_request 或 ci_run。")
    where = [GithubActivity.project_id == project_id]
    if kind:
        where.append(GithubActivity.kind == kind)
    if author_id is not None:
        where.append(GithubActivity.author_user_id == author_id)
    total = session.scalar(select(func.count()).select_from(GithubActivity).where(*where)) or 0
    rows = session.scalars(
        select(GithubActivity)
        .where(*where)
        .order_by(GithubActivity.occurred_at.desc(), GithubActivity.id.asc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return list(rows), total
