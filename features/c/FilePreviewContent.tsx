"use client";

import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import type { components } from "@/packages/domain/api.generated";
import { formatDate } from "@/lib/utils";
import { MarkdownPreview } from "./MarkdownPreview";
import { formatBytes, PREVIEW_TEXT_LIMIT, previewKind, readTextLimited } from "./file-preview";
import { apiButton, queryPolicy } from "./c-project-api";

type FileVersion = components["schemas"]["FileVersionDTO"];

async function fetchPreviewText(url: string) {
  const response = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return readTextLimited(response);
}

function prettyText(text: string, version: FileVersion) {
  if (version.extension.toLowerCase() === "json" || version.mime_type === "application/json") {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
  }
  return text;
}

function Notice({ children, role }: { children: React.ReactNode; role?: "status" | "alert" }) {
  return <p role={role} className="rounded-md border border-dashed border-slate-200 bg-slate-50 px-3 py-6 text-center text-sm text-slate-600">{children}</p>;
}

function Fallback({ openUrl, downloadUrl, reason }: { openUrl: string; downloadUrl?: string; reason: string }) {
  return <div role="alert" className="space-y-2 rounded-md border border-amber-200 bg-amber-50/70 px-3 py-4 text-sm text-amber-900">
    <p>{reason}</p>
    <p className="flex flex-wrap gap-3">
      <a className="gp-link" href={openUrl} target="_blank" rel="noopener noreferrer">在新窗口打开</a>
      {downloadUrl && <a className="gp-link" href={downloadUrl} target="_blank" rel="noopener noreferrer" download>直接下载</a>}
    </p>
  </div>;
}

export function FilePreviewContent({ version, url, downloadUrl }: { version: FileVersion; url: string; downloadUrl?: string }) {
  const kind = previewKind(version);
  const textual = kind === "markdown" || kind === "text";
  const content = useQuery({ queryKey: ["c-project-file-text", url], queryFn: () => fetchPreviewText(url), enabled: textual, ...queryPolicy, refetchOnWindowFocus: false, refetchOnReconnect: false });

  if (kind === "image") {
    // eslint-disable-next-line @next/next/no-img-element -- short-lived signed storage URL, not optimisable by next/image
    return <div className="flex justify-center rounded-md border border-slate-200 bg-slate-50 p-3"><img src={url} alt={version.original_name} referrerPolicy="no-referrer" className="max-h-[70vh] max-w-full object-contain" /></div>;
  }
  if (kind === "pdf") {
    return <div className="space-y-2">
      <iframe src={url} title={`${version.original_name} PDF 预览`} referrerPolicy="no-referrer" className="h-[70vh] w-full rounded-md border border-slate-200 bg-white" />
      <p className="text-xs text-slate-500">若浏览器未显示 PDF，请<a className="gp-link mx-1" href={url} target="_blank" rel="noopener noreferrer">在新窗口打开</a>{downloadUrl && <>或<a className="gp-link ml-1" href={downloadUrl} target="_blank" rel="noopener noreferrer" download>直接下载</a></>}。</p>
    </div>;
  }
  if (textual) {
    if (content.isPending) return <Notice role="status">正在读取文件内容…</Notice>;
    if (content.isError) return <Fallback openUrl={url} downloadUrl={downloadUrl} reason="无法在此处显示文件内容（可能是链接已过期或存储服务限制了页面读取）。可在新窗口打开或下载查看。" />;
    const { text, truncated } = content.data;
    return <div className="space-y-2">
      {truncated && <p role="status" className="text-xs text-amber-800">文件较大，仅显示前 {formatBytes(PREVIEW_TEXT_LIMIT)}，完整内容请下载查看。</p>}
      {!text.trim() ? <Notice>文件内容为空。</Notice> : kind === "markdown"
        ? <div className="rounded-md border border-slate-200 bg-white px-5 py-3"><MarkdownPreview source={text} /></div>
        : <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-slate-200 bg-slate-50 p-3 font-mono text-[13px] leading-6 text-slate-800" data-testid="text-preview">{prettyText(text, version)}</pre>}
    </div>;
  }
  return <div className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-6 py-8 text-center">
    <FileText aria-hidden="true" className="h-10 w-10 text-slate-400" />
    <p className="break-all font-medium text-slate-900">{version.original_name}</p>
    <p className="text-sm text-slate-600">此类型文件暂不支持在线预览。</p>
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-left text-xs text-slate-600">
      <dt>类型</dt><dd className="break-all">{version.mime_type || version.extension || "未知"}</dd>
      <dt>大小</dt><dd>{formatBytes(version.size_bytes)}</dd>
      <dt>上传时间</dt><dd>{formatDate(version.created_at)}</dd>
    </dl>
    {downloadUrl ? <a className={apiButton} href={downloadUrl} target="_blank" rel="noopener noreferrer" download>下载文件</a> : <button className={apiButton} type="button" disabled>下载文件</button>}
  </div>;
}
