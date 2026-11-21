"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Feedback } from "@/components/common";
import { FeishuChatBinding } from "@/features/feishu-binding/FeishuChatBinding";
import { GithubRepoBinding } from "@/features/github-binding/GithubRepoBinding";
import { projectRequest } from "@/features/github-binding/integration-request";
import { ApiFailure, projectApi, queryPolicy } from "@/features/c/c-project-api";
import { useWorkspace } from "@/lib/workspace";

type Settings = { name: string; project_type: string | null; language: string | null;
  visibility: "members" | "course"; lifecycle: string };
type Reopen = { new_project_id: string; version_label: string; copy_scope: string; reason: string; created_at: string };

export function ProjectSettingsApiPage({ projectId, reopenView }: { projectId: string; reopenView: boolean }) {
  const base = `/api/v1/projects/${projectId}`;
  const { userId } = useWorkspace();
  const context = useQuery({
    queryKey: ["c-project-context", userId, projectId],
    queryFn: () => projectApi.projectContext(projectId),
    ...queryPolicy,
  });
  const access = context.isSuccess ? context.data : null;
  const member = Boolean(access?.actor.is_member);
  const leader = member && Boolean(access?.actor.is_leader);
  const writable = leader && access?.project.lifecycle === "active" && access.permissions.can_manage_files && !context.isFetching;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [history, setHistory] = useState<Reopen[]>([]);
  const [form, setForm] = useState({ name: "", project_type: "", language: "", visibility: "members" as "members" | "course" });
  const [version, setVersion] = useState("");
  const [reason, setReason] = useState("");
  const [scope, setScope] = useState<"full" | "baseline">("full");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    const [next, versions] = await Promise.all([projectRequest<Settings>(`${base}/settings`), projectRequest<Reopen[]>(`${base}/reopens`)]);
    setSettings(next); setHistory(versions);
    setForm({ name: next.name, project_type: next.project_type ?? "", language: next.language ?? "", visibility: next.visibility });
  }, [base]);
  useEffect(() => { if (member) void refresh().catch((failure) => setError(failure.message)); }, [member, refresh]);
  async function save(path: string, method: "POST" | "PUT", body?: unknown) {
    setBusy(true); setError(""); setNotice("");
    try { await projectRequest(path, { method, body }); await Promise.all([refresh(), context.refetch()]); setNotice("已保存"); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  if (context.isError) return <ApiFailure error={context.error} retry={() => void context.refetch()} />;
  if (!access) return <p role="status">正在读取项目权限…</p>;
  if (!member) return <Feedback tone="warning">项目设置和绑定仅对本项目成员开放。</Feedback>;
  return <main className="mx-auto max-w-4xl space-y-5 p-6"><h1 className="text-2xl font-semibold">{reopenView ? "重新开启项目" : "项目设置"}</h1>
    {error && <p role="alert" className="text-red-700">{error}</p>}{notice && <p role="status">{notice}</p>}
    <p>状态：{settings?.lifecycle ?? "读取中"}</p>
    {!reopenView && <><section className="space-y-3 rounded border bg-white p-4"><h2 className="font-semibold">基本设置</h2>
      <input aria-label="项目名称" className="w-full rounded border p-2" value={form.name} readOnly={!writable} onChange={(event) => setForm({ ...form, name: event.target.value })} />
      <input aria-label="项目类型" className="w-full rounded border p-2" value={form.project_type} readOnly={!writable} onChange={(event) => setForm({ ...form, project_type: event.target.value })} />
      <input aria-label="项目语言" className="w-full rounded border p-2" value={form.language} readOnly={!writable} onChange={(event) => setForm({ ...form, language: event.target.value })} />
      <select aria-label="可见范围" value={form.visibility} disabled={!writable} onChange={(event) => setForm({ ...form, visibility: event.target.value as "members" | "course" })}><option value="members">仅项目成员</option><option value="course">课程成员</option></select>
      {leader && <button disabled={!writable || busy || settings?.lifecycle !== "active" || !form.name.trim()} onClick={() => void save(`${base}/settings`, "PUT", form)}>保存设置</button>}
    </section>
    <section id="project-integrations" aria-labelledby="project-integrations-title" className="scroll-mt-20 space-y-3">
      <h2 id="project-integrations-title" className="text-lg font-semibold">项目集成</h2>
      <p className="text-sm text-slate-600">{writable ? "绑定项目仓库和飞书群，团队成员可查看同步的协作记录。" : "当前可查看已绑定的项目资源。仅项目可编辑时，组长可绑定或同步。"}</p>
      <div className="grid gap-4 lg:grid-cols-2">
        <div id="github-integration" className="min-w-0 scroll-mt-20"><GithubRepoBinding projectId={projectId} userId={userId} canManage={writable} /></div>
        <div id="feishu-integration" className="min-w-0 scroll-mt-20"><FeishuChatBinding projectId={projectId} userId={userId} canManage={writable} /></div>
      </div>
    </section>
    {leader && <button disabled={!writable || busy || settings?.lifecycle !== "active"} onClick={() => { if (window.confirm("确认归档？报告、任务和贡献必须已定稿。")) void save(`${base}/archive`, "POST"); }}>确认归档项目</button>}</>}
    {leader && (reopenView || settings?.lifecycle === "archived") && <section className="space-y-3 rounded border bg-white p-4"><h2 className="font-semibold">重新开启</h2><input aria-label="新版本号" placeholder="新版本号" className="w-full rounded border p-2" value={version} onChange={(event) => setVersion(event.target.value)} /><textarea aria-label="重新开启原因" className="w-full rounded border p-2" value={reason} onChange={(event) => setReason(event.target.value)} /><select aria-label="复制范围" value={scope} onChange={(event) => setScope(event.target.value as "full" | "baseline")}><option value="full">复制项目结构</option><option value="baseline">仅复制基线</option></select><button disabled={busy || settings?.lifecycle !== "archived" || !version.trim() || !reason.trim()} onClick={() => void save(`${base}/reopen`, "POST", { version_label: version, reason, copy_scope: scope })}>创建新项目版本</button></section>}
    <section><h2 className="font-semibold">重新开启历史</h2>{history.map((row) => <p key={row.new_project_id}>{row.version_label} · {row.copy_scope} · {row.reason} · <Link className="text-blue-700" href={`/projects/${row.new_project_id}`}>查看新项目</Link></p>)}</section>
  </main>;
}
