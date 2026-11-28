"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  GitBranchPlus,
  GitCommitHorizontal,
  Plus,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { EmptyState, Feedback } from "@/shared/components/common";
import { Button } from "@/shared/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/shared/components/ui/sheet";
import { queryPolicy } from "@/shared/lib/b-ui";
import { cn } from "@/shared/lib/utils";
import { useWorkspace } from "@/shared/lib/workspace";
import {
  adoptCodeDiscovery,
  approveCodeDiscovery,
  dismissCodeDiscovery,
  listCodeDiscoveries,
  scanCodeDiscoveries,
  type CodeDiscoveryActionType,
  type CodeDiscoveryAdoptInput,
  type CodeDiscoveryItem,
} from "@/student/api/b-code-discoveries";
import type { BPerson } from "@/student/api/b-courses";
import type { BPlanOption } from "@/student/api/b-planning";
import { bTasksApi, type BTaskRow } from "@/student/api/b-tasks";
import { useBErrorMessage } from "@/student/projects/use-b-error";

type DrawerTab = "pending" | "pending_approval" | "adopted";

type DraftState = {
  action_type: CodeDiscoveryActionType;
  title: string;
  description: string;
  module_id: string;
  parent_task_id: string;
  target_task_id: string;
  assignee_ids: string[];
  weight: number;
  acceptance_criteria: string[];
  reason: string;
};

const fieldInput =
  "w-full rounded-lg border border-slate-200/90 bg-white px-2.5 py-1.5 text-xs text-slate-900 placeholder:text-slate-400 outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-500/15 disabled:bg-slate-50";

function makeInitialDraft(item: CodeDiscoveryItem): DraftState {
  return {
    action_type: item.action_type,
    title: item.title,
    description: item.description,
    module_id: item.suggested_module_id ?? "",
    parent_task_id: item.suggested_parent_task_id ?? "",
    target_task_id: item.target_task_id ?? "",
    assignee_ids: [...(item.suggested_assignee_ids ?? [])],
    weight: Math.min(10, Math.max(1, Math.round(item.suggested_weight || 3))),
    acceptance_criteria:
      item.acceptance_criteria.length > 0 ? [...item.acceptance_criteria] : [""],
    reason: "",
  };
}

function actionPillStyle(actionType: CodeDiscoveryActionType): string {
  if (actionType === "merge_existing") {
    return "border-sky-200/90 bg-sky-50 text-sky-700";
  }
  if (actionType === "new_subtask") {
    return "border-indigo-200/90 bg-indigo-50 text-indigo-700";
  }
  return "border-violet-200/90 bg-violet-50 text-violet-700";
}

function actionLabelKey(actionType: CodeDiscoveryActionType) {
  if (actionType === "merge_existing") return "actionMergeExisting" as const;
  if (actionType === "new_subtask") return "actionNewSubtask" as const;
  return "actionNewTopLevel" as const;
}

export function CodeDiscoveryDrawer({
  projectId,
  open,
  onOpenChange,
  onChanged,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged?: () => void;
}) {
  const t = useTranslations("codeDiscovery");
  const errorText = useBErrorMessage();
  const { userId } = useWorkspace();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<DrawerTab>("pending");
  const [showUnmatched, setShowUnmatched] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "info"; text: string } | null>(
    null,
  );
  const [busyItemId, setBusyItemId] = useState<string | null>(null);

  const discoveryQuery = useQuery({
    queryKey: ["b-code-discoveries", userId, projectId],
    queryFn: () => listCodeDiscoveries(projectId),
    enabled: open && Boolean(projectId),
    ...queryPolicy,
  });

  const tasksMetaQuery = useQuery({
    queryKey: ["b-tasks", userId, projectId, { view: "tree" }],
    queryFn: () => bTasksApi.list(projectId, { view: "tree" }),
    enabled: open && Boolean(projectId),
    ...queryPolicy,
  });

  const invalidateProjectCaches = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["b-code-discoveries", userId, projectId] }),
      queryClient.invalidateQueries({ queryKey: ["b-tasks", userId, projectId] }),
      queryClient.invalidateQueries({ queryKey: ["b-plan", userId, projectId] }),
      queryClient.invalidateQueries({ queryKey: ["b-milestones", userId, projectId] }),
      queryClient.invalidateQueries({ queryKey: ["b-project-overview", userId, projectId] }),
      queryClient.invalidateQueries({ queryKey: ["c-project-context", userId, projectId] }),
      queryClient.invalidateQueries({ queryKey: ["c-project-activities", userId, projectId] }),
    ]);
    onChanged?.();
  };

  const scanMutation = useMutation({
    mutationFn: () => scanCodeDiscoveries(projectId, { max_commits: 20 }),
    onSuccess: async (res) => {
      queryClient.setQueryData(["b-code-discoveries", userId, projectId], res);
      setNotice({
        tone: res.created_count > 0 ? "success" : "info",
        text:
          res.created_count > 0
            ? t("scanSuccessCreated", { count: res.created_count })
            : t("scanSuccessNone"),
      });
      if (res.created_count > 0) setTab("pending");
      await invalidateProjectCaches();
    },
    onError: (err) => setNotice({ tone: "error", text: errorText(err) }),
  });

  const handleAdopt = async (item: CodeDiscoveryItem, payload: CodeDiscoveryAdoptInput) => {
    setBusyItemId(item.id);
    setNotice(null);
    try {
      const res = await adoptCodeDiscovery(projectId, item.id, payload);
      setNotice({
        tone: "success",
        text:
          res.message?.trim() ||
          (res.adopted_immediately
            ? t("adoptSuccessImmediate", { count: res.attached_evidence_count })
            : t("adoptSuccessPending")),
      });
      if (!res.adopted_immediately) setTab("pending_approval");
      await invalidateProjectCaches();
    } catch (err) {
      setNotice({ tone: "error", text: errorText(err) });
    } finally {
      setBusyItemId(null);
    }
  };

  const handleApprove = async (item: CodeDiscoveryItem, reason: string) => {
    setBusyItemId(item.id);
    setNotice(null);
    try {
      const res = await approveCodeDiscovery(projectId, item.id, reason ? { reason } : {});
      setNotice({
        tone: "success",
        text: res.message?.trim() || t("approveSuccess"),
      });
      if (res.adopted_immediately) setTab("adopted");
      await invalidateProjectCaches();
    } catch (err) {
      setNotice({ tone: "error", text: errorText(err) });
    } finally {
      setBusyItemId(null);
    }
  };

  const handleDismiss = async (item: CodeDiscoveryItem, reason: string) => {
    setBusyItemId(item.id);
    setNotice(null);
    try {
      await dismissCodeDiscovery(projectId, item.id, reason ? { reason } : {});
      setNotice({ tone: "info", text: t("dismissSuccess") });
      await invalidateProjectCaches();
    } catch (err) {
      setNotice({ tone: "error", text: errorText(err) });
    } finally {
      setBusyItemId(null);
    }
  };

  const data = discoveryQuery.data;
  const allItems = useMemo(() => data?.items ?? [], [data?.items]);
  const pendingItems = useMemo(
    () => allItems.filter((item) => item.status === "pending" && item.approval_status !== "pending_approval"),
    [allItems],
  );
  const pendingApprovalItems = useMemo(
    () => allItems.filter((item) => item.status === "pending" && item.approval_status === "pending_approval"),
    [allItems],
  );
  const adoptedItems = useMemo(
    () => allItems.filter((item) => item.status === "adopted"),
    [allItems],
  );

  const activeItems =
    tab === "pending"
      ? pendingItems
      : tab === "pending_approval"
        ? pendingApprovalItems
        : adoptedItems;

  const modules = tasksMetaQuery.data?.modules ?? [];
  const members = tasksMetaQuery.data?.members ?? [];
  const projectTasks = tasksMetaQuery.data?.items ?? [];
  const unmatchedCount = data?.unmatched_commits_count ?? 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        data-testid="code-discovery-drawer"
        className="!flex !w-[min(100vw,640px)] !flex-col !overflow-hidden !p-0"
      >
        <div className="shrink-0 border-b border-slate-200/85 bg-white px-5 pb-4 pt-5 pr-12">
          <SheetHeader className="!mb-3">
            <SheetTitle className="flex items-center gap-2 text-base font-bold text-slate-900">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-violet-50 text-violet-700 ring-1 ring-violet-200/80">
                <GitBranchPlus size={15} aria-hidden="true" />
              </span>
              {t("drawerTitle")}
            </SheetTitle>
            <SheetDescription className="text-xs leading-5 text-slate-500">
              {t("drawerDescription")}
            </SheetDescription>
          </SheetHeader>

          {/* Unmatched commits bar + AI Scan trigger */}
          <div className="rounded-xl border border-slate-200/85 bg-slate-50/75 px-3.5 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="inline-flex items-center gap-1.5 font-semibold tabular-nums text-slate-800">
                  <GitCommitHorizontal size={14} className="text-violet-600" aria-hidden="true" />
                  {t("unmatchedCommitsCount", { count: unmatchedCount })}
                </span>
                {(data?.unmatched_commits.length ?? 0) > 0 && (
                  <button
                    type="button"
                    className="inline-flex items-center gap-0.5 text-[11px] font-medium text-sky-700 hover:underline"
                    onClick={() => setShowUnmatched((prev) => !prev)}
                  >
                    {showUnmatched ? t("hideUnmatchedList") : t("toggleUnmatchedList")}
                    {showUnmatched ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  </button>
                )}
              </div>

              <Button
                type="button"
                size="sm"
                loading={scanMutation.isPending}
                disabled={scanMutation.isPending || discoveryQuery.isLoading}
                onClick={() => scanMutation.mutate()}
                data-testid="code-discovery-scan-btn"
              >
                <Sparkles size={13} aria-hidden="true" />
                {scanMutation.isPending ? t("scanningButton") : t("scanButton")}
              </Button>
            </div>

            {showUnmatched && (data?.unmatched_commits.length ?? 0) > 0 && (
              <ul className="mt-2.5 max-h-40 divide-y divide-slate-200/70 overflow-y-auto rounded-lg border border-slate-200/80 bg-white px-2.5 py-1 text-[11px]">
                {data!.unmatched_commits.map((commit) => (
                  <li key={commit.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                    <div className="flex min-w-0 flex-1 items-center gap-1.5">
                      <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-slate-600">
                        {commit.sha.slice(0, 7)}
                      </span>
                      <span className="truncate font-medium text-slate-800" title={commit.title}>
                        {commit.title}
                      </span>
                    </div>
                    <span className="shrink-0 tabular-nums text-slate-400">
                      {t("unmatchedCommitMeta", {
                        author: commit.author_name,
                        lines: commit.effective_lines,
                        files: commit.files_count,
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Filter Tabs */}
          <div className="mt-3 flex flex-wrap items-center gap-1.5" role="tablist">
            {(
              [
                { id: "pending" as const, label: t("tabPending"), count: pendingItems.length },
                {
                  id: "pending_approval" as const,
                  label: t("tabPendingApproval"),
                  count: pendingApprovalItems.length,
                },
                { id: "adopted" as const, label: t("tabAdopted"), count: adoptedItems.length },
              ] as const
            ).map((item) => {
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-testid={`code-discovery-tab-${item.id}`}
                  onClick={() => setTab(item.id)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                    active
                      ? "bg-slate-900 text-white shadow-2xs"
                      : "bg-slate-100/85 text-slate-600 hover:bg-slate-200/75 hover:text-slate-900",
                  )}
                >
                  <span>{item.label}</span>
                  <span
                    className={cn(
                      "rounded-full px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums",
                      active ? "bg-white/20 text-white" : "bg-white text-slate-600",
                    )}
                  >
                    {item.count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Scrollable body */}
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-slate-50/45 px-5 py-4">
          {notice && (
            <Feedback tone={notice.tone}>
              <div className="flex items-center justify-between gap-2">
                <span>{notice.text}</span>
                <button
                  type="button"
                  className="shrink-0 opacity-70 hover:opacity-100"
                  onClick={() => setNotice(null)}
                  aria-label="dismiss"
                >
                  <X size={13} />
                </button>
              </div>
            </Feedback>
          )}

          {discoveryQuery.isLoading ? (
            <div role="status" className="rounded-xl border border-slate-200/80 bg-white p-6 text-center text-xs text-slate-500">
              {t("loadingList")}
            </div>
          ) : discoveryQuery.isError ? (
            <div role="alert" className="space-y-2">
              <Feedback tone="error">{errorText(discoveryQuery.error)}</Feedback>
              <Button type="button" variant="outline" size="sm" onClick={() => void discoveryQuery.refetch()}>
                {t("retry")}
              </Button>
            </div>
          ) : activeItems.length === 0 ? (
            <div className="rounded-2xl border border-slate-200/85 bg-white p-6">
              {tab === "pending" ? (
                <EmptyState
                  title={
                    unmatchedCount > 0
                      ? t("emptyPendingHasCommitsTitle")
                      : t("emptyPendingNoCommitsTitle")
                  }
                  description={
                    unmatchedCount > 0
                      ? t("emptyPendingHasCommitsDesc", { count: unmatchedCount })
                      : t("emptyPendingNoCommitsDesc")
                  }
                />
              ) : tab === "pending_approval" ? (
                <EmptyState
                  title={t("emptyPendingApprovalTitle")}
                  description={t("emptyPendingApprovalDesc")}
                />
              ) : (
                <EmptyState title={t("emptyAdoptedTitle")} description={t("emptyAdoptedDesc")} />
              )}
            </div>
          ) : (
            activeItems.map((item) => (
              <CodeDiscoveryCard
                key={item.id}
                projectId={projectId}
                item={item}
                modules={modules}
                members={members}
                tasks={projectTasks}
                busy={busyItemId === item.id}
                onAdopt={(payload) => void handleAdopt(item, payload)}
                onApprove={(reason) => void handleApprove(item, reason)}
                onDismiss={(reason) => void handleDismiss(item, reason)}
              />
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function CodeDiscoveryCard({
  projectId,
  item,
  modules,
  members,
  tasks,
  busy,
  onAdopt,
  onApprove,
  onDismiss,
}: {
  projectId: string;
  item: CodeDiscoveryItem;
  modules: BPlanOption[];
  members: BPerson[];
  tasks: BTaskRow[];
  busy: boolean;
  onAdopt: (payload: CodeDiscoveryAdoptInput) => void;
  onApprove: (reason: string) => void;
  onDismiss: (reason: string) => void;
}) {
  const t = useTranslations("codeDiscovery");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DraftState>(() => makeInitialDraft(item));
  const [actionReason, setActionReason] = useState("");

  const isPendingReview = item.status === "pending" && item.approval_status !== "pending_approval";
  const isPendingApproval = item.status === "pending" && item.approval_status === "pending_approval";
  const isAdopted = item.status === "adopted";
  const confidencePct = Math.round(Math.max(0, Math.min(1, item.confidence)) * 100);

  const toggleAssignee = (uid: string) => {
    setDraft((prev) => ({
      ...prev,
      assignee_ids: prev.assignee_ids.includes(uid)
        ? prev.assignee_ids.filter((id) => id !== uid)
        : [...prev.assignee_ids, uid],
    }));
  };

  const updateCriterion = (index: number, value: string) => {
    setDraft((prev) => ({
      ...prev,
      acceptance_criteria: prev.acceptance_criteria.map((c, i) => (i === index ? value : c)),
    }));
  };

  const removeCriterion = (index: number) => {
    setDraft((prev) => ({
      ...prev,
      acceptance_criteria: prev.acceptance_criteria.filter((_, i) => i !== index),
    }));
  };

  const addCriterion = () => {
    setDraft((prev) => ({
      ...prev,
      acceptance_criteria: [...prev.acceptance_criteria, ""],
    }));
  };

  const submitAdopt = () => {
    const cleanedCriteria = draft.acceptance_criteria.map((s) => s.trim()).filter(Boolean);
    const payload: CodeDiscoveryAdoptInput = {
      action_type: draft.action_type,
      title: draft.title.trim() || item.title,
      description: draft.description.trim(),
      module_id: draft.module_id || null,
      parent_task_id: draft.action_type === "new_subtask" ? draft.parent_task_id || null : null,
      target_task_id: draft.action_type === "merge_existing" ? draft.target_task_id || null : null,
      assignee_ids: draft.assignee_ids,
      weight: Math.min(10, Math.max(1, Number.isFinite(draft.weight) ? Math.round(draft.weight) : 3)),
      acceptance_criteria: cleanedCriteria,
      reason: draft.reason.trim() || undefined,
    };
    onAdopt(payload);
  };

  const memberNameById = useMemo(
    () => new Map(members.map((m) => [m.id, m.name ?? m.id.slice(0, 6)])),
    [members],
  );

  return (
    <article
      data-testid={`code-discovery-card-${item.id}`}
      className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-2xs"
    >
      {/* Top pills row */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={cn(
              "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold",
              actionPillStyle(item.action_type),
            )}
          >
            {t(actionLabelKey(item.action_type))}
          </span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[10px] font-medium tabular-nums text-slate-600">
            {t("confidenceLabel", { percent: confidencePct })}
          </span>
          {item.is_placeholder && (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">
              {t("placeholderBadge")}
            </span>
          )}
        </div>
        {isPendingReview && (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200/90 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 transition hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900"
            onClick={() => setEditing((prev) => !prev)}
          >
            <SlidersHorizontal size={11} aria-hidden="true" />
            {editing ? t("editToggleClose") : t("editToggleOpen")}
          </button>
        )}
      </div>

      {/* Title & description */}
      <h3 className="mt-2 text-sm font-semibold leading-snug text-slate-900">{item.title}</h3>
      {item.description && (
        <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-slate-600">
          {item.description}
        </p>
      )}

      {/* Rationale */}
      {item.rationale && (
        <div className="mt-2 rounded-lg border-l-2 border-violet-300 bg-slate-50/85 px-2.5 py-1.5 text-[11px] leading-5 text-slate-600">
          {item.rationale}
        </div>
      )}

      {/* Metadata chips */}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
        {item.suggested_module_name && (
          <span>{t("suggestedModule", { name: item.suggested_module_name })}</span>
        )}
        {item.target_task_title && (
          <span>{t("suggestedTargetTask", { title: item.target_task_title })}</span>
        )}
        {item.suggested_parent_task_title && (
          <span>{t("suggestedParentTask", { title: item.suggested_parent_task_title })}</span>
        )}
        <span className="font-mono tabular-nums">
          {t("suggestedWeight", { weight: item.suggested_weight })}
        </span>
        <span className="tabular-nums">
          {t("criteriaPreviewCount", { count: item.acceptance_criteria.length })}
        </span>
        {item.suggested_assignee_ids.length > 0 && (
          <span className="inline-flex items-center gap-1">
            <Users size={11} aria-hidden="true" />
            {item.suggested_assignee_ids
              .map((id) => memberNameById.get(id) ?? id.slice(0, 6))
              .join(", ")}
          </span>
        )}
      </div>

      {/* Source commit chips */}
      {item.source_commits.length > 0 && (
        <div className="mt-2.5 space-y-1">
          <div className="text-[11px] font-medium text-slate-500">
            {t("sourceCommitsHeading", { count: item.source_commits.length })}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {item.source_commits.map((commit) => (
              <span
                key={commit.id}
                title={`${commit.sha} · ${commit.title} (${commit.author_name})`}
                className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-slate-200/85 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-700"
              >
                <span className="shrink-0 font-mono text-[10px] font-semibold text-violet-700">
                  {commit.sha.slice(0, 7)}
                </span>
                <span className="max-w-[200px] truncate">{commit.title}</span>
                <span className="shrink-0 text-slate-400">· {commit.author_name}</span>
                <span className="shrink-0 font-mono text-[10px] tabular-nums text-emerald-700">
                  +{t("commitLines", { lines: commit.effective_lines })}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Pending approval progress */}
      {isPendingApproval && (
        <div
          data-testid="code-discovery-approval-progress"
          className="mt-3 rounded-xl border border-amber-200/85 bg-amber-50/60 px-3 py-2.5 text-xs"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold tabular-nums text-amber-900">
              {t("approvalProgress", {
                current: item.approvals.length,
                required: Math.max(1, item.required_approvals),
              })}
            </span>
            {item.proposed_by_name && (
              <span className="text-[11px] text-amber-800/80">
                {t("proposedBy", { name: item.proposed_by_name })}
              </span>
            )}
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-amber-100">
            <div
              className="h-full rounded-full bg-amber-500 transition-[width] duration-200"
              style={{
                width: `${Math.min(
                  100,
                  Math.round(
                    (item.approvals.length / Math.max(1, item.required_approvals)) * 100,
                  ),
                )}%`,
              }}
            />
          </div>
          {item.approvals.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {item.approvals.map((appr) => (
                <span
                  key={`${appr.user_id}-${appr.approved_at}`}
                  className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-200/80"
                >
                  <CheckCircle2 size={11} aria-hidden="true" />
                  {appr.name}
                </span>
              ))}
            </div>
          )}
          {!item.can_approve && (
            <p className="mt-2 text-[11px] text-amber-800/85">{t("waitingOtherApprovers")}</p>
          )}
        </div>
      )}

      {/* Expandable inline edit form */}
      {isPendingReview && editing && (
        <div className="mt-3 space-y-2.5 rounded-xl border border-slate-200/90 bg-slate-50/75 p-3">
          <div className="grid gap-2.5 sm:grid-cols-2">
            <label className="block space-y-1 text-[11px] font-medium text-slate-700">
              <span>{t("fieldActionType")}</span>
              <select
                className={fieldInput}
                value={draft.action_type}
                disabled={busy}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    action_type: e.target.value as CodeDiscoveryActionType,
                  }))
                }
              >
                <option value="merge_existing">{t("actionMergeExisting")}</option>
                <option value="new_subtask">{t("actionNewSubtask")}</option>
                <option value="new_top_level">{t("actionNewTopLevel")}</option>
              </select>
            </label>

            <label className="block space-y-1 text-[11px] font-medium text-slate-700">
              <span>{t("fieldWeight")}</span>
              <input
                type="number"
                min={1}
                max={10}
                step={1}
                className={`${fieldInput} font-mono tabular-nums`}
                value={draft.weight}
                disabled={busy}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    weight: Math.min(10, Math.max(1, Number(e.target.value) || 1)),
                  }))
                }
              />
            </label>
          </div>

          <label className="block space-y-1 text-[11px] font-medium text-slate-700">
            <span>{t("fieldTitle")}</span>
            <input
              type="text"
              className={fieldInput}
              value={draft.title}
              disabled={busy}
              onChange={(e) => setDraft((prev) => ({ ...prev, title: e.target.value }))}
            />
          </label>

          <label className="block space-y-1 text-[11px] font-medium text-slate-700">
            <span>{t("fieldDescription")}</span>
            <textarea
              rows={2}
              className={fieldInput}
              value={draft.description}
              disabled={busy}
              onChange={(e) => setDraft((prev) => ({ ...prev, description: e.target.value }))}
            />
          </label>

          <div className="grid gap-2.5 sm:grid-cols-2">
            {draft.action_type === "merge_existing" ? (
              <label className="block space-y-1 text-[11px] font-medium text-slate-700 sm:col-span-2">
                <span>{t("fieldTargetTask")}</span>
                <select
                  className={fieldInput}
                  value={draft.target_task_id}
                  disabled={busy}
                  onChange={(e) => setDraft((prev) => ({ ...prev, target_task_id: e.target.value }))}
                >
                  <option value="">{t("fieldTargetTaskPlaceholder")}</option>
                  {tasks.map((task) => (
                    <option key={task.id} value={task.id}>
                      {task.code ? `${task.code} · ` : ""}
                      {task.title}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <>
                <label className="block space-y-1 text-[11px] font-medium text-slate-700">
                  <span>{t("fieldModule")}</span>
                  <select
                    className={fieldInput}
                    value={draft.module_id}
                    disabled={busy}
                    onChange={(e) => setDraft((prev) => ({ ...prev, module_id: e.target.value }))}
                  >
                    <option value="">{t("fieldModulePlaceholder")}</option>
                    {modules.map((mod) => (
                      <option key={mod.id} value={mod.id}>
                        {mod.name}
                      </option>
                    ))}
                  </select>
                </label>

                {draft.action_type === "new_subtask" && (
                  <label className="block space-y-1 text-[11px] font-medium text-slate-700">
                    <span>{t("fieldParentTask")}</span>
                    <select
                      className={fieldInput}
                      value={draft.parent_task_id}
                      disabled={busy}
                      onChange={(e) =>
                        setDraft((prev) => ({ ...prev, parent_task_id: e.target.value }))
                      }
                    >
                      <option value="">{t("fieldParentTaskPlaceholder")}</option>
                      {tasks.map((task) => (
                        <option key={task.id} value={task.id}>
                          {task.code ? `${task.code} · ` : ""}
                          {task.title}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </>
            )}
          </div>

          {/* Assignees toggle chips */}
          <div className="space-y-1">
            <span className="block text-[11px] font-medium text-slate-700">
              {t("fieldAssignees")}
            </span>
            {members.length === 0 ? (
              <p className="text-[11px] text-slate-400">{t("fieldNoMembers")}</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {members.map((member) => {
                  const selected = draft.assignee_ids.includes(member.id);
                  return (
                    <button
                      key={member.id}
                      type="button"
                      disabled={busy}
                      onClick={() => toggleAssignee(member.id)}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors",
                        selected
                          ? "border-sky-500 bg-sky-50 text-sky-700"
                          : "border-slate-200 bg-white text-slate-600 hover:border-slate-300",
                      )}
                    >
                      {selected && <Check size={10} aria-hidden="true" />}
                      {member.name ?? member.id.slice(0, 6)}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Editable criteria list */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-slate-700">{t("fieldCriteria")}</span>
              <button
                type="button"
                disabled={busy}
                onClick={addCriterion}
                className="inline-flex items-center gap-0.5 text-[11px] font-medium text-sky-700 hover:underline"
              >
                <Plus size={11} aria-hidden="true" />
                {t("addCriterion")}
              </button>
            </div>
            <div className="space-y-1.5">
              {draft.acceptance_criteria.map((criterion, index) => (
                <div key={index} className="flex items-center gap-1.5">
                  <input
                    type="text"
                    className={fieldInput}
                    value={criterion}
                    disabled={busy}
                    placeholder={t("fieldCriteriaPlaceholder")}
                    onChange={(e) => updateCriterion(index, e.target.value)}
                  />
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={t("removeCriterion")}
                    onClick={() => removeCriterion(index)}
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-400 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600"
                  >
                    <Trash2 size={12} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Optional reason */}
          <label className="block space-y-1 text-[11px] font-medium text-slate-700">
            <span>{t("fieldReason")}</span>
            <input
              type="text"
              className={fieldInput}
              value={draft.reason}
              disabled={busy}
              placeholder={t("fieldReasonPlaceholder")}
              onChange={(e) => setDraft((prev) => ({ ...prev, reason: e.target.value }))}
            />
          </label>
        </div>
      )}

      {/* Optional reason input for approval/dismissal when pending_approval */}
      {isPendingApproval && item.can_approve && (
        <div className="mt-2.5">
          <input
            type="text"
            className={fieldInput}
            value={actionReason}
            disabled={busy}
            placeholder={t("fieldReasonPlaceholder")}
            onChange={(e) => setActionReason(e.target.value)}
          />
        </div>
      )}

      {/* Footer actions */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2.5">
        {isPendingReview && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              loading={busy}
              disabled={busy}
              onClick={submitAdopt}
              data-testid={`code-discovery-adopt-${item.id}`}
            >
              {busy ? t("adoptingButton") : t("adoptButton")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onDismiss(draft.reason.trim())}
              data-testid={`code-discovery-dismiss-${item.id}`}
            >
              {busy ? t("dismissingButton") : t("dismissButton")}
            </Button>
          </div>
        )}

        {isPendingApproval && (
          <div className="flex flex-wrap items-center gap-2">
            {item.can_approve && (
              <Button
                type="button"
                size="sm"
                loading={busy}
                disabled={busy}
                onClick={() => onApprove(actionReason.trim())}
                data-testid={`code-discovery-approve-${item.id}`}
              >
                <CheckCircle2 size={13} aria-hidden="true" />
                {busy ? t("approvingButton") : t("approveButton")}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onDismiss(actionReason.trim())}
              data-testid={`code-discovery-dismiss-${item.id}`}
            >
              {busy ? t("dismissingButton") : t("dismissButton")}
            </Button>
          </div>
        )}

        {isAdopted && item.adopted_task_id && (
          <Link
            href={`/projects/${projectId}/tasks/${item.adopted_task_id}`}
            className="gp-link inline-flex items-center gap-1 text-xs font-medium"
          >
            {t("viewAdoptedTask")}
            <ArrowUpRight size={13} aria-hidden="true" />
          </Link>
        )}
      </div>
    </article>
  );
}
