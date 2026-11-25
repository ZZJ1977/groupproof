"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Archive,
  ChevronDown,
  ChevronUp,
  Crown,
  ExternalLink,
  FolderGit2,
  MessageSquareText,
  RotateCcw,
  Save,
  UserMinus,
  UserPlus,
} from "lucide-react";
import { Avatar, Feedback, StatusBadge } from "@/components/common";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FeishuChatBinding } from "@/features/feishu-binding/FeishuChatBinding";
import { GithubRepoBinding } from "@/features/github-binding/GithubRepoBinding";
import { projectRequest } from "@/features/github-binding/integration-request";
import type { FeishuCollaborationInsights } from "@/features/c/FeishuCollaborationInsights";
import type { GithubActivityStats } from "@/features/c/GithubStatsChart";
import type { BMilestone } from "@/lib/api/b-milestones";
import type { BProjectOverview } from "@/lib/api/b-projects";
import type { BTaskRow, BTasksPage } from "@/lib/api/b-tasks";
import type { components } from "@/packages/domain/api.generated";
import { useUiText } from "@/lib/i18n/use-ui-text";
import { button, dangerButton, dateOnly, input, label } from "@/features/b/ui";

export type OverviewTab = "overview" | "milestones" | "integrations";
export type TaskQuickFilter = "all" | "pending_verification" | "in_progress";

export type ProjectSettingsDTO = {
  name: string;
  project_type: string | null;
  language: string | null;
  visibility: "members" | "course";
  lifecycle: string;
};

export type ProjectReopenDTO = {
  new_project_id: string;
  version_label: string;
  copy_scope: string;
  reason: string;
  created_at: string;
};

export type GithubRepoDTO = components["schemas"]["GithubRepoDTO"];
export type LinkedFeishuChatDTO = components["schemas"]["LinkedFeishuChatDTO"];

type Notice = { tone: "success" | "error" | "warning" | "info"; text: string } | undefined;

const TASK_STATUS_LABEL: Record<string, string> = {
  not_started: "未开始",
  in_progress: "进行中",
  pending_submission: "待提交",
  pending_verification: "待验收",
  completed: "已完成",
};

const MILESTONE_STATUS_LABEL: Record<string, string> = {
  not_started: "未开始",
  in_progress: "进行中",
  completed: "已交付",
  at_risk: "有风险",
};

const MODULE_BAR_COLORS = [
  "bg-sky-600",
  "bg-emerald-600",
  "bg-indigo-600",
  "bg-amber-600",
];

function taskUrgencyScore(row: BTaskRow): number {
  const statusScore: Record<string, number> = {
    pending_verification: 0,
    pending_submission: 1,
    in_progress: 2,
    not_started: 3,
    completed: 4,
  };
  const priorityScore: Record<string, number> = {
    high: 0,
    medium: 1,
    low: 2,
  };
  return (statusScore[row.status] ?? 3) * 10 + (priorityScore[row.priority] ?? 1);
}

function taskActionMeta(row: BTaskRow): { href: string; label: string } {
  if (row.status === "pending_verification") return { href: row.links.verification, label: "去验收" };
  if (row.status === "completed") return { href: row.links.verification, label: "查看验收" };
  if (row.status === "in_progress" || row.status === "pending_submission") {
    return { href: row.links.submit, label: "提交验收" };
  }
  return { href: row.links.detail, label: "查看详情" };
}

type ModuleProgressItem = {
  id: string;
  name: string;
  progress: number;
  completed: number;
  total: number;
};

function computeModuleProgress(tasksPage: BTasksPage | undefined): ModuleProgressItem[] {
  if (!tasksPage) return [];
  const items = tasksPage.items ?? [];
  const grouped = new Map<string, { name: string; tasks: BTaskRow[] }>();

  for (const mod of tasksPage.modules ?? []) {
    grouped.set(mod.id, { name: mod.name, tasks: [] });
  }
  for (const row of items) {
    const key = row.module?.id ?? "__unassigned";
    const entry = grouped.get(key) ?? { name: row.module?.name || "未分组模块", tasks: [] };
    entry.tasks.push(row);
    grouped.set(key, entry);
  }

  const result: ModuleProgressItem[] = [];
  for (const [id, entry] of grouped.entries()) {
    const allTasks = entry.tasks;
    if (allTasks.length === 0 && grouped.size > 4) continue;
    const roots = allTasks.filter((t) => !t.parent_task_id);
    const basis = roots.length > 0 ? roots : allTasks;
    const totalWeight = basis.reduce((acc, t) => acc + Math.max(0, t.weight || 0), 0);
    let progress = 0;
    if (totalWeight > 0) {
      progress = Math.round(basis.reduce((acc, t) => acc + Math.max(0, t.weight || 0) * t.progress_percent, 0) / totalWeight);
    } else if (basis.length > 0) {
      progress = Math.round(basis.reduce((acc, t) => acc + t.progress_percent, 0) / basis.length);
    }
    const completed = allTasks.filter((t) => t.status === "completed").length;
    result.push({ id, name: entry.name, progress, completed, total: allTasks.length });
  }
  return result;
}

export function OverviewLeftTabsCard({
  projectId,
  userId,
  project,
  activeTab,
  onTabChange,
  taskFilter,
  onTaskFilterChange,
  tasksPage,
  tasksLoading,
  milestones,
  milestonesLoading,
  repos,
  githubStats,
  chats,
  feishuInsights,
  writableSettings,
}: {
  projectId: string;
  userId: string;
  project: BProjectOverview;
  activeTab: OverviewTab;
  onTabChange: (tab: OverviewTab) => void;
  taskFilter: TaskQuickFilter;
  onTaskFilterChange: (next: TaskQuickFilter) => void;
  tasksPage: BTasksPage | undefined;
  tasksLoading: boolean;
  milestones: BMilestone[] | undefined;
  milestonesLoading: boolean;
  repos: GithubRepoDTO[] | undefined;
  githubStats: GithubActivityStats | undefined;
  chats: LinkedFeishuChatDTO[] | undefined;
  feishuInsights: FeishuCollaborationInsights | undefined;
  writableSettings: boolean;
}) {
  const tr = useUiText();

  const modules = useMemo(() => computeModuleProgress(tasksPage), [tasksPage]);
  const allTasks = useMemo(() => tasksPage?.items ?? [], [tasksPage]);
  const pendingVerificationCount = useMemo(
    () => allTasks.filter((t) => t.status === "pending_verification").length,
    [allTasks],
  );
  const inProgressCount = useMemo(
    () => allTasks.filter((t) => t.status === "in_progress" || t.status === "pending_submission").length,
    [allTasks],
  );
  const visibleTasks = useMemo(() => {
    const filtered = allTasks.filter((row) => {
      if (taskFilter === "pending_verification") return row.status === "pending_verification";
      if (taskFilter === "in_progress") return row.status === "in_progress" || row.status === "pending_submission";
      return true;
    });
    return [...filtered].sort((a, b) => taskUrgencyScore(a) - taskUrgencyScore(b)).slice(0, 5);
  }, [allTasks, taskFilter]);

  const milestoneList = milestones ?? [];
  const achievedMilestones = milestoneList.filter((m) => m.status === "completed").length;
  const overdueMilestones = milestoneList.filter((m) => m.overdue).length;

  const tabs: { id: OverviewTab; label: string }[] = [
    { id: "overview", label: tr("模块与任务") },
    {
      id: "milestones",
      label:
        project.stats.milestone_count > 0
          ? tr("里程碑 ({0})", { 0: project.stats.milestone_count })
          : tr("里程碑"),
    },
    { id: "integrations", label: tr("集成与同步") },
  ];

  const headerLink =
    activeTab === "overview"
      ? { href: `/projects/${projectId}/tasks?view=tree`, text: tr("打开任务工作区 →") }
      : activeTab === "milestones"
        ? { href: `/projects/${projectId}/milestones`, text: tr("打开里程碑 →") }
        : { href: `/projects/${projectId}/github`, text: tr("开发活动 →") };

  return (
    <section className="flex flex-col rounded-xl border border-slate-200/90 bg-white p-3.5 shadow-2xs space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
        <div
          role="tablist"
          aria-label={tr("项目总览视图")}
          className="inline-flex flex-wrap gap-0.5 rounded-lg bg-slate-100/90 p-0.5"
        >
          {tabs.map((tab) => {
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => onTabChange(tab.id)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  selected
                    ? "bg-white text-slate-900 shadow-2xs"
                    : "text-slate-500 hover:text-slate-800"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
        <Link href={headerLink.href} className="text-xs font-medium text-[var(--gp-action)] hover:underline">
          {headerLink.text}
        </Link>
      </div>

      {/* TAB 1: Modules & Priority Tasks */}
      {activeTab === "overview" && (
        <div className="space-y-3">
          {modules.length > 0 ? (
            <div className="space-y-1.5">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {modules.slice(0, 4).map((mod, idx) => (
                  <Link
                    key={mod.id}
                    href={`/projects/${projectId}/tasks?view=list&module=${encodeURIComponent(mod.id)}`}
                    className="group rounded-lg border border-slate-200/80 px-3 py-2 transition-colors hover:border-slate-300 hover:bg-slate-50/50 space-y-1.5"
                  >
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="truncate font-medium text-slate-800 group-hover:text-[var(--gp-action)]" title={mod.name}>
                        {mod.name}
                      </span>
                      <span className="shrink-0 font-semibold tabular-nums text-slate-700">
                        {mod.progress}%
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className={`h-full rounded-full transition-all ${MODULE_BAR_COLORS[idx % MODULE_BAR_COLORS.length]}`}
                        style={{ width: `${Math.min(100, Math.max(0, mod.progress))}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-slate-400">
                      <span>{tr("已完成 {0}/{1} 项", { 0: mod.completed, 1: mod.total })}</span>
                    </div>
                  </Link>
                ))}
              </div>
              {modules.length > 4 && (
                <div className="text-right">
                  <Link
                    href={`/projects/${projectId}/tasks?view=tree`}
                    className="text-[11px] font-medium text-[var(--gp-action)] hover:underline"
                  >
                    {tr("查看全部 {0} 个模块 →", { 0: modules.length })}
                  </Link>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-slate-200 bg-slate-50/60 px-3 py-2.5 text-xs text-slate-500">
              <span>{tasksLoading ? tr("正在读取模块进度…") : tr("尚未拆解任务模块，可前往任务规划建立任务树。")}</span>
              {project.entry !== "readonly" && (
                <Link href={`/projects/${projectId}/tasks?view=plan`} className="font-medium text-[var(--gp-action)] hover:underline">
                  {tr("前往任务规划 →")}
                </Link>
              )}
            </div>
          )}

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-slate-800">{tr("重点任务（Top 5）")}</span>
              <div className="flex flex-wrap items-center gap-1">
                {(
                  [
                    { key: "all", label: tr("全部"), count: allTasks.length },
                    { key: "pending_verification", label: tr("待验收"), count: pendingVerificationCount },
                    { key: "in_progress", label: tr("进行中"), count: inProgressCount },
                  ] as const
                ).map((item) => {
                  const active = taskFilter === item.key;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      aria-pressed={active}
                      onClick={() => onTaskFilterChange(item.key)}
                      className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${
                        active
                          ? "border-[var(--gp-action)] bg-[var(--gp-action)] text-white"
                          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      {item.label} ({item.count})
                    </button>
                  );
                })}
              </div>
            </div>

            {visibleTasks.length > 0 ? (
              <div className="divide-y divide-slate-100 rounded-lg border border-slate-200/80">
                {visibleTasks.map((row) => {
                  const action = taskActionMeta(row);
                  const dotColor =
                    row.status === "pending_verification"
                      ? "bg-amber-500"
                      : row.status === "completed"
                        ? "bg-emerald-500"
                        : row.status === "in_progress" || row.status === "pending_submission"
                          ? "bg-sky-500"
                          : "bg-slate-300";
                  const ownerNames = row.assignees.map((a) => a.name).filter(Boolean).join("、");
                  return (
                    <div key={row.id} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className={`h-2 w-2 shrink-0 rounded-full ${dotColor}`} aria-hidden="true" />
                        <Link
                          href={row.links.detail}
                          className="truncate font-medium text-slate-800 hover:text-[var(--gp-action)] hover:underline"
                          title={row.code ? `${row.code} ${row.title}` : row.title}
                        >
                          {row.code ? `${row.code} ` : ""}{row.title}
                        </Link>
                      </div>
                      <div className="flex shrink-0 items-center gap-2.5">
                        <span className="hidden text-slate-500 sm:inline">
                          {ownerNames ? `${ownerNames} · ` : ""}
                          {tr(TASK_STATUS_LABEL[row.status] ?? row.status)}
                        </span>
                        <Link
                          href={action.href}
                          className="rounded-md border border-slate-200 px-2 py-0.5 font-medium text-[var(--gp-action)] transition-colors hover:bg-slate-50"
                        >
                          {tr(action.label)}
                        </Link>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-lg border border-slate-200/80 bg-slate-50/50 px-3 py-4 text-center text-xs text-slate-500">
                {tasksLoading
                  ? tr("正在加载任务列表…")
                  : allTasks.length === 0
                    ? tr("当前还没有任务记录。")
                    : tr("当前筛选条件下暂无任务。")}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: Milestones */}
      {activeTab === "milestones" && (
        <div className="space-y-3">
          {milestoneList.length > 0 ? (
            <>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {milestoneList.slice(0, 6).map((m) => (
                  <Link
                    key={m.id}
                    href={m.href || `/projects/${projectId}/milestones`}
                    className="rounded-lg border border-slate-200/80 px-3 py-2.5 transition-colors hover:border-slate-300 hover:bg-slate-50/50 space-y-1.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-semibold text-slate-800" title={m.title}>
                        {m.title}
                      </span>
                      {m.overdue ? (
                        <StatusBadge tone="red" label={tr("已逾期")} />
                      ) : (
                        <StatusBadge
                          tone={m.status === "completed" ? "green" : m.status === "in_progress" ? "blue" : "gray"}
                          label={tr(MILESTONE_STATUS_LABEL[m.status] ?? m.status)}
                        />
                      )}
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-slate-500">
                      <span>{tr("目标日期：{0}", { 0: dateOnly(m.deadline, tr("未设置")) })}</span>
                      <span>{tr("已完成 {0}/{1}", { 0: m.completed_task_count, 1: m.task_count })}</span>
                    </div>
                    {typeof m.progress_percent === "number" && (
                      <div className="h-1 overflow-hidden rounded-full bg-slate-100">
                        <div
                          className={`h-full rounded-full ${m.overdue ? "bg-rose-500" : m.status === "completed" ? "bg-emerald-500" : "bg-[var(--gp-action)]"}`}
                          style={{ width: `${Math.min(100, Math.max(0, m.progress_percent))}%` }}
                        />
                      </div>
                    )}
                  </Link>
                ))}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                <span>
                  {tr("共 {0} 个里程碑 · 已交付 {1} · 逾期 {2}", {
                    0: milestoneList.length,
                    1: achievedMilestones,
                    2: overdueMilestones,
                  })}
                </span>
                <Link href={`/projects/${projectId}/milestones`} className="font-medium text-[var(--gp-action)] hover:underline">
                  {tr("查看全部里程碑 →")}
                </Link>
              </div>
            </>
          ) : (
            <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/50 px-4 py-6 text-center text-xs text-slate-500 space-y-2">
              <p>{milestonesLoading ? tr("正在读取里程碑…") : tr("暂无里程碑记录。")}</p>
              <Link href={`/projects/${projectId}/milestones`} className="inline-block font-medium text-[var(--gp-action)] hover:underline">
                {tr("前往里程碑页面 →")}
              </Link>
            </div>
          )}
        </div>
      )}

      {/* TAB 3: Integrations & Sync */}
      {activeTab === "integrations" && (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="rounded-lg border border-slate-200/80 bg-slate-50/60 px-3 py-2 text-xs space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 font-semibold text-slate-800">
                  <FolderGit2 size={13} className="text-slate-500" aria-hidden="true" />
                  {tr("GitHub 同步概览")}
                </span>
                <Link href={`/projects/${projectId}/github`} className="font-medium text-[var(--gp-action)] hover:underline">
                  {tr("查看活动 →")}
                </Link>
              </div>
              <p className="text-slate-600">
                {repos && repos.length > 0
                  ? tr("已绑定 {0} 个仓库 · {1} 次提交 · {2} 个 PR", {
                      0: repos.length,
                      1: githubStats?.all_time_commits ?? githubStats?.total_commits ?? 0,
                      2: githubStats?.total_pull_requests ?? 0,
                    })
                  : tr("尚未绑定 GitHub 仓库，可在下方完成绑定。")}
              </p>
            </div>

            <div className="rounded-lg border border-slate-200/80 bg-slate-50/60 px-3 py-2 text-xs space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 font-semibold text-slate-800">
                  <MessageSquareText size={13} className="text-slate-500" aria-hidden="true" />
                  {tr("飞书协作概览")}
                </span>
                <Link href={`/projects/${projectId}/collaboration`} className="font-medium text-[var(--gp-action)] hover:underline">
                  {tr("协作记录 →")}
                </Link>
              </div>
              <p className="text-slate-600">
                {chats && chats.length > 0
                  ? tr("已接入 {0} 个群聊 · {1} 条协作结论", {
                      0: chats.length,
                      1: feishuInsights?.items.length ?? 0,
                    })
                  : tr("尚未接入飞书群聊，可在下方完成接入。")}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="min-w-0">
              <GithubRepoBinding projectId={projectId} userId={userId} canManage={writableSettings} />
            </div>
            <div className="min-w-0">
              <FeishuChatBinding projectId={projectId} userId={userId} canManage={writableSettings} />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export function ProjectSettingsModal({
  open,
  onOpenChange,
  projectId,
  userId,
  project,
  settings,
  reopens,
  writable,
  isLeader,
  isMember,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  userId: string;
  project: BProjectOverview;
  settings: ProjectSettingsDTO | undefined;
  reopens: ProjectReopenDTO[] | undefined;
  writable: boolean;
  isLeader: boolean;
  isMember: boolean;
  onSaved: () => Promise<void>;
}) {
  const tr = useUiText();
  const [modalTab, setModalTab] = useState<"basic" | "integrations">("basic");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(94vw,48rem)] max-w-3xl max-h-[85vh] overflow-y-auto p-5">
        <DialogHeader className="mb-3">
          <DialogTitle>{tr("项目设置")}</DialogTitle>
          <DialogDescription>
            {tr("管理项目基础信息、归档与版本重开，以及 GitHub 和飞书集成。")}
          </DialogDescription>
        </DialogHeader>

        <div
          role="tablist"
          aria-label={tr("项目设置视图")}
          className="mb-4 inline-flex gap-1 rounded-lg bg-slate-100 p-0.5"
        >
          <button
            type="button"
            role="tab"
            aria-selected={modalTab === "basic"}
            onClick={() => setModalTab("basic")}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              modalTab === "basic" ? "bg-white text-slate-900 shadow-2xs" : "text-slate-500 hover:text-slate-800"
            }`}
          >
            {tr("基本设置与归档")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={modalTab === "integrations"}
            onClick={() => setModalTab("integrations")}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              modalTab === "integrations" ? "bg-white text-slate-900 shadow-2xs" : "text-slate-500 hover:text-slate-800"
            }`}
          >
            {tr("GitHub 与飞书集成")}
          </button>
        </div>

        {modalTab === "basic" ? (
          <OverviewSettingsTab
            projectId={projectId}
            project={project}
            settings={settings}
            reopens={reopens}
            writable={writable}
            isLeader={isLeader}
            isMember={isMember}
            onSaved={onSaved}
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="min-w-0">
              <GithubRepoBinding projectId={projectId} userId={userId} canManage={writable} />
            </div>
            <div className="min-w-0">
              <FeishuChatBinding projectId={projectId} userId={userId} canManage={writable} />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function OverviewSettingsTab({
  projectId,
  project,
  settings,
  reopens,
  writable,
  isLeader,
  isMember,
  onSaved,
}: {
  projectId: string;
  project: BProjectOverview;
  settings: ProjectSettingsDTO | undefined;
  reopens: ProjectReopenDTO[] | undefined;
  writable: boolean;
  isLeader: boolean;
  isMember: boolean;
  onSaved: () => Promise<void>;
}) {
  const tr = useUiText();
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}`;
  const [form, setForm] = useState({
    name: settings?.name ?? project.name,
    project_type: settings?.project_type ?? "",
    language: settings?.language ?? "",
    visibility: (settings?.visibility ?? "members") as "members" | "course",
  });
  const [version, setVersion] = useState("");
  const [reason, setReason] = useState("");
  const [scope, setScope] = useState<"full" | "baseline">("full");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>();

  useEffect(() => {
    if (!settings) return;
    setForm({
      name: settings.name,
      project_type: settings.project_type ?? "",
      language: settings.language ?? "",
      visibility: settings.visibility,
    });
  }, [settings]);

  async function submitAction(path: string, method: "POST" | "PUT", body?: unknown, successText = "已保存") {
    setBusy(true);
    setNotice(undefined);
    try {
      await projectRequest(path, { method, body });
      await onSaved();
      setNotice({ tone: "success", text: tr(successText) });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : tr("操作失败，请稍后重试。") });
    } finally {
      setBusy(false);
    }
  }

  const lifecycle = settings?.lifecycle ?? project.lifecycle;

  if (!isMember) {
    return <Feedback tone="warning">{tr("项目设置和绑定仅对本项目成员开放。")}</Feedback>;
  }

  return (
    <div className="space-y-3">
      {notice && <Feedback tone={notice.tone}>{notice.text}</Feedback>}
      {!settings && (
        <Feedback tone="info">{tr("正在读取项目设置，或当前接口暂不可用。")}</Feedback>
      )}

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="overview-set-name">{tr("项目名称")}</label>
          <input
            id="overview-set-name"
            className={input}
            value={form.name}
            readOnly={!writable}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </div>
        <div>
          <label className={label} htmlFor="overview-set-vis">{tr("可见范围")}</label>
          <select
            id="overview-set-vis"
            className={input}
            value={form.visibility}
            disabled={!writable}
            onChange={(e) => setForm({ ...form, visibility: e.target.value as "members" | "course" })}
          >
            <option value="members">{tr("仅项目成员")}</option>
            <option value="course">{tr("课程成员")}</option>
          </select>
        </div>
        <div>
          <label className={label} htmlFor="overview-set-type">{tr("项目类型")}</label>
          <input
            id="overview-set-type"
            className={input}
            placeholder={tr("例如：Web 应用、移动应用")}
            value={form.project_type}
            readOnly={!writable}
            onChange={(e) => setForm({ ...form, project_type: e.target.value })}
          />
        </div>
        <div>
          <label className={label} htmlFor="overview-set-lang">{tr("项目语言")}</label>
          <input
            id="overview-set-lang"
            className={input}
            maxLength={16}
            placeholder={tr("例如：中文、English")}
            value={form.language}
            readOnly={!writable}
            onChange={(e) => setForm({ ...form, language: e.target.value })}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="text-slate-500">
          {writable ? tr("组长可调整项目信息与课程内可见范围。") : tr("当前为只读视图。")}
        </span>
        <div className="flex items-center gap-2">
          <Link href={`/projects/${projectId}/setup`} className="inline-flex items-center gap-1 font-medium text-[var(--gp-action)] hover:underline">
            {tr("项目资料与日程")}
            <ExternalLink size={12} aria-hidden="true" />
          </Link>
          {isLeader && (
            <button
              type="button"
              className={button}
              disabled={!writable || busy || lifecycle !== "active" || !form.name.trim() || !settings}
              onClick={() => void submitAction(`${base}/settings`, "PUT", form, "已保存")}
            >
              <Save size={14} aria-hidden="true" />
              {tr("保存设置")}
            </button>
          )}
        </div>
      </div>

      {isLeader && (
        <div className="rounded-lg border border-slate-200/80 bg-slate-50/70 px-3 py-2.5 space-y-2.5 text-xs">
          {lifecycle === "active" ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-slate-600">
                {tr("归档前需确认所有任务已验收、贡献快照已冻结且结项报告已定稿；归档后项目转为只读快照。")}
              </span>
              <button
                type="button"
                className={dangerButton}
                disabled={!writable || busy || !settings}
                onClick={() => {
                  if (window.confirm(tr("确认归档？报告、任务和贡献必须已定稿。"))) {
                    void submitAction(`${base}/archive`, "POST", undefined, "项目已归档");
                  }
                }}
              >
                <Archive size={14} aria-hidden="true" />
                {tr("归档项目")}
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="font-semibold text-slate-800">{tr("重新开启新版本")}</div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <input
                  className={input}
                  aria-label={tr("新版本号")}
                  placeholder={tr("例如 v2.0")}
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                />
                <select
                  className={input}
                  aria-label={tr("复制范围")}
                  value={scope}
                  onChange={(e) => setScope(e.target.value as "full" | "baseline")}
                >
                  <option value="full">{tr("复制项目结构")}</option>
                  <option value="baseline">{tr("仅复制基线")}</option>
                </select>
                <input
                  className={input}
                  aria-label={tr("重新开启原因")}
                  placeholder={tr("说明迭代目标或变更原因")}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  className={button}
                  disabled={busy || lifecycle !== "archived" || !version.trim() || !reason.trim()}
                  onClick={() => {
                    void submitAction(
                      `${base}/reopen`,
                      "POST",
                      { version_label: version.trim(), reason: reason.trim(), copy_scope: scope },
                      "已创建新项目版本",
                    );
                  }}
                >
                  <RotateCcw size={14} aria-hidden="true" />
                  {tr("创建新项目版本")}
                </button>
              </div>
            </div>
          )}

          {reopens && reopens.length > 0 && (
            <div className="border-t border-slate-200/70 pt-2 space-y-1">
              <div className="font-medium text-slate-500">{tr("重新开启历史")}</div>
              {reopens.map((row) => (
                <div key={row.new_project_id} className="flex items-center justify-between gap-2">
                  <span className="truncate text-slate-700">
                    <strong>{row.version_label}</strong> · {row.reason}
                  </span>
                  <Link href={`/projects/${row.new_project_id}`} className="shrink-0 font-medium text-[var(--gp-action)] hover:underline">
                    {tr("查看新项目 →")}
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function OverviewRightSidebar({
  projectId,
  project,
  currentUserId,
  tasksPage,
  milestones,
  githubStats,
  onSelectTab,
  onFilterVerification,
}: {
  projectId: string;
  project: BProjectOverview;
  currentUserId: string;
  tasksPage: BTasksPage | undefined;
  milestones: BMilestone[] | undefined;
  githubStats: GithubActivityStats | undefined;
  onSelectTab: (tab: OverviewTab) => void;
  onFilterVerification: () => void;
}) {
  const tr = useUiText();
  const cache = useQueryClient();
  const [alertOpen, setAlertOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [identifier, setIdentifier] = useState("");
  const [memberNotice, setMemberNotice] = useState<Notice>();

  const isPersonal = !project.course_id && !project.group_id;
  const canManage = isPersonal && project.is_leader && project.lifecycle === "active";

  const pendingTasks = useMemo(
    () => (tasksPage?.items ?? []).filter((row) => row.status === "pending_verification"),
    [tasksPage],
  );
  const overdueMilestones = useMemo(
    () => (milestones ?? []).filter((m) => m.overdue && m.status !== "completed"),
    [milestones],
  );
  const riskMilestones = useMemo(
    () => (milestones ?? []).filter((m) => (m.risk?.open_count ?? 0) > 0),
    [milestones],
  );
  const alertTotal = pendingTasks.length + overdueMilestones.length + riskMilestones.length;

  const taskStatsByMember = useMemo(() => {
    const map = new Map<string, { completed: number; total: number }>();
    for (const row of tasksPage?.items ?? []) {
      for (const assignee of row.assignees) {
        const cur = map.get(assignee.id) ?? { completed: 0, total: 0 };
        cur.total += 1;
        if (row.status === "completed") cur.completed += 1;
        map.set(assignee.id, cur);
      }
    }
    return map;
  }, [tasksPage]);

  const commitsByMember = useMemo(() => {
    const byId = new Map<string, number>();
    const byName = new Map<string, number>();
    for (const contributor of githubStats?.contributors ?? []) {
      if (contributor.author_user_id) {
        byId.set(contributor.author_user_id, (byId.get(contributor.author_user_id) ?? 0) + contributor.commits);
      }
      if (contributor.author_name) {
        const key = contributor.author_name.trim().toLowerCase();
        byName.set(key, (byName.get(key) ?? 0) + contributor.commits);
      }
    }
    return { byId, byName };
  }, [githubStats]);

  const refreshMembers = () =>
    Promise.all([
      cache.invalidateQueries({ queryKey: ["b-project-overview"] }),
      cache.invalidateQueries({ queryKey: ["b-plan"] }),
      cache.invalidateQueries({ queryKey: ["c-project-context"] }),
    ]);

  const addMember = useMutation({
    mutationFn: () =>
      projectRequest<{ user_id: string; name: string | null }>(
        `/api/v1/a/projects/${encodeURIComponent(projectId)}/members`,
        { method: "POST", body: { identifier: identifier.trim() } },
      ),
    onSuccess: async (added) => {
      setIdentifier("");
      setInviteOpen(false);
      setMemberNotice({
        tone: "success",
        text: tr("已将 {0} 加入项目，现在可以在任务计划中分配任务。", { 0: added.name ?? tr("成员") }),
      });
      await refreshMembers();
    },
    onError: (err) => {
      setMemberNotice({
        tone: "error",
        text: err instanceof Error ? err.message : tr("添加队友失败，请核对学号、用户名或邮箱。"),
      });
    },
  });

  const removeMember = useMutation({
    mutationFn: (memberId: string) =>
      projectRequest(`/api/v1/a/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(memberId)}`, {
        method: "DELETE",
      }),
    onSuccess: async () => {
      setMemberNotice({ tone: "info", text: tr("已移除该成员。") });
      await refreshMembers();
    },
    onError: (err) => {
      setMemberNotice({ tone: "error", text: err instanceof Error ? err.message : tr("移除成员失败。") });
    },
  });

  const transferLeader = useMutation({
    mutationFn: (newLeaderId: string) =>
      projectRequest(`/api/v1/a/projects/${encodeURIComponent(projectId)}/leader`, {
        method: "POST",
        body: { new_leader_id: newLeaderId },
      }),
    onSuccess: async () => {
      setMemberNotice({ tone: "success", text: tr("组长身份已转让。") });
      await refreshMembers();
    },
    onError: (err) => {
      setMemberNotice({ tone: "error", text: err instanceof Error ? err.message : tr("转让组长失败。") });
    },
  });

  const quickJumps = [
    { href: `/projects/${projectId}/requirements`, label: tr("需求基线") },
    { href: `/projects/${projectId}/evidence`, label: tr("证据中心") },
    { href: `/projects/${projectId}/contribution`, label: tr("贡献总览") },
    { href: `/projects/${projectId}/contribution?tab=report`, label: tr("项目报告") },
  ];

  return (
    <aside className="flex flex-col gap-2.5">
      {/* Compact 1-Line Alerts / Risks Strip */}
      <div
        className={`rounded-xl border px-3 py-2 text-xs shadow-2xs ${
          alertTotal > 0
            ? "border-amber-200/90 bg-amber-50/60"
            : "border-slate-200/90 bg-white"
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <AlertTriangle
              size={14}
              className={`shrink-0 ${alertTotal > 0 ? "text-amber-600" : "text-slate-400"}`}
              aria-hidden="true"
            />
            <span className="truncate font-medium text-slate-800">
              {alertTotal > 0
                ? tr("待关注提醒：{0} 项待验收 · {1} 个逾期里程碑", {
                    0: pendingTasks.length,
                    1: overdueMilestones.length,
                  })
                : tr("当前暂无待验收或逾期里程碑提醒")}
            </span>
          </div>
          {alertTotal > 0 && (
            <button
              type="button"
              aria-expanded={alertOpen}
              onClick={() => setAlertOpen((prev) => !prev)}
              className="inline-flex shrink-0 items-center gap-0.5 font-medium text-[var(--gp-action)] hover:underline"
            >
              {alertOpen ? tr("收起") : tr("详情")}
              {alertOpen ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
            </button>
          )}
        </div>

        {alertOpen && alertTotal > 0 && (
          <div className="mt-2 space-y-1.5 border-t border-amber-200/60 pt-2 text-slate-600">
            {overdueMilestones.length > 0 && (
              <div className="flex items-center justify-between gap-2">
                <span className="truncate">
                  {tr("{0} 个里程碑已超期未交付", { 0: overdueMilestones.length })}
                </span>
                <button
                  type="button"
                  onClick={() => onSelectTab("milestones")}
                  className="shrink-0 font-medium text-[var(--gp-action)] hover:underline"
                >
                  {tr("去处理")}
                </button>
              </div>
            )}
            {pendingTasks.length > 0 && (
              <div className="flex items-center justify-between gap-2">
                <span className="truncate">
                  {tr("{0} 项任务已提交，等待人工验收确认", { 0: pendingTasks.length })}
                </span>
                <button
                  type="button"
                  onClick={onFilterVerification}
                  className="shrink-0 font-medium text-[var(--gp-action)] hover:underline"
                >
                  {tr("去验收")}
                </button>
              </div>
            )}
            {riskMilestones.length > 0 && (
              <div className="flex items-center justify-between gap-2">
                <span className="truncate">
                  {tr("{0} 个里程碑存在未关闭风险", { 0: riskMilestones.length })}
                </span>
                <Link href={`/projects/${projectId}/milestones`} className="shrink-0 font-medium text-[var(--gp-action)] hover:underline">
                  {tr("查看风险")}
                </Link>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Compact Project Members Card */}
      <section
        id="project-members"
        className="scroll-mt-20 rounded-xl border border-slate-200/90 bg-white p-3.5 shadow-2xs space-y-2.5"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <h2 className="text-xs font-semibold text-slate-900">
              {tr("项目成员")} ({project.members.length})
            </h2>
            {isPersonal && (
              <span className="text-[11px] text-slate-400">{tr("· 独立项目")}</span>
            )}
          </div>
          {canManage && (
            <button
              type="button"
              aria-expanded={inviteOpen}
              onClick={() => setInviteOpen((prev) => !prev)}
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-0.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
            >
              <UserPlus size={12} aria-hidden="true" />
              {tr("+ 邀请")}
            </button>
          )}
        </div>

        {memberNotice && <Feedback tone={memberNotice.tone}>{memberNotice.text}</Feedback>}

        {canManage && inviteOpen && (
          <form
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 p-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (identifier.trim() && !addMember.isPending) addMember.mutate();
            }}
          >
            <input
              id="personal-member-identifier"
              aria-label={tr("邀请队友加入")}
              className="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-900 placeholder:text-slate-400 outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
              placeholder={tr("输入学号、用户名或邮箱")}
              value={identifier}
              maxLength={320}
              disabled={addMember.isPending}
              onChange={(event) => setIdentifier(event.target.value)}
            />
            <button
              type="submit"
              className="shrink-0 rounded-md bg-[var(--gp-action)] px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-[var(--gp-action-hover)] disabled:opacity-50"
              disabled={!identifier.trim() || addMember.isPending}
            >
              {addMember.isPending ? tr("添加中…") : tr("添加")}
            </button>
          </form>
        )}

        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200/80 text-xs">
          {project.members.map((member) => {
            const isSelf = member.id === currentUserId;
            const memberRole = "role" in member ? (member as { role?: string | null }).role : undefined;
            const isMemberLeader = memberRole === "leader" || (project.is_leader && isSelf);
            const taskStat = taskStatsByMember.get(member.id);
            const commits =
              commitsByMember.byId.get(member.id) ??
              (member.name ? commitsByMember.byName.get(member.name.trim().toLowerCase()) : undefined);

            return (
              <li key={member.id} className="space-y-1 px-2.5 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Avatar name={member.name || "成"} size={24} />
                    <span className="truncate font-medium text-slate-800">{member.name ?? tr("未命名")}</span>
                    {isMemberLeader && (
                      <span className="gp-pill shrink-0 text-[11px]">{tr("组长")}</span>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-[11px] tabular-nums text-slate-500">
                    {taskStat && (
                      <span>{tr("{0}/{1} 任务", { 0: taskStat.completed, 1: taskStat.total })}</span>
                    )}
                    {typeof commits === "number" && (
                      <span className="font-medium text-slate-700">{tr("{0} 提交", { 0: commits })}</span>
                    )}
                  </div>
                </div>
                {canManage && !isSelf && (
                  <div className="flex items-center justify-end gap-1.5 pt-0.5">
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800"
                      disabled={transferLeader.isPending || removeMember.isPending}
                      title={tr("转让组长")}
                      onClick={() => {
                        if (
                          window.confirm(
                            tr("确定将「{0}」设为项目组长吗？转让后你将变为普通成员。", {
                              0: member.name ?? tr("该成员"),
                            }),
                          )
                        ) {
                          transferLeader.mutate(member.id);
                        }
                      }}
                    >
                      <Crown size={11} aria-hidden="true" />
                      {tr("设为组长")}
                    </button>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-rose-600 transition-colors hover:bg-rose-50"
                      disabled={removeMember.isPending || transferLeader.isPending}
                      title={tr("移除成员")}
                      onClick={() => {
                        if (
                          window.confirm(
                            tr("确定将「{0}」移出本项目吗？", { 0: member.name ?? tr("该成员") }),
                          )
                        ) {
                          removeMember.mutate(member.id);
                        }
                      }}
                    >
                      <UserMinus size={11} aria-hidden="true" />
                      {tr("移除")}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {/* Compact 4-Pill Quick-Jump Card */}
      <section className="rounded-xl border border-slate-200/90 bg-white p-3 shadow-2xs space-y-2">
        <div className="text-xs font-semibold text-slate-600">{tr("快捷直达")}</div>
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 xl:grid-cols-2">
          {quickJumps.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-lg border border-slate-200/80 bg-slate-50/70 px-2.5 py-1.5 text-center text-xs font-medium text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-100/80 hover:text-[var(--gp-action)]"
            >
              {item.label}
            </Link>
          ))}
        </div>
      </section>
    </aside>
  );
}
