"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  BookOpenCheck,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  FileText,
  FolderGit2,
  ListTodo,
  MessageSquareText,
  Settings,
  Users,
} from "lucide-react";
import { StatusBadge } from "@/shared/components/common";
import { projectRequest } from "@/shared/lib/integration-request";
import { bPlanningApi } from "@/student/api/b-planning";
import { bProjectsApi, type BProjectOverview, type BProjectSetup } from "@/student/api/b-projects";
import { bRequirementsApi } from "@/student/api/b-requirements";
import { buildSetupCards, type SetupCard, type SetupCardId } from "@/student/ux/student-workspace";
import { useWorkspace } from "@/shared/lib/workspace";
import { queryPolicy, secondary } from "@/shared/lib/b-ui";
import { useUiText } from "@/shared/i18n/use-ui-text";

const icons: Record<SetupCardId, typeof Settings> = {
  details: Settings,
  members: Users,
  github: FolderGit2,
  feishu: MessageSquareText,
  materials: FileText,
  requirements: BookOpenCheck,
  conflicts: CircleAlert,
  baseline: Check,
  plan: ListTodo,
};

const statusText: Record<SetupCard["status"], string> = {
  not_started: "按需设置",
  in_progress: "进行中",
  complete: "已完成",
  required: "需要完成",
  unavailable: "暂不可用",
  attention: "需要处理",
};

const statusTone: Record<SetupCard["status"], "gray" | "blue" | "green" | "amber" | "red"> = {
  not_started: "gray",
  in_progress: "blue",
  complete: "green",
  required: "amber",
  unavailable: "gray",
  attention: "red",
};

function actionLabel(card: SetupCard, count: number) {
  if (card.id === "github") return count > 0 ? "管理 GitHub 仓库" : "绑定 GitHub 仓库";
  if (card.id === "feishu") return count > 0 ? "管理飞书群" : "接入飞书群";
  return card.actionLabel;
}

export function ProjectSetupCenter({
  projectId,
  overview,
  initialSetup,
  compact = false,
}: {
  projectId: string;
  overview: BProjectOverview;
  initialSetup?: BProjectSetup;
  compact?: boolean;
}) {
  const tr = useUiText();
  const { userId } = useWorkspace();
  const [expanded, setExpanded] = useState(false);

  const setup = useQuery({
    queryKey: ["b-project-setup", userId, projectId],
    queryFn: () => bProjectsApi.setup(projectId),
    initialData: initialSetup,
    enabled: !initialSetup,
    ...queryPolicy,
  });
  const board = useQuery({
    queryKey: ["b-requirements-board", userId, projectId],
    queryFn: () => bRequirementsApi.board(projectId),
    ...queryPolicy,
  });
  const plan = useQuery({
    queryKey: ["b-plan", userId, projectId],
    queryFn: () => bPlanningApi.plan(projectId),
    ...queryPolicy,
  });
  const repos = useQuery({
    queryKey: ["project-integration-repos", userId, projectId],
    queryFn: ({ signal }) => projectRequest<unknown[]>(`/api/v1/a/projects/${projectId}/github/repos`, { signal }),
    ...queryPolicy,
  });
  const chats = useQuery({
    queryKey: ["project-integration-chats", userId, projectId],
    queryFn: ({ signal }) => projectRequest<unknown[]>(`/api/v1/a/projects/${projectId}/feishu/chats`, { signal }),
    ...queryPolicy,
  });

  const setupData = initialSetup ?? setup.data;
  const repoCount = repos.data?.length ?? 0;
  const chatCount = chats.data?.length ?? 0;
  const cards = buildSetupCards({
    projectId,
    kind: overview.course_id ? "course" : "independent",
    detailsComplete: Boolean(overview.name && (overview.description || setupData?.project_type)),
    memberCount: overview.stats.member_count,
    githubBindings: repoCount,
    feishuBindings: chatCount,
    materialCount: setupData?.materials.length ?? 0,
    requirementCount: board.data?.requirements.filter((row) => !row.excluded).length ?? 0,
    moduleCount: board.data?.modules.length ?? 0,
    unresolvedConflictCount: board.data?.open_conflicts ?? 0,
    baselineStarted: overview.setup_status === "pending_confirmation" || overview.setup_status === "frozen",
    baselineFrozen: overview.setup_status === "frozen",
    hasPlan: Boolean(plan.data?.tasks.length),
    githubAvailable: !repos.isError,
    feishuAvailable: !chats.isError,
  });

  const descriptionFor = (card: SetupCard) => {
    if (card.id === "github" && repos.isPending) return tr("正在读取 GitHub 仓库绑定状态…");
    if (card.id === "github" && repos.isError) return tr("暂时无法读取仓库绑定状态，可进入设置重试。");
    if (card.id === "feishu" && chats.isPending) return tr("正在读取飞书群绑定状态…");
    if (card.id === "feishu" && chats.isError) return tr("暂时无法读取群聊绑定状态，可进入设置重试。");
    if (card.id === "materials" && !setupData) return tr("进入资料区查看或补充项目资料。");
    if ((card.id === "requirements" || card.id === "conflicts") && board.isError) return tr("进入需求工作区查看当前需求状态。");
    if (card.id === "plan" && plan.isError) return tr("进入任务规划查看当前计划。");
    return card.description;
  };

  const countFor = (card: SetupCard) =>
    card.id === "github" ? repoCount : card.id === "feishu" ? chatCount : 0;

  if (compact) {
    const completedCount = cards.filter((card) => card.status === "complete").length;
    const totalCount = cards.length;
    const allReady = totalCount > 0 && completedCount === totalCount;
    const pendingCards = cards.filter((card) => card.status !== "complete");
    const readinessLabel = overview.course_id && overview.setup_status !== "frozen" ? tr("课程要求待完善") : tr("可开始协作");

    return (
      <section
        className={`rounded-xl border px-3.5 py-2 shadow-2xs transition-colors ${
          allReady ? "border-emerald-200/80 bg-emerald-50/45" : "border-slate-200/90 bg-white"
        }`}
        aria-labelledby="project-setup-center-title"
      >
        <div className="flex min-h-[28px] flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {allReady ? (
              <CheckCircle2 size={15} className="shrink-0 text-emerald-600" aria-hidden="true" />
            ) : (
              <Settings size={14} className="shrink-0 text-slate-500" aria-hidden="true" />
            )}
            <h2 id="project-setup-center-title" className="text-xs font-semibold text-slate-900">
              {tr("项目设置中心")}
            </h2>
            <span className="text-slate-300" aria-hidden="true">·</span>
            {allReady ? (
              <>
                <span className="font-semibold text-emerald-700">
                  {tr("{0}/{1} 已就绪", { 0: completedCount, 1: totalCount })}
                </span>
                <span className="text-slate-300" aria-hidden="true">·</span>
                <span className="text-slate-600">{tr("可开始协作")}</span>
              </>
            ) : (
              <>
                <span className="font-semibold text-amber-700">
                  {tr("{0}/{1} 已就绪", { 0: completedCount, 1: totalCount })}
                </span>
                <span className="hidden text-slate-500 sm:inline">· {readinessLabel}</span>
              </>
            )}
          </div>
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((prev) => !prev)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-[var(--gp-action)] transition-colors hover:bg-slate-100/80"
          >
            {expanded ? tr("收起设置清单") : tr("展开设置清单")}
            {expanded ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
          </button>
        </div>

        {!allReady && !expanded && pendingCards.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-2">
            {pendingCards.map((card) => {
              const Icon = icons[card.id];
              const isIntegration = card.id === "github" || card.id === "feishu";
              const urgent = card.status === "required" || card.status === "attention";
              return (
                <span
                  key={card.id}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs ${
                    urgent
                      ? "border-amber-200/90 bg-amber-50/70 text-slate-700"
                      : "border-slate-200/90 bg-slate-50/80 text-slate-700"
                  }`}
                >
                  <Icon size={12} className="shrink-0 text-slate-500" aria-hidden="true" />
                  {!isIntegration && <span className="text-slate-500">{card.title}</span>}
                  <Link
                    href={card.href}
                    className="font-medium text-[var(--gp-action)] hover:underline"
                  >
                    {tr(actionLabel(card, countFor(card)))}
                  </Link>
                </span>
              );
            })}
          </div>
        )}

        {expanded && (
          <div className="mt-2.5 grid grid-cols-2 gap-2 border-t border-slate-200/70 pt-2.5 sm:grid-cols-4">
            {cards.map((card) => {
              const Icon = icons[card.id];
              return (
                <div
                  key={card.id}
                  className="flex flex-col justify-between gap-1.5 rounded-lg border border-slate-200/80 bg-white px-2.5 py-2 text-xs"
                  data-status={card.status}
                >
                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-1.5">
                      <span className="inline-flex min-w-0 items-center gap-1 font-semibold text-slate-800">
                        <Icon size={13} className="shrink-0 text-slate-500" aria-hidden="true" />
                        <span className="truncate">{card.title}</span>
                      </span>
                      <StatusBadge tone={statusTone[card.status]} label={tr(statusText[card.status])} />
                    </div>
                    <p className="truncate text-[11px] text-slate-500" title={descriptionFor(card)}>
                      {descriptionFor(card)}
                    </p>
                  </div>
                  <Link
                    href={card.href}
                    className="w-fit text-[11px] font-medium text-[var(--gp-action)] hover:underline"
                  >
                    {tr(actionLabel(card, countFor(card)))}
                  </Link>
                </div>
              );
            })}
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="gp-setup-center" aria-labelledby="project-setup-center-title">
      <div className="gp-setup-center-heading">
        <div>
          <h2 id="project-setup-center-title" className="gp-panel-title text-[18px]">
            {tr("项目设置中心")}
          </h2>
          <p className="mt-1 text-sm text-[var(--gp-ink-soft)]">
            {tr("项目已经可以使用。按当前需要连接工具、整理资料或制定计划，不必按固定顺序完成。")}
          </p>
        </div>
        <StatusBadge
          tone={overview.course_id && overview.setup_status !== "frozen" ? "amber" : "green"}
          label={overview.course_id && overview.setup_status !== "frozen" ? tr("课程要求待完善") : tr("可开始协作")}
        />
      </div>
      <div className="gp-setup-card-grid">
        {cards.map((card) => {
          const Icon = icons[card.id];
          return (
            <article key={card.id} className="gp-setup-card" data-status={card.status}>
              <div className="flex min-w-0 items-start gap-3">
                <span className="gp-setup-card-icon">
                  <Icon size={18} aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold text-[var(--gp-ink)]">{card.title}</h3>
                    <StatusBadge tone={statusTone[card.status]} label={tr(statusText[card.status])} />
                  </div>
                  <p className="mt-1 text-sm leading-6 text-[var(--gp-ink-soft)]">{descriptionFor(card)}</p>
                </div>
              </div>
              <Link className={`${secondary} mt-4 w-fit`} href={card.href}>
                {tr(actionLabel(card, countFor(card)))}
              </Link>
            </article>
          );
        })}
      </div>
    </section>
  );
}
