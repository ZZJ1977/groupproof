"""后台自动巡检已绑定 GitHub 仓库：新提交自动同步并触发 AI 代码功能分析。"""

from __future__ import annotations

import logging
import os
import threading
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, text

from app.db.models import Project
from app.db.session import SessionLocal, engine
from app.modules.a import activity_summary, github, github_sync
from app.modules.a.models import GithubRepoLink
from app.modules.b import code_progress_service

logger = logging.getLogger("groupproof.a.github_auto_sync")

_ADVISORY_LOCK_ID = 88421031
_DEFAULT_INTERVAL_SECONDS = 60
_MIN_SYNC_GAP_SECONDS = 50
_stop_event = threading.Event()
_thread: threading.Thread | None = None


def _is_enabled() -> bool:
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return False
    if (os.environ.get("APP_ENV") or "").strip().lower() == "test":
        return False
    flag = (os.environ.get("GITHUB_AUTO_SYNC_ENABLED") or "1").strip().lower()
    if flag in {"0", "false", "no", "off"}:
        return False
    if engine.dialect.name != "postgresql":
        return False
    return github.github_settings() is not None


def _interval_seconds() -> int:
    raw = (os.environ.get("GITHUB_AUTO_SYNC_INTERVAL_SECONDS") or "").strip()
    try:
        value = int(raw)
    except ValueError:
        value = _DEFAULT_INTERVAL_SECONDS
    return max(30, min(value, 600))


def run_once(*, session_factory=None, client=None) -> dict[str, int]:
    """执行一轮活跃项目 GitHub 自动同步与未分析提交的 AI 摘要生成。"""
    factory = session_factory or SessionLocal
    owned_client = client is None
    if client is None:
        client = github.get_github_client()
    if client is None:
        return {"repos_checked": 0, "repos_synced": 0, "summaries_generated": 0}

    repos_checked = 0
    repos_synced = 0
    summaries_generated = 0
    pending_jobs: list[tuple] = []

    try:
        with factory() as session:
            is_pg = session.get_bind().dialect.name == "postgresql"
            if is_pg:
                locked = session.scalar(
                    text("SELECT pg_try_advisory_lock(:lock_id)"),
                    {"lock_id": _ADVISORY_LOCK_ID},
                )
                if not locked:
                    return {"repos_checked": 0, "repos_synced": 0, "summaries_generated": 0}
            try:
                cutoff = datetime.now(UTC) - timedelta(seconds=_MIN_SYNC_GAP_SECONDS)
                links = list(
                    session.scalars(
                        select(GithubRepoLink)
                        .join(Project, Project.id == GithubRepoLink.project_id)
                        .where(Project.lifecycle == "active")
                        .order_by(GithubRepoLink.last_synced_at.asc().nullsfirst())
                    ).all()
                )
                seen_repos: set[tuple[str, str]] = set()
                for link in links:
                    repos_checked += 1
                    repo_key = (link.owner.lower(), link.repo.lower())
                    if repo_key in seen_repos:
                        continue
                    seen_repos.add(repo_key)

                    last_synced = link.last_synced_at
                    if last_synced is not None:
                        last_utc = (
                            last_synced.astimezone(UTC)
                            if last_synced.tzinfo is not None
                            else last_synced.replace(tzinfo=UTC)
                        )
                        needs_sync = last_utc <= cutoff
                    else:
                        needs_sync = True

                    if needs_sync:
                        try:
                            github_sync.sync_repo_links_by_webhook(
                                session, link.owner, link.repo, client
                            )
                            code_progress_service.sync_task_code_progress(session, link.project_id)
                            session.commit()
                            repos_synced += 1
                        except Exception as exc:  # noqa: BLE001
                            session.rollback()
                            logger.warning(
                                "auto sync failed for %s/%s: %s", link.owner, link.repo, exc
                            )
                            continue

                    pending_ids = activity_summary.recent_unanalyzed_commit_ids(
                        session, link.project_id
                    )
                    if pending_ids:
                        pending_jobs.append((link.project_id, link.linked_by_id, pending_ids))
            finally:
                if is_pg:
                    try:
                        session.execute(
                            text("SELECT pg_advisory_unlock(:lock_id)"),
                            {"lock_id": _ADVISORY_LOCK_ID},
                        )
                        session.commit()
                    except Exception:  # noqa: BLE001
                        session.rollback()
    finally:
        if owned_client and hasattr(client, "close"):
            client.close()

    for project_id, actor_id, commit_ids in pending_jobs:
        summaries_generated += activity_summary.run_auto_summaries(
            project_id,
            actor_id,
            commit_ids,
            session_factory=factory,
            refresh_code_progress=True,
        )

    return {
        "repos_checked": repos_checked,
        "repos_synced": repos_synced,
        "summaries_generated": summaries_generated,
    }


def _loop() -> None:
    interval = _interval_seconds()
    logger.info("GitHub 自动同步与 AI 摘要后台线程已启动（每 %s 秒巡检）", interval)
    # 启动后稍等 15 秒再执行首轮巡检，避免阻塞冷启动健康检查
    if _stop_event.wait(15):
        return
    while not _stop_event.is_set():
        try:
            result = run_once()
            if result["repos_synced"] or result["summaries_generated"]:
                logger.info("GitHub 自动巡检完成：%s", result)
        except Exception as exc:  # noqa: BLE001
            logger.warning("GitHub 自动巡检本轮异常：%s", exc)
        _stop_event.wait(interval)


def start_auto_sync_loop() -> None:
    global _thread
    if not _is_enabled():
        return
    if _thread is not None and _thread.is_alive():
        return
    _stop_event.clear()
    _thread = threading.Thread(target=_loop, name="github-auto-sync", daemon=True)
    _thread.start()


def stop_auto_sync_loop() -> None:
    _stop_event.set()
