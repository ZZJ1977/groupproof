"""GitHub 提交与任务进度自动联动服务（只读匹配 + 受控更新进行中进度）。

规则：
- 自动排除 Claude / Dependabot / GitHub Actions 等 Bot 提交；
- 严格尊重既有人工关联（c_activity_records）与显式编号（#T-001 / 模块代号）；
- 命中真实提交的任务自动推进至 ``in_progress`` 并按提交量与测试覆盖估算进度；
- 遵守红线：自动代码进度最高封顶 **90%**，绝不自动改成 100% 或自动提交验收/完成。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID, uuid4

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import (
    FunctionalModule,
    Milestone,
    ProgressEvent,
    ProjectMember,
    Task,
    TaskAssignee,
    TaskMilestone,
    User,
)
from app.modules.a import github_activity, permissions
from app.modules.a.audit import record_audit
from app.modules.a.models import GithubActivity
from app.modules.b.common import lock_project_for_write, now
from app.modules.b.models import BTaskMeta
from app.modules.c.activity_models import ActivityRecordState

MAX_AUTO_CODE_PROGRESS = 90
_TASK_CODE_RE = re.compile(r"(?:#|\b)T-?0*(\d+)\b", re.IGNORECASE)
_MODULE_CODE_RE = re.compile(r"\b([A-Za-z]\d+(?:-\d+)?)\b")
_ASCII_TOKEN_RE = re.compile(r"[a-z0-9_]{3,}", re.IGNORECASE)

# 跨项目通用的双语领域关键词组：用于将提交标题/变更文件路径与任务标题/模块对齐
_CONCEPT_RULES: tuple[tuple[tuple[str, ...], tuple[str, ...]], ...] = (
    (
        ("仓库", "分支", "模板", "ci", "workflow", "actions", "eslint", "ruff", "lint"),
        (".github/", "ci", "workflow", "eslint", "ruff", "prettier", "branch", "actions"),
    ),
    (
        (
            "底座",
            "骨架",
            "数据库",
            "迁移",
            "alembic",
            "fastapi",
            "openapi",
            "celery",
            "redis",
            "docker",
            "pgvector",
            "种子",
        ),
        (
            "alembic",
            "migrations/",
            "app/db/",
            "seed",
            "openapi",
            "api.generated",
            "docker",
            "fastapi",
            "worker",
            "redis",
        ),
    ),
    (
        ("登录", "注册", "认证", "oauth", "google", "邮箱验证", "密码", "rbac", "权限", "越权"),
        (
            "app/auth/",
            "auth",
            "oauth",
            "google",
            "login",
            "register",
            "onboarding",
            "password",
            "permission",
            "rbac",
        ),
    ),
    (
        ("通知", "审计", "待办", "文件存储", "正文提取", "公共服务"),
        ("inbox", "audit", "notification", "storage", "text_extraction", "upload"),
    ),
    (
        ("github", "webhook", "多分支", "仓库绑定", "同步", "提交统计"),
        ("github", "webhook", "github_activity", "github_sync", "githubstats", "github-binding"),
    ),
    (
        ("飞书", "feishu", "群消息", "脱敏"),
        ("feishu",),
    ),
    (
        ("ai", "openrouter", "deepseek", "智能", "摘要", "蓝图", "模型", "用量"),
        (
            "modules/a/ai",
            "openrouter",
            "activity_summary",
            "deepseek",
            "ai-usage",
            "ai_blueprint",
            "prompt",
        ),
    ),
    (
        ("上线", "部署", "railway", "sentry", "备份", "监控", "mock", "生产", "环境"),
        ("railway", "dockerfile", "sentry", "healthz", "readyz", "entrypoint"),
    ),
    (
        ("课程", "加入课程", "邀请码", "班级"),
        ("course", "courses"),
    ),
    (
        ("小组", "成员变动", "组长", "邀请", "退出", "移出"),
        ("group", "groups", "membership"),
    ),
    (
        ("初始化", "向导", "项目资料", "冲突处理", "审核清单"),
        ("setup", "draft", "material", "checklist", "conflict", "projectoverview"),
    ),
    (
        ("需求基线", "需求管理", "需求清单", "变更", "版本历史"),
        ("requirement", "baseline"),
    ),
    (
        ("任务规划", "任务计划", "ai建议", "冻结", "解锁", "分工"),
        ("planning", "plan_validation", "suggestion", "code_progress"),
    ),
    (
        ("任务树", "看板", "列表", "三视图", "拖拽"),
        ("tasksview", "tasksapi", "tasks_view", "board", "kanban", "tree"),
    ),
    (
        ("里程碑", "交付物", "延期", "阶段交付"),
        ("milestone",),
    ),
    (
        ("首页", "通知中心", "待处理", "个人动态", "日常入口"),
        ("daily", "home", "action-items", "notifications", "inbox"),
    ),
    (
        ("任务执行", "状态机", "提交验收", "进度更新", "实现说明", "详情drawer"),
        ("execution", "submit", "progress", "detaildrawer", "note"),
    ),
    (
        ("证据中心", "采纳", "撤回", "来源失效", "有效证据"),
        ("evidence",),
    ),
    (
        ("文件资料", "版本管理", "课程文件", "下载"),
        ("files", "course_files"),
    ),
    (
        ("讨论区", "讨论", "回复", "@提及"),
        ("discussion",),
    ),
    (
        ("管理后台", "admin", "教师审核", "系统日志", "访问审批"),
        ("admin", "access_grant", "teacher_verification"),
    ),
    (
        ("验收", "完整性检查", "人工确认", "改判", "作废", "规则+ai"),
        ("verification", "acceptance", "completeness"),
    ),
    (
        ("贡献", "100%", "申诉", "裁决", "存档"),
        ("contribution", "appeal"),
    ),
    (
        ("风险", "每日巡检", "风险解释"),
        ("risk", "daily_risks"),
    ),
    (
        ("报告", "导出", "pdf", "docx", "快照"),
        ("report", "reporting", "pdf", "docx", "export"),
    ),
    (
        ("项目设置", "归档", "重开", "生命周期"),
        ("settings", "lifecycle", "reopen", "archive"),
    ),
    (
        ("教师端", "规则模板", "打分", "结课", "助教"),
        ("teacher", "grading", "rule_change"),
    ),
)

_TEST_FILE_HINT = ("test", "spec", "e2e", "pytest")


class CodeProgressSyncDTO(BaseModel):
    commits_scanned: int
    commits_matched: int
    tasks_updated: int
    milestones_updated: int


@dataclass
class TaskMatchStat:
    commit_count: int = 0
    test_commit_count: int = 0
    earliest_at: datetime | None = None
    latest_at: datetime | None = None


def _utc(dt: datetime) -> datetime:
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)


def _cjk_bigrams(text: str) -> set[str]:
    runs = re.findall(r"[\u4e00-\u9fff]{2,}", text)
    grams: set[str] = set()
    for run in runs:
        for i in range(len(run) - 1):
            grams.add(run[i : i + 2])
    return grams


def _task_profile(task: Task, module_name: str) -> tuple[set[str], set[str], set[str]]:
    """提取任务的显式编号、概念触发词组及中英文关键词。"""
    text = f"{task.title}\n{task.description or ''}\n{module_name}".lower()
    subcodes: set[str] = set()
    for m in _MODULE_CODE_RE.finditer(task.title):
        subcodes.add(m.group(1).lower())
    # 也提取说明里类似 A5-01 ~ A5-07 的前缀如 a5
    for m in re.finditer(r"\b([a-d]\d)-\d+\b", text):
        subcodes.add(m.group(1).lower())

    concept_markers: set[str] = set()
    for task_hints, commit_hints in _CONCEPT_RULES:
        if any(h in text for h in task_hints):
            concept_markers.update(commit_hints)

    ascii_tokens = {
        tok
        for tok in _ASCII_TOKEN_RE.findall(text)
        if tok not in {"api", "app", "src", "tsx", "json", "http", "true", "false"}
    }
    return subcodes, concept_markers, ascii_tokens | _cjk_bigrams(text)


def _commit_text_and_files(row: GithubActivity) -> tuple[str, list[str], bool]:
    detail = row.detail if isinstance(row.detail, dict) else {}
    raw_files = detail.get("files") if isinstance(detail.get("files"), list) else []
    paths = [
        str(item.get("path") or "").lower()
        for item in raw_files
        if isinstance(item, dict) and item.get("path")
    ]
    branch = str(detail.get("branch") or "")
    branches = " ".join(str(b) for b in (detail.get("branches") or []) if b)
    combined = f"{row.title}\n{row.summary}\n{branch} {branches}\n" + "\n".join(paths)
    has_test = any(any(hint in p for hint in _TEST_FILE_HINT) for p in paths) or any(
        hint in (row.title or "").lower() for hint in ("test(", "e2e", "pytest")
    )
    return combined.lower(), paths, has_test


def _member_aliases(session: Session, project_id: UUID) -> dict[str, UUID]:
    rows = session.execute(
        select(User.id, User.name, User.github_username)
        .join(ProjectMember, ProjectMember.user_id == User.id)
        .where(ProjectMember.project_id == project_id, ProjectMember.left_at.is_(None))
    ).all()
    mapping: dict[str, UUID] = {}
    for uid, name, gh in rows:
        if gh:
            mapping[gh.strip().lower()] = uid
        if name:
            mapping[name.strip().lower()] = uid
    return mapping


def _match_commits_to_tasks(
    session: Session,
    project_id: UUID,
    tasks: list[Task],
    meta_by_task: dict[UUID, BTaskMeta],
    assignees_by_task: dict[UUID, set[UUID]],
    modules_by_id: dict[UUID, str],
) -> tuple[dict[UUID, TaskMatchStat], int, int]:
    """把本项目全部非机器人 GitHub 提交映射到最匹配的任务，返回每个任务的命中统计。"""
    stats_by_task: dict[UUID, TaskMatchStat] = {t.id: TaskMatchStat() for t in tasks}
    if not tasks:
        return stats_by_task, 0, 0

    commits = list(
        session.scalars(
            select(GithubActivity)
            .where(
                GithubActivity.project_id == project_id,
                GithubActivity.kind == "commit",
                GithubActivity.deleted.is_(False),
            )
            .order_by(GithubActivity.occurred_at.asc())
        )
    )
    if not commits:
        return stats_by_task, 0, 0

    explicit_links = {
        row.source_id: row.task_id
        for row in session.scalars(
            select(ActivityRecordState).where(
                ActivityRecordState.project_id == project_id,
                ActivityRecordState.source_type == "github",
                ActivityRecordState.task_id.is_not(None),
            )
        )
        if row.task_id is not None
    }
    by_seq = {meta.seq: meta.task_id for meta in meta_by_task.values()}
    profiles = {t.id: _task_profile(t, modules_by_id.get(t.module_id, "")) for t in tasks}
    aliases = _member_aliases(session, project_id)

    scanned = 0
    matched_commits = 0
    for row in commits:
        if github_activity._is_excluded_bot_author(
            row.author_login, row.author_name, row.author_email
        ):
            continue
        scanned += 1
        occurred = _utc(row.occurred_at)
        text, paths, has_test = _commit_text_and_files(row)

        target_task_id: UUID | None = explicit_links.get(row.id)
        if target_task_id is not None and target_task_id not in stats_by_task:
            target_task_id = None

        if target_task_id is None:
            for m in _TASK_CODE_RE.finditer(f"{row.title}\n{row.summary}"):
                seq = int(m.group(1))
                if seq in by_seq:
                    target_task_id = by_seq[seq]
                    break

        if target_task_id is None:
            author_uid = row.author_user_id
            if author_uid is None:
                for cand in (row.author_login, row.author_name):
                    if cand and cand.strip().lower() in aliases:
                        author_uid = aliases[cand.strip().lower()]
                        break

            # 提取提交自身文本与路径里的信号
            commit_ascii = set(_ASCII_TOKEN_RE.findall(text))
            commit_bigrams = _cjk_bigrams(text)

            best_score = 0
            best_task_id: UUID | None = None
            for task in tasks:
                subcodes, concept_markers, tokens = profiles[task.id]
                score = 0
                # 1. 提交明确带 A5 / B3 等模块编号
                for sc in subcodes:
                    if re.search(rf"\b{re.escape(sc)}(?:-\d+)?\b", text):
                        score += 24
                # 2. 概念规则命中文件路径与标题关键词
                title_lower = (row.title or "").lower()
                for marker in concept_markers:
                    if marker in title_lower:
                        score += 6
                    elif any(marker in p for p in paths):
                        score += 5
                    elif marker in text:
                        score += 3
                # 3. 共享词命中
                overlap = (commit_ascii | commit_bigrams) & tokens
                score += min(12, len(overlap) * 2)
                # 4. 提交者恰好是该任务负责人时的合理加权
                if author_uid is not None and author_uid in assignees_by_task.get(task.id, set()):
                    score += 5

                if score > best_score:
                    best_score = score
                    best_task_id = task.id

            if best_score >= 6 and best_task_id is not None:
                target_task_id = best_task_id

        if target_task_id is not None:
            matched_commits += 1
            stat = stats_by_task[target_task_id]
            stat.commit_count += 1
            if has_test:
                stat.test_commit_count += 1
            if stat.earliest_at is None or occurred < stat.earliest_at:
                stat.earliest_at = occurred
            if stat.latest_at is None or occurred > stat.latest_at:
                stat.latest_at = occurred

    return stats_by_task, scanned, matched_commits


def _estimate_code_progress(stat: TaskMatchStat) -> int:
    """根据真实提交数量与是否含测试变更估算进度（封顶 90%，保留人工最终提交与验收）。"""
    n = stat.commit_count
    if n <= 0:
        return 0
    if n == 1:
        base = 25
    elif n == 2:
        base = 40
    elif n <= 4:
        base = 55
    elif n <= 8:
        base = 70
    elif n <= 14:
        base = 80
    else:
        base = 85
    if stat.test_commit_count > 0 and n >= 2:
        base = min(MAX_AUTO_CODE_PROGRESS, base + 5)
    return min(MAX_AUTO_CODE_PROGRESS, base)


def task_commit_metrics(
    session: Session, project_id: UUID, tasks: list[Task]
) -> dict[UUID, TaskMatchStat]:
    """只读计算本项目每个任务关联到的真实提交数量与最近提交时间。"""
    if not tasks:
        return {}
    task_ids = [t.id for t in tasks]
    meta_by_task = {
        m.task_id: m
        for m in session.scalars(select(BTaskMeta).where(BTaskMeta.project_id == project_id))
    }
    assignees_by_task: dict[UUID, set[UUID]] = {}
    for row in session.scalars(
        select(TaskAssignee).where(
            TaskAssignee.task_id.in_(task_ids), TaskAssignee.unassigned_at.is_(None)
        )
    ):
        assignees_by_task.setdefault(row.task_id, set()).add(row.user_id)
    modules_by_id = {
        m.id: m.name
        for m in session.scalars(
            select(FunctionalModule).where(FunctionalModule.project_id == project_id)
        )
    }
    stats_by_task, _, _ = _match_commits_to_tasks(
        session, project_id, tasks, meta_by_task, assignees_by_task, modules_by_id
    )
    return stats_by_task


def sync_task_code_progress(
    session: Session,
    project_id: UUID,
    *,
    actor: User | None = None,
    require_member_auth: bool = False,
    request=None,
) -> CodeProgressSyncDTO:
    """根据已同步的 GitHub 提交自动推进关联任务至进行中并更新参考进度（最高 90%）。"""
    if require_member_auth:
        if actor is None:
            raise ApiError(401, "UNAUTHORIZED", "请先登录。")
        relation = lock_project_for_write(session, actor, project_id)
        project = relation.project
    else:
        from app.db.models import Project

        project = session.get(Project, project_id, with_for_update=True)
        if project is None:
            raise ApiError(404, "PROJECT_NOT_FOUND", "项目不存在。")
        if actor is not None:
            permissions.require_project_member(session, actor, project_id, write=False)

    tasks = list(
        session.scalars(
            select(Task).where(Task.project_id == project_id).order_by(Task.created_at, Task.id)
        )
    )
    if not tasks:
        return CodeProgressSyncDTO(
            commits_scanned=0, commits_matched=0, tasks_updated=0, milestones_updated=0
        )

    task_ids = [t.id for t in tasks]
    meta_by_task = {
        m.task_id: m
        for m in session.scalars(select(BTaskMeta).where(BTaskMeta.project_id == project_id))
    }
    assignees_by_task: dict[UUID, set[UUID]] = {}
    for row in session.scalars(
        select(TaskAssignee).where(
            TaskAssignee.task_id.in_(task_ids), TaskAssignee.unassigned_at.is_(None)
        )
    ):
        assignees_by_task.setdefault(row.task_id, set()).add(row.user_id)
    modules_by_id = {
        m.id: m.name
        for m in session.scalars(
            select(FunctionalModule).where(FunctionalModule.project_id == project_id)
        )
    }

    stats_by_task, scanned, matched_commits = _match_commits_to_tasks(
        session, project_id, tasks, meta_by_task, assignees_by_task, modules_by_id
    )

    parent_ids = {t.parent_task_id for t in tasks if t.parent_task_id is not None}
    fallback_actor_id = actor.id if actor is not None else None
    if fallback_actor_id is None:
        fallback_actor_id = session.scalar(
            select(ProjectMember.user_id)
            .where(ProjectMember.project_id == project_id, ProjectMember.left_at.is_(None))
            .limit(1)
        )

    ts = now()
    tasks_updated = 0
    for task in tasks:
        if task.id in parent_ids:
            continue  # 父任务进度从子任务自动汇总
        stat = stats_by_task.get(task.id)
        if stat is None or stat.commit_count == 0:
            continue
        if task.status not in {"not_started", "in_progress", "pending_submission"}:
            continue

        estimated = _estimate_code_progress(stat)
        changed = False
        prev_status = task.status
        prev_progress = task.progress_percent

        if task.status == "not_started":
            task.status = "in_progress"
            if task.started_at is None:
                task.started_at = stat.earliest_at or ts
            changed = True
        if estimated > task.progress_percent:
            task.progress_percent = estimated
            changed = True

        if changed:
            task.lock_version += 1
            task.updated_at = ts
            tasks_updated += 1
            ev_actor = (
                fallback_actor_id
                or next(iter(assignees_by_task.get(task.id, set())), None)
                or task.created_by
            )
            if ev_actor is not None:
                session.add(
                    ProgressEvent(
                        id=uuid4(),
                        project_id=project_id,
                        task_id=task.id,
                        actor_id=ev_actor,
                        from_status=prev_status,
                        to_status=task.status,
                        progress_before=prev_progress,
                        progress_after=task.progress_percent,
                        reason=(
                            f"GitHub 代码同步自动关联 {stat.commit_count} 次提交"
                            "（参考进度上限 90%，待人工提交验收）"
                        ),
                    )
                )

    # 联动里程碑状态：若里程碑下已有任务进入进行中，则把里程碑从 not_started 推进至 in_progress
    milestones_updated = 0
    milestones = list(session.scalars(select(Milestone).where(Milestone.project_id == project_id)))
    if milestones:
        by_task = {t.id: t for t in tasks}
        links: dict[UUID, list[UUID]] = {}
        for tm in session.scalars(
            select(TaskMilestone).where(TaskMilestone.milestone_id.in_([m.id for m in milestones]))
        ):
            links.setdefault(tm.milestone_id, []).append(tm.task_id)
        for ms in milestones:
            if ms.status != "not_started":
                continue
            linked_tasks = [by_task[tid] for tid in links.get(ms.id, []) if tid in by_task]
            if any(t.status != "not_started" or t.progress_percent > 0 for t in linked_tasks):
                ms.status = "in_progress"
                ms.lock_version += 1
                milestones_updated += 1

    if tasks_updated > 0 and actor is not None:
        record_audit(
            session,
            actor=actor,
            action="project.tasks.code_progress_synced",
            target=("project", project_id),
            project_id=project_id,
            course_id=project.course_id,
            after={
                "commits_scanned": scanned,
                "commits_matched": matched_commits,
                "tasks_updated": tasks_updated,
                "milestones_updated": milestones_updated,
            },
            request=request,
        )
    session.flush()
    return CodeProgressSyncDTO(
        commits_scanned=scanned,
        commits_matched=matched_commits,
        tasks_updated=tasks_updated,
        milestones_updated=milestones_updated,
    )
