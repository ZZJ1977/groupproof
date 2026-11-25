"use client";

import { projectApi } from "@/features/c/c-project-api";
import type { FeishuCollaborationInsights } from "@/features/c/FeishuCollaborationInsights";
import type { GithubActivityStats } from "@/features/c/GithubStatsChart";
import { projectRequest } from "@/features/github-binding/integration-request";
import { bProjectsApi, type BProjectOverview } from "@/lib/api/b-projects";
import { bTasksApi, type BTaskRow } from "@/lib/api/b-tasks";
import { fetchWithSession } from "@/lib/api/client";
import { apiConfig } from "@/lib/api/config";
import type { components } from "@/packages/domain/api.generated";

export type ContributionTaskCredit = {
  task_id: string;
  title: string;
  responsibility_share: number;
  weight: number;
  formal_outcome_id: string | null;
  evidence_url: string;
  evidence: { criterion_id: string; evidence_id: string; version: number }[];
};

export type ContributionSnapshotMember = {
  user_id: string;
  name: string;
  share: number;
  task_credit: number;
  tasks: ContributionTaskCredit[];
};

export type ContributionSnapshot = {
  id: string;
  version: number;
  status?: string;
  frozen_at?: string | null;
  formula_version: string;
  calculated_at: string;
  stale: boolean;
  members: ContributionSnapshotMember[];
};

export type MemberAnalyticsRow = {
  userId: string;
  name: string;
  color: string;
  // Formal acceptance metrics
  formalShare: number;
  taskCredit: number;
  formalTasks: ContributionTaskCredit[];
  // Task execution metrics
  assignedCount: number;
  completedCount: number;
  pendingVerificationCount: number;
  inProgressCount: number;
  pendingSubmissionCount: number;
  notStartedCount: number;
  assignedWeight: number;
  weightedTaskProgress: number;
  assignedTasks: BTaskRow[];
  // GitHub metrics
  commits: number;
  additions: number;
  deletions: number;
  filesChanged: number;
  pullRequests: number;
  githubLogin: string | null;
  lastCommitAt: string | null;
  // Feishu collaboration metrics
  collabTopics: number;
  collabRecords: number;
  collabScore: number;
  // Multi-source composite reference (0-100%, never replaces formal weight)
  activityShare: number;
};

export type TaskStatusCounts = {
  completed: number;
  pendingVerification: number;
  inProgress: number;
  pendingSubmission: number;
  notStarted: number;
  total: number;
};

export type ProjectContributionAnalytics = {
  projectId: string;
  projectName: string;
  snapshot: ContributionSnapshot | null;
  members: MemberAnalyticsRow[];
  tasks: BTaskRow[];
  taskStatusCounts: TaskStatusCounts;
  githubStats: GithubActivityStats | null;
  feishuInsights: FeishuCollaborationInsights | null;
  feishuTotalMessages: number;
  totalFormalCredit: number;
  formalParticipantCount: number;
  activeContributorCount: number;
  totalCommits: number;
  totalAdditions: number;
  totalDeletions: number;
  totalPullRequests: number;
  unmatchedCommits: number;
  unmatchedLines: number;
  canCalculate: boolean;
  canFreeze: boolean;
};

const MEMBER_COLORS = [
  "#0284c7", // sky-600
  "#059669", // emerald-600
  "#7c3aed", // violet-600
  "#d97706", // amber-600
  "#e11d48", // rose-600
  "#0d9488", // teal-600
  "#4f46e5", // indigo-600
  "#ca8a04", // yellow-600
];

type ActivityItem = components["schemas"]["ActivityDTO"];

export async function contributionRequest<T>(url: string, method = "GET"): Promise<T> {
  const response = await fetchWithSession(
    new Request(new URL(apiConfig.baseUrl + url, window.location.origin), {
      method,
      credentials: "include",
      cache: "no-store",
    }),
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message ?? "读取贡献失败");
  return body.data as T;
}

async function fetchAllProjectTasks(projectId: string) {
  const first = await bTasksApi.list(projectId, { view: "list", page: 1, page_size: 100 });
  const items = [...first.items];
  const totalPages = Math.min(10, Math.ceil(first.total / 100));
  if (totalPages > 1) {
    const rest = await Promise.all(
      Array.from({ length: totalPages - 1 }, (_, idx) =>
        bTasksApi.list(projectId, { view: "list", page: idx + 2, page_size: 100 }),
      ),
    );
    for (const page of rest) {
      items.push(...page.items);
    }
  }
  return { items, members: first.members, total: first.total };
}

export async function fetchContributionAnalytics(projectId: string): Promise<ProjectContributionAnalytics> {
  const encodedId = encodeURIComponent(projectId);
  const [
    snapshotRes,
    tasksRes,
    contextRes,
    overviewRes,
    githubStatsRes,
    githubPrsRes,
    feishuInsightsRes,
    feishuActivitiesRes,
  ] = await Promise.allSettled([
    contributionRequest<ContributionSnapshot | null>(`/api/v1/projects/${encodedId}/contribution`),
    fetchAllProjectTasks(projectId),
    projectApi.projectContext(projectId),
    bProjectsApi.overview(projectId),
    projectRequest<GithubActivityStats>(`/api/v1/a/projects/${encodedId}/github/stats?range=all`),
    projectApi.activities(projectId, "github", { kind: "pull_request", page: 1, page_size: 50 }),
    projectRequest<FeishuCollaborationInsights>(`/api/v1/a/projects/${encodedId}/feishu/insights`),
    projectApi.activities(projectId, "feishu", { page: 1, page_size: 50 }),
  ]);

  if (snapshotRes.status === "rejected") {
    throw snapshotRes.reason instanceof Error ? snapshotRes.reason : new Error("读取贡献数据失败");
  }

  const snapshot = snapshotRes.value;
  const tasksData = tasksRes.status === "fulfilled" ? tasksRes.value : { items: [], members: [], total: 0 };
  const context = contextRes.status === "fulfilled" ? contextRes.value : null;
  const overview: BProjectOverview | null = overviewRes.status === "fulfilled" ? overviewRes.value : null;
  const githubStats = githubStatsRes.status === "fulfilled" ? githubStatsRes.value : null;
  const githubPrItems: ActivityItem[] =
    githubPrsRes.status === "fulfilled" ? githubPrsRes.value.items : [];
  const feishuInsights = feishuInsightsRes.status === "fulfilled" ? feishuInsightsRes.value : null;
  const feishuActivities =
    feishuActivitiesRes.status === "fulfilled" ? feishuActivitiesRes.value : null;

  const projectName = context?.project?.name || overview?.name || "当前项目";

  // 1. Build canonical list of ALL active project members (never drop 0% formal members)
  const memberNameMap = new Map<string, string>();
  for (const m of context?.members ?? []) {
    if (m.id && m.title) memberNameMap.set(m.id, m.title);
  }
  for (const m of overview?.members ?? []) {
    if (m.id && !memberNameMap.has(m.id)) memberNameMap.set(m.id, m.name || "项目成员");
  }
  for (const m of snapshot?.members ?? []) {
    if (m.user_id && !memberNameMap.has(m.user_id)) memberNameMap.set(m.user_id, m.name || "项目成员");
  }
  for (const m of tasksData.members ?? []) {
    if (m.id && !memberNameMap.has(m.id)) memberNameMap.set(m.id, m.name || "项目成员");
  }
  if (memberNameMap.size === 0) {
    for (const t of tasksData.items) {
      for (const a of t.assignees) {
        if (a.id && !memberNameMap.has(a.id)) memberNameMap.set(a.id, a.name || "项目成员");
      }
    }
  }

  const snapshotByUser = new Map<string, ContributionSnapshotMember>();
  for (const item of snapshot?.members ?? []) {
    snapshotByUser.set(item.user_id, item);
  }

  // 2. Match GitHub contributors & PRs to canonical project members
  const memberIdsByName = new Map<string, string[]>();
  for (const [uid, name] of memberNameMap.entries()) {
    const key = name.trim().toLowerCase();
    if (!key) continue;
    const list = memberIdsByName.get(key) ?? [];
    list.push(uid);
    memberIdsByName.set(key, list);
  }

  const githubByUser = new Map<
    string,
    { commits: number; additions: number; deletions: number; filesChanged: number; login: string | null; lastCommitAt: string | null }
  >();
  let unmatchedCommits = 0;
  let unmatchedLines = 0;

  for (const contributor of githubStats?.contributors ?? []) {
    let targetUid = contributor.author_user_id && memberNameMap.has(contributor.author_user_id)
      ? contributor.author_user_id
      : null;
    if (!targetUid && contributor.author_name) {
      const matches = memberIdsByName.get(contributor.author_name.trim().toLowerCase()) ?? [];
      if (matches.length === 1) targetUid = matches[0];
    }
    if (!targetUid && contributor.author_login) {
      const matches = memberIdsByName.get(contributor.author_login.trim().toLowerCase()) ?? [];
      if (matches.length === 1) targetUid = matches[0];
    }
    if (!targetUid) {
      unmatchedCommits += contributor.commits;
      unmatchedLines += contributor.additions + contributor.deletions;
      continue;
    }
    const prev = githubByUser.get(targetUid) ?? {
      commits: 0,
      additions: 0,
      deletions: 0,
      filesChanged: 0,
      login: null,
      lastCommitAt: null,
    };
    const nextLastCommit =
      !prev.lastCommitAt || contributor.last_commit_at > prev.lastCommitAt
        ? contributor.last_commit_at
        : prev.lastCommitAt;
    githubByUser.set(targetUid, {
      commits: prev.commits + contributor.commits,
      additions: prev.additions + contributor.additions,
      deletions: prev.deletions + contributor.deletions,
      filesChanged: prev.filesChanged + contributor.files_changed,
      login: prev.login || contributor.author_login || null,
      lastCommitAt: nextLastCommit,
    });
  }

  const prsByUser = new Map<string, number>();
  for (const pr of githubPrItems) {
    let targetUid = pr.author_id && memberNameMap.has(pr.author_id) ? pr.author_id : null;
    if (!targetUid && pr.author_name) {
      const matches = memberIdsByName.get(pr.author_name.trim().toLowerCase()) ?? [];
      if (matches.length === 1) targetUid = matches[0];
    }
    if (targetUid) {
      prsByUser.set(targetUid, (prsByUser.get(targetUid) ?? 0) + 1);
    }
  }

  // 3. Task counts & status aggregation
  const taskStatusCounts: TaskStatusCounts = {
    completed: 0,
    pendingVerification: 0,
    inProgress: 0,
    pendingSubmission: 0,
    notStarted: 0,
    total: tasksData.items.length,
  };
  for (const t of tasksData.items) {
    if (t.status === "completed") taskStatusCounts.completed += 1;
    else if (t.status === "pending_verification") taskStatusCounts.pendingVerification += 1;
    else if (t.status === "pending_submission") taskStatusCounts.pendingSubmission += 1;
    else if (t.status === "in_progress") taskStatusCounts.inProgress += 1;
    else taskStatusCounts.notStarted += 1;
  }

  // 4. Build initial rows for every active member
  const orderedIds = Array.from(memberNameMap.keys());
  const rawRows: Omit<MemberAnalyticsRow, "color" | "activityShare">[] = orderedIds.map((uid) => {
    const name = memberNameMap.get(uid) ?? "项目成员";
    const formal = snapshotByUser.get(uid);
    const assignedTasks = tasksData.items.filter((t) => t.assignees.some((a) => a.id === uid));
    const assignedTaskIds = new Set(assignedTasks.map((t) => t.id));

    let completedCount = 0;
    let pendingVerificationCount = 0;
    let inProgressCount = 0;
    let pendingSubmissionCount = 0;
    let notStartedCount = 0;
    let assignedWeight = 0;
    let weightedSum = 0;
    let plainSum = 0;

    for (const t of assignedTasks) {
      if (t.status === "completed") completedCount += 1;
      else if (t.status === "pending_verification") pendingVerificationCount += 1;
      else if (t.status === "pending_submission") pendingSubmissionCount += 1;
      else if (t.status === "in_progress") inProgressCount += 1;
      else notStartedCount += 1;
      const w = Number(t.weight) > 0 ? Number(t.weight) : 0;
      assignedWeight += w;
      weightedSum += w * t.progress_percent;
      plainSum += t.progress_percent;
    }

    const weightedTaskProgress =
      assignedTasks.length === 0
        ? 0
        : assignedWeight > 0
          ? Math.round(weightedSum / assignedWeight)
          : Math.round(plainSum / assignedTasks.length);

    // Feishu collaboration signals: direct author attribution + task-linked insights + task-linked messages + name mentions
    let collabTopics = 0;
    let collabRecords = 0;
    const normalizedName = name.trim().toLowerCase();

    for (const item of feishuInsights?.items ?? []) {
      const linkedToMemberTask = item.linked_tasks.some((lt) => assignedTaskIds.has(lt.id));
      const mentionsName =
        normalizedName.length >= 2 &&
        (item.summary.toLowerCase().includes(normalizedName) ||
          item.messages.some((m) => m.text.toLowerCase().includes(normalizedName)));
      if (linkedToMemberTask || mentionsName) {
        collabTopics += 1;
        collabRecords += Math.max(1, item.message_count);
      }
    }

    for (const act of feishuActivities?.items ?? []) {
      const directAuthor = act.author_id === uid;
      const linkedTask = act.task_id ? assignedTaskIds.has(act.task_id) : false;
      const mentionsName =
        normalizedName.length >= 2 &&
        (`${act.title} ${act.summary}`.toLowerCase().includes(normalizedName));
      if (directAuthor || linkedTask || mentionsName) {
        collabRecords += 1;
      }
    }

    const gh = githubByUser.get(uid);
    const collabScore = collabTopics * 2 + collabRecords;

    return {
      userId: uid,
      name,
      formalShare: formal?.share ?? 0,
      taskCredit: formal?.task_credit ?? 0,
      formalTasks: formal?.tasks ?? [],
      assignedCount: assignedTasks.length,
      completedCount,
      pendingVerificationCount,
      inProgressCount,
      pendingSubmissionCount,
      notStartedCount,
      assignedWeight,
      weightedTaskProgress,
      assignedTasks,
      commits: gh?.commits ?? 0,
      additions: gh?.additions ?? 0,
      deletions: gh?.deletions ?? 0,
      filesChanged: gh?.filesChanged ?? 0,
      pullRequests: prsByUser.get(uid) ?? 0,
      githubLogin: gh?.login ?? null,
      lastCommitAt: gh?.lastCommitAt ?? null,
      collabTopics,
      collabRecords,
      collabScore,
    };
  });

  // Sort members: formalShare desc, then taskCredit desc, then commits desc, then weightedTaskProgress desc, then name
  rawRows.sort((a, b) => {
    if (b.formalShare !== a.formalShare) return b.formalShare - a.formalShare;
    if (b.taskCredit !== a.taskCredit) return b.taskCredit - a.taskCredit;
    if (b.commits !== a.commits) return b.commits - a.commits;
    if (b.weightedTaskProgress !== a.weightedTaskProgress) {
      return b.weightedTaskProgress - a.weightedTaskProgress;
    }
    return a.name.localeCompare(b.name, "zh-CN");
  });

  // 5. Compute normalized multi-source activity share (always sums to 100% when any activity exists)
  const sumFormal = rawRows.reduce((acc, r) => acc + r.formalShare, 0);
  const sumTaskWork = rawRows.reduce(
    (acc, r) => acc + (r.assignedCount > 0 ? Math.max(1, r.assignedWeight) * (r.weightedTaskProgress / 100) : 0),
    0,
  );
  const sumCommits = rawRows.reduce((acc, r) => acc + r.commits, 0);
  const sumCollab = rawRows.reduce((acc, r) => acc + r.collabScore, 0);

  const rawActivityScores = rawRows.map((r) => {
    const parts: number[] = [];
    if (sumFormal > 0) parts.push(r.formalShare / sumFormal);
    if (sumTaskWork > 0) {
      const work = r.assignedCount > 0 ? Math.max(1, r.assignedWeight) * (r.weightedTaskProgress / 100) : 0;
      parts.push(work / sumTaskWork);
    }
    if (sumCommits > 0) parts.push(r.commits / sumCommits);
    if (sumCollab > 0) parts.push(r.collabScore / sumCollab);
    if (parts.length === 0) return 0;
    return parts.reduce((acc, v) => acc + v, 0) / parts.length;
  });
  const totalRawActivity = rawActivityScores.reduce((acc, v) => acc + v, 0);

  const members: MemberAnalyticsRow[] = rawRows.map((row, idx) => ({
    ...row,
    color: MEMBER_COLORS[idx % MEMBER_COLORS.length],
    activityShare:
      totalRawActivity > 0 ? Math.round((rawActivityScores[idx] / totalRawActivity) * 1000) / 10 : 0,
  }));

  const totalFormalCredit = members.reduce((acc, m) => acc + m.taskCredit, 0);
  const formalParticipantCount = members.filter((m) => m.formalShare > 0).length;
  const activeContributorCount = members.filter(
    (m) => m.formalShare > 0 || m.commits > 0 || m.assignedCount > 0 || m.collabScore > 0,
  ).length;

  const canCalculate = context ? context.actor.is_leader || context.actor.is_teacher : true;
  const canFreeze = context ? context.actor.is_leader || context.actor.is_teacher : true;

  return {
    projectId,
    projectName,
    snapshot,
    members,
    tasks: tasksData.items,
    taskStatusCounts,
    githubStats,
    feishuInsights,
    feishuTotalMessages: feishuInsights?.total_messages ?? feishuActivities?.total ?? 0,
    totalFormalCredit: Math.round(totalFormalCredit * 100) / 100,
    formalParticipantCount,
    activeContributorCount,
    totalCommits: githubStats?.total_commits ?? 0,
    totalAdditions: githubStats?.total_additions ?? 0,
    totalDeletions: githubStats?.total_deletions ?? 0,
    totalPullRequests: githubStats?.total_pull_requests ?? 0,
    unmatchedCommits,
    unmatchedLines,
    canCalculate,
    canFreeze,
  };
}
