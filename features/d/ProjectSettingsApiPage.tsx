"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Archive, RotateCcw, Save } from "lucide-react";
import { Feedback, PageHeader, Section, StateBlock, StatusBadge } from "@/components/common";
import { button, dangerButton, input, label, secondary } from "@/features/b/ui";
import { FeishuChatBinding } from "@/features/feishu-binding/FeishuChatBinding";
import { GithubRepoBinding } from "@/features/github-binding/GithubRepoBinding";
import { projectRequest } from "@/features/github-binding/integration-request";
import { ApiFailure, projectApi, queryPolicy } from "@/features/c/c-project-api";
import { useWorkspace } from "@/lib/workspace";

type Settings = { name: string; project_type: string | null; language: string | null;
  visibility: "members" | "course"; lifecycle: string };
type Reopen = { new_project_id: string; version_label: string; copy_scope: string; reason: string; created_at: string };

const lifecycleLabels: Record<string, string> = {
  active: "进行中",
  archived: "已归档",
};

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
  if (!access) return <StateBlock tone="loading" title="正在读取项目权限…" />;
  if (!member) return <Feedback tone="warning">项目设置和绑定仅对本项目成员开放。</Feedback>;

  return <div className="space-y-6">
    <PageHeader
      title={reopenView ? "重新开启项目" : "项目设置"}
      description="管理项目基础信息、外部仓库与群聊集成，以及项目归档与版本重开。"
      actions={<div className="flex items-center gap-2">
        {settings && <StatusBadge status={settings.lifecycle} label={lifecycleLabels[settings.lifecycle] ?? settings.lifecycle} />}
        <Link className={secondary} href={`/projects/${projectId}`}>返回项目总览</Link>
      </div>}
    />
    {error && <div role="alert"><Feedback tone="error">{error}</Feedback></div>}
    {notice && <Feedback tone="success">{notice}</Feedback>}

    {!reopenView && <>
      <Section title="基本设置" description={writable ? "组长可调整项目信息与课程内可见范围。" : "当前为只读视图。"} surface>
        <div id="project-details" className="scroll-mt-20 space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div><label className={label} htmlFor="proj-set-name">项目名称</label><input id="proj-set-name" aria-label="项目名称" className={input} value={form.name} readOnly={!writable} onChange={(event) => setForm({ ...form, name: event.target.value })} /></div>
            <div><label className={label} htmlFor="proj-set-vis">可见范围</label><select id="proj-set-vis" aria-label="可见范围" className={input} value={form.visibility} disabled={!writable} onChange={(event) => setForm({ ...form, visibility: event.target.value as "members" | "course" })}><option value="members">仅项目成员</option><option value="course">课程成员</option></select></div>
            <div><label className={label} htmlFor="proj-set-type">项目类型</label><input id="proj-set-type" aria-label="项目类型" className={input} placeholder="例如：Web 应用、移动应用" value={form.project_type} readOnly={!writable} onChange={(event) => setForm({ ...form, project_type: event.target.value })} /></div>
            <div><label className={label} htmlFor="proj-set-lang">项目语言</label><input id="proj-set-lang" aria-label="项目语言" maxLength={16} className={input} placeholder="例如：中文、English" value={form.language} readOnly={!writable} onChange={(event) => setForm({ ...form, language: event.target.value })} /></div>
          </div>
          {leader && (
            <div className="flex justify-end">
              <button type="button" className={button} disabled={!writable || busy || settings?.lifecycle !== "active" || !form.name.trim()} onClick={() => void save(`${base}/settings`, "PUT", form)}><Save size={14} />保存设置</button>
            </div>
          )}
        </div>
      </Section>

      <section id="project-integrations" aria-labelledby="project-integrations-title" className="scroll-mt-20 space-y-3">
        <div>
          <h2 id="project-integrations-title" className="text-base font-bold tracking-tight text-slate-900">项目集成</h2>
          <p className="mt-0.5 text-xs text-slate-500">{writable ? "绑定项目仓库和飞书群，团队成员即可实时查看同步的提交与协作记录。" : "当前可查看已绑定的项目资源；仅组长在项目活跃期可绑定或同步。"}</p>
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          <div id="github-integration" className="gp-surface-card min-w-0 scroll-mt-20"><GithubRepoBinding projectId={projectId} userId={userId} canManage={writable} /></div>
          <div id="feishu-integration" className="gp-surface-card min-w-0 scroll-mt-20"><FeishuChatBinding projectId={projectId} userId={userId} canManage={writable} /></div>
        </div>
      </section>

      {leader && (
        <Section title="项目归档" description="归档前需确认所有任务已验收、贡献快照已冻结且结项报告已定稿；归档后项目转为只读快照。" surface>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-slate-600">{settings?.lifecycle === "archived" ? "当前项目已完成归档。" : "完成结项交付后可将项目归档封存。"}</p>
            <button type="button" className={dangerButton} disabled={!writable || busy || settings?.lifecycle !== "active"} onClick={() => { if (window.confirm("确认归档？报告、任务和贡献必须已定稿。")) void save(`${base}/archive`, "POST"); }}><Archive size={14} />确认归档项目</button>
          </div>
        </Section>
      )}
    </>}

    {leader && (reopenView || settings?.lifecycle === "archived") && (
      <Section title="重新开启" description="基于当前归档版本创建一个新的迭代项目，保留历史快照不变。" surface>
        <div className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div><label className={label} htmlFor="reopen-ver">新版本号</label><input id="reopen-ver" aria-label="新版本号" placeholder="例如 v2.0" className={input} value={version} onChange={(event) => setVersion(event.target.value)} /></div>
            <div><label className={label} htmlFor="reopen-scope">复制范围</label><select id="reopen-scope" aria-label="复制范围" className={input} value={scope} onChange={(event) => setScope(event.target.value as "full" | "baseline")}><option value="full">复制项目结构</option><option value="baseline">仅复制基线</option></select></div>
          </div>
          <div><label className={label} htmlFor="reopen-reason">重新开启原因</label><textarea id="reopen-reason" aria-label="重新开启原因" rows={2} placeholder="说明迭代目标或变更原因" className={input} value={reason} onChange={(event) => setReason(event.target.value)} /></div>
          <div className="flex justify-end"><button type="button" className={button} disabled={busy || settings?.lifecycle !== "archived" || !version.trim() || !reason.trim()} onClick={() => void save(`${base}/reopen`, "POST", { version_label: version, reason, copy_scope: scope })}><RotateCcw size={14} />创建新项目版本</button></div>
        </div>
      </Section>
    )}

    {history.length > 0 && (
      <Section title="重新开启历史" surface>
        <div className="divide-y divide-slate-100 text-sm">
          {history.map((row) => (
            <div className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0" key={row.new_project_id}>
              <span><strong className="font-semibold text-slate-900">{row.version_label}</strong> · {row.copy_scope} · {row.reason}</span>
              <Link className="gp-link" href={`/projects/${row.new_project_id}`}>查看新项目 →</Link>
            </div>
          ))}
        </div>
      </Section>
    )}
  </div>;
}
