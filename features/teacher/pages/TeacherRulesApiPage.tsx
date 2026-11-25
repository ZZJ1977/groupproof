"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Bell,
  CheckCircle2,
  ClipboardList,
  Folder,
  History,
  Plus,
  Save,
  Send,
  Settings,
  Shield,
  Trash2,
} from "lucide-react";
import { SaveState } from "@/components/common";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { dateTime, errorText } from "@/features/b/ui";
import { MilestoneTemplateEditor } from "@/features/teacher/components/MilestoneTemplateEditor";
import { TeacherFeedbackPill } from "@/features/teacher/components/TeacherFeedbackPill";
import { TeacherSegmentedTabs } from "@/features/teacher/components/TeacherSegmentedTabs";
import { useTeacherPermissions } from "@/features/teacher/hooks/use-teacher-permissions";
import { teacherClassesApi, teacherKeys } from "@/features/teacher/api/teacher-client";
import {
  type CourseRulesData,
  type RuleVersionData,
  newIdempotencyKey,
  teacherRulesApi,
  teacherRulesKeys,
} from "@/features/teacher/api/teacher-rules-client";
import { tr } from "@/lib/i18n/tr";
import { useWorkspace } from "@/lib/workspace";

const panelClass =
  "rounded-[12px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-5 shadow-[var(--gp-shadow-card)]";
const inputClass =
  "w-full rounded-[8px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] px-3 py-2 text-sm text-[var(--gp-ink,#1f2329)] outline-none transition-colors focus:border-[var(--gp-action,#3370ff)] focus:ring-2 focus:ring-[var(--gp-action-soft,#e8f0fe)] disabled:cursor-not-allowed disabled:bg-[var(--gp-surface-subtle,#f8f9fa)] disabled:text-[var(--gp-muted,#646a73)]";
const labelClass = "mb-1.5 block text-xs font-semibold text-[var(--gp-ink-soft,#4e5969)]";

const EMPTY_RULES: CourseRulesData = {
  grouping_mode: "free",
  min_group_size: 1,
  max_group_size: 6,
  post_deadline_policy: "teacher_approval",
  allow_cross_group_transfer: true,
  milestone_template: [],
  require_baseline_review: false,
  require_plan_review: false,
  auto_contribution: true,
  contribution_weights: { task_weight: 50, verification_weight: 30, collaboration_weight: 20 },
  appeal_window_days: 7,
  required_deliverables: [],
  final_presentation: false,
};

export function TeacherRulesApiPage({ courseId }: { courseId: string }) {
  const qc = useQueryClient();
  const { userId } = useWorkspace();
  const perms = useTeacherPermissions(courseId);

  const rulesQuery = useQuery({
    queryKey: teacherRulesKeys.overview(userId, courseId),
    queryFn: () => teacherRulesApi.overview(courseId),
    enabled: Boolean(courseId),
  });

  const classDetailQuery = useQuery({
    queryKey: teacherKeys.classDetail(userId, courseId),
    queryFn: () => teacherClassesApi.detail(courseId),
    enabled: Boolean(courseId),
  });

  const [rules, setRules] = useState<CourseRulesData>(EMPTY_RULES);
  const [minSizeDraft, setMinSizeDraft] = useState<string>(String(EMPTY_RULES.min_group_size));
  const [maxSizeDraft, setMaxSizeDraft] = useState<string>(String(EMPTY_RULES.max_group_size));
  const [newDeliverable, setNewDeliverable] = useState("");
  const [changeSummary, setChangeSummary] = useState("");
  const [publishModal, setPublishModal] = useState(false);
  const [inspectVersion, setInspectVersion] = useState<number | null>(null);
  const [versionDetail, setVersionDetail] = useState<RuleVersionData | null>(null);
  const [saveOutcome, setSaveOutcome] = useState<"clean" | "saved" | "error">("clean");
  const justSavedRef = useRef(false);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    const o = rulesQuery.data;
    if (!o) return;
    const nextRules = o.draft?.rules ?? o.effective_rules;
    setRules(nextRules);
    setMinSizeDraft(String(nextRules.min_group_size));
    setMaxSizeDraft(String(nextRules.max_group_size));
    if (o.draft?.change_summary) setChangeSummary(o.draft.change_summary);
    if (justSavedRef.current) {
      justSavedRef.current = false;
    } else {
      setSaveOutcome("clean");
    }
  }, [rulesQuery.data]);

  const isDirty = useMemo(() => {
    const o = rulesQuery.data;
    if (!o) return false;
    const base = o.draft?.rules ?? o.effective_rules;
    return JSON.stringify(rules) !== JSON.stringify(base);
  }, [rulesQuery.data, rules]);

  const invalidate = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: teacherRulesKeys.overview(userId, courseId) }),
      qc.invalidateQueries({ queryKey: teacherKeys.settings(userId, courseId) }),
      qc.invalidateQueries({ queryKey: teacherKeys.classDetail(userId, courseId) }),
    ]);
  };

  const withSyncedDeadlines = (draft: CourseRulesData): CourseRulesData => ({
    ...draft,
    formation_deadline:
      classDetailQuery.data?.formation_deadline ?? draft.formation_deadline ?? null,
    project_deadline:
      classDetailQuery.data?.project_deadline ?? draft.project_deadline ?? null,
  });

  const saveDraft = useMutation({
    mutationFn: () =>
      teacherRulesApi.saveDraft(
        courseId,
        {
          rules: withSyncedDeadlines(rules),
          change_summary: changeSummary.trim() || "保存规则草稿",
        },
        newIdempotencyKey(),
      ),
    onSuccess: async () => {
      justSavedRef.current = true;
      setSaveOutcome("saved");
      setFeedback({ tone: "success", text: "规则草稿已保存，发布前不会影响新立项。" });
      await invalidate();
    },
    onError: (err) => {
      setSaveOutcome("error");
      setFeedback({ tone: "error", text: errorText(err) });
    },
  });

  const publish = useMutation({
    mutationFn: () =>
      teacherRulesApi.publish(
        courseId,
        {
          change_summary: changeSummary.trim() || "发布课程规则版本",
          rules: withSyncedDeadlines(rules),
        },
        newIdempotencyKey(),
      ),
    onSuccess: async (pub) => {
      justSavedRef.current = true;
      setSaveOutcome("saved");
      setPublishModal(false);
      setChangeSummary("");
      setFeedback({
        tone: "success",
        text: tr("课程规则 v{0} 已发布，里程碑模板已同步用于后续立项。", { 0: pub.version_no }),
      });
      await invalidate();
    },
    onError: (err) => {
      setSaveOutcome("error");
      setFeedback({ tone: "error", text: errorText(err) });
    },
  });

  const openVersion = async (ver: number) => {
    setInspectVersion(ver);
    try {
      const detail = await teacherRulesApi.version(courseId, ver);
      setVersionDetail(detail);
    } catch (err) {
      setFeedback({ tone: "error", text: errorText(err) });
      setInspectVersion(null);
    }
  };

  const hub5Tabs = (
    <TeacherSegmentedTabs
      variant="segmented"
      size="sm"
      ariaLabel={tr("切换子页面")}
      testId="hub5-segmented-tabs"
      activeId="rules"
      items={[
        {
          id: "settings",
          label: tr("基础设置"),
          href: `/teacher/courses/${courseId}/settings`,
          icon: Settings,
        },
        {
          id: "rules",
          label: tr("规则与模板"),
          href: `/teacher/courses/${courseId}/rules`,
          icon: ClipboardList,
        },
        {
          id: "files",
          label: tr("课程资料"),
          href: `/teacher/courses/${courseId}/files`,
          icon: Folder,
        },
        {
          id: "announcements",
          label: tr("课程公告"),
          href: `/teacher/courses/${courseId}/announcements`,
          icon: Bell,
        },
        {
          id: "staff",
          label: tr("助教管理"),
          href: `/teacher/courses/${courseId}/staff`,
          icon: Shield,
          hidden: !perms.isOwner,
        },
      ]}
    />
  );

  if (rulesQuery.isLoading) {
    return (
      <div className="space-y-5">
        {hub5Tabs}
        <div role="status" className="gp-empty">
          {tr("正在加载…")}
        </div>
      </div>
    );
  }

  if (rulesQuery.error || !rulesQuery.data) {
    return (
      <div className="space-y-5">
        {hub5Tabs}
        <div role="alert" className="rounded-[12px] border border-red-200 bg-red-50 p-4 text-xs text-[var(--gp-danger,#d93025)]">
          <p>{errorText(rulesQuery.error)}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => void rulesQuery.refetch()}
          >
            {tr("重试")}
          </Button>
        </div>
      </div>
    );
  }

  const overview = rulesQuery.data;
  const editable = overview.can_edit;
  const weightSum =
    rules.contribution_weights.task_weight +
    rules.contribution_weights.verification_weight +
    rules.contribution_weights.collaboration_weight;
  const weightsInRange =
    Number.isFinite(rules.contribution_weights.task_weight) &&
    Number.isFinite(rules.contribution_weights.verification_weight) &&
    Number.isFinite(rules.contribution_weights.collaboration_weight) &&
    rules.contribution_weights.task_weight >= 0 &&
    rules.contribution_weights.task_weight <= 100 &&
    rules.contribution_weights.verification_weight >= 0 &&
    rules.contribution_weights.verification_weight <= 100 &&
    rules.contribution_weights.collaboration_weight >= 0 &&
    rules.contribution_weights.collaboration_weight <= 100;
  const weightsValid = weightsInRange && weightSum === 100;
  const groupSizesPositive =
    Number.isInteger(rules.min_group_size) &&
    Number.isInteger(rules.max_group_size) &&
    rules.min_group_size >= 1 &&
    rules.min_group_size <= 50 &&
    rules.max_group_size >= 1 &&
    rules.max_group_size <= 50;
  const groupSizesValid =
    groupSizesPositive && rules.min_group_size <= rules.max_group_size;
  const rulesValid = weightsValid && groupSizesValid;
  const weightHint = !weightsInRange
    ? tr("各项权重需在 0%–100% 之间，且合计为 100%")
    : tr("权重合计：{0}%（需等于 100%）", { 0: weightSum });
  const groupSizeHint =
    !Number.isInteger(rules.min_group_size) || rules.min_group_size < 1 || rules.min_group_size > 50
      ? tr("最小组队人数需为 1–50 之间的整数")
      : !Number.isInteger(rules.max_group_size) || rules.max_group_size < 1 || rules.max_group_size > 50
        ? tr("最大组队人数需为 1–50 之间的整数")
        : tr("最小组队人数不能大于最大组队人数");
  const validationHint = !weightsValid
    ? weightHint
    : !groupSizesValid
      ? groupSizeHint
      : undefined;
  const saveState: "clean" | "dirty" | "saving" | "saved" | "error" =
    saveDraft.isPending || publish.isPending
      ? "saving"
      : saveOutcome === "error"
        ? "error"
        : isDirty
          ? "dirty"
          : saveOutcome;

  const publishedRules = overview.current_published?.rules;
  const formationDeadlineValue =
    classDetailQuery.data?.formation_deadline ?? rules.formation_deadline;
  const projectDeadlineValue =
    classDetailQuery.data?.project_deadline ?? rules.project_deadline;

  const updateRules = (updater: (prev: CourseRulesData) => CourseRulesData) => {
    setSaveOutcome("clean");
    setRules(updater);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {hub5Tabs}
        <TeacherFeedbackPill
          tone={feedback?.tone ?? "idle"}
          message={feedback?.text}
          autoHideMs={3500}
          onDismiss={() => setFeedback(null)}
        />
      </div>

      <div className={`${panelClass} flex flex-wrap items-center justify-between gap-3`}>
        <div className="min-w-0">
          <h1 className="text-lg font-bold text-[var(--gp-ink,#1f2329)]">课程规则与评分模板</h1>
          <p className="mt-1 text-xs text-[var(--gp-muted,#646a73)]">
            规则发布后生成不可变版本号；已立项项目继续保留其立项时适用的原规则快照。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {overview.current_published && (
            <span className="gp-tabular inline-flex items-center gap-1 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-[var(--gp-success,#008a5c)]">
              <CheckCircle2 size={13} aria-hidden="true" />
              {tr("当前生效 v{0}", { 0: overview.current_published.version_no })}
            </span>
          )}
          {overview.draft && (
            <span className="gp-tabular rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800">
              {tr("含未发布草稿 v{0}", { 0: overview.draft.version_no })}
            </span>
          )}
          {editable && (
            <>
              <SaveState state={saveState} />
              {!rulesValid && validationHint && (
                <span
                  title={validationHint}
                  className="gp-tabular rounded-full border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-medium text-[var(--gp-danger,#d93025)]"
                >
                  {validationHint}
                </span>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={saveDraft.isPending}
                preserveWidth
                disabled={saveDraft.isPending || !rulesValid}
                title={!rulesValid ? validationHint : undefined}
                onClick={() => {
                  if (!rulesValid) return;
                  saveDraft.mutate();
                }}
              >
                <Save size={14} aria-hidden="true" />
                {tr("保存草稿")}
              </Button>
              <Button
                type="button"
                variant="default"
                size="sm"
                pill
                disabled={!rulesValid || publish.isPending}
                title={!rulesValid ? validationHint : undefined}
                onClick={() => {
                  if (!rulesValid) return;
                  setPublishModal(true);
                }}
              >
                <Send size={14} aria-hidden="true" />
                {tr("发布规则")}
              </Button>
            </>
          )}
        </div>
      </div>

      <div className={`${panelClass} space-y-4`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-[var(--gp-ink,#1f2329)]">组队规则</h2>
          {!groupSizesValid && (
            <span className="text-xs font-medium text-[var(--gp-danger,#d93025)]">
              {groupSizeHint}
            </span>
          )}
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="min-w-0">
            <label className={labelClass} htmlFor="rules-grouping-mode">
              组队模式
            </label>
            <select
              id="rules-grouping-mode"
              name="grouping_mode"
              className={inputClass}
              disabled={!editable}
              value={rules.grouping_mode}
              onChange={(e) =>
                updateRules((prev) => ({
                  ...prev,
                  grouping_mode: e.target.value as "free" | "approval",
                }))
              }
            >
              <option value="free">自由组队</option>
              <option value="approval">审批组队</option>
            </select>
          </div>
          <div className="min-w-0">
            <label className={labelClass} htmlFor="rules-min-group-size">
              最小人数
            </label>
            <input
              id="rules-min-group-size"
              name="min_group_size"
              type="number"
              min={1}
              max={50}
              className={`${inputClass} gp-tabular`}
              disabled={!editable}
              value={minSizeDraft}
              onChange={(e) => {
                const raw = e.target.value;
                setMinSizeDraft(raw);
                const parsed = raw.trim() === "" ? Number.NaN : Number(raw);
                updateRules((prev) => ({ ...prev, min_group_size: parsed }));
              }}
            />
          </div>
          <div className="min-w-0">
            <label className={labelClass} htmlFor="rules-max-group-size">
              最大人数
            </label>
            <input
              id="rules-max-group-size"
              name="max_group_size"
              type="number"
              min={1}
              max={50}
              className={`${inputClass} gp-tabular`}
              disabled={!editable}
              value={maxSizeDraft}
              onChange={(e) => {
                const raw = e.target.value;
                setMaxSizeDraft(raw);
                const parsed = raw.trim() === "" ? Number.NaN : Number(raw);
                updateRules((prev) => ({ ...prev, max_group_size: parsed }));
              }}
            />
          </div>
          <div className="min-w-0">
            <label className={labelClass} htmlFor="rules-post-deadline-policy">
              截止后组队邀请策略
            </label>
            <select
              id="rules-post-deadline-policy"
              name="post_deadline_policy"
              className={inputClass}
              disabled={!editable}
              value={rules.post_deadline_policy}
              onChange={(e) =>
                updateRules((prev) => ({
                  ...prev,
                  post_deadline_policy: e.target.value as "teacher_approval" | "forbidden" | "free",
                }))
              }
            >
              <option value="teacher_approval">需教师审批</option>
              <option value="forbidden">严禁新增</option>
              <option value="free">保持开放</option>
            </select>
          </div>
          <div className="flex items-end pb-2">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--gp-ink-soft,#4e5969)]">
              <input
                type="checkbox"
                disabled={!editable}
                checked={rules.allow_cross_group_transfer}
                onChange={(e) =>
                  updateRules((prev) => ({ ...prev, allow_cross_group_transfer: e.target.checked }))
                }
              />
              允许截止前跨组调换成员
            </label>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-[var(--gp-border-subtle,#ebedf0)] bg-[var(--gp-surface-subtle,#f8f9fa)] px-3.5 py-2.5 text-xs">
          <div className="gp-tabular flex flex-wrap items-center gap-x-4 gap-y-1 text-[var(--gp-ink-soft,#4e5969)]">
            <span className="font-semibold text-[var(--gp-ink,#1f2329)]">{tr("只读")}</span>
            <span>
              {tr("组队截止时间")}：{dateTime(formationDeadlineValue)}
            </span>
            <span>
              {tr("结项截止时间")}：{dateTime(projectDeadlineValue)}
            </span>
          </div>
          <Link
            href={`/teacher/courses/${courseId}/settings`}
            className={buttonVariants({ variant: "tonal", size: "sm", pill: true })}
          >
            {tr("基础设置")}
            <ArrowRight size={13} aria-hidden="true" />
          </Link>
        </div>
      </div>

      <div className={`${panelClass} space-y-4`}>
        <h2 className="text-sm font-semibold text-[var(--gp-ink,#1f2329)]">项目与里程碑模板规则</h2>
        <div className="flex flex-wrap gap-5">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--gp-ink-soft,#4e5969)]">
            <input
              type="checkbox"
              disabled={!editable}
              checked={rules.require_baseline_review}
              onChange={(e) =>
                updateRules((prev) => ({ ...prev, require_baseline_review: e.target.checked }))
              }
            />
            需求基线冻结后提示教师复核
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--gp-ink-soft,#4e5969)]">
            <input
              type="checkbox"
              disabled={!editable}
              checked={rules.require_plan_review}
              onChange={(e) =>
                updateRules((prev) => ({ ...prev, require_plan_review: e.target.checked }))
              }
            />
            任务计划发布后提示教师复核
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--gp-ink-soft,#4e5969)]">
            <input
              type="checkbox"
              disabled={!editable}
              checked={rules.final_presentation}
              onChange={(e) =>
                updateRules((prev) => ({ ...prev, final_presentation: e.target.checked }))
              }
            />
            结项要求现场或视频答辩
          </label>
        </div>

        <MilestoneTemplateEditor
          items={rules.milestone_template}
          editable={editable}
          onChange={(next) => updateRules((prev) => ({ ...prev, milestone_template: next }))}
        />

        <div className="space-y-2 border-t border-[var(--gp-border-subtle,#ebedf0)] pt-4">
          <label className={labelClass} htmlFor="rules-new-deliverable">
            必须提交交付物清单
          </label>
          <div className="flex flex-wrap gap-2">
            {rules.required_deliverables.map((item, idx) => (
              <span
                key={`${item}-${idx}`}
                className="inline-flex items-center gap-1.5 rounded-full bg-[var(--gp-surface-hover,#eff0f1)] px-3 py-1 text-xs text-[var(--gp-ink-soft,#4e5969)]"
              >
                <span>{item}</span>
                {editable && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5 rounded-full text-[var(--gp-muted,#646a73)] hover:text-[var(--gp-danger,#d93025)]"
                    onClick={() =>
                      updateRules((prev) => ({
                        ...prev,
                        required_deliverables: prev.required_deliverables.filter((_, i) => i !== idx),
                      }))
                    }
                    aria-label={tr("删除交付物要求")}
                    title={tr("删除交付物要求")}
                  >
                    <Trash2 size={12} aria-hidden="true" />
                  </Button>
                )}
              </span>
            ))}
          </div>
          {editable && (
            <div className="flex max-w-md flex-wrap items-center gap-2 pt-1">
              <input
                id="rules-new-deliverable"
                className={`${inputClass} min-w-0 flex-1`}
                value={newDeliverable}
                onChange={(e) => setNewDeliverable(e.target.value)}
                placeholder="例如：系统架构设计文档"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  const trimmed = newDeliverable.trim();
                  if (!trimmed) return;
                  updateRules((prev) => ({
                    ...prev,
                    required_deliverables: [...prev.required_deliverables, trimmed],
                  }));
                  setNewDeliverable("");
                }}
              >
                <Plus size={14} aria-hidden="true" />
                添加
              </Button>
            </div>
          )}
        </div>
      </div>

      <div className={`${panelClass} space-y-4`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-[var(--gp-ink,#1f2329)]">评分与申诉规则</h2>
          <span
            className={`gp-tabular text-xs font-medium ${
              weightsValid
                ? "text-[var(--gp-success,#008a5c)]"
                : "text-[var(--gp-danger,#d93025)]"
            }`}
          >
            {weightHint}
          </span>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="min-w-0">
            <label className={labelClass} htmlFor="rules-task-weight">
              任务完成权重 %
            </label>
            <input
              id="rules-task-weight"
              name="task_weight"
              type="number"
              min={0}
              max={100}
              className={`${inputClass} gp-tabular`}
              disabled={!editable}
              value={rules.contribution_weights.task_weight}
              onChange={(e) =>
                updateRules((prev) => ({
                  ...prev,
                  contribution_weights: {
                    ...prev.contribution_weights,
                    task_weight: Number(e.target.value),
                  },
                }))
              }
            />
          </div>
          <div className="min-w-0">
            <label className={labelClass} htmlFor="rules-verification-weight">
              验收质量权重 %
            </label>
            <input
              id="rules-verification-weight"
              name="verification_weight"
              type="number"
              min={0}
              max={100}
              className={`${inputClass} gp-tabular`}
              disabled={!editable}
              value={rules.contribution_weights.verification_weight}
              onChange={(e) =>
                updateRules((prev) => ({
                  ...prev,
                  contribution_weights: {
                    ...prev.contribution_weights,
                    verification_weight: Number(e.target.value),
                  },
                }))
              }
            />
          </div>
          <div className="min-w-0">
            <label className={labelClass} htmlFor="rules-collaboration-weight">
              协作活跃权重 %
            </label>
            <input
              id="rules-collaboration-weight"
              name="collaboration_weight"
              type="number"
              min={0}
              max={100}
              className={`${inputClass} gp-tabular`}
              disabled={!editable}
              value={rules.contribution_weights.collaboration_weight}
              onChange={(e) =>
                updateRules((prev) => ({
                  ...prev,
                  contribution_weights: {
                    ...prev.contribution_weights,
                    collaboration_weight: Number(e.target.value),
                  },
                }))
              }
            />
          </div>
          <div className="min-w-0">
            <label className={labelClass} htmlFor="rules-appeal-window-days">
              结项后申诉窗口（天）
            </label>
            <input
              id="rules-appeal-window-days"
              name="appeal_window_days"
              type="number"
              min={0}
              max={90}
              className={`${inputClass} gp-tabular`}
              disabled={!editable}
              value={rules.appeal_window_days}
              onChange={(e) =>
                updateRules((prev) => ({ ...prev, appeal_window_days: Number(e.target.value) }))
              }
            />
          </div>
        </div>
      </div>

      <div className={`${panelClass} space-y-3`}>
        <div className="flex items-center gap-2">
          <History size={16} className="text-[var(--gp-ink-soft,#4e5969)]" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-[var(--gp-ink,#1f2329)]">规则版本历史</h2>
        </div>
        {overview.versions.length === 0 ? (
          <p className="text-xs text-[var(--gp-muted,#646a73)]">
            尚未发布任何规则版本，当前采用建班默认参数。
          </p>
        ) : (
          <div className="divide-y divide-[var(--gp-border-subtle,#ebedf0)]">
            {overview.versions.map((v) => (
              <div
                key={v.version_no}
                className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-xs"
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="gp-tabular font-semibold text-[var(--gp-ink,#1f2329)]">
                      {tr("版本 v{0}", { 0: v.version_no })}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        v.status === "published"
                          ? "bg-emerald-50 text-[var(--gp-success,#008a5c)]"
                          : v.status === "draft"
                            ? "bg-amber-50 text-amber-800"
                            : "bg-[var(--gp-surface-hover,#eff0f1)] text-[var(--gp-muted,#646a73)]"
                      }`}
                    >
                      {v.status === "published" ? "当前生效" : v.status === "draft" ? "草稿" : "已归档"}
                    </span>
                  </div>
                  <p className="gp-tabular break-words text-[var(--gp-muted,#646a73)]">
                    {v.change_summary}
                    {v.published_at ? ` · ${dateTime(v.published_at)}` : ""}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void openVersion(v.version_no)}
                >
                  查看快照
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <Sheet
        open={publishModal}
        onOpenChange={(open) => {
          if (publish.isPending && !open) return;
          setPublishModal(open);
        }}
      >
        <SheetContent
          side="right"
          className="flex flex-col justify-between"
          onEscapeKeyDown={(event) => {
            if (publish.isPending) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (publish.isPending) event.preventDefault();
          }}
        >
          <div className="space-y-4">
            <SheetHeader className="pr-8">
              <SheetTitle className="text-base font-bold text-[var(--gp-ink,#1f2329)]">
                确认发布新版课程规则
              </SheetTitle>
              <SheetDescription className="text-xs text-[var(--gp-muted,#646a73)]">
                发布后将通知全班教职与学生，里程碑模板将作用于后续新立项小组。
              </SheetDescription>
            </SheetHeader>

            <div className="gp-tabular space-y-1.5 rounded-[10px] border border-[var(--gp-border-subtle,#ebedf0)] bg-[var(--gp-surface-subtle,#f8f9fa)] p-3.5 text-xs text-[var(--gp-ink-soft,#4e5969)]">
              <div>
                {tr("人数区间：{0}-{1} 人", {
                  0: rules.min_group_size,
                  1: rules.max_group_size,
                })}
                {publishedRules &&
                  (publishedRules.min_group_size !== rules.min_group_size ||
                    publishedRules.max_group_size !== rules.max_group_size) && (
                    <span className="ml-2 text-[var(--gp-action-on-soft,#1d4ed8)]">
                      ({publishedRules.min_group_size}-{publishedRules.max_group_size})
                    </span>
                  )}
              </div>
              <div>
                {tr("权重分配：任务 {0}% / 验收 {1}% / 协作 {2}%", {
                  0: rules.contribution_weights.task_weight,
                  1: rules.contribution_weights.verification_weight,
                  2: rules.contribution_weights.collaboration_weight,
                })}
              </div>
              <div>
                {tr("里程碑阶段数：{0}", { 0: rules.milestone_template.length })}
                {publishedRules &&
                  publishedRules.milestone_template.length !== rules.milestone_template.length && (
                    <span className="ml-2 text-[var(--gp-action-on-soft,#1d4ed8)]">
                      ({publishedRules.milestone_template.length})
                    </span>
                  )}
              </div>
            </div>

            <div>
              <label className={labelClass} htmlFor="rules-publish-summary">
                本次变更说明
              </label>
              <input
                id="rules-publish-summary"
                className={inputClass}
                value={changeSummary}
                onChange={(e) => setChangeSummary(e.target.value)}
                placeholder="例如：补充中期检查里程碑要求"
              />
            </div>
          </div>

          <SheetFooter className="border-t border-[var(--gp-border-subtle,#ebedf0)] pt-4">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={publish.isPending}
              onClick={() => setPublishModal(false)}
            >
              {tr("取消")}
            </Button>
            <Button
              type="button"
              variant="default"
              size="sm"
              pill
              loading={publish.isPending}
              preserveWidth
              disabled={publish.isPending || !changeSummary.trim() || !rulesValid}
              onClick={() => {
                if (!rulesValid) return;
                publish.mutate();
              }}
            >
              {tr("确认发布")}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <Dialog
        open={inspectVersion !== null && Boolean(versionDetail)}
        onOpenChange={(open) => {
          if (!open) {
            setInspectVersion(null);
            setVersionDetail(null);
          }
        }}
      >
        <DialogContent>
          {versionDetail && (
            <>
              <DialogHeader className="pr-8">
                <DialogTitle className="text-base font-bold text-[var(--gp-ink,#1f2329)]">
                  {tr("规则版本快照 v{0}", { 0: versionDetail.version_no })}
                </DialogTitle>
                <DialogDescription className="text-xs text-[var(--gp-muted,#646a73)]">
                  {versionDetail.change_summary}
                </DialogDescription>
              </DialogHeader>
              <div className="gp-tabular max-h-72 space-y-1.5 overflow-y-auto rounded-[10px] border border-[var(--gp-border-subtle,#ebedf0)] bg-[var(--gp-surface-subtle,#f8f9fa)] p-3 text-xs text-[var(--gp-ink-soft,#4e5969)]">
                <div>
                  {tr("人数区间：{0}-{1} 人", {
                    0: versionDetail.rules.min_group_size,
                    1: versionDetail.rules.max_group_size,
                  })}
                </div>
                <div>
                  {tr("权重分配：任务 {0}% / 验收 {1}% / 协作 {2}%", {
                    0: versionDetail.rules.contribution_weights.task_weight,
                    1: versionDetail.rules.contribution_weights.verification_weight,
                    2: versionDetail.rules.contribution_weights.collaboration_weight,
                  })}
                </div>
                <div>
                  {tr("里程碑阶段数：{0}", { 0: versionDetail.rules.milestone_template.length })}
                </div>
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setInspectVersion(null);
                    setVersionDetail(null);
                  }}
                >
                  {tr("关闭")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
