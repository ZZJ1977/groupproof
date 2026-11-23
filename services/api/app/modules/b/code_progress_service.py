"""GitHub 代码提交 ↔ 交付标准 ↔ 真实候选证据联动服务。

核心原则：
- **严格以代码改动与交付标准为依据**：只根据真实改动文件路径、提交说明与 AI 提交代码分析摘要
  匹配任务的每条验收/交付标准（``AcceptanceCriterion``），绝不按“某人提交了多少次”兜底凑数；
- **自动排除 Bot 与纯合并提交**：自动忽略 Claude / Dependabot / GitHub Actions 等 Bot 提交，
  以及无显式任务编号的 ``Merge branch ...`` 纯合并提交；
- **真实证据可点击可追溯**：为每条命中的交付标准挑选最具代表性的代码提交，幂等写入 C 模块真实
  ``Evidence``（``status="candidate"``, ``source_type="github"``）、``EvidenceCriterion``、
  ``EvidenceSourceSnapshot`` 与 ``EvidenceDecision``，并关联 ``ActivityRecordState``，
  让“查看证据”直接可见对应代码提交并支持人工采纳；
- **进度口径透明且守红线**：任务进度按“各交付标准的证据覆盖与人工确认情况”计算——仅代码候选证据
  覆盖封顶 **90%**，绝不自动改成 100% 或自动完成任务，需人工确认全部标准后正式完成。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from urllib.parse import urlsplit
from uuid import UUID, uuid4

from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import (
    AcceptanceCriterion,
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
from app.modules.a.models import ActivitySummary, GithubActivity
from app.modules.b.common import lock_project_for_write, now
from app.modules.b.models import BTaskMeta
from app.modules.c.activity_models import ActivityRecordState
from app.modules.c.integration_events import content_hash
from app.modules.c.models import (
    Evidence,
    EvidenceCriterion,
    EvidenceDecision,
    EvidenceSourceSnapshot,
)

MAX_AUTO_CODE_PROGRESS = 90
MAX_EVIDENCE_PER_CRITERION = 2
MAX_AUTO_EVIDENCE_PER_TASK = 6

_TASK_CODE_RE = re.compile(r"(?:#|\b)T-?0*(\d+)\b", re.IGNORECASE)
_MODULE_CODE_RE = re.compile(r"\b([A-Za-z]\d+(?:-\d+)?)\b")
_ASCII_TOKEN_RE = re.compile(r"[a-z][a-z0-9_]{2,}", re.IGNORECASE)
_MERGE_COMMIT_RE = re.compile(r"^merge\s+(?:branch|remote-tracking)\b", re.IGNORECASE)
_PR_MERGE_RE = re.compile(r"^merge\s+pull\s+request\b", re.IGNORECASE)
_AUTO_EVIDENCE_REASON = "代码同步按改动文件与交付标准自动关联为候选证据，待人工确认采纳。"

_STOP_ASCII = {
    "api",
    "app",
    "src",
    "tsx",
    "jsx",
    "json",
    "http",
    "https",
    "true",
    "false",
    "null",
    "none",
    "data",
    "meta",
    "list",
    "view",
    "page",
    "pages",
    "item",
    "items",
    "user",
    "users",
    "task",
    "tasks",
    "project",
    "projects",
    "module",
    "modules",
    "service",
    "services",
    "router",
    "schema",
    "schemas",
    "model",
    "models",
    "test",
    "tests",
    "spec",
    "feat",
    "fix",
    "chore",
    "docs",
    "refactor",
    "update",
    "add",
    "remove",
    "merge",
    "main",
    "develop",
    "branch",
}

# 跨项目通用的双语领域概念规则：(任务/标准关键词, 对应的文件路径或词边界触发词)
# 带 `/` 或 `.` 的触发词按路径子串匹配；纯英文词严格按词边界匹配，避免 "ci" 误命中 "service"。
_CONCEPT_RULES: tuple[tuple[tuple[str, ...], tuple[str, ...]], ...] = (
    # A1 拆分为原子概念：CI 检查 vs Docker/环境栈 vs 仓库协作规范
    (
        ("ci", "actions", "eslint", "ruff", "lint", "自动检查"),
        (".github/", "workflows/", "eslint", "ruff", "prettier", "ci/cd"),
    ),
    (
        ("docker compose", "本地栈", "环境模板", "环境变量"),
        ("docker-compose", ".env.example", "dev-backend"),
    ),
    (
        ("仓库协作", "分支保护", "模板", "目录规范"),
        ("codeowners", "pull_request_template", ".github/"),
    ),
    # A2 拆分为原子概念：数据库迁移 vs OpenAPI 契约 vs 异步任务/队列 vs 种子/骨架
    (
        ("数据库迁移", "alembic", "pgvector", "迁移"),
        ("alembic/", "migrations/", "app/db/", "pgvector"),
    ),
    (
        ("openapi", "自动生成", "前端类型", "契约"),
        ("export_openapi", "openapi.json", "api.generated.ts", "generate-api-client"),
    ),
    (
        ("celery", "redis", "异步任务", "worker", "sse"),
        ("celery", "worker/", "redis"),
    ),
    (
        ("后端核心底座", "fastapi", "种子", "乐观锁", "幂等"),
        ("app/main.py", "seed.py", "idempotency"),
    ),
    # A3 拆分为原子概念：Google OAuth vs 密码/入台 vs 学校邮箱验证 vs RBAC 权限
    (
        ("oauth", "google", "oidc", "账户绑定", "关联"),
        ("google_oidc", "google_auth", "oauth", "google"),
    ),
    (
        ("学校邮箱", "验证码", "邮箱核验", "未验证拦截"),
        ("school_email", "email_verification", "mail_outbox", "resend"),
    ),
    (
        ("密码", "注册", "登录", "入台"),
        ("password", "login", "register", "onboarding"),
    ),
    (
        ("rbac", "权限", "越权"),
        ("rbac", "permissions.py", "access_grants"),
    ),
    # A4 拆分为原子概念：通知/待办 vs 审计日志 vs 文件存储/正文提取
    (
        ("通知", "待办", "消息收件箱"),
        ("modules/a/inbox", "notification_delivery", "a_notifications", "action_items"),
    ),
    (
        ("审计日志", "不可变审计"),
        ("modules/a/audit", "a_audit", "auth_audit"),
    ),
    (
        ("文件存储", "正文提取", "uploadreceipt", "上传回执"),
        ("modules/a/storage", "text_extraction", "upload_receipt"),
    ),
    # A5 拆分为原子概念：GitHub 接入/同步 vs Webhook vs 统计可视化
    (
        ("webhook", "验签", "实时入库"),
        ("github_webhook", "webhooks/github"),
    ),
    (
        ("提交统计", "代码增减", "可视化", "贡献者"),
        ("githubstatschart", "github_activity"),
    ),
    (
        ("github", "多分支", "仓库绑定", "github app"),
        ("github_sync", "github_auto_sync", "modules/a/github", "github_evidence"),
    ),
    # A6 飞书
    (
        ("飞书", "feishu", "白名单群", "群消息", "脱敏"),
        ("feishu", "collaboration"),
    ),
    # A7 拆分为原子概念：OpenRouter 中间层 vs 用量计费 vs AI 能力/摘要
    (
        ("用量计费", "用量", "配额", "成本"),
        ("ai_usage", "usage.py"),
    ),
    (
        ("代码功能分析", "提交摘要", "自动分析"),
        ("activity_summary", "summarize_activity"),
    ),
    (
        ("openrouter", "deepseek", "ai 中间层", "ai中间层", "智能能力", "提示词"),
        ("modules/a/ai/", "openrouter", "deepseek", "ai_blueprint"),
    ),
    # A8 拆分为原子概念：Railway 部署 vs Sentry 监控 vs 健康检查
    (
        ("sentry", "错误监控", "告警"),
        ("sentry",),
    ),
    (
        ("健康检查", "healthz", "readyz"),
        ("healthz", "readyz"),
    ),
    (
        ("railway", "双环境", "正式上线", "部署"),
        ("railway", "dockerfile", "entrypoint", "deploy"),
    ),
    (
        ("我的课程", "邀请码", "加入课程", "入课审批"),
        (
            "courses_service",
            "courses_router",
            "coursesapipage",
            "b-courses",
            "course_join",
            "invite_code",
        ),
    ),
    (
        ("课程小组", "建组", "换组长", "组长变更", "成员退出", "移出", "成员变动"),
        (
            "groups_service",
            "groups_router",
            "groupsapipage",
            "membership_service",
            "membershipapipage",
            "b-groups",
            "b-membership",
        ),
    ),
    (
        ("创建项目向导", "初始化中心", "项目资料", "冲突处理", "审核清单"),
        (
            "projects_service",
            "projects_router",
            "projectsapipages",
            "setup_service",
            "b-projects",
            "project_materials",
            "conflicts",
        ),
    ),
    (
        ("需求基线", "需求管理", "需求清单", "变更影响", "版本历史", "r-001"),
        (
            "requirements_service",
            "requirements_router",
            "requirement_history",
            "requirementsapipage",
            "requirementssteps",
            "b-requirements",
            "b-manage",
        ),
    ),
    (
        ("任务规划", "任务计划", "ai 建议", "ai建议", "计划冻结", "解锁", "环形依赖", "权重总和"),
        (
            "planning_service",
            "planning_router",
            "plan_validation",
            "planningapipage",
            "b-planning",
            "ai_blueprint_service",
            "code_progress_service",
        ),
    ),
    (
        ("任务树", "看板", "列表", "三视图", "任务视图", "拖拽"),
        (
            "tasks_view_service",
            "tasks_view_router",
            "tasks_view_schemas",
            "tasksapipage",
            "b-tasks",
            "student-workspace",
        ),
    ),
    (
        ("里程碑", "交付物", "阶段确认", "日期调整", "延期"),
        (
            "milestones_service",
            "milestones_router",
            "milestonesapipage",
            "b-milestones",
        ),
    ),
    (
        ("日常入口", "首页", "通知中心", "待处理事项", "个人动态"),
        (
            "daily_service",
            "daily_router",
            "dailyapipages",
            "inboxapipages",
            "notificationspage",
            "daily-entry",
        ),
    ),
    (
        ("任务执行", "状态机", "提交验收", "提交准备", "任务说明", "进度历史"),
        (
            "task_execution",
            "execution_router",
            "executionapipage",
            "taskcriteriapanel",
            "note_service",
            "note_router",
        ),
    ),
    (
        ("证据中心", "候选证据", "正式证据", "采纳", "撤回", "来源失效", "有效证据"),
        (
            "evidence_service",
            "evidence_router",
            "evidence_sources",
            "evidenceapipage",
            "evidencecapturepanel",
        ),
    ),
    (
        ("协作活动", "github 与飞书", "开发活动"),
        (
            "activity_service",
            "activity_router",
            "activityapipages",
            "activityrecordpanels",
            "taskgithubactivities",
        ),
    ),
    (
        ("文件资料", "文件版本", "课程文件", "官方版本"),
        (
            "files_service",
            "files_router",
            "course_files",
            "projectfilesapipage",
            "coursefilesapipage",
            "fileversionhistory",
        ),
    ),
    (
        ("讨论区", "讨论串", "@提及", "重要结论转证据"),
        (
            "discussion_service",
            "discussion_router",
            "discussion_evidence",
            "discussionsapipage",
        ),
    ),
    (
        ("管理后台", "教师审核", "系统日志", "ai 用量", "访问审批", "治理"),
        (
            "admin_users",
            "admin_workbench",
            "governance_",
            "auth_audit",
            "admindashboard",
            "governanceapipages",
            "identityadminapipages",
            "c_admin",
        ),
    ),
    (
        ("完整性检查", "自动验收", "人工确认", "改判", "作废", "规则+ai"),
        (
            "modules/d/integrity",
            "modules/d/verification",
            "modules/d/acceptance",
            "acceptanceapipage",
            "taskverificationpanel",
            "integrity_check",
            "verification_run",
            "acceptance_decision",
            "week 4 acceptance",
            "week 5 acceptance",
        ),
    ),
    (
        ("贡献度", "100%", "申诉", "裁决", "贡献存档"),
        (
            "modules/d/contribution",
            "contributionapipage",
            "contributionweek7panel",
            "teacherappealsapipage",
        ),
    ),
    (
        ("风险管理", "每日自动巡检", "风险解释", "高风险"),
        ("risk_checks", "risk_read", "riskapipage"),
    ),
    (
        ("项目报告", "报告快照", "章节编辑", "pdf", "docx"),
        ("modules/d/reporting", "report_tasks", "reportapipage", "teacherreportsapipage"),
    ),
    (
        ("项目基本设置", "项目设置", "归档", "重开", "生命周期"),
        ("project_lifecycle", "projectsettingsapipage", "coursereopenapipage"),
    ),
    (
        ("教师端", "规则模板", "审阅打分", "结课归档", "助教"),
        (
            "teacher_course",
            "teacher_overview",
            "teacher_workspace",
            "teacher_reports",
            "teacherworkspaceapipage",
            "teacheroverviewapipage",
            "courserulesapipage",
        ),
    ),
)

_TEST_FILE_HINT = ("test", "spec", "e2e", "pytest")
_WORD_RE_CACHE: dict[str, re.Pattern[str]] = {}


class CodeProgressSyncDTO(BaseModel):
    commits_scanned: int
    commits_matched: int
    tasks_updated: int
    milestones_updated: int
    evidences_created: int = 0
    criteria_covered: int = 0


@dataclass
class TaskMatchStat:
    commit_count: int = 0
    test_commit_count: int = 0
    earliest_at: datetime | None = None
    latest_at: datetime | None = None
    matched_activity_ids: set[UUID] = field(default_factory=set)
    criterion_hits: dict[UUID, list[tuple[int, bool, GithubActivity]]] = field(default_factory=dict)


@dataclass
class TaskCriterionMetrics:
    criteria_total: int = 0
    criteria_evidenced: int = 0
    criteria_confirmed: int = 0
    evidence_count: int = 0
    matched_commits: int = 0
    latest_commit_at: datetime | None = None


def _utc(dt: datetime) -> datetime:
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)


def _cjk_bigrams(text: str) -> set[str]:
    runs = re.findall(r"[\u4e00-\u9fff]{2,}", text)
    grams: set[str] = set()
    for run in runs:
        for i in range(len(run) - 1):
            grams.add(run[i : i + 2])
    return grams


def _word_match(marker: str, text: str) -> bool:
    if "/" in marker or "." in marker or "_" in marker or "-" in marker:
        return marker in text
    pat = _WORD_RE_CACHE.get(marker)
    if pat is None:
        pat = re.compile(rf"(?<![a-z0-9]){re.escape(marker)}(?![a-z0-9])", re.IGNORECASE)
        _WORD_RE_CACHE[marker] = pat
    return pat.search(text) is not None


def _safe_github_url(raw: str | None) -> str | None:
    if not raw or not isinstance(raw, str):
        return None
    cleaned = raw.strip()
    if not cleaned or "\\" in cleaned or any(ord(c) < 32 or ord(c) == 127 for c in cleaned):
        return None
    parts = urlsplit(cleaned)
    if parts.scheme != "https" or parts.hostname != "github.com" or "@" in parts.netloc:
        return None
    return cleaned


def _extract_profile(text: str) -> tuple[set[str], set[str], set[str]]:
    lowered = text.lower()
    subcodes: set[str] = set()
    for m in _MODULE_CODE_RE.finditer(text):
        subcodes.add(m.group(1).lower())
    for m in re.finditer(r"\b([a-d]\d)-\d+\b", lowered):
        subcodes.add(m.group(1).lower())

    concept_markers: set[str] = set()
    for task_hints, commit_hints in _CONCEPT_RULES:
        if any(h in lowered for h in task_hints):
            concept_markers.update(commit_hints)

    ascii_tokens = {tok for tok in _ASCII_TOKEN_RE.findall(lowered) if tok not in _STOP_ASCII}
    return subcodes, concept_markers, ascii_tokens | _cjk_bigrams(lowered)


def _load_ai_summaries(session: Session, project_id: UUID) -> dict[UUID, dict]:
    rows = session.scalars(
        select(ActivitySummary)
        .where(
            ActivitySummary.project_id == project_id,
            ActivitySummary.source_type == "github",
            ActivitySummary.status.in_(("ready", "succeeded")),
        )
        .order_by(ActivitySummary.generated_at.desc(), ActivitySummary.created_at.desc())
    ).all()
    out: dict[UUID, dict] = {}
    for row in rows:
        if row.source_id not in out and isinstance(row.result_json, dict):
            out[row.source_id] = row.result_json
    return out


def _extract_ai_summary_fields(ai_summary: dict | None) -> tuple[str, str, str, list[str]]:
    """统一读取 ActivitySummaryResult 字段（headline/implementation/impact/verification）。"""
    if not isinstance(ai_summary, dict):
        return "", "", "", []

    def _pick(*keys: str) -> str:
        for key in keys:
            val = ai_summary.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
        return ""

    headline = _pick("headline", "summary_title")
    implementation = _pick("implementation", "implemented_features")
    impact = _pick("impact", "impact_scope")
    raw_ver = ai_summary.get("verification")
    verification = (
        [str(v).strip() for v in raw_ver if isinstance(v, str) and v.strip()][:3]
        if isinstance(raw_ver, list)
        else []
    )
    return headline, implementation, impact, verification


def _commit_text_and_files(
    row: GithubActivity, ai_summary: dict | None
) -> tuple[str, str, list[str], bool]:
    detail = row.detail if isinstance(row.detail, dict) else {}
    raw_files = detail.get("files") if isinstance(detail.get("files"), list) else []
    paths = [
        str(item.get("path") or "").lower()
        for item in raw_files
        if isinstance(item, dict) and item.get("path")
    ]
    headline, implementation, impact, verification = _extract_ai_summary_fields(ai_summary)
    ai_parts = [p for p in (headline, implementation, impact, *verification) if p]
    ai_text = "\n".join(ai_parts)
    title_lower = (row.title or "").lower()
    combined = f"{row.title}\n{row.summary}\n{ai_text}\n" + "\n".join(paths)
    has_test = any(any(hint in p for hint in _TEST_FILE_HINT) for p in paths) or any(
        hint in title_lower for hint in ("test(", "test:", "e2e", "pytest")
    )
    return combined.lower(), title_lower, paths, has_test


def _score_profile(
    profile: tuple[set[str], set[str], set[str]],
    *,
    text: str,
    title_lower: str,
    paths: list[str],
    commit_tokens: set[str],
) -> int:
    subcodes, concept_markers, tokens = profile
    score = 0
    for sc in subcodes:
        if re.search(rf"(?<![a-z0-9]){re.escape(sc)}(?:-\d+)?(?![a-z0-9])", text):
            score += 24
    for marker in concept_markers:
        if any(marker in p for p in paths):
            score += 8
        elif _word_match(marker, title_lower):
            score += 7
        elif _word_match(marker, text):
            score += 3
    overlap = commit_tokens & tokens
    score += min(10, len(overlap) * 2)
    return score


def _match_commits_to_tasks_and_criteria(
    session: Session,
    project_id: UUID,
    tasks: list[Task],
    meta_by_task: dict[UUID, BTaskMeta],
    modules_by_id: dict[UUID, str],
    criteria_by_task: dict[UUID, list[AcceptanceCriterion]],
) -> tuple[dict[UUID, TaskMatchStat], dict[UUID, dict], int, int]:
    """严格基于代码文件、提交信息与 AI 摘要将提交精准匹配至任务及具体交付标准。"""
    stats_by_task: dict[UUID, TaskMatchStat] = {t.id: TaskMatchStat() for t in tasks}
    if not tasks:
        return stats_by_task, {}, 0, 0

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
        return stats_by_task, {}, 0, 0

    ai_summaries = _load_ai_summaries(session, project_id)
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

    task_profiles: dict[UUID, tuple[set[str], set[str], set[str]]] = {}
    crit_profiles: dict[UUID, tuple[set[str], set[str], set[str]]] = {}
    for t in tasks:
        crits = criteria_by_task.get(t.id, [])
        crit_blob = "\n".join(c.text for c in crits)
        task_profiles[t.id] = _extract_profile(
            f"{t.title}\n{t.description or ''}\n{modules_by_id.get(t.module_id, '')}\n{crit_blob}"
        )
        for c in crits:
            # 严格仅按该条交付标准自身描述建特征，绝不混入任务标题，避免单条提交误命中全部标准
            crit_profiles[c.id] = _extract_profile(c.text)

    scanned = 0
    matched_commits = 0
    for row in commits:
        if github_activity._is_excluded_bot_author(
            row.author_login, row.author_name, row.author_email
        ):
            continue
        scanned += 1
        occurred = _utc(row.occurred_at)
        ai_summary = ai_summaries.get(row.id)
        text, title_lower, paths, has_test = _commit_text_and_files(row, ai_summary)
        commit_tokens = {
            tok for tok in _ASCII_TOKEN_RE.findall(text) if tok not in _STOP_ASCII
        } | _cjk_bigrams(text)

        matched_targets: list[tuple[UUID, int]] = []
        explicit_tid = explicit_links.get(row.id)
        if explicit_tid is not None and explicit_tid in stats_by_task:
            matched_targets.append((explicit_tid, 100))

        if not matched_targets:
            for m in _TASK_CODE_RE.finditer(f"{row.title}\n{row.summary}"):
                seq = int(m.group(1))
                if seq in by_seq:
                    matched_targets.append((by_seq[seq], 100))
                    break

        if not matched_targets:
            # 纯分支合并提交与超大跨模块 PR 合并提交包含大量无关历史改动，不作为自动代码匹配证据
            stripped_title = (row.title or "").strip()
            if _MERGE_COMMIT_RE.match(stripped_title) or (
                _PR_MERGE_RE.match(stripped_title) and len(paths) > 30
            ):
                continue

            scored: list[tuple[int, UUID]] = []
            for task in tasks:
                score = _score_profile(
                    task_profiles[task.id],
                    text=text,
                    title_lower=title_lower,
                    paths=paths,
                    commit_tokens=commit_tokens,
                )
                if score >= 8:
                    scored.append((score, task.id))
            scored.sort(key=lambda item: item[0], reverse=True)
            if scored:
                best_score, best_tid = scored[0]
                matched_targets.append((best_tid, best_score))
                # 若同一提交确切同时改动了第二个任务的核心文件，允许最多关联 2 个任务
                if len(scored) > 1:
                    second_score, second_tid = scored[1]
                    if second_score >= 14 and second_score >= best_score * 0.72:
                        matched_targets.append((second_tid, second_score))

        if not matched_targets:
            continue

        matched_commits += 1
        for tid, t_score in matched_targets:
            stat = stats_by_task[tid]
            stat.commit_count += 1
            stat.matched_activity_ids.add(row.id)
            if has_test:
                stat.test_commit_count += 1
            if stat.earliest_at is None or occurred < stat.earliest_at:
                stat.earliest_at = occurred
            if stat.latest_at is None or occurred > stat.latest_at:
                stat.latest_at = occurred

            crits = criteria_by_task.get(tid, [])
            if not crits:
                continue
            crit_scores: list[tuple[int, UUID]] = []
            for c in crits:
                cs = _score_profile(
                    crit_profiles[c.id],
                    text=text,
                    title_lower=title_lower,
                    paths=paths,
                    commit_tokens=commit_tokens,
                )
                crit_scores.append((cs, c.id))
            crit_scores.sort(key=lambda item: item[0], reverse=True)
            top_cs = crit_scores[0][0]
            chosen_cids = [
                cid
                for cs, cid in crit_scores
                if cs >= 8 and (cs >= top_cs * 0.72 or len(crits) <= 1)
            ]
            if not chosen_cids:
                # 显式 #T-001 绑定或单标准任务默认覆盖最相近的标准；多标准任务必须命中具体标准特征
                if t_score >= 100 or len(crits) == 1:
                    chosen_cids = [crit_scores[0][1]]
                elif top_cs >= 6:
                    chosen_cids = [crit_scores[0][1]]
            for cid in chosen_cids:
                stat.criterion_hits.setdefault(cid, []).append((t_score + top_cs, has_test, row))

    return stats_by_task, ai_summaries, scanned, matched_commits


def _create_candidate_evidences(
    session: Session,
    project_id: UUID,
    tasks: list[Task],
    stats_by_task: dict[UUID, TaskMatchStat],
    ai_summaries: dict[UUID, dict],
    criteria_by_task: dict[UUID, list[AcceptanceCriterion]],
    assignees_by_task: dict[UUID, set[UUID]],
    fallback_actor_id: UUID | None,
    *,
    recalculate: bool = False,
) -> int:
    """把各交付标准命中的代表性 GitHub 提交幂等写入 C 模块真实候选证据表。"""
    if fallback_actor_id is None:
        return 0

    if recalculate:
        # 仅清理旧版自动同步写入且尚未人工采纳的 candidate 证据，绝不触碰 formal / 人工提交证据
        auto_ev_ids = list(
            session.scalars(
                select(Evidence.id)
                .join(EvidenceDecision, EvidenceDecision.evidence_id == Evidence.id)
                .where(
                    Evidence.project_id == project_id,
                    Evidence.source_type == "github",
                    Evidence.status == "candidate",
                    EvidenceDecision.decision == "submitted",
                    EvidenceDecision.reason == _AUTO_EVIDENCE_REASON,
                )
            )
        )
        if auto_ev_ids:
            # 跳过已被 ActivityRecordState 引用的证据（双重保护）
            referenced_ids = set(
                session.scalars(
                    select(ActivityRecordState.evidence_id).where(
                        ActivityRecordState.evidence_id.in_(auto_ev_ids)
                    )
                )
            )
            removable_ids = [eid for eid in auto_ev_ids if eid not in referenced_ids]
            if removable_ids:
                session.execute(
                    delete(EvidenceCriterion).where(
                        EvidenceCriterion.evidence_id.in_(removable_ids)
                    )
                )
                session.execute(
                    delete(EvidenceSourceSnapshot).where(
                        EvidenceSourceSnapshot.evidence_id.in_(removable_ids)
                    )
                )
                session.execute(
                    delete(EvidenceDecision).where(EvidenceDecision.evidence_id.in_(removable_ids))
                )
                session.execute(delete(Evidence).where(Evidence.id.in_(removable_ids)))
                session.flush()

    existing_rows = session.execute(
        select(
            Evidence.id,
            Evidence.task_id,
            Evidence.status,
            EvidenceSourceSnapshot.content_json,
        )
        .join(EvidenceSourceSnapshot, EvidenceSourceSnapshot.evidence_id == Evidence.id)
        .where(
            Evidence.project_id == project_id,
            Evidence.source_type == "github",
            EvidenceSourceSnapshot.version_no == 1,
        )
    ).all()
    existing_by_key: dict[tuple[UUID, str], tuple[UUID, str]] = {}
    for ev_id, task_id, status, content_json in existing_rows:
        src_id = (content_json or {}).get("source_id") if isinstance(content_json, dict) else None
        if isinstance(src_id, str):
            existing_by_key[(task_id, src_id)] = (ev_id, status)

    existing_ec = set(
        session.execute(
            select(EvidenceCriterion.evidence_id, EvidenceCriterion.criterion_id)
            .join(Evidence, Evidence.id == EvidenceCriterion.evidence_id)
            .where(Evidence.project_id == project_id)
        ).all()
    )
    existing_state_rows = list(
        session.scalars(
            select(ActivityRecordState).where(
                ActivityRecordState.project_id == project_id,
                ActivityRecordState.source_type == "github",
            )
        )
    )
    existing_states = {row.source_id: row for row in existing_state_rows}
    existing_identities = {row.source_identity for row in existing_state_rows}

    created = 0
    for task in tasks:
        stat = stats_by_task.get(task.id)
        crits = criteria_by_task.get(task.id, [])
        if stat is None or not stat.criterion_hits or not crits:
            continue

        # 为每条交付标准挑出 Top 2 最具代表性的提交，合并到按 commit 去重的证据集合中
        selected_cids_by_act: dict[UUID, set[UUID]] = {}
        act_obj: dict[UUID, GithubActivity] = {}
        act_rank: dict[UUID, tuple[int, int, int, datetime]] = {}
        for c in crits:
            hits = stat.criterion_hits.get(c.id, [])
            if not hits:
                continue
            hits_sorted = sorted(
                hits,
                key=lambda item: (
                    item[0],
                    1 if item[2].id in ai_summaries else 0,
                    1 if item[1] else 0,
                    _utc(item[2].occurred_at),
                ),
                reverse=True,
            )
            seen_for_crit: set[UUID] = set()
            for score, has_test, act in hits_sorted:
                if act.id in seen_for_crit:
                    continue
                seen_for_crit.add(act.id)
                selected_cids_by_act.setdefault(act.id, set()).add(c.id)
                act_obj[act.id] = act
                rank = (
                    score,
                    1 if act.id in ai_summaries else 0,
                    1 if has_test else 0,
                    _utc(act.occurred_at),
                )
                if act.id not in act_rank or rank > act_rank[act.id]:
                    act_rank[act.id] = rank
                if len(seen_for_crit) >= MAX_EVIDENCE_PER_CRITERION:
                    break

        # 保证每条命中的交付标准至少保留 1 条代表提交，总自动候选证据受上限控制
        ordered_acts = sorted(
            selected_cids_by_act.keys(),
            key=lambda aid: (len(selected_cids_by_act[aid]), act_rank[aid]),
            reverse=True,
        )
        kept_acts: list[UUID] = []
        covered_cids: set[UUID] = set()
        for aid in ordered_acts:
            cids = selected_cids_by_act[aid]
            if len(kept_acts) < MAX_AUTO_EVIDENCE_PER_TASK or not cids.issubset(covered_cids):
                kept_acts.append(aid)
                covered_cids.update(cids)

        for aid in kept_acts:
            act = act_obj[aid]
            cids = sorted(selected_cids_by_act[aid], key=str)
            sha = (act.revision or act.external_id or str(act.id))[:40]
            short_sha = sha[:7]
            detail = act.detail if isinstance(act.detail, dict) else {}
            raw_files = detail.get("files") if isinstance(detail.get("files"), list) else []
            file_paths = [
                str(item.get("path"))
                for item in raw_files
                if isinstance(item, dict) and item.get("path")
            ]
            ai_headline, ai_impl, ai_impact, ai_ver = _extract_ai_summary_fields(
                ai_summaries.get(act.id)
            )
            ev_title = f"[{short_sha}] {ai_headline or act.title or 'GitHub 代码提交'}"[:240]
            desc_lines: list[str] = []
            if ai_impl:
                desc_lines.append(f"实现内容：{ai_impl}")
                if ai_impact:
                    desc_lines.append(f"影响范围：{ai_impact}")
                if ai_ver:
                    desc_lines.append(f"验证说明：{'；'.join(ai_ver[:2])}")
            elif act.summary and act.summary.strip() != (act.title or "").strip():
                desc_lines.append(f"实现内容：{act.summary.strip()}")
            else:
                desc_lines.append(f"实现内容：{act.title or 'GitHub 代码提交'}")
            if file_paths:
                preview = "、".join(file_paths[:8])
                suffix = f" 等 {len(file_paths)} 个文件" if len(file_paths) > 8 else ""
                desc_lines.append(f"改动文件：{preview}{suffix}")
            author_label = act.author_name or act.author_login or "项目成员"
            orig_title = (act.title or "").strip()
            if ai_headline and orig_title:
                desc_lines.append(f"原提交：{orig_title} · 提交人：{author_label}（{short_sha}）")
            else:
                desc_lines.append(f"提交人：{author_label} · 提交编号：{short_sha}")
            ev_desc = "\n".join(desc_lines)

            # 自动归集的代码候选证据归属给本任务负责人，确保每位负责人都能确认自己任务上的全部标准
            task_assignees = assignees_by_task.get(task.id, set())
            if act.author_user_id and act.author_user_id in task_assignees:
                author_id = act.author_user_id
            elif task_assignees:
                author_id = sorted(task_assignees, key=str)[0]
            else:
                author_id = act.author_user_id or fallback_actor_id

            key = (task.id, str(act.id))
            if key in existing_by_key:
                ev_id, ev_status = existing_by_key[key]
                # 仅更新 candidate 自动证据的标准关联、AI 描述与归属人，绝不修改 formal/withdrawn
                if ev_status == "candidate":
                    ev_row = session.get(Evidence, ev_id)
                    if ev_row is not None:
                        if ai_impl or not (ev_row.description or "").startswith("实现内容："):
                            ev_row.title = ev_title
                            ev_row.description = ev_desc
                        if author_id is not None and ev_row.author_id != author_id:
                            ev_row.author_id = author_id
                    for cid in cids:
                        if (ev_id, cid) not in existing_ec:
                            session.add(EvidenceCriterion(evidence_id=ev_id, criterion_id=cid))
                            existing_ec.add((ev_id, cid))
                continue

            ev_id = uuid4()
            source_url = _safe_github_url(act.url)
            source_payload = {
                "kind": "commit",
                "sha": sha,
                "title": act.title,
                "summary": ai_impl or act.summary or act.title,
                "body": ev_desc,
                "url": source_url,
                "author_login": act.author_login,
                "author_name": act.author_name,
                "files": file_paths[:20],
            }

            session.add(
                Evidence(
                    id=ev_id,
                    project_id=project_id,
                    task_id=task.id,
                    author_id=author_id,
                    title=ev_title,
                    description=ev_desc,
                    source_type="github",
                    source_url=source_url,
                    status="candidate",
                    lock_version=0,
                    source_changed=False,
                )
            )
            session.flush()
            for cid in cids:
                session.add(EvidenceCriterion(evidence_id=ev_id, criterion_id=cid))
                existing_ec.add((ev_id, cid))
            session.add(
                EvidenceSourceSnapshot(
                    evidence_id=ev_id,
                    version_no=1,
                    source_identity=sha,
                    source_revision=sha,
                    content_hash=content_hash(
                        {"availability": "available", "source": source_payload}
                    ),
                    content_json={
                        "source_id": str(act.id),
                        "availability": "available",
                        "source": source_payload,
                    },
                    captured_by=author_id,
                )
            )
            session.add(
                EvidenceDecision(
                    evidence_id=ev_id,
                    actor_id=author_id,
                    decision="submitted",
                    resulting_status="candidate",
                    reason=_AUTO_EVIDENCE_REASON,
                )
            )
            existing_by_key[key] = (ev_id, "candidate")
            created += 1

            # 同步写入 ActivityRecordState，确保任务详情里的 GitHub 提交面板同步可见
            st = existing_states.get(act.id)
            state_identity = f"commit:{sha}"
            if st is None and state_identity not in existing_identities:
                st = ActivityRecordState(
                    id=uuid4(),
                    project_id=project_id,
                    source_type="github",
                    source_id=act.id,
                    source_identity=state_identity,
                    status="candidate",
                    task_id=task.id,
                    evidence_id=None,
                )
                session.add(st)
                existing_states[act.id] = st
                existing_identities.add(state_identity)
            elif st is not None and st.task_id is None and st.status != "ignored":
                st.task_id = task.id

    session.flush()
    return created


def task_criteria_metrics(
    session: Session, project_id: UUID, tasks: list[Task]
) -> dict[UUID, TaskCriterionMetrics]:
    """只读计算各任务的交付标准达成与真实证据统计。"""
    out: dict[UUID, TaskCriterionMetrics] = {t.id: TaskCriterionMetrics() for t in tasks}
    if not tasks:
        return out
    task_ids = [t.id for t in tasks]

    criteria = session.scalars(
        select(AcceptanceCriterion).where(AcceptanceCriterion.task_id.in_(task_ids))
    ).all()
    criteria_ids_by_task: dict[UUID, set[UUID]] = {tid: set() for tid in task_ids}
    for c in criteria:
        criteria_ids_by_task.setdefault(c.task_id, set()).add(c.id)
    for tid, cids in criteria_ids_by_task.items():
        out[tid].criteria_total = len(cids)

    evidences = session.scalars(
        select(Evidence).where(
            Evidence.project_id == project_id,
            Evidence.task_id.in_(task_ids),
            Evidence.status.in_(("candidate", "pending_confirmation", "formal")),
            Evidence.source_changed.is_(False),
        )
    ).all()
    if not evidences:
        return out

    ev_by_id = {e.id: e for e in evidences}
    for e in evidences:
        out[e.task_id].evidence_count += 1
        if e.source_type == "github":
            out[e.task_id].matched_commits += 1
            ts = _utc(e.created_at) if e.created_at else None
            if ts and (
                out[e.task_id].latest_commit_at is None or ts > out[e.task_id].latest_commit_at
            ):
                out[e.task_id].latest_commit_at = ts

    ec_rows = session.execute(
        select(EvidenceCriterion.evidence_id, EvidenceCriterion.criterion_id).where(
            EvidenceCriterion.evidence_id.in_(list(ev_by_id.keys()))
        )
    ).all()
    evidenced_by_task: dict[UUID, set[UUID]] = {tid: set() for tid in task_ids}
    confirmed_by_task: dict[UUID, set[UUID]] = {tid: set() for tid in task_ids}
    for ev_id, cid in ec_rows:
        ev = ev_by_id.get(ev_id)
        if ev is None or cid not in criteria_ids_by_task.get(ev.task_id, set()):
            continue
        evidenced_by_task[ev.task_id].add(cid)
        if ev.status == "formal":
            confirmed_by_task[ev.task_id].add(cid)

    for tid in task_ids:
        out[tid].criteria_evidenced = len(evidenced_by_task[tid])
        out[tid].criteria_confirmed = len(confirmed_by_task[tid])

    return out


def task_commit_metrics(
    session: Session, project_id: UUID, tasks: list[Task]
) -> dict[UUID, TaskMatchStat]:
    """只读计算本项目每个任务关联到的真实提交数量与最近提交时间（兼容旧调用）。"""
    if not tasks:
        return {}
    task_ids = [t.id for t in tasks]
    meta_by_task = {
        m.task_id: m
        for m in session.scalars(select(BTaskMeta).where(BTaskMeta.project_id == project_id))
    }
    modules_by_id = {
        m.id: m.name
        for m in session.scalars(
            select(FunctionalModule).where(FunctionalModule.project_id == project_id)
        )
    }
    criteria_by_task: dict[UUID, list[AcceptanceCriterion]] = {}
    for c in session.scalars(
        select(AcceptanceCriterion)
        .where(AcceptanceCriterion.task_id.in_(task_ids))
        .order_by(AcceptanceCriterion.sort_order, AcceptanceCriterion.id)
    ):
        criteria_by_task.setdefault(c.task_id, []).append(c)

    stats_by_task, _, _, _ = _match_commits_to_tasks_and_criteria(
        session, project_id, tasks, meta_by_task, modules_by_id, criteria_by_task
    )
    return stats_by_task


def _estimate_criterion_progress(
    metrics: TaskCriterionMetrics,
    *,
    has_test: bool,
) -> int:
    """严格按交付标准覆盖比例估算进度（仅候选证据时封顶 90%，待人工确认与完成验收）。"""
    total = metrics.criteria_total
    if total <= 0:
        return 0
    confirmed = min(metrics.criteria_confirmed, total)
    candidate_only = max(0, min(metrics.criteria_evidenced, total) - confirmed)
    if confirmed == 0 and candidate_only == 0:
        return 0
    candidate_weight = 0.90 if has_test else 0.85
    raw = round(((confirmed * 1.0 + candidate_only * candidate_weight) / total) * 100)
    return min(MAX_AUTO_CODE_PROGRESS, max(1, raw))


def sync_task_code_progress(
    session: Session,
    project_id: UUID,
    *,
    actor: User | None = None,
    require_member_auth: bool = False,
    recalculate: bool = False,
    request=None,
) -> CodeProgressSyncDTO:
    """按代码内容关联交付标准、写入真实候选证据，并按标准覆盖度更新任务与里程碑进度。"""
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
    criteria_by_task: dict[UUID, list[AcceptanceCriterion]] = {}
    for c in session.scalars(
        select(AcceptanceCriterion)
        .where(AcceptanceCriterion.task_id.in_(task_ids))
        .order_by(AcceptanceCriterion.sort_order, AcceptanceCriterion.id)
    ):
        criteria_by_task.setdefault(c.task_id, []).append(c)

    fallback_actor_id = actor.id if actor is not None else None
    if fallback_actor_id is None:
        fallback_actor_id = session.scalar(
            select(ProjectMember.user_id)
            .where(ProjectMember.project_id == project_id, ProjectMember.left_at.is_(None))
            .limit(1)
        )

    stats_by_task, ai_summaries, scanned, matched_commits = _match_commits_to_tasks_and_criteria(
        session, project_id, tasks, meta_by_task, modules_by_id, criteria_by_task
    )

    evidences_created = _create_candidate_evidences(
        session,
        project_id,
        tasks,
        stats_by_task,
        ai_summaries,
        criteria_by_task,
        assignees_by_task,
        fallback_actor_id,
        recalculate=recalculate,
    )

    crit_metrics = task_criteria_metrics(session, project_id, tasks)
    total_criteria_covered = sum(m.criteria_evidenced for m in crit_metrics.values())

    parent_ids = {t.parent_task_id for t in tasks if t.parent_task_id is not None}
    ts = now()
    tasks_updated = 0
    for task in tasks:
        if task.id in parent_ids:
            continue  # 父任务进度从子任务自动汇总
        if task.status not in {"not_started", "in_progress", "pending_submission"}:
            continue

        cm = crit_metrics.get(task.id, TaskCriterionMetrics())
        stat = stats_by_task.get(task.id)
        has_test = bool(stat and stat.test_commit_count > 0)
        estimated = _estimate_criterion_progress(cm, has_test=has_test)

        changed = False
        prev_status = task.status
        prev_progress = task.progress_percent

        if cm.criteria_evidenced > 0:
            if task.status == "not_started":
                task.status = "in_progress"
                if task.started_at is None:
                    task.started_at = (stat.earliest_at if stat else None) or ts
                changed = True
            if (recalculate and estimated != task.progress_percent) or (
                not recalculate and estimated > task.progress_percent
            ):
                task.progress_percent = estimated
                changed = True
        elif recalculate and task.status == "in_progress" and task.progress_percent > 0:
            task.status = "not_started"
            task.progress_percent = 0
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
                reason = (
                    f"依据代码证据覆盖 {cm.criteria_evidenced}/{cm.criteria_total} 条交付标准"
                    f"（已人工确认 {cm.criteria_confirmed} 条，待人工确认后正式完成）"
                    if cm.criteria_evidenced > 0
                    else "重新按代码与交付标准核对：暂无匹配的代码证据，重置为未开始"
                )
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
                        reason=reason,
                    )
                )

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

    if (tasks_updated > 0 or evidences_created > 0) and actor is not None:
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
                "evidences_created": evidences_created,
                "criteria_covered": total_criteria_covered,
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
        evidences_created=evidences_created,
        criteria_covered=total_criteria_covered,
    )
