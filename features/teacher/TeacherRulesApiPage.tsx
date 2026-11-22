"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, History, Plus, Save, Send, Trash2 } from "lucide-react";
import { button, card, dateTime, errorText, input, label, secondary } from "@/features/b/ui";
import { MilestoneTemplateEditor } from "@/features/teacher/MilestoneTemplateEditor";
import {
  type CourseRulesData,
  type RuleVersionData,
  newIdempotencyKey,
  teacherRulesApi,
  teacherRulesKeys,
} from "@/lib/api/teacher-rules-client";
import { tr } from "@/lib/i18n/tr";
import { useWorkspace } from "@/lib/workspace";

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

  const rulesQuery = useQuery({
    queryKey: teacherRulesKeys.overview(userId, courseId),
    queryFn: () => teacherRulesApi.overview(courseId),
    enabled: Boolean(courseId),
  });

  const [rules, setRules] = useState<CourseRulesData>(EMPTY_RULES);
  const [newDeliverable, setNewDeliverable] = useState("");
  const [changeSummary, setChangeSummary] = useState("");
  const [publishModal, setPublishModal] = useState(false);
  const [inspectVersion, setInspectVersion] = useState<number | null>(null);
  const [versionDetail, setVersionDetail] = useState<RuleVersionData | null>(null);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    const o = rulesQuery.data;
    if (!o) return;
    setRules(o.draft?.rules ?? o.effective_rules);
    if (o.draft?.change_summary) setChangeSummary(o.draft.change_summary);
  }, [rulesQuery.data]);

  const invalidate = async () => {
    await qc.invalidateQueries({ queryKey: teacherRulesKeys.overview(userId, courseId) });
  };

  const saveDraft = useMutation({
    mutationFn: () =>
      teacherRulesApi.saveDraft(
        courseId,
        { rules, change_summary: changeSummary.trim() || "保存规则草稿" },
        newIdempotencyKey(),
      ),
    onSuccess: async () => {
      setFeedback({ tone: "success", text: "规则草稿已保存，发布前不会影响新立项。" });
      await invalidate();
    },
    onError: (err) => setFeedback({ tone: "error", text: errorText(err) }),
  });

  const publish = useMutation({
    mutationFn: () =>
      teacherRulesApi.publish(
        courseId,
        { change_summary: changeSummary.trim() || "发布课程规则版本", rules },
        newIdempotencyKey(),
      ),
    onSuccess: async (pub) => {
      setPublishModal(false);
      setChangeSummary("");
      setFeedback({
        tone: "success",
        text: tr("课程规则 v{0} 已发布，里程碑模板已同步用于后续立项。", { 0: pub.version_no }),
      });
      await invalidate();
    },
    onError: (err) => setFeedback({ tone: "error", text: errorText(err) }),
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

  if (rulesQuery.isLoading) {
    return (
      <div role="status" className="gp-empty">
        正在加载…
      </div>
    );
  }

  if (rulesQuery.error || !rulesQuery.data) {
    return (
      <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-700">
        <p>{errorText(rulesQuery.error)}</p>
        <button type="button" className={`${secondary} mt-3`} onClick={() => void rulesQuery.refetch()}>
          重试
        </button>
      </div>
    );
  }

  const overview = rulesQuery.data;
  const editable = overview.can_edit;
  const weightSum =
    rules.contribution_weights.task_weight +
    rules.contribution_weights.verification_weight +
    rules.contribution_weights.collaboration_weight;

  return (
    <div className="space-y-5">
      <div className={`${card} flex flex-wrap items-center justify-between gap-3`}>
        <div>
          <h1 className="text-lg font-bold text-slate-900">课程规则与评分模板</h1>
          <p className="mt-1 text-xs text-slate-500">
            规则发布后生成不可变版本号；已立项项目继续保留其立项时适用的原规则快照。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {overview.current_published && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
              <CheckCircle2 size={13} />
              {tr("当前生效 v{0}", { 0: overview.current_published.version_no })}
            </span>
          )}
          {overview.draft && (
            <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800">
              {tr("含未发布草稿 v{0}", { 0: overview.draft.version_no })}
            </span>
          )}
          {editable && (
            <>
              <button
                type="button"
                className={secondary}
                disabled={saveDraft.isPending || weightSum !== 100}
                onClick={() => saveDraft.mutate()}
              >
                <Save size={14} />
                {saveDraft.isPending ? "正在保存…" : "保存草稿"}
              </button>
              <button
                type="button"
                className={button}
                disabled={weightSum !== 100}
                onClick={() => setPublishModal(true)}
              >
                <Send size={14} />
                发布规则
              </button>
            </>
          )}
        </div>
      </div>

      {feedback && (
        <div
          role={feedback.tone === "error" ? "alert" : "status"}
          className={`rounded-lg border px-4 py-2.5 text-xs ${
            feedback.tone === "error"
              ? "border-red-200 bg-red-50 text-red-700"
              : "border-emerald-200 bg-emerald-50 text-emerald-800"
          }`}
        >
          {feedback.text}
        </div>
      )}

      <div className={`${card} space-y-4`}>
        <h2 className="text-sm font-semibold text-slate-900">组队规则</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div>
            <label className={label}>组队模式</label>
            <select
              className={input}
              disabled={!editable}
              value={rules.grouping_mode}
              onChange={(e) =>
                setRules((prev) => ({
                  ...prev,
                  grouping_mode: e.target.value as "free" | "approval",
                }))
              }
            >
              <option value="free">自由组队</option>
              <option value="approval">审批组队</option>
            </select>
          </div>
          <div>
            <label className={label}>最小人数</label>
            <input
              type="number"
              min={1}
              max={50}
              className={input}
              disabled={!editable}
              value={rules.min_group_size}
              onChange={(e) =>
                setRules((prev) => ({ ...prev, min_group_size: Number(e.target.value) }))
              }
            />
          </div>
          <div>
            <label className={label}>最大人数</label>
            <input
              type="number"
              min={1}
              max={50}
              className={input}
              disabled={!editable}
              value={rules.max_group_size}
              onChange={(e) =>
                setRules((prev) => ({ ...prev, max_group_size: Number(e.target.value) }))
              }
            />
          </div>
          <div>
            <label className={label}>截止后组队邀请策略</label>
            <select
              className={input}
              disabled={!editable}
              value={rules.post_deadline_policy}
              onChange={(e) =>
                setRules((prev) => ({
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
            <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                disabled={!editable}
                checked={rules.allow_cross_group_transfer}
                onChange={(e) =>
                  setRules((prev) => ({ ...prev, allow_cross_group_transfer: e.target.checked }))
                }
              />
              允许截止前跨组调换成员
            </label>
          </div>
        </div>
      </div>

      <div className={`${card} space-y-4`}>
        <h2 className="text-sm font-semibold text-slate-900">项目与里程碑模板规则</h2>
        <div className="flex flex-wrap gap-5">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              disabled={!editable}
              checked={rules.require_baseline_review}
              onChange={(e) =>
                setRules((prev) => ({ ...prev, require_baseline_review: e.target.checked }))
              }
            />
            需求基线冻结后提示教师复核
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              disabled={!editable}
              checked={rules.require_plan_review}
              onChange={(e) =>
                setRules((prev) => ({ ...prev, require_plan_review: e.target.checked }))
              }
            />
            任务计划发布后提示教师复核
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              disabled={!editable}
              checked={rules.final_presentation}
              onChange={(e) =>
                setRules((prev) => ({ ...prev, final_presentation: e.target.checked }))
              }
            />
            结项要求现场或视频答辩
          </label>
        </div>

        <MilestoneTemplateEditor
          items={rules.milestone_template}
          editable={editable}
          onChange={(next) => setRules((prev) => ({ ...prev, milestone_template: next }))}
        />

        <div className="space-y-2 border-t border-slate-100 pt-4">
          <label className={label}>必须提交交付物清单</label>
          <div className="flex flex-wrap gap-2">
            {rules.required_deliverables.map((item, idx) => (
              <span
                key={`${item}-${idx}`}
                className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700"
              >
                {item}
                {editable && (
                  <button
                    type="button"
                    onClick={() =>
                      setRules((prev) => ({
                        ...prev,
                        required_deliverables: prev.required_deliverables.filter((_, i) => i !== idx),
                      }))
                    }
                    className="text-slate-400 hover:text-red-500"
                    aria-label="删除交付物要求"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </span>
            ))}
          </div>
          {editable && (
            <div className="flex max-w-md gap-2 pt-1">
              <input
                className={input}
                value={newDeliverable}
                onChange={(e) => setNewDeliverable(e.target.value)}
                placeholder="例如：系统架构设计文档"
              />
              <button
                type="button"
                className={secondary}
                onClick={() => {
                  const trimmed = newDeliverable.trim();
                  if (!trimmed) return;
                  setRules((prev) => ({
                    ...prev,
                    required_deliverables: [...prev.required_deliverables, trimmed],
                  }));
                  setNewDeliverable("");
                }}
              >
                <Plus size={14} />
                添加
              </button>
            </div>
          )}
        </div>
      </div>

      <div className={`${card} space-y-4`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">评分与申诉规则</h2>
          <span
            className={`text-xs font-medium ${weightSum === 100 ? "text-emerald-700" : "text-red-600"}`}
          >
            {tr("权重合计：{0}%（需等于 100%）", { 0: weightSum })}
          </span>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <div>
            <label className={label}>任务完成权重 %</label>
            <input
              type="number"
              min={0}
              max={100}
              className={input}
              disabled={!editable}
              value={rules.contribution_weights.task_weight}
              onChange={(e) =>
                setRules((prev) => ({
                  ...prev,
                  contribution_weights: {
                    ...prev.contribution_weights,
                    task_weight: Number(e.target.value),
                  },
                }))
              }
            />
          </div>
          <div>
            <label className={label}>验收质量权重 %</label>
            <input
              type="number"
              min={0}
              max={100}
              className={input}
              disabled={!editable}
              value={rules.contribution_weights.verification_weight}
              onChange={(e) =>
                setRules((prev) => ({
                  ...prev,
                  contribution_weights: {
                    ...prev.contribution_weights,
                    verification_weight: Number(e.target.value),
                  },
                }))
              }
            />
          </div>
          <div>
            <label className={label}>协作活跃权重 %</label>
            <input
              type="number"
              min={0}
              max={100}
              className={input}
              disabled={!editable}
              value={rules.contribution_weights.collaboration_weight}
              onChange={(e) =>
                setRules((prev) => ({
                  ...prev,
                  contribution_weights: {
                    ...prev.contribution_weights,
                    collaboration_weight: Number(e.target.value),
                  },
                }))
              }
            />
          </div>
          <div>
            <label className={label}>结项后申诉窗口（天）</label>
            <input
              type="number"
              min={0}
              max={90}
              className={input}
              disabled={!editable}
              value={rules.appeal_window_days}
              onChange={(e) =>
                setRules((prev) => ({ ...prev, appeal_window_days: Number(e.target.value) }))
              }
            />
          </div>
        </div>
      </div>

      <div className={`${card} space-y-3`}>
        <div className="flex items-center gap-2">
          <History size={16} className="text-slate-600" />
          <h2 className="text-sm font-semibold text-slate-900">规则版本历史</h2>
        </div>
        {overview.versions.length === 0 ? (
          <p className="text-xs text-slate-500">尚未发布任何规则版本，当前采用建班默认参数。</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {overview.versions.map((v) => (
              <div key={v.version_no} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-xs">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-900">
                      {tr("版本 v{0}", { 0: v.version_no })}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        v.status === "published"
                          ? "bg-emerald-50 text-emerald-700"
                          : v.status === "draft"
                            ? "bg-amber-50 text-amber-800"
                            : "bg-slate-100 text-slate-600"
                      }`}
                    >
                      {v.status === "published" ? "当前生效" : v.status === "draft" ? "草稿" : "已归档"}
                    </span>
                  </div>
                  <p className="text-slate-500">
                    {v.change_summary}
                    {v.published_at ? ` · ${dateTime(v.published_at)}` : ""}
                  </p>
                </div>
                <button
                  type="button"
                  className={secondary}
                  onClick={() => void openVersion(v.version_no)}
                >
                  查看快照
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {publishModal && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
        >
          <div className="w-full max-w-md space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-xl">
            <h2 className="text-base font-bold text-slate-900">确认发布新版课程规则</h2>
            <p className="text-xs text-slate-500">
              发布后将通知全班教职与学生，里程碑模板将作用于后续新立项小组。
            </p>
            <div>
              <label className={label} htmlFor="rules-publish-summary">
                本次变更说明
              </label>
              <input
                id="rules-publish-summary"
                className={input}
                value={changeSummary}
                onChange={(e) => setChangeSummary(e.target.value)}
                placeholder="例如：补充中期检查里程碑要求"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className={secondary} onClick={() => setPublishModal(false)}>
                取消
              </button>
              <button
                type="button"
                className={button}
                disabled={publish.isPending || !changeSummary.trim()}
                onClick={() => publish.mutate()}
              >
                {publish.isPending ? "正在发布…" : "确认发布"}
              </button>
            </div>
          </div>
        </div>
      )}

      {inspectVersion !== null && versionDetail && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
        >
          <div className="w-full max-w-lg space-y-3 rounded-xl border border-slate-200 bg-white p-5 shadow-xl">
            <h2 className="text-base font-bold text-slate-900">
              {tr("规则版本快照 v{0}", { 0: versionDetail.version_no })}
            </h2>
            <p className="text-xs text-slate-500">{versionDetail.change_summary}</p>
            <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700 space-y-1.5">
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
            <div className="flex justify-end">
              <button
                type="button"
                className={secondary}
                onClick={() => {
                  setInspectVersion(null);
                  setVersionDetail(null);
                }}
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
