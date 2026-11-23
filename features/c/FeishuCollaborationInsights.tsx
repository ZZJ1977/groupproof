"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileText,
  MessageSquare,
  Paperclip,
  Sparkles,
  Users,
} from "lucide-react";
import {
  DetailDrawer,
  EmptyState,
  Feedback,
  Section,
  StateBlock,
  StatusBadge,
} from "@/components/common";
import { formatDate } from "@/lib/utils";
import { apiButton, apiPrimaryButton } from "./c-project-api";

export type FeishuInsightCategory =
  | "division_confirm"
  | "task_progress"
  | "doc_review"
  | "decision"
  | "blocker";

export type FeishuInsightStatus = "completed" | "in_progress" | "needs_followup";

export type FeishuInsightAttachment = {
  id: string;
  kind: string;
  name: string | null;
  verified: boolean;
};

export type FeishuInsightMessage = {
  id: string;
  chat_id: string;
  occurred_at: string;
  sender_label: string;
  msg_type: string;
  text: string;
  attachments: FeishuInsightAttachment[];
};

export type FeishuInsightTask = {
  id: string;
  code: string;
  title: string;
  status: string;
};

export type FeishuInsightItem = {
  id: string;
  title: string;
  category: FeishuInsightCategory;
  status: FeishuInsightStatus;
  summary: string;
  judgment_basis: string;
  confirmed_count: number;
  confidence: number;
  linked_tasks: FeishuInsightTask[];
  started_at: string | null;
  ended_at: string | null;
  message_count: number;
  messages: FeishuInsightMessage[];
};

export type FeishuCollaborationInsights = {
  status: "ready" | "not_generated" | "pending" | "failed" | "empty";
  overview: string | null;
  items: FeishuInsightItem[];
  total_messages: number;
  analyzed_messages: number;
  stale: boolean;
  provider: string | null;
  model: string | null;
  is_placeholder: boolean;
  needs_human_review: boolean;
  error_code: string | null;
  generated_at: string | null;
};

const CATEGORY_LABELS: Record<FeishuInsightCategory, string> = {
  division_confirm: "分工与方案确认",
  task_progress: "任务推进",
  doc_review: "文档与规范",
  decision: "团队决策",
  blocker: "待跟进风险",
};

const STATUS_LABELS: Record<FeishuInsightStatus, string> = {
  completed: "已达成",
  in_progress: "推进中",
  needs_followup: "待跟进",
};

function statusTone(status: FeishuInsightStatus): "green" | "blue" | "amber" {
  if (status === "completed") return "green";
  if (status === "in_progress") return "blue";
  return "amber";
}

function StatusIcon({ status }: { status: FeishuInsightStatus }) {
  if (status === "completed") {
    return <CheckCircle2 size={18} className="shrink-0 text-emerald-600" />;
  }
  if (status === "needs_followup") {
    return <AlertTriangle size={18} className="shrink-0 text-amber-600" />;
  }
  return <Clock size={18} className="shrink-0 text-sky-600" />;
}

const SENDER_STYLES = [
  "bg-sky-100 text-sky-800 border-sky-200",
  "bg-emerald-100 text-emerald-800 border-emerald-200",
  "bg-violet-100 text-violet-800 border-violet-200",
  "bg-amber-100 text-amber-900 border-amber-200",
  "bg-rose-100 text-rose-800 border-rose-200",
  "bg-teal-100 text-teal-800 border-teal-200",
];

function senderBadgeClass(senderLabel: string): string {
  let hash = 0;
  for (let i = 0; i < senderLabel.length; i += 1) {
    hash = (hash * 31 + senderLabel.charCodeAt(i)) % SENDER_STYLES.length;
  }
  return SENDER_STYLES[Math.abs(hash) % SENDER_STYLES.length];
}

function formatRange(startedAt: string | null, endedAt: string | null): string {
  if (!startedAt && !endedAt) return "";
  if (startedAt && endedAt && formatDate(startedAt) === formatDate(endedAt)) {
    return formatDate(startedAt);
  }
  if (startedAt && endedAt) {
    return `${formatDate(startedAt)} ~ ${formatDate(endedAt)}`;
  }
  return formatDate(startedAt || endedAt || "");
}

function formatMessageTime(iso: string): string {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  return dt.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function FeishuCollaborationInsightsPanel({
  projectId,
  data,
  loading,
  analyzing,
  canAnalyze,
  onAnalyze,
  onOpenRawMessage,
}: {
  projectId: string;
  data: FeishuCollaborationInsights | undefined;
  loading: boolean;
  analyzing: boolean;
  canAnalyze: boolean;
  onAnalyze: () => void;
  onOpenRawMessage: (messageId: string) => void;
}) {
  const [categoryFilter, setCategoryFilter] = useState<FeishuInsightCategory | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const items = useMemo(() => data?.items ?? [], [data?.items]);
  const counts = useMemo(() => {
    let completed = 0;
    let inProgress = 0;
    let followup = 0;
    for (const item of items) {
      if (item.status === "completed") completed += 1;
      else if (item.status === "in_progress") inProgress += 1;
      else followup += 1;
    }
    return { completed, inProgress, followup };
  }, [items]);

  const filtered = useMemo(
    () => (categoryFilter === "all" ? items : items.filter((item) => item.category === categoryFilter)),
    [categoryFilter, items],
  );

  const selectedInsight = useMemo(
    () => items.find((item) => item.id === selectedId) ?? null,
    [items, selectedId],
  );

  if (loading && !data) {
    return <StateBlock tone="loading" title="正在读取 AI 协作结论" />;
  }

  if (!data || data.status === "empty") {
    return (
      <EmptyState
        title="暂无可分析的飞书群聊消息"
        description="点击右上角「同步飞书记录」拉取群聊后，AI 会自动过滤闲聊并提炼分工确认、任务推进与团队决策结论。"
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-50 px-2.5 py-1 text-xs font-semibold text-sky-700">
                <Sparkles size={13} />
                AI 协作进展分析
              </span>
              <span className="text-xs text-slate-500">
                共 {data.total_messages} 条群聊消息（已过滤系统提示，分析 {data.analyzed_messages} 条有效消息）
              </span>
              {data.stale && (
                <StatusBadge label="有新消息未分析" tone="amber" />
              )}
              {data.generated_at && (
                <span className="text-xs text-slate-400">
                  更新于 {formatDate(data.generated_at)}
                </span>
              )}
            </div>
            {data.overview ? (
              <p className="text-sm leading-6 text-slate-700">{data.overview}</p>
            ) : (
              <p className="text-sm leading-6 text-slate-600">
                AI 会通读群内对话上下文，识别「发送分工/文档 + 成员回复收到/OK/可以」等协作确认信号以及任务推进情况，过滤无关闲聊并生成可回溯原聊天记录的协作结论。
              </p>
            )}
            {items.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
                <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 font-medium text-emerald-700">
                  已达成 {counts.completed}
                </span>
                <span className="rounded-full bg-sky-50 px-2.5 py-0.5 font-medium text-sky-700">
                  推进中 {counts.inProgress}
                </span>
                {counts.followup > 0 && (
                  <span className="rounded-full bg-amber-50 px-2.5 py-0.5 font-medium text-amber-800">
                    待跟进 {counts.followup}
                  </span>
                )}
                <span className="text-slate-400">· AI 判断仅供参考，正式任务验收仍需人工确认</span>
              </div>
            )}
          </div>
          {canAnalyze && (
            <button
              type="button"
              className={apiPrimaryButton}
              disabled={analyzing}
              onClick={onAnalyze}
            >
              <Sparkles size={14} className={analyzing ? "animate-pulse" : ""} />
              {analyzing
                ? "AI 分析群聊中…"
                : data.status === "ready"
                  ? "AI 重新分析"
                  : "AI 分析群聊协作结论"}
            </button>
          )}
        </div>
        {analyzing && (
          <div className="mt-4">
            <Feedback tone="info">
              正在通读 {data.analyzed_messages} 条有效群聊消息并提炼分工确认与任务进展，大约需要 10～20 秒…
            </Feedback>
          </div>
        )}
        {data.status === "failed" && !analyzing && (
          <div className="mt-4">
            <Feedback tone="warning">
              上次 AI 协作分析未能完成（{data.error_code || "AI_UNAVAILABLE"}），请稍后点击「AI 分析群聊协作结论」重试，或切换查看原始聊天记录。
            </Feedback>
          </div>
        )}
      </div>

      {data.status === "not_generated" && !analyzing && (
        <EmptyState
          title="尚未生成 AI 协作结论"
          description="点击上方「AI 分析群聊协作结论」，自动从群聊中提炼分工确认、任务进展与团队决策。"
          action={
            canAnalyze ? (
              <button type="button" className={apiPrimaryButton} onClick={onAnalyze}>
                <Sparkles size={14} />
                立即分析群聊
              </button>
            ) : undefined
          }
        />
      )}

      {data.status === "ready" && items.length === 0 && (
        <EmptyState
          title="暂未识别出明确的协作结论"
          description="当前群聊中未检测到明显的分工确认、文档评审或任务推进记录，可点击「原始聊天记录」查看完整消息。"
        />
      )}

      {items.length > 0 && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="按协作结论类型筛选">
            {(
              [
                ["all", `全部结论 (${items.length})`],
                ["division_confirm", CATEGORY_LABELS.division_confirm],
                ["task_progress", CATEGORY_LABELS.task_progress],
                ["doc_review", CATEGORY_LABELS.doc_review],
                ["decision", CATEGORY_LABELS.decision],
                ["blocker", CATEGORY_LABELS.blocker],
              ] as const
            ).map(([key, label]) => {
              const count = key === "all" ? items.length : items.filter((item) => item.category === key).length;
              if (key !== "all" && count === 0) return null;
              const active = categoryFilter === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setCategoryFilter(key)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                    active
                      ? "bg-slate-900 text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200/80"
                  }`}
                >
                  {key === "all" ? label : `${label} (${count})`}
                </button>
              );
            })}
          </div>

          <div className="space-y-3">
            {filtered.map((item) => (
              <div
                key={item.id}
                className="rounded-2xl border border-slate-200/80 bg-white p-4 transition hover:border-slate-300/90"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <div className="mt-0.5">
                      <StatusIcon status={item.status} />
                    </div>
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-semibold text-slate-900">{item.title}</h3>
                        <StatusBadge
                          label={STATUS_LABELS[item.status]}
                          tone={statusTone(item.status)}
                        />
                        <span className="gp-pill">{CATEGORY_LABELS[item.category]}</span>
                      </div>
                      <p className="text-sm leading-6 text-slate-700">{item.summary}</p>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-1 text-xs text-slate-500">
                        <span className="inline-flex items-center gap-1">
                          <Users size={13} />
                          {item.confirmed_count} 位成员参与/确认
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <MessageSquare size={13} />
                          关联 {item.message_count} 条聊天记录
                        </span>
                        {formatRange(item.started_at, item.ended_at) && (
                          <span>{formatRange(item.started_at, item.ended_at)}</span>
                        )}
                        {item.linked_tasks.length > 0 && (
                          <div className="flex flex-wrap items-center gap-1.5">
                            {item.linked_tasks.map((task) => (
                              <Link
                                key={task.id}
                                href={`/projects/${projectId}/tasks`}
                                className="rounded-md bg-slate-100 px-2 py-0.5 font-medium text-slate-700 hover:bg-sky-50 hover:text-sky-700"
                              >
                                {task.code} {task.title}
                              </Link>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="shrink-0">
                    <button
                      type="button"
                      className={apiButton}
                      onClick={() => setSelectedId(item.id)}
                    >
                      <MessageSquare size={14} />
                      查看聊天记录
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <DetailDrawer
        open={Boolean(selectedInsight)}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
        title={selectedInsight?.title ?? "协作结论详情"}
        description={
          selectedInsight
            ? `${CATEGORY_LABELS[selectedInsight.category]} · ${STATUS_LABELS[selectedInsight.status]} · 关联 ${selectedInsight.message_count} 条聊天记录`
            : undefined
        }
      >
        {selectedInsight && (
          <div className="space-y-5">
            <Section
              title="AI 协作判断依据"
              description="结论由 AI 基于下方真实群聊记录提炼，仅供参考，不自动替代人工任务验收。"
              surface
            >
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge
                    label={STATUS_LABELS[selectedInsight.status]}
                    tone={statusTone(selectedInsight.status)}
                  />
                  <span className="gp-pill">{CATEGORY_LABELS[selectedInsight.category]}</span>
                  <span className="gp-pill">
                    参与/确认 {selectedInsight.confirmed_count} 人
                  </span>
                  <span className="gp-pill">
                    置信度 {Math.round(selectedInsight.confidence * 100)}%
                  </span>
                </div>
                <p className="text-sm leading-6 text-slate-800">{selectedInsight.summary}</p>
                {selectedInsight.judgment_basis && (
                  <div className="rounded-xl bg-slate-50 px-3.5 py-2.5 text-xs leading-5 text-slate-600">
                    <strong className="font-semibold text-slate-700">判断依据：</strong>
                    {selectedInsight.judgment_basis}
                  </div>
                )}
                {selectedInsight.linked_tasks.length > 0 && (
                  <div className="space-y-1.5 pt-1">
                    <p className="text-xs font-semibold text-slate-500">关联项目任务</p>
                    <div className="flex flex-wrap gap-2">
                      {selectedInsight.linked_tasks.map((task) => (
                        <Link
                          key={task.id}
                          href={`/projects/${projectId}/tasks`}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:border-sky-300 hover:text-sky-700"
                        >
                          <FileText size={12} />
                          {task.code} {task.title}
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </Section>

            <Section
              title={`关联聊天记录（${selectedInsight.messages.length} 条）`}
              description="按真实发送时间先后展示支撑该结论的原始飞书群聊记录。"
            >
              <div className="space-y-3">
                {selectedInsight.messages.map((msg) => (
                  <div
                    key={msg.id}
                    className="rounded-xl border border-slate-200/80 bg-slate-50/60 p-3.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${senderBadgeClass(msg.sender_label)}`}
                        >
                          {msg.sender_label}
                        </span>
                        <span className="text-xs text-slate-400">
                          {formatMessageTime(msg.occurred_at)}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="text-xs font-medium text-sky-700 hover:underline"
                        onClick={() => {
                          setSelectedId(null);
                          onOpenRawMessage(msg.id);
                        }}
                      >
                        打开原始记录 →
                      </button>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-800">
                      {msg.text}
                    </p>
                    {msg.attachments.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {msg.attachments.map((att) => (
                          <span
                            key={att.id}
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-700"
                          >
                            <Paperclip size={12} className="text-slate-400" />
                            {att.name || `[${att.kind}]`}
                            {att.verified && (
                              <span className="text-emerald-600">· 已核验</span>
                            )}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Section>
          </div>
        )}
      </DetailDrawer>
    </div>
  );
}
