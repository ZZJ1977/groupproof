"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, BookOpen, FolderPlus } from "lucide-react";
import { Feedback, Panel } from "@/components/common";
import { bProjectsApi } from "@/lib/api/b-projects";
import { button, input, label, secondary } from "./ui";

export function IndependentProjectPage() {
  const t = useTranslations("pages.independentProject");
  const router = useRouter();
  const cache = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const create = useMutation({
    mutationFn: () => bProjectsApi.createPersonal({ name: name.trim(), description: description.trim() || null }),
    onSuccess: async (project) => {
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["c-home-summary"] }),
        cache.invalidateQueries({ queryKey: ["b-my-courses"] }),
        cache.invalidateQueries({ queryKey: ["b-project-overview"] }),
      ]);
      router.push(`/projects/${project.project_id}`);
    },
  });
  return (
    <div className="mx-auto max-w-lg py-6 sm:py-10">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sky-50 text-[var(--gp-action)]">
            <FolderPlus size={20} />
          </span>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">{t("title")}</h1>
            <p className="mt-0.5 text-xs text-slate-500">{t("description")}</p>
          </div>
        </div>
        <Link href="/home" className={`${secondary} !min-h-8 !px-3 !py-1.5 !text-xs`}>{t("back")}</Link>
      </div>

      <Panel className="rounded-2xl border-slate-200/85 shadow-sm">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() && !create.isPending) create.mutate();
          }}
        >
          <div>
            <label className={label} htmlFor="project-name">{t("name")}</label>
            <input
              id="project-name"
              className={input}
              value={name}
              maxLength={200}
              required
              autoFocus
              disabled={create.isPending}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div>
            <label className={label} htmlFor="project-description">{t("summary")}</label>
            <textarea
              id="project-description"
              className={input}
              rows={4}
              maxLength={2000}
              value={description}
              disabled={create.isPending}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          {create.isError && <div role="alert"><Feedback tone="error">{create.error.message}</Feedback></div>}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="submit" className={`${button} w-full sm:w-auto`} disabled={!name.trim() || create.isPending}>
              {create.isPending ? t("creating") : t("title")}
            </button>
          </div>
        </form>
      </Panel>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200/80 bg-slate-50/70 px-4 py-3.5 text-sm">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 font-semibold text-slate-800">
            <BookOpen size={14} className="text-teal-600" />
            <span>{t("courseTitle")}</span>
          </div>
          <p className="mt-0.5 text-xs text-slate-500">{t("courseDescription")}</p>
        </div>
        <Link href="/courses?intent=create-project" className={`${secondary} !min-h-8 !px-3 !py-1.5 !text-xs`}>
          {t("courseAction")}
          <ArrowRight size={13} />
        </Link>
      </div>
    </div>
  );
}
