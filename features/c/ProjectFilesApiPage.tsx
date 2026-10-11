"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { EmptyState, PageHeader, Panel } from "@/components/common";
import { useWorkspace } from "@/lib/workspace";
import { formatDate } from "@/lib/utils";
import type { components } from "@/packages/domain/api.generated";
import type { ProjectFileQuery } from "@/lib/api/c-client";
import { useUrlQuery } from "./use-url-query";
import { accessFailure, ApiFailure, ApiPager, apiButton, apiInput, isUuid, pageNumber, projectApi, queryPolicy, safeHttps, useCommandKey, versionFailure } from "./c-project-api";

type FileVersion = components["schemas"]["FileVersionDTO"];
type SignedLink = components["schemas"]["SignedFileLinkDTO"];
const statuses = { draft: "草稿", current: "正式", superseded: "历史版本" } as const;
const actions = { created: "登记文件", appended: "追加版本", designated: "设为正式" } as const;
const categories = { all: "全部资料", documents: "文档", images: "图片", exports: "导出文件", archived: "历史版本" } as const;
const sorts = { updated_desc: "最近更新", updated_asc: "较早更新", name_asc: "名称", size_desc: "文件大小" } as const;

export function ProjectFilesApiPage({ projectId }: { projectId: string }) {
  const { userId } = useWorkspace();
  return <FilesPage key={`${userId}:${projectId}`} projectId={projectId} userId={userId} />;
}

function FilesPage({ projectId, userId }: { projectId: string; userId: string }) {
  const { query, updateQuery } = useUrlQuery();
  const category = query.get("category") ?? "all";
  const sort = query.get("sort") ?? "updated_desc";
  const status = query.get("status");
  const filters: ProjectFileQuery = { category: Object.hasOwn(categories, category) ? category as keyof typeof categories : "all", sort: Object.hasOwn(sorts, sort) ? sort as keyof typeof sorts : "updated_desc", q: query.get("q") || undefined, file_type: query.get("file_type") || undefined, status: status && Object.hasOwn(statuses, status) ? status as keyof typeof statuses : undefined, page: pageNumber(query.get("page")), page_size: 10 };
  const selectedId = query.get("file");
  const enabled = isUuid(projectId);
  const context = useQuery({ queryKey: ["c-project-context", userId, projectId], queryFn: () => projectApi.projectContext(projectId), enabled, ...queryPolicy });
  const list = useQuery({ queryKey: ["c-project-files", userId, projectId, filters], queryFn: () => projectApi.files(projectId, filters), enabled, ...queryPolicy });
  const detail = useQuery({ queryKey: ["c-project-file", userId, projectId, selectedId], queryFn: () => projectApi.file(projectId, selectedId!), enabled: enabled && Boolean(selectedId && isUuid(selectedId)) && context.isSuccess && !context.isFetching, ...queryPolicy });
  const [blocked, setBlocked] = useState<unknown>(null);
  const [operationError, setOperationError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [command, setCommand] = useState<{ fileId: string; versionId: string; expected: number; name: string; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [link, setLink] = useState<SignedLink | null>(null);
  const commandKey = useCommandKey();
  const denial = blocked || [context.error, list.error, detail.error].find(accessFailure);
  const freshContext = context.isSuccess && !context.isFetching && !denial ? context.data : undefined;
  const file = detail.isSuccess && !detail.isFetching && !denial ? detail.data : undefined;
  const rows = list.isSuccess && !list.isFetching && freshContext && !denial ? list.data : undefined;

  useEffect(() => {
    if (!link) return;
    const delay = Date.parse(link.expires_at) - Date.now();
    const timer = window.setTimeout(() => setLink(null), Math.max(0, delay));
    return () => window.clearTimeout(timer);
  }, [link]);

  function fail(error: unknown) {
    setOperationError(error);
    if (accessFailure(error)) { setBlocked(error); setCommand(null); setLink(null); }
  }
  async function refresh() {
    setLink(null);
    const results = await Promise.all([context.refetch(), list.refetch(), ...(selectedId ? [detail.refetch()] : [])]);
    if (results.some((result) => accessFailure(result.error))) { setCommand(null); setBlocked(results.find((result) => accessFailure(result.error))?.error); }
    else if (results[0].isSuccess && results[1].isSuccess) setBlocked(null);
  }
  async function designate() {
    if (!command || !freshContext?.permissions.can_manage_files || busyRef.current) return;
    if (!command.reason.trim()) { setNotice("请填写设为正式的原因。"); return; }
    busyRef.current = true; setBusy(true); setOperationError(null); setNotice("");
    const input = { version_id: command.versionId, expected_version: command.expected, reason: command.reason.trim() };
    try {
      await projectApi.designateFileVersion(projectId, command.fileId, input, commandKey({ projectId, fileId: command.fileId, input }));
      setCommand(null); setNotice("已设为正式，原正式版本已保留。");
      await refresh();
    } catch (error) { fail(error); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function issueLink(version: FileVersion, purpose: "preview" | "download") {
    if (!file || !freshContext || busyRef.current) return;
    busyRef.current = true; setBusy(true); setLink(null); setOperationError(null);
    try {
      const next = await projectApi.fileLink(projectId, file.id, version.id, purpose);
      const expiry = Date.parse(next.expires_at);
      if (next.version_id !== version.id || next.purpose !== purpose || !safeHttps(next.url) || !Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 15 * 60_000) throw new Error("Invalid signed response");
      setLink(next);
    } catch (error) { fail(error); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function reviewLatest() {
    if (!command || busyRef.current) return;
    const [latest, access] = await Promise.all([detail.refetch(), context.refetch()]);
    const error = latest.error || access.error;
    if (error) { fail(error); return; }
    if (latest.data && access.data?.permissions.can_manage_files) {
      const version = latest.data.versions.find((entry) => entry.id === command.versionId);
      if (version?.status !== "draft" || version.version_no !== latest.data.latest_version_no) { setCommand(null); setOperationError(null); setNotice("所选版本已不再是最新草稿，请重新选择。"); }
      else { setCommand({ ...command, expected: latest.data.lock_version }); setOperationError(null); setNotice("已读取最新状态，请核对原因后再次提交。"); }
    }
  }
  if (!enabled) return <EmptyState title="项目地址无效" description="请从已授权项目入口打开资料页。" />;
  return <>
    <PageHeader title="项目资料" description={freshContext?.project.name ?? "正在验证项目权限…"} actions={<button className={apiButton} disabled={busy || context.isFetching || list.isFetching} onClick={() => void refresh()}>刷新资料</button>} />
    <p className="mb-4 text-sm text-slate-600">真实文件上传尚未接入，目前可查询已有资料、查看历史及申请预览或下载。新建和替换上传暂不可用。</p>
    {denial ? <ApiFailure error={denial} retry={() => void refresh()} /> : <>
      {context.isFetching && <p role="status">正在验证项目权限…</p>}
      {context.isError && <ApiFailure error={context.error} retry={() => void refresh()} />}
      {freshContext && <>
        {!freshContext.permissions.can_manage_files && <p className="mb-3 text-sm">当前项目资料只读。</p>}
        <form key={`${category}:${sort}:${status}:${query.get("q")}:${query.get("file_type")}`} className="mb-4 flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); updateQuery({ category: String(form.get("category")), sort: String(form.get("sort")), q: String(form.get("q") ?? "").trim() || null, status: String(form.get("status") ?? "") || null, file_type: String(form.get("file_type") ?? "").trim() || null, page: null, file: null }); setCommand(null); setLink(null); }}>
          <label>资料分类<select className={`${apiInput} block`} name="category" defaultValue={filters.category}>{Object.entries(categories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>版本状态<select className={`${apiInput} block`} name="status" defaultValue={filters.status ?? ""}><option value="">全部状态</option>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>文件名<input className={`${apiInput} block`} name="q" maxLength={200} defaultValue={filters.q ?? ""} /></label>
          <label>文件类型<input className={`${apiInput} block`} name="file_type" maxLength={16} placeholder="如 pdf" defaultValue={filters.file_type ?? ""} /></label>
          <label>排序<select className={`${apiInput} block`} name="sort" defaultValue={filters.sort}>{Object.entries(sorts).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <button className={apiButton} type="submit">查询资料</button><button className={apiButton} type="button" onClick={() => { updateQuery({ category: null, sort: null, status: null, q: null, file_type: null, page: null, file: null }); setCommand(null); setLink(null); }}>重置</button>
        </form>
        {list.isFetching && <p role="status">正在读取资料…</p>}{list.isError && <ApiFailure error={list.error} retry={() => void refresh()} />}
        {rows && <Panel><div className="gp-table-wrap"><table className="gp-table"><thead><tr><th>资料</th><th>版本</th><th>状态</th><th>大小</th><th>操作</th></tr></thead><tbody>{rows.items.map((item) => <tr key={item.id}><td>{item.name}<p className="text-xs text-slate-500">{item.original_name}</p></td><td>v{item.version_no}</td><td>{statuses[item.status]}</td><td>{(item.size_bytes / 1024).toFixed(1)} KB</td><td><button className={apiButton} onClick={() => { updateQuery({ file: item.file_id }); setCommand(null); setLink(null); setOperationError(null); }}>查看版本</button></td></tr>)}</tbody></table></div>{!rows.items.length && <EmptyState title="没有符合条件的资料" />}<ApiPager page={rows.page} pageSize={rows.page_size} total={rows.total} change={(page) => { updateQuery({ page: String(page), file: null }); setCommand(null); setLink(null); }} /></Panel>}
        {selectedId && <Panel title="资料版本与历史" action={<button className={apiButton} onClick={() => { updateQuery({ file: null }); setCommand(null); setLink(null); }}>关闭详情</button>}>
          {detail.isFetching && <p role="status">正在读取版本…</p>}{detail.isError && <ApiFailure error={detail.error} retry={() => void detail.refetch()} label="重试详情" />}
          {file && <><h2 className="mb-3 font-semibold">{file.name}</h2><div className="space-y-3">{file.versions.map((version) => <article key={version.id} className="rounded-md border border-slate-200 p-3"><strong>v{version.version_no} · {statuses[version.status]}</strong><p>{version.original_name}</p><p className="mb-2 text-xs text-slate-500">{formatDate(version.created_at)} · {(version.size_bytes / 1024).toFixed(1)} KB</p><div className="flex flex-wrap gap-2"><button className={apiButton} disabled={busy} onClick={() => void issueLink(version, "preview")}>申请预览 v{version.version_no}</button><button className={apiButton} disabled={busy} onClick={() => void issueLink(version, "download")}>申请下载 v{version.version_no}</button>{freshContext.permissions.can_manage_files && version.status === "draft" && version.version_no === file.latest_version_no && <button className={apiButton} disabled={busy} onClick={() => { setCommand({ fileId: file.id, versionId: version.id, expected: file.lock_version, name: `v${version.version_no}`, reason: "" }); setOperationError(null); setNotice(""); }}>设为正式 v{version.version_no}</button>}</div></article>)}</div><h3 className="mb-2 mt-5 font-semibold">操作历史</h3>{file.decisions.map((decision) => <p key={decision.id} className="mb-2 text-sm">{actions[decision.action]} · {decision.reason} · {formatDate(decision.created_at)}</p>)}</>}
        </Panel>}
        {command && command.fileId === selectedId && freshContext.permissions.can_manage_files && <Panel title={`确认将 ${command.name} 设为正式`}><p className="mb-3 text-sm">旧正式版本会保留；已冻结的资料引用不会被改写。</p><label htmlFor="file-designation-reason">设为正式的原因</label><textarea id="file-designation-reason" className={`${apiInput} mt-1 block w-full`} maxLength={4000} value={command.reason} disabled={busy} onChange={(event) => setCommand({ ...command, reason: event.target.value })} /><div className="mt-3 flex gap-2"><button className={apiButton} disabled={busy || !file} onClick={() => void designate()}>{busy ? "保存中…" : "确认设为正式"}</button><button className={apiButton} disabled={busy} onClick={() => setCommand(null)}>取消</button>{versionFailure(operationError) && <button className={apiButton} disabled={busy} onClick={() => void reviewLatest()}>刷新并核对版本</button>}</div></Panel>}
        {link && file?.versions.some((version) => version.id === link.version_id) && <p className="my-3"><a className="gp-link" href={link.url} target="_blank" rel="noopener noreferrer">{link.purpose === "preview" ? "打开预览" : "下载文件"}</a><span className="ml-2 text-xs text-slate-500">临时链接，过期后请重新申请。</span></p>}
        {operationError && <ApiFailure error={operationError} />}{notice && <p role="status" className="my-3">{notice}</p>}
      </>}
    </>}
  </>;
}
