"use client";

import { useState } from "react";
import { Copy, Link2, RefreshCw } from "lucide-react";
import { Button } from "@/shared/components/ui/button";
import { tr } from "@/shared/i18n/tr";
import { TeacherFeedbackPill } from "@/teacher/components/TeacherFeedbackPill";

export function InviteCodeCard({
  inviteCode,
  joinUrl,
  canManage,
  compact = false,
  rotating = false,
  errorMessage,
  onRotate,
}: {
  inviteCode: string | null;
  joinUrl: string | null;
  canManage?: boolean;
  compact?: boolean;
  rotating?: boolean;
  errorMessage?: string | null;
  onRotate?: () => void;
}) {
  const [copiedKind, setCopiedKind] = useState<"code" | "link" | "error" | null>(null);
  const [confirmingRotate, setConfirmingRotate] = useState(false);

  const copyText = async (text: string, kind: "code" | "link") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKind(kind);
    } catch {
      setCopiedKind("error");
    }
  };

  const fullJoinUrl =
    joinUrl && typeof window !== "undefined" ? `${window.location.origin}${joinUrl}` : joinUrl;

  const feedbackTone =
    errorMessage || copiedKind === "error"
      ? "error"
      : copiedKind === "code" || copiedKind === "link"
        ? "success"
        : "idle";
  const feedbackMessage = errorMessage
    ? errorMessage
    : copiedKind === "error"
      ? tr("复制失败，请手动复制邀请码。")
      : copiedKind === "code"
        ? tr("已复制邀请码")
        : copiedKind === "link"
          ? tr("已复制加入链接")
          : null;

  return (
    <div className="rounded-[12px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface-subtle,#f8f9fa)] p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold text-[var(--gp-ink-soft,#4e5969)]">班级邀请码</span>
        <TeacherFeedbackPill
          tone={feedbackTone}
          message={feedbackMessage}
          autoHideMs={2200}
          onDismiss={() => setCopiedKind(null)}
        />
      </div>
      {inviteCode ? (
        <>
          <div
            data-testid="teacher-invite-code"
            className={`gp-tabular mt-1.5 break-all rounded-[8px] border border-[var(--gp-border,#dee0e3)] bg-white px-3 py-2 font-mono font-semibold tracking-wider text-[var(--gp-ink,#1f2329)] ${compact ? "text-xs" : "text-sm"}`}
          >
            {inviteCode}
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void copyText(inviteCode, "code")}
            >
              <Copy size={14} />
              复制邀请码
            </Button>
            {fullJoinUrl && (
              <Button
                type="button"
                variant="tonal"
                size="sm"
                pill
                onClick={() => void copyText(fullJoinUrl, "link")}
              >
                <Link2 size={14} />
                复制加入链接
              </Button>
            )}
            {canManage && onRotate && !confirmingRotate && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={rotating}
                onClick={() => setConfirmingRotate(true)}
              >
                <RefreshCw size={14} />
                重置邀请码
              </Button>
            )}
          </div>
          {canManage && onRotate && confirmingRotate && (
            <div className="mt-3 rounded-[8px] border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              <p>旧邀请码会立即失效，已经入班的学生不受影响。</p>
              <div className="mt-2 flex gap-2">
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  pill
                  loading={rotating}
                  preserveWidth
                  onClick={() => {
                    setConfirmingRotate(false);
                    onRotate();
                  }}
                >
                  确认重置
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={rotating}
                  onClick={() => setConfirmingRotate(false)}
                >
                  取消
                </Button>
              </div>
            </div>
          )}
        </>
      ) : (
        <p className="mt-1.5 text-xs text-[var(--gp-muted,#646a73)]">当前暂无可用邀请码</p>
      )}
    </div>
  );
}
