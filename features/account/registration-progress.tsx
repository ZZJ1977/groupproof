"use client";

import { useTranslations } from "next-intl";
import { AlertCircle, CheckCircle2, Info, ShieldAlert } from "lucide-react";
import type { AccountState, MeDTO } from "@/lib/api/auth-client";
import { cn } from "@/lib/utils";

/**
 * 注册进度派生（2026-10-10）：侧栏、页面内容与「登入」按钮共用同一份推导。
 * 完成状态只来源于后端已保存/已验证的事实（/me 注册 DTO），不看页面访问顺序、
 * 表单本地输入或前端变量；未知/加载中一律不标为完成。
 */

export type StageTone = "done" | "todo" | "optional" | "unknown";
export type StatusTone = "done" | "pending" | "danger" | "muted";

export interface StageView {
  id: "profile" | "email" | "identity" | "security";
  tone: StageTone;
  complete: boolean;
  /** account.progress.* 词条后缀；未知/停用时为空（不显示状态文字） */
  stateKey: string;
}

export interface ProgressView {
  loading: boolean;
  loadFailed: boolean;
  stages: StageView[];
  /** account.progress.* 词条后缀 */
  statusKey: string;
  statusTone: StatusTone;
  requiredCompletedCount: number;
  /** 前三项必填全部完成（「登入」前提；可选账号安全不参与） */
  canEnter: boolean;
  /** 登录邮箱归属待验证（历史账户）：进入业务前需在账号安全补验 */
  loginEmailPending: boolean;
  missingStageIds: string[];
}

const IDENTITY_STATE_KEYS: Record<string, string> = {
  review_required: "stageReviewRequired",
  review_pending: "stageReviewPending",
  review_rejected: "stageReviewRejected",
};

const STATUS_BY_REVIEW: Record<string, string> = {
  review_required: "statusReviewRequired",
  review_pending: "statusReviewPending",
  review_rejected: "statusReviewRejected",
};

export function deriveProgress(
  me: MeDTO | undefined,
  opts: { isError?: boolean; authMethod?: string | null } = {},
): ProgressView {
  const reg = me?.registration;
  const accountState = (reg?.accountState ?? "profile_required") as AccountState;
  const loading = !me && !opts.isError;
  const loadFailed = Boolean(opts.isError);
  const disabled = accountState === "disabled";
  // 事实是否已知：停用账户的状态接口只回状态说明，阶段保持未知（不得标完成）
  const known = Boolean(reg) && !loading && !loadFailed && !disabled;

  const complete = {
    profile: reg?.profileComplete === true,
    email: reg?.schoolEmailVerified === true,
    identity: reg?.identityConfirmed === true,
    security: reg?.securityComplete === true,
  };

  const toneFor = (done: boolean, optional = false): StageTone =>
    !known ? "unknown" : done ? "done" : optional ? "optional" : "todo";
  const stateFor = (done: boolean, pendingKey = "stageTodo", optional = false): string =>
    !known ? "" : done ? "stageDone" : optional ? "stageOptional" : pendingKey;

  const stages: StageView[] = [
    { id: "profile", tone: toneFor(complete.profile), complete: complete.profile, stateKey: stateFor(complete.profile) },
    { id: "email", tone: toneFor(complete.email), complete: complete.email, stateKey: stateFor(complete.email) },
    {
      id: "identity",
      tone: toneFor(complete.identity),
      complete: complete.identity,
      stateKey: stateFor(complete.identity, IDENTITY_STATE_KEYS[reg?.teacherReviewStatus ?? ""] ?? "stageTodo"),
    },
    {
      id: "security",
      tone: toneFor(complete.security, true),
      complete: complete.security,
      stateKey: stateFor(complete.security, "stageTodo", true),
    },
  ];

  let statusKey: string;
  let statusTone: StatusTone;
  if (loading) {
    statusKey = "loading";
    statusTone = "muted";
  } else if (loadFailed) {
    statusKey = "loadFailed";
    statusTone = "danger";
  } else if (disabled) {
    statusKey = "statusDisabled";
    statusTone = "danger";
  } else if (complete.profile && complete.email && complete.identity) {
    statusKey = "done"; // 前三项全部完成：完成注册（不再显示“待完善基本资料”）
    statusTone = "done";
  } else if (!complete.profile) {
    statusKey = "statusProfile";
    statusTone = "pending";
  } else if (!complete.email) {
    statusKey = "statusEmail";
    statusTone = "pending";
  } else {
    statusKey = STATUS_BY_REVIEW[reg?.teacherReviewStatus ?? ""] ?? "statusTodo";
    statusTone = reg?.teacherReviewStatus === "review_rejected" ? "danger" : "pending";
  }

  const requiredIds = ["profile", "email", "identity"] as const;
  const missingStageIds = requiredIds.filter((id) => !complete[id]);
  const requiredCompletedCount = reg?.requiredCompletedCount ?? requiredIds.length - missingStageIds.length;
  const canEnter = !loading && !loadFailed && !disabled && missingStageIds.length === 0;
  const loginEmailPending = Boolean(
    canEnter && reg?.loginEmailVerified === false && reg?.canEnterWorkspace === false && opts.authMethod !== "google",
  );

  return { loading, loadFailed, stages, statusKey, statusTone, requiredCompletedCount, canEnter, loginEmailPending, missingStageIds };
}

/** 总状态提示（侧栏与第 3 页主内容共用；图标 + 文字，不只靠颜色） */
export function ProgressStatusChip({ statusKey, statusTone, className }: { statusKey: string; statusTone: StatusTone; className?: string }) {
  const t = useTranslations("account.progress");
  const Icon = statusTone === "done" ? CheckCircle2 : statusTone === "danger" ? ShieldAlert : statusTone === "pending" ? AlertCircle : Info;
  return (
    <span className={cn("gp-progress-status", className)} data-tone={statusTone}>
      <Icon size={14} aria-hidden="true" />
      {t(statusKey)}
    </span>
  );
}
