"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderPlus } from "lucide-react";
import { Feedback } from "@/shared/components/common";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/shared/components/ui/dialog";
import { newIdempotencyKey } from "@/student/api/b-client";
import { bProjectsApi } from "@/student/api/b-projects";
import { useBErrorMessage } from "@/student/projects/use-b-error";
import { button, input, label, secondary } from "@/shared/lib/b-ui";
import { useUiText } from "@/shared/i18n/use-ui-text";

export function CreateProjectModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const tr = useUiText();
  const router = useRouter();
  const cache = useQueryClient();
  const errorText = useBErrorMessage();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);

  const create = useMutation({
    mutationFn: () => bProjectsApi.createPersonal({ name: name.trim() }, idempotencyKey),
    onSuccess: async (created) => {
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["c-home-summary"] }),
        cache.invalidateQueries({ queryKey: ["b-my-courses"] }),
        cache.invalidateQueries({ queryKey: ["b-project-overview"] }),
      ]);
      onOpenChange(false);
      router.push(`/projects/${encodeURIComponent(created.project_id)}`);
    },
    onError: () => {
      setIdempotencyKey(newIdempotencyKey());
    },
  });

  useEffect(() => {
    if (!open) {
      setName("");
      create.reset();
      setIdempotencyKey(newIdempotencyKey());
      return;
    }
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim() || create.isPending) return;
    create.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[min(92vw,440px)] rounded-2xl border-slate-200/90 p-6 shadow-xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <DialogHeader className="mb-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-sky-50 text-[var(--gp-action)]">
              <FolderPlus size={18} />
            </span>
            <div>
              <DialogTitle className="text-base font-bold text-slate-900">{tr("创建项目")}</DialogTitle>
              <DialogDescription className="mt-0.5 text-xs text-slate-500">
                {tr("输入项目名称即可快速创建独立项目")}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className={label} htmlFor="create-project-modal-name">
              {tr("项目名称")}
            </label>
            <input
              ref={inputRef}
              id="create-project-modal-name"
              className={input}
              placeholder={tr("例如：智能教学辅助平台")}
              value={name}
              maxLength={200}
              required
              disabled={create.isPending}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <p className="text-xs leading-relaxed text-slate-500">
            {tr("创建后自动成为项目组长，简介、成员与仓库集成可在项目总览中继续设置。")}
          </p>

          {create.isError && (
            <div role="alert">
              <Feedback tone="error">{errorText(create.error)}</Feedback>
            </div>
          )}

          <div className="pt-0.5">
            <Link
              href="/courses?intent=create-project"
              onClick={() => onOpenChange(false)}
              className="inline-flex items-center text-xs font-medium text-[var(--gp-action)] hover:underline"
            >
              {tr("需要创建课程项目？前往我的课程 →")}
            </Link>
          </div>

          <DialogFooter className="mt-4 pt-2 border-t border-slate-100">
            <button
              type="button"
              className={secondary}
              disabled={create.isPending}
              onClick={() => onOpenChange(false)}
            >
              {tr("取消")}
            </button>
            <button
              type="submit"
              className={button}
              disabled={!name.trim() || create.isPending}
            >
              {create.isPending ? tr("正在创建…") : tr("创建项目")}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
