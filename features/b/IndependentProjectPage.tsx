"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Feedback, PageHeader, Panel } from "@/components/common";
import { createBClient } from "@/lib/api/b-client";
import { button, input, label, secondary } from "./ui";

const request = createBClient();
export function IndependentProjectPage() {
  const t = useTranslations("pages.independentProject");
  const router = useRouter();
  const cache = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const create = useMutation({
    mutationFn: () => request<{ project_id: string }>({ method: "POST", path: "/api/v1/a/projects", body: { name: name.trim(), description: description.trim() || null } }),
    onSuccess: async (project) => {
      await cache.invalidateQueries({ queryKey: ["c-home-summary"] });
      router.push(`/projects/${project.project_id}`);
    },
  });
  return <div>
    <PageHeader title={t("title")} description={t("description")} actions={<Link href="/home" className={secondary}>{t("back")}</Link>} />
    <Panel className="mt-6">
      <form className="max-w-3xl space-y-6" onSubmit={event => { event.preventDefault(); if (name.trim() && !create.isPending) create.mutate(); }}>
        <div><label className={label} htmlFor="project-name">{t("name")}</label><input id="project-name" className={input} value={name} maxLength={200} required onChange={event => setName(event.target.value)} /></div>
        <div><label className={label} htmlFor="project-description">{t("summary")}</label><textarea id="project-description" className={input} rows={5} maxLength={2000} value={description} onChange={event => setDescription(event.target.value)} /></div>
        {create.isError && <div role="alert"><Feedback tone="error">{create.error.message}</Feedback></div>}
        <button className={button} disabled={!name.trim() || create.isPending}>{create.isPending ? t("creating") : t("title")}</button>
      </form>
    </Panel>
    <Panel className="mt-5"><h2 className="font-semibold">{t("courseTitle")}</h2><p className="my-3 text-sm text-slate-600">{t("courseDescription")}</p><Link href="/courses?intent=create-project" className={secondary}>{t("courseAction")}</Link></Panel>
  </div>;
}
