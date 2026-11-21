"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { BookOpenCheck, Check, CircleAlert, FileText, FolderGit2, ListTodo, MessageSquareText, Settings, Users } from "lucide-react";
import { StatusBadge } from "@/components/common";
import { projectRequest } from "@/features/github-binding/integration-request";
import { bPlanningApi } from "@/lib/api/b-planning";
import { bProjectsApi, type BProjectOverview, type BProjectSetup } from "@/lib/api/b-projects";
import { bRequirementsApi } from "@/lib/api/b-requirements";
import { buildSetupCards, type SetupCard, type SetupCardId } from "@/lib/ux/student-workspace";
import { useWorkspace } from "@/lib/workspace";
import { queryPolicy, secondary } from "@/features/b/ui";

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

export function ProjectSetupCenter({ projectId, overview, initialSetup }: {
  projectId: string;
  overview: BProjectOverview;
  initialSetup?: BProjectSetup;
}) {
  const { userId } = useWorkspace();
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
    retry: false,
  });
  const plan = useQuery({
    queryKey: ["b-plan", userId, projectId],
    queryFn: () => bPlanningApi.plan(projectId),
    retry: false,
  });
  const repos = useQuery({
    queryKey: ["project-integration-repos", userId, projectId],
    queryFn: ({ signal }) => projectRequest<unknown[]>(`/api/v1/a/projects/${projectId}/github/repos`, { signal }),
    retry: false,
  });
  const chats = useQuery({
    queryKey: ["project-integration-chats", userId, projectId],
    queryFn: ({ signal }) => projectRequest<unknown[]>(`/api/v1/a/projects/${projectId}/feishu/chats`, { signal }),
    retry: false,
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
    if (card.id === "github" && repos.isPending) return "正在读取 GitHub 仓库绑定状态…";
    if (card.id === "github" && repos.isError) return "暂时无法读取仓库绑定状态，可进入设置重试。";
    if (card.id === "feishu" && chats.isPending) return "正在读取飞书群绑定状态…";
    if (card.id === "feishu" && chats.isError) return "暂时无法读取群聊绑定状态，可进入设置重试。";
    if (card.id === "materials" && !setupData) return "进入资料区查看或补充项目资料。";
    if ((card.id === "requirements" || card.id === "conflicts") && board.isError) return "进入需求工作区查看当前需求状态。";
    if (card.id === "plan" && plan.isError) return "进入任务规划查看当前计划。";
    return card.description;
  };

  return <section className="gp-setup-center" aria-labelledby="project-setup-center-title">
    <div className="gp-setup-center-heading">
      <div>
        <h2 id="project-setup-center-title" className="gp-panel-title text-[18px]">项目设置中心</h2>
        <p className="mt-1 text-sm text-[var(--gp-ink-soft)]">项目已经可以使用。按当前需要连接工具、整理资料或制定计划，不必按固定顺序完成。</p>
      </div>
      <StatusBadge tone={overview.course_id && overview.setup_status !== "frozen" ? "amber" : "green"} label={overview.course_id && overview.setup_status !== "frozen" ? "课程要求待完善" : "可开始协作"} />
    </div>
    <div className="gp-setup-card-grid">
      {cards.map((card) => {
        const Icon = icons[card.id];
        return <article key={card.id} className="gp-setup-card" data-status={card.status}>
          <div className="flex min-w-0 items-start gap-3">
            <span className="gp-setup-card-icon"><Icon size={18} aria-hidden="true" /></span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold text-[var(--gp-ink)]">{card.title}</h3><StatusBadge tone={statusTone[card.status]} label={statusText[card.status]} /></div>
              <p className="mt-1 text-sm leading-6 text-[var(--gp-ink-soft)]">{descriptionFor(card)}</p>
            </div>
          </div>
          <Link className={`${secondary} mt-4 w-fit`} href={card.href}>{actionLabel(card, card.id === "github" ? repoCount : card.id === "feishu" ? chatCount : 0)}</Link>
        </article>;
      })}
    </div>
  </section>;
}
