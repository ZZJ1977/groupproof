"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { CApiError, createCClient } from "@/lib/api/c-client";
import { createGovernanceClient, type ResolveLabelsDTO } from "@/lib/api/c-governance-client";
import { useWorkspace } from "@/lib/workspace";
import { tr } from "@/lib/i18n/tr";
import styles from "@/features/governance/governance.module.css";

const directoryClient = createCClient();
const governanceClient = createGovernanceClient();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuidString(value: string | null | undefined): value is string {
  return Boolean(value && UUID_PATTERN.test(value));
}

export function CopyableId({ value, compact = true }: { value: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const display = compact && value.length > 12 ? value.slice(0, 8) : value;
  const copy = (event: React.MouseEvent) => {
    event.stopPropagation();
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    }).catch(() => {});
  };
  return (
    <span className={styles.copyableId} title={value}>
      <code>{display}</code>
      <button
        type="button"
        className={styles.copyIdButton}
        aria-label={`复制编号 ${value}`}
        onClick={copy}
      >
        {copied ? <Check size={11} /> : <Copy size={11} />}
      </button>
    </span>
  );
}

export function EntityLabel({
  name,
  id,
  subtitle,
  fallback = "未命名对象",
}: {
  name?: string | null;
  id?: string | null;
  subtitle?: string | null;
  fallback?: string;
}) {
  if (!name && !id) return <span className={styles.muted}>—</span>;
  return (
    <span className={styles.entityLabel}>
      <strong className={styles.entityPrimary}>{name || fallback}</strong>
      {(subtitle || id) && (
        <span className={styles.entityMeta}>
          {subtitle && <span>{subtitle}</span>}
          {id && <CopyableId value={id} />}
        </span>
      )}
    </span>
  );
}

const emptyLabels: ResolveLabelsDTO = { users: {}, courses: {}, projects: {} };

export function useAdminLabels({
  userIds = [],
  courseIds = [],
  projectIds = [],
  enabled = true,
}: {
  userIds?: (string | null | undefined)[];
  courseIds?: (string | null | undefined)[];
  projectIds?: (string | null | undefined)[];
  enabled?: boolean;
}) {
  const { userId } = useWorkspace();
  const payload = useMemo(() => {
    const clean = (values: (string | null | undefined)[]) =>
      Array.from(new Set(values.filter(isUuidString))).sort().slice(0, 100);
    return {
      user_ids: clean(userIds),
      course_ids: clean(courseIds),
      project_ids: clean(projectIds),
    };
  }, [userIds, courseIds, projectIds]);

  const hasIds =
    payload.user_ids.length > 0 || payload.course_ids.length > 0 || payload.project_ids.length > 0;

  const query = useQuery({
    queryKey: ["admin-workbench-labels", userId, payload],
    queryFn: () => governanceClient.workbenchResolveLabels(payload),
    enabled: enabled && hasIds,
    staleTime: 60_000,
    gcTime: 120_000,
    retry: false,
  });

  return query.data ?? emptyLabels;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatRelativeTime(iso?: string | null): string {
  if (!iso) return "从未";
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return iso;
  const diffSec = Math.round((Date.now() - time) / 1000);
  if (diffSec < 0) return "即将";
  if (diffSec < 60) return "刚刚";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3600)} 小时前`;
  if (diffSec < 86_400 * 14) return `${Math.floor(diffSec / 86_400)} 天前`;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(time));
}

function unauthorized(error: unknown): error is CApiError {
  return error instanceof CApiError && (error.status === 401 || error.status === 403);
}

/** Compact single-row user picker preserving exact accessible labels & auth checks. */
export function CompactUserSelect({
  label,
  value,
  onChange,
  teacherOnly = false,
  required = false,
  includeSystem = false,
  onUnauthorized,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  teacherOnly?: boolean;
  required?: boolean;
  includeSystem?: boolean;
  onUnauthorized?: (error: CApiError) => void;
}) {
  const { userId } = useWorkspace();
  const searchId = useId();
  const selectId = useId();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (!search) {
      setDebouncedSearch("");
      return;
    }
    const timer = window.setTimeout(() => setDebouncedSearch(search), 150);
    return () => window.clearTimeout(timer);
  }, [search]);

  const query = {
    page,
    page_size: 10,
    q: debouncedSearch || undefined,
    ...(teacherOnly ? { role: "teacher" as const, status: "active" as const } : {}),
  };

  const list = useQuery({
    queryKey: ["c-governance-users", userId, query],
    queryFn: async () => {
      try {
        return await directoryClient.adminUsers(query);
      } catch (error) {
        if (unauthorized(error)) onUnauthorized?.(error);
        throw error;
      }
    },
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  const options =
    list.isSuccess && !list.isFetching
      ? list.data.items.filter((item) => !teacherOnly || item.email_verified)
      : [];

  const selectedUser = useQuery({
    queryKey: ["c-governance-selected-user", userId, value],
    queryFn: async () => {
      try {
        return await directoryClient.adminUser(value);
      } catch (error) {
        if (unauthorized(error)) onUnauthorized?.(error);
        throw error;
      }
    },
    enabled:
      Boolean(value) &&
      !(includeSystem && value === "system") &&
      list.isSuccess &&
      !list.isFetching,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  const retained =
    list.isSuccess &&
    !list.isFetching &&
    selectedUser.isSuccess &&
    !selectedUser.isFetching &&
    selectedUser.data.id === value &&
    (!teacherOnly ||
      (selectedUser.data.global_role === "teacher" &&
        selectedUser.data.status === "active" &&
        selectedUser.data.email_verified))
      ? selectedUser.data
      : undefined;

  const combined =
    retained && !options.some((item) => item.id === retained.id)
      ? [retained, ...options]
      : options;

  const total = list.data?.total ?? 0;

  return (
    <div className={styles.compactUserSelect}>
      <div className={styles.compactUserSelectRow}>
        <div className={styles.compactUserSelectField}>
          <label htmlFor={searchId}>{tr("{0}搜索", { 0: label })}</label>
          <input
            id={searchId}
            className={styles.input}
            type="search"
            maxLength={200}
            value={search}
            placeholder={teacherOnly ? "按教师姓名或邮箱搜索" : "按姓名、学号或邮箱搜索"}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
        </div>
        <div className={styles.compactUserSelectField}>
          <label htmlFor={selectId}>{label}</label>
          <select
            id={selectId}
            className={styles.select}
            aria-label={label}
            value={
              (includeSystem && value === "system") ||
              combined.some((item) => item.id === value)
                ? value
                : ""
            }
            required={required}
            disabled={list.isFetching || list.isError}
            onChange={(event) => onChange(event.target.value)}
          >
            <option value="">
              {required ? "请选择有效教师" : includeSystem ? "全部操作人" : "全部用户"}
            </option>
            {includeSystem && list.isSuccess && !list.isFetching && (
              <option value="system">系统操作</option>
            )}
            {combined.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.email}
              </option>
            ))}
          </select>
        </div>
        {list.isSuccess && !list.isFetching && total > 10 && (
          <div className={styles.compactUserPager}>
            <button
              type="button"
              className={styles.button}
              disabled={page === 1}
              onClick={() => setPage(page - 1)}
            >
              用户上一页
            </button>
            <span className={styles.muted}>{tr("第 {0} 页", { 0: page })}</span>
            <button
              type="button"
              className={styles.button}
              disabled={page * 10 >= total}
              onClick={() => setPage(page + 1)}
            >
              用户下一页
            </button>
          </div>
        )}
      </div>
      {list.isError && (
        <div role="alert" className={styles.compactUserError}>
          <span>用户目录暂时不可用</span>
          <button type="button" className={styles.button} onClick={() => void list.refetch()}>
            重试用户目录
          </button>
        </div>
      )}
      {list.isFetching && (
        <p role="status" className={styles.compactUserHint}>
          正在读取用户选项…
        </p>
      )}
      {list.isSuccess && !list.isFetching && (
        <small className={styles.compactUserHint}>
          {teacherOnly
            ? "仅可选择已验证学校邮箱的在职教师。"
            : "输入关键词筛选后选择用户。"}
          {!options.length && " 当前查询没有可选用户。"}
        </small>
      )}
    </div>
  );
}

const AUDIT_ACTION_LABELS: Record<string, { category: string; label: string }> = {
  "github.repo.linked": { category: "GitHub 集成", label: "绑定项目代码仓库" },
  "github.sync.completed": { category: "GitHub 同步", label: "手动同步仓库提交记录" },
  "github.webhook.synced": { category: "GitHub 同步", label: "Webhook 自动同步仓库提交" },
  "feishu.chat.linked": { category: "飞书集成", label: "绑定项目飞书协作群" },
  "feishu.sync.completed": { category: "飞书同步", label: "同步飞书群协作消息" },
  "feishu.attachment.verified": { category: "飞书同步", label: "校验飞书群附件文件" },
  "access.grant.activated": { category: "临时授权", label: "激活临时只读访问权限" },
  "access.grant.revoked": { category: "临时授权", label: "撤销临时只读访问权限" },
  "admin.user.sessions_revoked": { category: "账号安全", label: "管理员强制撤销全部会话" },
  "admin.project.lifecycle_updated": { category: "项目治理", label: "管理员变更项目生命周期" },
  "project.created": { category: "项目管理", label: "创建团队项目" },
  "project.setup.basic_saved": { category: "项目管理", label: "保存项目基础信息" },
  "project.leader.transferred": { category: "团队成员", label: "移交项目组长权限" },
  "project.member.added": { category: "团队成员", label: "添加项目成员" },
  "project.member.removed": { category: "团队成员", label: "移除项目成员" },
  "project.material.added": { category: "项目资料", label: "上传项目资料" },
  "project.ai_blueprint.generated": { category: "AI 规划", label: "生成 AI 项目研发蓝图" },
  "project.analysis.started": { category: "需求分析", label: "发起项目需求拆解分析" },
  "project.analysis.merged": { category: "需求分析", label: "合并需求分析结果" },
  "project.module.created": { category: "需求模块", label: "新建功能模块" },
  "project.module.updated": { category: "需求模块", label: "更新功能模块" },
  "project.module.deleted": { category: "需求模块", label: "删除功能模块" },
  "project.requirement.created": { category: "需求管理", label: "新增项目需求条目" },
  "project.requirement.updated": { category: "需求管理", label: "更新项目需求条目" },
  "project.conflict.resolved": { category: "需求管理", label: "解决需求冲突" },
  "project.baseline.scope_saved": { category: "范围基线", label: "保存项目范围基线草稿" },
  "project.baseline.submitted": { category: "范围基线", label: "提交范围基线待确认" },
  "project.baseline.confirmed": { category: "范围基线", label: "成员确认范围基线" },
  "project.baseline.rejected": { category: "范围基线", label: "驳回范围基线" },
  "project.baseline.frozen": { category: "范围基线", label: "冻结正式范围基线" },
  "project.baseline.force_frozen": { category: "范围基线", label: "强制冻结范围基线" },
  "project.plan.task_created": { category: "任务规划", label: "新建项目计划任务" },
  "project.plan.task_updated": { category: "任务规划", label: "更新项目计划任务" },
  "project.plan.task_deleted": { category: "任务规划", label: "删除项目计划任务" },
  "project.plan.assignment_confirmed": { category: "任务规划", label: "确认任务分工与责任人" },
  "project.plan.frozen": { category: "任务规划", label: "冻结正式任务计划" },
  "project.plan.unlocked": { category: "任务规划", label: "解锁任务计划进入修订" },
  "project.plan.suggestions_generated": { category: "AI 规划", label: "生成 AI 任务拆分建议" },
  "project.plan.suggestion_dismissed": { category: "AI 规划", label: "忽略 AI 任务拆分建议" },
  "project.milestone.deliverable_added": { category: "里程碑", label: "添加里程碑交付物" },
  "project.milestone.deliverable_checked": { category: "里程碑", label: "勾选/验收里程碑交付物" },
  "project.milestone.completed": { category: "里程碑", label: "完成项目里程碑" },
  "project.milestone.rescheduled": { category: "里程碑", label: "调整里程碑截止时间" },
  "project.tasks.code_progress_synced": { category: "代码进度", label: "同步代码提交到任务进度" },
  "task.status.changed": { category: "任务执行", label: "更新任务执行状态" },
  "group.created": { category: "课程组队", label: "创建课程小组" },
  "group.member.joined": { category: "课程组队", label: "学生加入课程小组" },
  "group.invitation.created": { category: "课程组队", label: "发出小组邀请" },
  "group.leader_change.requested": { category: "课程组队", label: "申请更换小组组长" },
  "group.leader.changed": { category: "课程组队", label: "变更小组组长" },
  "group.membership_change.resubmitted": { category: "课程组队", label: "重新提交组员变动申请" },
  "group.teacher_created": { category: "教师管班", label: "教师创建课程小组" },
  "group.teacher_assign": { category: "教师管班", label: "教师分配小组成员" },
  "group.teacher_set_leader": { category: "教师管班", label: "教师指定小组组长" },
  "course.member.joined": { category: "课程成员", label: "加入课程班级" },
  "course.join_request.created": { category: "课程成员", label: "提交入课申请" },
  "course.join_policy.updated": { category: "课程配置", label: "更新入课审批策略" },
  "course.project_template.updated": { category: "课程配置", label: "更新课程项目模板" },
  "course.rules_draft_saved": { category: "评价规则", label: "保存评分规则草稿" },
  "course.rules_published": { category: "评价规则", label: "发布正式课程评分规则" },
  "course.announcement.created": { category: "课程公告", label: "发布课程公告" },
  "course.announcement.updated": { category: "课程公告", label: "更新课程公告" },
  "course.announcement.deleted": { category: "课程公告", label: "删除课程公告" },
  "course.announcement.reminded": { category: "课程公告", label: "提醒未读学生查看公告" },
  "course.appeal.submitted": { category: "成绩申诉", label: "提交课程申诉" },
  "course.appeal.supplemented": { category: "成绩申诉", label: "补充课程申诉材料" },
  "course.folder.created": { category: "课程资料", label: "新建课程资料目录" },
  "course.folder.updated": { category: "课程资料", label: "更新课程资料目录" },
  "course.folder.deleted": { category: "课程资料", label: "删除课程资料目录" },
  "course.material.uploaded": { category: "课程资料", label: "上传课程资料文件" },
  "course.material.version_appended": { category: "课程资料", label: "追加课程资料新版本" },
  "course.material.updated": { category: "课程资料", label: "更新课程资料信息" },
  "course.material.deleted": { category: "课程资料", label: "删除课程资料文件" },
  "course.group.project_reminded": { category: "教学督导", label: "催办小组推进项目" },
  "course.report.exported": { category: "教学导出", label: "导出课程统计报告" },
  "class.created": { category: "班级治理", label: "新建教学班级" },
  "class.settings_updated": { category: "班级治理", label: "更新班级配置" },
  "class.invite_rotated": { category: "班级治理", label: "重置班级邀请码" },
  "class.student_removed": { category: "班级治理", label: "移出班级学生" },
  "class.ended": { category: "班级治理", label: "结束教学班级" },
  "class.archived": { category: "班级治理", label: "归档教学班级" },
  "class.reopened": { category: "班级治理", label: "重新开放教学班级" },
  "class.deleted": { category: "班级治理", label: "删除教学班级" },
  "staff.invited": { category: "助教授权", label: "邀请课程助教" },
  "staff.permissions_updated": { category: "助教授权", label: "调整助教操作权限" },
  "staff.removed": { category: "助教授权", label: "移除课程助教" },
  "teacher.action.reminded": { category: "教学督导", label: "发送教学提醒通知" },
  "course.created": { category: "课程治理", label: "创建课程草稿" },
  "course.published": { category: "课程治理", label: "发布课程并启用邀请码" },
  "course.ended": { category: "课程治理", label: "结束课程并撤销邀请码" },
  "course.updated": { category: "课程治理", label: "更新课程信息" },
};

const AUDIT_PREFIX_CATEGORIES: Array<[string, string]> = [
  ["github.", "GitHub 同步"],
  ["feishu.", "飞书同步"],
  ["access.", "临时授权"],
  ["admin.", "平台管理"],
  ["course.", "课程教学"],
  ["class.", "班级治理"],
  ["group.", "小组协作"],
  ["project.milestone.", "里程碑"],
  ["project.plan.", "任务规划"],
  ["project.baseline.", "范围基线"],
  ["project.", "项目协作"],
  ["task.", "任务执行"],
  ["evidence.", "过程证据"],
  ["staff.", "助教授权"],
  ["teacher.", "教学督导"],
  ["auth.", "身份认证"],
];

export function describeAuditAction(action: string): { category: string; label: string } {
  const exact = AUDIT_ACTION_LABELS[action];
  if (exact) return exact;
  for (const [prefix, category] of AUDIT_PREFIX_CATEGORIES) {
    if (action.startsWith(prefix)) {
      return { category, label: `${category}：${action.slice(prefix.length).replace(/[._]/g, " ")}` };
    }
  }
  return { category: "业务操作", label: action };
}

const AUDIT_TARGET_TYPE_LABELS: Record<string, string> = {
  course: "课程",
  project: "项目",
  task: "任务",
  evidence: "正式证据",
  user: "用户账号",
  group: "课程小组",
  project_group: "项目小组",
  milestone: "里程碑",
  milestone_deliverable: "里程碑交付物",
  plan_version: "计划版本",
  baseline_version: "范围基线",
  functional_module: "功能模块",
  requirement: "项目需求",
  requirement_conflict: "需求冲突",
  task_suggestion: "AI 任务建议",
  access_request: "访问申请",
  access_grant: "临时只读授权",
  github_repo_link: "GitHub 仓库绑定",
  feishu_chat_link: "飞书群绑定",
  feishu_attachment: "飞书附件",
  course_announcement: "课程公告",
  course_appeal: "课程申诉",
  course_folder: "课程资料夹",
  course_material: "课程资料",
  course_member: "课程成员",
  course_join_request: "入课申请",
  course_staff: "课程助教",
  group_invitation: "小组邀请",
  leader_change_request: "换组长申请",
  membership_change: "成员变动申请",
  project_material: "项目资料",
  b_analysis_run: "需求分析任务",
  system: "系统",
};

export function describeAuditTargetType(targetType: string): string {
  return AUDIT_TARGET_TYPE_LABELS[targetType] ?? targetType;
}
