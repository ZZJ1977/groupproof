"use client";

import { useState } from "react";
import { Check, Copy, Link2, RefreshCw } from "lucide-react";
import { button, secondary } from "@/features/b/ui";

export function InviteCodeCard({
  inviteCode,
  joinUrl,
  canManage,
  compact = false,
  rotating = false,
  onRotate,
}: {
  inviteCode: string | null;
  joinUrl: string | null;
  canManage?: boolean;
  compact?: boolean;
  rotating?: boolean;
  onRotate?: () => void;
}) {
  const [copiedKind, setCopiedKind] = useState<"code" | "link" | null>(null);
  const [confirmingRotate, setConfirmingRotate] = useState(false);

  const copyText = async (text: string, kind: "code" | "link") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKind(kind);
      window.setTimeout(() => setCopiedKind(null), 2000);
    } catch {
      setCopiedKind(null);
    }
  };

  const fullJoinUrl =
    joinUrl && typeof window !== "undefined" ? `${window.location.origin}${joinUrl}` : joinUrl;

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold text-slate-600">班级邀请码</span>
        {copiedKind && (
          <span role="status" className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600">
            <Check size={13} />
            {copiedKind === "code" ? "已复制邀请码" : "已复制加入链接"}
          </span>
        )}
      </div>
      {inviteCode ? (
        <>
          <div
            data-testid="teacher-invite-code"
            className={`mt-1.5 break-all rounded border border-slate-200 bg-white px-3 py-2 font-mono font-semibold tracking-wider text-slate-900 ${compact ? "text-xs" : "text-sm"}`}
          >
            {inviteCode}
          </div>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <button
              type="button"
              className={secondary}
              onClick={() => void copyText(inviteCode, "code")}
            >
              <Copy size={14} />
              复制邀请码
            </button>
            {fullJoinUrl && (
              <button
                type="button"
                className={secondary}
                onClick={() => void copyText(fullJoinUrl, "link")}
              >
                <Link2 size={14} />
                复制加入链接
              </button>
            )}
            {canManage && onRotate && !confirmingRotate && (
              <button
                type="button"
                className={secondary}
                disabled={rotating}
                onClick={() => setConfirmingRotate(true)}
              >
                <RefreshCw size={14} />
                重置邀请码
              </button>
            )}
          </div>
          {canManage && onRotate && confirmingRotate && (
            <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              <p>旧邀请码会立即失效，已经入班的学生不受影响。</p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  className={button}
                  disabled={rotating}
                  onClick={() => {
                    setConfirmingRotate(false);
                    onRotate();
                  }}
                >
                  {rotating ? "正在重置…" : "确认重置"}
                </button>
                <button
                  type="button"
                  className={secondary}
                  disabled={rotating}
                  onClick={() => setConfirmingRotate(false)}
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <p className="mt-1.5 text-xs text-slate-500">当前暂无可用邀请码</p>
      )}
    </div>
  );
}
