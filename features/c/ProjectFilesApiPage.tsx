"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Upload } from "lucide-react";
import { EmptyState, PageHeader, Panel } from "@/components/common";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useWorkspace } from "@/lib/workspace";
import { formatDate } from "@/lib/utils";
import type { components } from "@/packages/domain/api.generated";
import type { ProjectFileQuery } from "@/lib/api/c-client";
import { FileUploadForm } from "./FileUploadForm";
import { FilePreviewContent } from "./FilePreviewContent";
import { FileVersionHistory, groupVersionDecisions } from "./FileVersionHistory";
import { formatBytes } from "./file-preview";
import { useUrlQuery } from "./use-url-query";
import { accessFailure, ApiFailure, ApiPager, apiButton, apiInput, isUuid, pageNumber, projectApi, queryPolicy, safeHttps, useCommandKey, versionFailure } from "./c-project-api";

type FileVersion = components["schemas"]["FileVersionDTO"];
type SignedLink = components["schemas"]["SignedFileLinkDTO"];
type ExternalSyncResult = components["schemas"]["ExternalFilesSyncDTO"];
const statuses = { draft: "草稿", current: "正式", superseded: "历史版本" } as const;
const actions = { created: "登记文件", appended: "追加版本", designated: "设为正式" } as const;
const categories = { all: "全部资料", documents: "文档", images: "图片", exports: "导出文件", archived: "历史版本" } as const;
const sorts = { updated_desc: "最近更新", updated_asc: "较早更新", name_asc: "名称", size_desc: "文件大小" } as const;
const toolbarField = "h-8 rounded-md border border-slate-200/90 bg-white px-2 text-sm text-slate-900 outline-none transition-colors focus:border-sky-500 focus:ring-2 focus:ring-sky-500/15";
const toolbarButton = "inline-flex h-8 items-center justify-center rounded-md border border-slate-200/90 bg-white px-3 text-sm font-medium text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const noRefocus = { refetchOnWindowFocus: false, refetchOnReconnect: false } as const;

function validatedLink(next: SignedLink, versionId: string, purpose: "preview" | "download") {
  const expiry = Date.parse(next.expires_at);
  if (next.version_id !== versionId || next.purpose !== purpose || !safeHttps(next.url) || !Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 15 * 60_000) throw new Error("Invalid signed response");
  return next;
}

export function ProjectFilesApiPage({ projectId }: { projectId: string }) {
  const { userId } = useWorkspace();
  const location = useUrlQuery();
  const selectedId = location.query.get("file")?.toLowerCase() ?? null;
  const versionId = location.query.get("version")?.toLowerCase() ?? null;
  return <FilesPage key={`${userId}:${projectId}`} projectId={projectId} userId={userId}
    {...location} selectedId={selectedId} versionId={versionId} />;
}

function FilesPage({ projectId, userId, query, updateQuery, selectedId, versionId }: ReturnType<typeof useUrlQuery> & {
  projectId: string; userId: string; selectedId: string | null; versionId: string | null;
}) {
  const category = query.get("category") ?? "all";
  const sort = query.get("sort") ?? "updated_desc";
  const status = query.get("status");
  const filters: ProjectFileQuery = { category: Object.hasOwn(categories, category) ? category as keyof typeof categories : "all", sort: Object.hasOwn(sorts, sort) ? sort as keyof typeof sorts : "updated_desc", q: query.get("q") || undefined, file_type: query.get("file_type") || undefined, status: status && Object.hasOwn(statuses, status) ? status as keyof typeof statuses : undefined, page: pageNumber(query.get("page")), page_size: 10 };
  const enabled = isUuid(projectId);
  // No refocus refetch: it would hide and remount an open viewer every time the window regains focus.
  const context = useQuery({ queryKey: ["c-project-context", userId, projectId], queryFn: () => projectApi.projectContext(projectId), enabled, ...queryPolicy, ...noRefocus });
  const list = useQuery({ queryKey: ["c-project-files", userId, projectId, filters], queryFn: () => projectApi.files(projectId, filters), enabled, ...queryPolicy, ...noRefocus });
  const [blocked, setBlocked] = useState<unknown>(null);
  const [operationError, setOperationError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [downloadingIds, setDownloadingIds] = useState<string[]>([]);
  const downloadingRef = useRef<Set<string>>(new Set());
  const [syncResult, setSyncResult] = useState<ExternalSyncResult | null>(null);
  const denial = blocked || [context.error, list.error].find(accessFailure);
  const freshContext = context.isSuccess && !context.isFetching && !denial ? context.data : undefined;
  const rows = list.isSuccess && !list.isFetching && freshContext && !denial ? list.data : undefined;

  function fail(error: unknown) {
    setOperationError(error);
    if (accessFailure(error)) { setBlocked(error); setUploadOpen(false); }
  }
  async function refresh() {
    const results = await Promise.all([context.refetch(), list.refetch()]);
    if (results.some((result) => accessFailure(result.error))) setBlocked(results.find((result) => accessFailure(result.error))?.error);
    else if (results[0].isSuccess && results[1].isSuccess) setBlocked(null);
  }
  function openFile(fileId: string) { updateQuery({ file: fileId, version: null }); setOperationError(null); setNotice(""); }
  function closeFile() { updateQuery({ file: null, version: null }); }
  async function downloadFile(item: { id: string; file_id: string; name: string; original_name: string }) {
    if (downloadingRef.current.has(item.id)) return;
    downloadingRef.current.add(item.id);
    setDownloadingIds(Array.from(downloadingRef.current));
    setOperationError(null);
    try {
      const next = await projectApi.fileLink(projectId, item.file_id, item.id, "download");
      const signed = validatedLink(next, item.id, "download");
      const anchor = document.createElement("a");
      anchor.href = signed.url;
      anchor.download = item.original_name || item.name;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (error) {
      fail(error);
    } finally {
      downloadingRef.current.delete(item.id);
      setDownloadingIds(Array.from(downloadingRef.current));
    }
  }
  async function syncExternal() {
    if (!freshContext?.permissions.can_manage_files || busyRef.current) return;
    busyRef.current = true; setBusy(true); setOperationError(null); setNotice(""); setSyncResult(null);
    try {
      const res = await projectApi.syncExternalFiles(projectId);
      setSyncResult(res);
      const ghAdded = res.github_synced ?? 0;
      const fsAdded = res.feishu_synced ?? 0;
      const matAdded = res.materials_synced ?? 0;
      const totalAdded = ghAdded + fsAdded + matAdded;
      const totalSkipped = (res.github_skipped ?? 0) + (res.feishu_skipped ?? 0) + (res.materials_skipped ?? 0);
      setNotice(
        totalAdded > 0
          ? `已同步 ${totalAdded} 份资料（GitHub README ${ghAdded} 份 · 飞书群文档 ${fsAdded} 份 · 初始化资料 ${matAdded} 份）。`
          : totalSkipped > 0
            ? `外部资料已是最新（共核对 ${totalSkipped} 份，无新增变更）。`
            : "同步完成，暂未发现可导入的新文档。"
      );
      await refresh();
    } catch (error) { fail(error); }
    finally { busyRef.current = false; setBusy(false); }
  }
  if (!enabled) return <EmptyState title="项目地址无效" description="请从已授权项目入口打开资料页。" />;
  const viewerOpen = Boolean(selectedId) && Boolean(freshContext);
  return <>
    <PageHeader
      title="项目资料"
      description={freshContext?.project.name ?? "正在验证项目权限…"}
      actions={
        <div className="flex flex-wrap gap-2">
          {freshContext?.permissions.can_manage_files && (
            <button
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-sky-600 px-3.5 text-sm font-medium text-white shadow-2xs transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
              type="button"
              onClick={() => { setUploadOpen(true); setNotice(""); setOperationError(null); }}
            >
              <Upload aria-hidden="true" className="h-4 w-4" />
              上传文件
            </button>
          )}
          {freshContext?.permissions.can_manage_files && (
            <button
              className={apiButton}
              disabled={busy || context.isFetching || list.isFetching}
              onClick={() => void syncExternal()}
            >
              {busy ? "同步中…" : "同步 GitHub / 飞书资料"}
            </button>
          )}
          <button
            className={apiButton}
            disabled={busy || context.isFetching || list.isFetching}
            onClick={() => void refresh()}
          >
            刷新资料
          </button>
        </div>
      }
    />

    {syncResult && ((syncResult.warnings?.length ?? 0) > 0 || (syncResult.missing_feishu_scopes?.length ?? 0) > 0) && (
      <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50/80 px-4 py-3 text-sm text-amber-900">
        <p className="font-medium">外部资料同步提示</p>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-xs">
          {(syncResult.warnings ?? []).map((w, idx) => <li key={idx}>{w}</li>)}
        </ul>
        {(syncResult.missing_feishu_scopes?.length ?? 0) > 0 && (
          <p className="mt-2 text-xs text-amber-800">
            缺少飞书只读权限：<code className="rounded bg-amber-100 px-1 py-0.5">{(syncResult.missing_feishu_scopes ?? []).join(", ")}</code>
            {syncResult.feishu_auth_url && safeHttps(syncResult.feishu_auth_url) && (
              <>
                {" · "}
                <a className="gp-link" href={syncResult.feishu_auth_url} target="_blank" rel="noopener noreferrer">
                  前往飞书开放平台开通权限
                </a>
              </>
            )}
          </p>
        )}
      </div>
    )}

    {denial ? <ApiFailure error={denial} retry={() => void refresh()} /> : <>
      {context.isFetching && <p role="status">正在验证项目权限…</p>}
      {context.isError && <ApiFailure error={context.error} retry={() => void refresh()} />}
      {freshContext && <>
        {freshContext.permissions.can_manage_files && (
          <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
            <DialogContent className="w-[min(92vw,540px)]">
              <DialogTitle>上传文件</DialogTitle>
              <DialogDescription>从本地选择或拖拽资料上传，保存后作为草稿版本登记，可在查看内容中设为正式。</DialogDescription>
              <div className="mt-4">
                <FileUploadForm
                  scope="project"
                  scopeId={projectId}
                  bare
                  hideLegend
                  denied={fail}
                  onCancel={() => setUploadOpen(false)}
                  saved={() => { setUploadOpen(false); setNotice("文件草稿版本已保存。"); void refresh(); }}
                />
              </div>
            </DialogContent>
          </Dialog>
        )}
        <form key={`${category}:${sort}:${status}:${query.get("q")}:${query.get("file_type")}`} role="search" aria-label="资料筛选" className="mb-3 flex flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); updateQuery({ category: String(form.get("category")), sort: String(form.get("sort")), q: String(form.get("q") ?? "").trim() || null, status: String(form.get("status") ?? "") || null, file_type: String(form.get("file_type") ?? "").trim() || null, page: null, file: null, version: null }); }}>
          <select aria-label="资料分类" title="资料分类" className={toolbarField} name="category" defaultValue={filters.category}>{Object.entries(categories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <select aria-label="版本状态" title="版本状态" className={toolbarField} name="status" defaultValue={filters.status ?? ""}><option value="">全部状态</option>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <input aria-label="文件名" className={`${toolbarField} w-40`} name="q" maxLength={200} placeholder="文件名" defaultValue={filters.q ?? ""} />
          <input aria-label="文件类型" className={`${toolbarField} w-24`} name="file_type" maxLength={16} placeholder="类型，如 pdf" defaultValue={filters.file_type ?? ""} />
          <select aria-label="排序" title="排序" className={toolbarField} name="sort" defaultValue={filters.sort}>{Object.entries(sorts).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <button className={toolbarButton} type="submit" aria-label="查询资料">查询</button>
          <button className={toolbarButton} type="button" onClick={() => updateQuery({ category: null, sort: null, status: null, q: null, file_type: null, page: null, file: null, version: null })}>重置</button>
          {!freshContext.permissions.can_manage_files && <span className="ml-auto text-xs text-slate-500">当前项目资料只读。</span>}
        </form>
        {list.isFetching && <p role="status">正在读取资料…</p>}{list.isError && <ApiFailure error={list.error} retry={() => void refresh()} />}
        {rows && <Panel><div className="gp-table-wrap"><table className="gp-table"><thead><tr><th>资料</th><th>版本</th><th>状态</th><th>大小</th><th>操作</th></tr></thead><tbody>{rows.items.map((item) => {
          const isDownloading = downloadingIds.includes(item.id);
          return <tr key={item.id}><td><button type="button" className="gp-link text-left font-medium" onClick={() => openFile(item.file_id)}>{item.name}</button>{item.original_name !== item.name && <p className="text-xs text-slate-500">{item.original_name}</p>}</td><td>v{item.version_no}</td><td>{statuses[item.status]}</td><td>{formatBytes(item.size_bytes)}</td><td><div className="flex flex-wrap items-center gap-2"><button className={apiButton} type="button" onClick={() => openFile(item.file_id)}>查看内容</button><button className={apiButton} type="button" disabled={isDownloading} aria-busy={isDownloading} onClick={() => void downloadFile(item)}>{isDownloading ? "下载中…" : "下载"}</button></div></td></tr>;
        })}</tbody></table></div>{!rows.items.length && <EmptyState title="没有符合条件的资料" />}<ApiPager page={rows.page} pageSize={rows.page_size} total={rows.total} change={(page) => updateQuery({ page: String(page), file: null, version: null })} /></Panel>}
        {!viewerOpen && operationError !== null && <ApiFailure error={operationError} />}{!viewerOpen && notice && <p role="status" className="my-3">{notice}</p>}
        {viewerOpen && selectedId && <FileViewer key={selectedId} projectId={projectId} userId={userId} fileId={selectedId} versionId={versionId}
          canManage={freshContext.permissions.can_manage_files} onSelectVersion={(nextId) => updateQuery({ version: nextId })}
          onClose={closeFile} onDenied={(error) => setBlocked(error)} onChanged={() => void list.refetch()} />}
      </>}
    </>}
  </>;
}

function FileViewer({ projectId, userId, fileId, versionId, canManage, onSelectVersion, onClose, onDenied, onChanged }: {
  projectId: string; userId: string; fileId: string; versionId: string | null; canManage: boolean;
  onSelectVersion: (versionId: string) => void; onClose: () => void; onDenied: (error: unknown) => void; onChanged: () => void;
}) {
  const detail = useQuery({ queryKey: ["c-project-file", userId, projectId, fileId], queryFn: () => projectApi.file(projectId, fileId), enabled: isUuid(fileId), ...queryPolicy, ...noRefocus });
  const file = detail.data;
  const referencedVersion = file?.versions.find((version) => version.id === versionId);
  const active: FileVersion | undefined = file && (referencedVersion
    ?? file.versions.find((version) => version.status === "current") ?? file.versions.find((version) => version.version_no === file.latest_version_no) ?? file.versions[0]);
  const linkEnabled = Boolean(file && active);
  const linkKey = (purpose: string) => ["c-project-file-link", userId, projectId, file?.id, active?.id, purpose];
  const previewLink = useQuery({ queryKey: linkKey("preview"), queryFn: () => projectApi.fileLink(projectId, file!.id, active!.id, "preview").then((next) => validatedLink(next, active!.id, "preview")), enabled: linkEnabled, ...queryPolicy, ...noRefocus });
  const downloadLink = useQuery({ queryKey: linkKey("download"), queryFn: () => projectApi.fileLink(projectId, file!.id, active!.id, "download").then((next) => validatedLink(next, active!.id, "download")), enabled: linkEnabled, ...queryPolicy, ...noRefocus });
  const [operationError, setOperationError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [historyOpen, setHistoryOpen] = useState(Boolean(versionId));
  const [command, setCommand] = useState<{ versionId: string; expected: number; name: string; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const explicitSwitchRef = useRef(false);
  const pendingFocusRef = useRef(Boolean(versionId));
  const referencedArticle = useRef<HTMLElement>(null);
  const commandKey = useCommandKey();
  const decisionsByVersion = file && groupVersionDecisions(file.decisions);
  const denied = [detail.error, previewLink.error, downloadLink.error].find(accessFailure);
  const downloadExpiry = downloadLink.data?.expires_at;
  const refetchDownload = downloadLink.refetch;

  useEffect(() => {
    if (explicitSwitchRef.current) { explicitSwitchRef.current = false; pendingFocusRef.current = false; return; }
    if (versionId) { pendingFocusRef.current = true; setHistoryOpen(true); }
    else pendingFocusRef.current = false;
  }, [versionId]);
  useEffect(() => {
    if (historyOpen && pendingFocusRef.current && referencedVersion && referencedArticle.current) {
      pendingFocusRef.current = false;
      referencedArticle.current.focus();
    }
  }, [historyOpen, referencedVersion]);
  useEffect(() => { if (denied) onDenied(denied); }, [denied, onDenied]);
  useEffect(() => {
    // Keep the one-click download link valid: renew it shortly before the signed URL expires.
    if (!downloadExpiry) return;
    const delay = Math.max(1000, Date.parse(downloadExpiry) - Date.now() - 10_000);
    const timer = window.setTimeout(() => void refetchDownload(), delay);
    return () => window.clearTimeout(timer);
  }, [downloadExpiry, refetchDownload]);

  function selectVersion(nextId: string) {
    explicitSwitchRef.current = true;
    setOperationError(null);
    onSelectVersion(nextId);
  }
  function fail(error: unknown) {
    setOperationError(error);
    if (accessFailure(error)) { setCommand(null); onDenied(error); }
  }
  async function designate() {
    if (!command || !canManage || busyRef.current) return;
    if (!command.reason.trim()) { setNotice("请填写设为正式的原因。"); return; }
    busyRef.current = true; setBusy(true); setOperationError(null); setNotice("");
    const input = { version_id: command.versionId, expected_version: command.expected, reason: command.reason.trim() };
    try {
      await projectApi.designateFileVersion(projectId, fileId, input, commandKey({ projectId, fileId, input }));
      setCommand(null); setNotice("已设为正式，原正式版本已保留。");
      await detail.refetch(); onChanged();
    } catch (error) { fail(error); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function reviewLatest() {
    if (!command || busyRef.current) return;
    const latest = await detail.refetch();
    if (latest.error) { fail(latest.error); return; }
    if (latest.data) {
      const version = latest.data.versions.find((entry) => entry.id === command.versionId);
      if (version?.status !== "draft" || version.version_no !== latest.data.latest_version_no) { setCommand(null); setOperationError(null); setNotice("所选版本已不再是最新草稿，请重新选择。"); }
      else { setCommand({ ...command, expected: latest.data.lock_version }); setOperationError(null); setNotice("已读取最新状态，请核对原因后再次提交。"); }
    }
  }
  const downloadUrl = active && downloadLink.data?.version_id === active.id ? downloadLink.data.url : undefined;
  const previewUrl = active && previewLink.data?.version_id === active.id ? previewLink.data.url : undefined;
  const downloadAction = downloadUrl
    ? <a className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-sky-600 px-3 text-sm font-medium text-white shadow-2xs transition hover:bg-sky-700" href={downloadUrl} target="_blank" rel="noopener noreferrer" download>下载</a>
    : <button className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-sky-600 px-3 text-sm font-medium text-white shadow-2xs transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50" type="button" disabled aria-busy={downloadLink.isFetching}>下载</button>;

  return <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
    <SheetContent onOpenAutoFocus={(event) => {
      if (pendingFocusRef.current && referencedArticle.current) {
        event.preventDefault();
        pendingFocusRef.current = false;
        referencedArticle.current.focus();
      }
    }} className="flex w-[min(100vw,980px)] flex-col gap-0 p-0">
      <header className="flex flex-wrap items-center gap-2 border-b border-slate-200 py-3 pl-5 pr-12">
        <div className="min-w-0 flex-1">
          <SheetTitle className="truncate text-base font-semibold text-slate-900">{file?.name ?? "文件内容"}</SheetTitle>
          <SheetDescription className="truncate text-xs text-slate-500">
            {active ? `v${active.version_no} · ${statuses[active.status]} · ${formatBytes(active.size_bytes)} · ${formatDate(active.created_at)}` : "正在读取文件信息…"}
          </SheetDescription>
        </div>
        {file && file.versions.length > 1 && active && <select aria-label="切换版本" className={toolbarField} value={active.id} onChange={(event) => selectVersion(event.target.value)}>
          {file.versions.map((version) => <option key={version.id} value={version.id}>{`v${version.version_no}（${statuses[version.status]}）`}</option>)}
        </select>}
        {active && downloadAction}
        {previewUrl && <a className={toolbarButton} href={previewUrl} target="_blank" rel="noopener noreferrer">新窗口打开</a>}
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {detail.isFetching && !file && <p role="status">正在读取文件…</p>}
        {!isUuid(fileId) && <p role="alert">找不到该文件，请从资料列表重新打开。</p>}
        {detail.isError && !denied && <ApiFailure error={detail.error} retry={() => void detail.refetch()} label="重试详情" />}
        {file && versionId && !referencedVersion && <p role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">此文件中找不到证据引用的版本。</p>}
        {operationError !== null && <ApiFailure error={operationError} />}{notice && <p role="status">{notice}</p>}
        {active && (previewLink.isError && !denied
          ? <ApiFailure error={previewLink.error} retry={() => { void previewLink.refetch(); if (downloadLink.isError) void downloadLink.refetch(); }} label="重新获取预览" />
          : previewUrl
            ? <FilePreviewContent key={`${active.id}:${previewUrl}`} version={active} url={previewUrl} downloadUrl={downloadUrl} />
            : <p role="status" className="rounded-md border border-dashed border-slate-200 bg-slate-50 px-3 py-6 text-center text-sm text-slate-600">正在准备预览…</p>)}
        {downloadLink.isError && !previewLink.isError && !denied && <ApiFailure error={downloadLink.error} retry={() => void downloadLink.refetch()} label="重新获取下载链接" />}
        {file && active && <section aria-label="版本与历史" className="rounded-md border border-slate-200">
          <button type="button" className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium text-slate-800" aria-expanded={historyOpen} aria-controls="file-version-history" onClick={() => setHistoryOpen((open) => !open)}>
            <span>版本与历史</span><span aria-hidden="true" className="text-xs text-slate-500">{historyOpen ? "收起" : `共 ${file.versions.length} 个版本`}</span>
          </button>
          <div id="file-version-history" hidden={!historyOpen} className="space-y-3 border-t border-slate-200 p-3">
            {file.versions.map((version) => <article key={version.id}
              ref={version === referencedVersion ? referencedArticle : undefined}
              tabIndex={version === referencedVersion ? -1 : undefined}
              aria-label={version === referencedVersion ? `证据引用的版本 v${version.version_no}` : undefined}
              className={`rounded-md border p-3 ${version === referencedVersion ? "border-blue-600 bg-blue-50" : "border-slate-200"}`}>
              {version === referencedVersion && <p className="mb-1 text-sm font-semibold text-blue-800">证据引用的版本</p>}
              <strong>v{version.version_no} · {statuses[version.status]}</strong><p>{version.original_name}</p><p className="mb-2 text-xs text-slate-500">{formatDate(version.created_at)} · {formatBytes(version.size_bytes)}</p>
              <FileVersionHistory version={version.version_no} decisions={decisionsByVersion?.get(version.id)} labels={actions} />
              <div className="flex flex-wrap gap-2">
                {version.id !== active.id && <button className={apiButton} type="button" onClick={() => selectVersion(version.id)}>预览 v{version.version_no}</button>}
                {canManage && version.status === "draft" && version.version_no === file.latest_version_no && <button className={apiButton} type="button" disabled={busy} onClick={() => { setCommand({ versionId: version.id, expected: file.lock_version, name: `v${version.version_no}`, reason: "" }); setOperationError(null); setNotice(""); }}>设为正式 v{version.version_no}</button>}
              </div>
            </article>)}
            {command && canManage && <Panel title={`确认将 ${command.name} 设为正式`}><p className="mb-3 text-sm">旧正式版本仍可在版本历史中查看。</p><label htmlFor="file-designation-reason">设为正式的原因</label><textarea id="file-designation-reason" className={`${apiInput} mt-1 block w-full`} maxLength={4000} value={command.reason} disabled={busy} onChange={(event) => setCommand({ ...command, reason: event.target.value })} /><div className="mt-3 flex gap-2"><button className={apiButton} disabled={busy} onClick={() => void designate()}>{busy ? "保存中…" : "确认设为正式"}</button><button className={apiButton} disabled={busy} onClick={() => setCommand(null)}>取消</button>{versionFailure(operationError) && <button className={apiButton} disabled={busy} onClick={() => void reviewLatest()}>刷新并核对版本</button>}</div></Panel>}
            {canManage && <FileUploadForm key={file.id} scope="project" scopeId={projectId} target={file} bare denied={fail}
              saved={() => { setNotice("文件草稿版本已保存。"); void detail.refetch(); onChanged(); }} />}
          </div>
        </section>}
      </div>
    </SheetContent>
  </Sheet>;
}
