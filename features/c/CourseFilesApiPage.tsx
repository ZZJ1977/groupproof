"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { EmptyState, PageHeader, Panel } from "@/components/common";
import { CApiError } from "@/lib/api/c-client";
import { courseFilesApi, type CourseFileQuery } from "@/lib/api/c-course-files-client";
import { useWorkspace } from "@/lib/workspace";
import { formatDate } from "@/lib/utils";
import type { components } from "@/packages/domain/api.generated";
import { useUrlQuery } from "./use-url-query";
import { accessFailure, ApiPager, apiButton, apiInput, isUuid, pageNumber, queryPolicy, safeHttps, useCommandKey, versionFailure } from "./c-project-api";

type Version = components["schemas"]["CourseFileVersionDTO"];
type SignedLink = components["schemas"]["SignedCourseFileLinkDTO"];
const statuses = { draft: "草稿", current: "已发布", superseded: "历史版本" } as const;
const actions = { created: "登记资料", appended: "替换草稿", published: "发布资料" } as const;
const categories = { all: "全部资料", documents: "文档", images: "图片", exports: "导出资料", archived: "历史版本" } as const;
const sorts = { updated_desc: "最近更新", updated_asc: "较早更新", name_asc: "名称", size_desc: "文件大小" } as const;

function CourseFailure({ error, retry }: { error: unknown; retry?: () => void }) {
  let message = "课程资料暂不可用，请重试；本次输入已保留。";
  if (error instanceof CApiError) {
    if (error.status === 401) message = "当前登录身份无法读取课程资料，请重新登录或重试。";
    if (error.status === 403) message = "课程访问权限已失效，原有资料已隐藏。";
    if (error.status === 404) message = "课程或资料不存在，或当前没有可查看的已发布版本。";
    if (error.status === 409) message = "资料已变化，请刷新并核对版本；发布原因已保留。";
    if (error.status === 422) message = "请检查资料选择和发布原因后重试。";
    if (error.status === 503) message = "资料服务暂不可用，暂不能确认操作结果；请刷新核对后重试。";
  }
  return <div role="alert" className="my-3 rounded-md border border-red-200 p-3"><p>{message}</p>{retry && <button type="button" className={`${apiButton} mt-2`} onClick={retry}>重试</button>}</div>;
}

export function CourseFilesApiPage({ courseId }: { courseId: string }) {
  const { userId } = useWorkspace();
  return <CourseFilesPage key={`${userId}:${courseId}`} courseId={courseId} userId={userId} />;
}

function CourseFilesPage({ courseId, userId }: { courseId: string; userId: string }) {
  const { query, updateQuery } = useUrlQuery();
  const rawCategory = query.get("category") ?? "all";
  const rawSort = query.get("sort") ?? "updated_desc";
  const rawStatus = query.get("status");
  const filters: CourseFileQuery = {
    category: Object.hasOwn(categories, rawCategory) ? rawCategory as keyof typeof categories : "all",
    sort: Object.hasOwn(sorts, rawSort) ? rawSort as keyof typeof sorts : "updated_desc",
    status: rawStatus && Object.hasOwn(statuses, rawStatus) ? rawStatus as keyof typeof statuses : undefined,
    q: query.get("q") || undefined, file_type: query.get("file_type") || undefined,
    page: pageNumber(query.get("page")), page_size: 10,
  };
  const selectedId = query.get("file");
  const enabled = isUuid(courseId);
  const list = useQuery({ queryKey: ["c-course-files", userId, courseId, filters], queryFn: () => courseFilesApi.files(courseId, filters), enabled, ...queryPolicy });
  const detail = useQuery({ queryKey: ["c-course-file", userId, courseId, selectedId], queryFn: () => courseFilesApi.file(courseId, selectedId!), enabled: enabled && Boolean(selectedId && isUuid(selectedId)) && list.isSuccess && !list.isFetching, ...queryPolicy });
  const [command, setCommand] = useState<{ fileId: string; versionId: string; versionNo: number; expected: number; reason: string } | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [blocked, setBlocked] = useState<unknown>(null);
  const [link, setLink] = useState<SignedLink | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const commandKey = useCommandKey();
  const denial = blocked || [list.error, detail.error].find(accessFailure);
  const rows = list.isSuccess && !list.isFetching && !denial ? list.data : undefined;
  const file = rows && detail.isSuccess && !detail.isFetching && !denial ? detail.data : undefined;
  const currentDraft = command && file?.id === command.fileId && file.versions.find((version) => version.id === command.versionId && version.status === "draft" && version.version_no === file.latest_version_no);

  useEffect(() => {
    if (!link) return;
    const timer = window.setTimeout(() => setLink(null), Math.max(0, Date.parse(link.expires_at) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [link]);

  function fail(failure: unknown) {
    setError(failure);
    if (accessFailure(failure)) { setBlocked(failure); setLink(null); setCommand(null); }
  }
  function clearSelection() { setLink(null); setCommand(null); setError(null); setNotice(""); }
  async function refresh() {
    setLink(null);
    const results = await Promise.all([list.refetch(), ...(selectedId && isUuid(selectedId) ? [detail.refetch()] : [])]);
    const denied = results.find((result) => accessFailure(result.error));
    if (denied) fail(denied.error);
    else if (results[0].isSuccess) setBlocked(null);
  }
  async function publish() {
    if (!command || !currentDraft || !rows?.can_write || !command.reason.trim() || locked.current) return;
    locked.current = true; setBusy(true); setError(null); setNotice(""); setLink(null);
    const input = { version_id: command.versionId, expected_version: command.expected, reason: command.reason.trim() };
    try {
      await courseFilesApi.publishVersion(courseId, command.fileId, input, commandKey({ courseId, fileId: command.fileId, input }));
      setCommand(null); setNotice("课程资料已发布，历史版本和冻结项目原引用均已保留；通知尚未发送。");
      await refresh();
    } catch (failure) { fail(failure); }
    finally { locked.current = false; setBusy(false); }
  }
  async function reviewLatest() {
    if (!command || locked.current) return;
    locked.current = true; setBusy(true); setLink(null);
    try {
      const [latest, access] = await Promise.all([detail.refetch(), list.refetch()]);
      if (latest.error || access.error) { fail(latest.error || access.error); return; }
      if (!access.data?.can_write) { setNotice("当前课程资料只读，无法发布。"); return; }
      const version = latest.data?.versions.find((entry) => entry.id === command.versionId);
      if (latest.data?.id !== command.fileId || version?.status !== "draft" || version.version_no !== latest.data.latest_version_no) { setNotice("所选版本已不再是最新草稿，请重新选择；当前原因仍保留。"); return; }
      setCommand({ ...command, expected: latest.data.lock_version }); setError(null);
      setNotice("已读取最新版本，请核对发布原因后再次确认。");
    } finally { locked.current = false; setBusy(false); }
  }
  async function issueLink(version: Version, purpose: "preview" | "download") {
    if (!file || locked.current) return;
    locked.current = true; setBusy(true); setLink(null); setError(null);
    try {
      const next = await courseFilesApi.fileLink(courseId, file.id, version.id, purpose);
      const expires = Date.parse(next.expires_at);
      if (next.version_id !== version.id || next.purpose !== purpose || !safeHttps(next.url) || new URL(next.url).hash || !Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 15 * 60_000) throw new Error("Invalid signed response");
      setLink(next);
    } catch (failure) { fail(failure); }
    finally { locked.current = false; setBusy(false); }
  }
  if (!enabled) return <EmptyState title="课程地址无效" description="请从已授权课程入口打开资料页。" />;
  return <>
    <PageHeader title="课程资料" description="查看课程提供的资料与允许访问的版本历史。" actions={<button type="button" className={apiButton} disabled={busy || list.isFetching} onClick={() => void refresh()}>刷新课程资料</button>} />
    <p className="mb-4 text-sm text-slate-600">文件上传和替换暂不可用。你仍可查询已保存的资料、查看历史版本及申请预览或下载。</p>
    {denial ? <CourseFailure error={denial} retry={() => void refresh()} /> : <>
      {rows && !rows.can_write && <p className="mb-3 text-sm">当前课程资料只读，仅展示你有权查看的版本。</p>}
      <form key={`${rawCategory}:${rawSort}:${rawStatus}:${query.get("q")}:${query.get("file_type")}`} className="mb-4 flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); clearSelection(); updateQuery({ category: String(form.get("category")), sort: String(form.get("sort")), status: String(form.get("status") || "") || null, q: String(form.get("q") || "").trim() || null, file_type: String(form.get("file_type") || "").trim() || null, page: null, file: null }); }}>
        <label>资料分类<select className={`${apiInput} block`} name="category" defaultValue={filters.category}>{Object.entries(categories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>版本状态<select className={`${apiInput} block`} name="status" defaultValue={filters.status ?? ""}><option value="">全部状态</option>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>课程文件名<input className={`${apiInput} block`} name="q" maxLength={200} defaultValue={filters.q ?? ""} /></label>
        <label>文件类型<input className={`${apiInput} block`} name="file_type" maxLength={16} placeholder="如 pdf" defaultValue={filters.file_type ?? ""} /></label>
        <label>排序<select className={`${apiInput} block`} name="sort" defaultValue={filters.sort}>{Object.entries(sorts).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <button className={apiButton} type="submit" disabled={busy}>查询课程资料</button><button className={apiButton} type="button" disabled={busy} onClick={() => { clearSelection(); updateQuery({ category: null, sort: null, status: null, q: null, file_type: null, page: null, file: null }); }}>重置</button>
      </form>
      {list.isFetching && <p role="status">正在读取课程资料…</p>}{list.isError && <CourseFailure error={list.error} retry={() => void refresh()} />}
      {rows && <Panel><div className="gp-table-wrap"><table className="gp-table" aria-label="课程资料列表"><thead><tr><th>资料</th><th>版本</th><th>状态</th><th>大小</th><th>操作</th></tr></thead><tbody>{rows.items.map((item) => <tr key={item.id}><td>{item.name}<p className="text-xs text-slate-500">{item.original_name}</p></td><td>v{item.version_no}</td><td>{statuses[item.status]}</td><td>{(item.size_bytes / 1024).toFixed(1)} KB</td><td><button type="button" className={apiButton} disabled={busy} onClick={() => { clearSelection(); updateQuery({ file: item.file_id }); }}>查看版本</button></td></tr>)}</tbody></table></div>{!rows.items.length && <EmptyState title="没有符合条件的课程资料" />}<ApiPager page={rows.page} pageSize={rows.page_size} total={rows.total} change={(page) => { if (!busy) { clearSelection(); updateQuery({ page: String(page), file: null }); } }} /></Panel>}
      {selectedId && <Panel title="课程资料版本与历史" action={<button type="button" className={apiButton} disabled={busy} onClick={() => { clearSelection(); updateQuery({ file: null }); }}>关闭详情</button>}>
        {!isUuid(selectedId) && <p role="alert">资料地址无效，请重新选择课程资料。</p>}
        {detail.isFetching && <p role="status">正在读取课程资料版本…</p>}{detail.isError && <CourseFailure error={detail.error} retry={() => void detail.refetch()} />}
        {file && <><h2 className="mb-3 font-semibold">{file.name}</h2><div className="space-y-3">{file.versions.map((version) => <article key={version.id} className="rounded-md border border-slate-200 p-3"><strong>v{version.version_no} · {statuses[version.status]}</strong><p>{version.original_name}</p><p className="mb-2 text-xs text-slate-500">{formatDate(version.created_at)} · {(version.size_bytes / 1024).toFixed(1)} KB</p><div className="flex flex-wrap gap-2"><button type="button" className={apiButton} disabled={busy} onClick={() => void issueLink(version, "preview")}>申请预览 v{version.version_no}</button><button type="button" className={apiButton} disabled={busy} onClick={() => void issueLink(version, "download")}>申请下载 v{version.version_no}</button>{rows?.can_write && version.status === "draft" && version.version_no === file.latest_version_no && <button type="button" className={apiButton} disabled={busy} onClick={() => { setCommand({ fileId: file.id, versionId: version.id, versionNo: version.version_no, expected: file.lock_version, reason: "" }); setError(null); setNotice(""); }}>发布 v{version.version_no}</button>}</div></article>)}</div><h3 className="mb-2 mt-5 font-semibold">操作历史</h3>{file.decisions.map((decision) => <p key={decision.id} className="mb-2 text-sm">{actions[decision.action]} · {decision.reason} · {formatDate(decision.created_at)}</p>)}</>}
      </Panel>}
      {command && command.fileId === selectedId && <Panel title={`确认发布 v${command.versionNo}`}><p className="mb-3 text-sm">原发布版本会保留；冻结项目的资料引用不会自动更新。通知发送尚未接入。</p><label htmlFor="course-file-publish-reason">发布原因</label><textarea id="course-file-publish-reason" className={`${apiInput} mt-1 block w-full`} maxLength={4000} value={command.reason} disabled={busy} onChange={(event) => setCommand({ ...command, reason: event.target.value })} /><div className="mt-3 flex gap-2"><button type="button" className={apiButton} disabled={busy || !currentDraft || !rows?.can_write || !command.reason.trim() || versionFailure(error)} onClick={() => void publish()}>{busy ? "保存中…" : "确认发布课程资料"}</button><button type="button" className={apiButton} disabled={busy} onClick={() => setCommand(null)}>取消</button>{versionFailure(error) && <button type="button" className={apiButton} disabled={busy} onClick={() => void reviewLatest()}>刷新并核对版本</button>}</div></Panel>}
      {link && file?.versions.some((version) => version.id === link.version_id) && <p className="my-3"><a className="gp-link" href={link.url} target="_blank" rel="noopener noreferrer">{link.purpose === "preview" ? "打开课程资料预览" : "下载课程资料"}</a><span className="ml-2 text-xs text-slate-500">临时链接，过期后请重新申请。</span></p>}
      {error && <CourseFailure error={error} />}{notice && <p role="status" className="my-3">{notice}</p>}
    </>}
  </>;
}
