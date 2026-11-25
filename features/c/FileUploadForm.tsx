"use client";

import { useEffect, useId, useRef, useState, type DragEvent, type FormEvent } from "react";
import { AlertCircle, CheckCircle2, FileArchive, FileSpreadsheet, FileText, Image as ImageIcon, Loader2, Upload, X } from "lucide-react";
import { CApiError } from "@/lib/api/c-client";
import { courseFilesApi } from "@/lib/api/c-course-files-client";
import { DirectPutFallbackError, sendFile, sendFileDirect, uploadAccept, verifyFile } from "@/lib/api/c-storage-upload";
import { formatBytes } from "./file-preview";
import { projectApi, useCommandKey } from "./c-project-api";

type Category = "documents" | "images" | "exports";
type ReviewedFile = { lock_version: number; latest_version_no: number; latestName: string };
type Props = {
  scope: "course" | "project";
  scopeId: string;
  target?: { id: string; lock_version: number; name: string };
  saved: () => void;
  denied: (error: CApiError) => void;
  onCancel?: () => void;
  /** Render without the card chrome, for use inside a dialog or drawer section. */
  bare?: boolean;
  hideLegend?: boolean;
};

const fieldClass =
  "h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-500/15 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500";
const primaryButtonClass =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-sky-600 px-4 text-sm font-medium text-white shadow-2xs transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButtonClass =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 text-sm font-medium text-slate-700 shadow-2xs transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg"]);
const ARCHIVE_EXTENSIONS = new Set(["zip"]);
const SHEET_EXTENSIONS = new Set(["csv", "xls", "xlsx"]);

function extensionOf(name: string) {
  return name.includes(".") ? name.split(".").pop()?.toLowerCase() ?? "" : "";
}

function FileKindIcon({ name }: { name: string }) {
  const ext = extensionOf(name);
  if (IMAGE_EXTENSIONS.has(ext)) return <ImageIcon aria-hidden="true" className="h-5 w-5 text-sky-600" />;
  if (ARCHIVE_EXTENSIONS.has(ext)) return <FileArchive aria-hidden="true" className="h-5 w-5 text-amber-600" />;
  if (SHEET_EXTENSIONS.has(ext)) return <FileSpreadsheet aria-hidden="true" className="h-5 w-5 text-emerald-600" />;
  return <FileText aria-hidden="true" className="h-5 w-5 text-sky-600" />;
}

export function FileUploadForm({ scope, scopeId, target, saved, denied, onCancel, bare = false, hideLegend = false }: Props) {
  const fileInputId = useId();
  const categoryId = useId();
  const reasonId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [reason, setReason] = useState("");
  const [category, setCategory] = useState<Category>("documents");
  const [status, setStatus] = useState("");
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState("");
  const receipt = useRef<{ id: string; verified: boolean } | null>(null);
  const [review, setReview] = useState<"required" | ReviewedFile | null>(null);
  const operation = useRef<AbortController | null>(null);
  const commandKey = useCommandKey();
  const busy = Boolean(status);
  useEffect(() => () => operation.current?.abort(), []);

  function selectFile(next: File | null) {
    setFile(next);
    receipt.current = null;
    setError("");
    commandKey.reset();
    if (!target && next) {
      const ext = extensionOf(next.name);
      setCategory(IMAGE_EXTENSIONS.has(ext) ? "images" : "documents");
    }
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (!busy) setDragging(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (busy) return;
    const dropped = event.dataTransfer.files?.[0] ?? null;
    if (dropped) selectFile(dropped);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setError("");
    try {
      if (target && review === "required") {
        setStatus("正在读取最新文件版本…");
        const latest = scope === "project" ? await projectApi.file(scopeId, target.id) : await courseFilesApi.file(scopeId, target.id);
        controller.signal.throwIfAborted();
        const returnedScope = "project_id" in latest ? latest.project_id : latest.course_id;
        const version = latest.versions.find((item) => item.version_no === latest.latest_version_no);
        if (latest.id !== target.id || returnedScope.toLowerCase() !== scopeId.toLowerCase() || !version) {
          throw new Error("无法核对最新文件版本，请重试。");
        }
        setReview({ lock_version: latest.lock_version, latest_version_no: version.version_no, latestName: version.original_name });
        return;
      }
      if (!receipt.current) {
        setStatus("正在上传到存储服务…");
        setPercent(0);
        try {
          const id = await sendFile(scope, scopeId, file, controller.signal, setPercent);
          receipt.current = { id, verified: false };
        } catch (uploadFailure) {
          if (controller.signal.aborted) return;
          const shouldFallback =
            (uploadFailure instanceof CApiError && uploadFailure.code === "FILE_STORAGE_UNAVAILABLE") ||
            uploadFailure instanceof DirectPutFallbackError;
          if (!shouldFallback) throw uploadFailure;
          setStatus("正在上传到存储服务…");
          setPercent(0);
          const id = await sendFileDirect(scope, scopeId, file, controller.signal, setPercent);
          receipt.current = { id, verified: true };
        }
      }
      const upload = receipt.current;
      if (!upload.verified) {
        setPercent(null);
        setStatus("正在校验并登记文件…");
        await verifyFile(scope, scopeId, file, upload.id, controller.signal);
        upload.verified = true;
      }
      controller.signal.throwIfAborted();
      setPercent(null);
      setStatus("正在校验并登记文件…");
      const effectiveReason = reason.trim() || (target ? "上传新版本" : "本地上传资料");
      const common = { reason: effectiveReason, receipt_id: upload.id };
      if (target) {
        const input = { ...common, expected_version: (typeof review === "object" && review) ? review.lock_version : target.lock_version };
        const key = commandKey({ scope, scopeId, fileId: target.id, input });
        if (scope === "project") await projectApi.appendFileVersion(scopeId, target.id, input, key, controller.signal);
        else await courseFilesApi.appendVersion(scopeId, target.id, input, key, controller.signal);
      } else {
        const input = { ...common, category };
        const key = commandKey({ scope, scopeId, input });
        if (scope === "project") await projectApi.registerFile(scopeId, input, key, controller.signal);
        else await courseFilesApi.registerFile(scopeId, input, key, controller.signal);
      }
      if (!controller.signal.aborted) {
        receipt.current = null;
        commandKey.reset();
        saved();
      }
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (failure instanceof CApiError) {
        if (failure.status === 401 || failure.status === 403) {
          receipt.current = null;
          denied(failure);
          return;
        }
        if (target && failure.code === "VERSION_CONFLICT") {
          setReview("required");
          setError("文件已有变动。请核对最新版本后再追加草稿。");
          return;
        }
        if (failure.code === "FILE_NAME_EXISTS") {
          setError("项目中已存在同名文件，请在文件详情的「版本与历史」中上传新版本，或重命名后再上传。");
          return;
        }
        if (["UPLOAD_NOT_FOUND", "UPLOAD_NOT_RECEIVED", "UPLOAD_REJECTED", "UPLOAD_RECEIPT_INVALID", "UPLOAD_RECEIPT_EXPIRED"].includes(failure.code)) {
          receipt.current = null;
        }
        setError(failure.status === 404 || failure.status === 503 ? "上传服务暂不可用，请稍后重试。" : failure.message);
      } else {
        setError(failure instanceof Error ? failure.message : "上传失败，请重试。");
      }
    } finally {
      operation.current = null;
      if (!controller.signal.aborted) {
        setStatus("");
        setPercent(null);
      }
    }
  }

  return (
    <form className={bare ? "space-y-4" : "my-4 space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-xs"} onSubmit={submit}>
      <fieldset disabled={busy} className="space-y-4">
        <legend className={hideLegend ? "sr-only" : "text-sm font-semibold text-slate-900"}>
          {target ? "上传新版本 · " + target.name : "上传文件"}
        </legend>

        <div className="space-y-1.5">
          <label htmlFor={fileInputId} className="block text-sm font-medium text-slate-700">
            选择文件
          </label>
          <input
            id={fileInputId}
            ref={fileInputRef}
            type="file"
            required
            accept={uploadAccept}
            className="sr-only"
            onChange={(event) => {
              selectFile(event.target.files?.[0] ?? null);
            }}
          />
          {!file ? (
            <div
              role="button"
              tabIndex={busy ? -1 : 0}
              onClick={() => { if (!busy) fileInputRef.current?.click(); }}
              onKeyDown={(event) => {
                if (!busy && (event.key === "Enter" || event.key === " ")) {
                  event.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-5 py-7 text-center transition-colors ${
                dragging
                  ? "border-sky-500 bg-sky-50/80"
                  : "border-slate-300 bg-slate-50/70 hover:border-sky-400 hover:bg-sky-50/40"
              }`}
            >
              <span className="mb-2.5 flex h-10 w-10 items-center justify-center rounded-full bg-sky-100 text-sky-600">
                <Upload aria-hidden="true" className="h-5 w-5" />
              </span>
              <p className="text-sm font-medium text-slate-800">点击选择本地文件，或将文件拖拽到此处</p>
              <p className="mt-1 text-xs text-slate-500">
                支持 PDF、MD、DOCX、XLSX、PPTX、PNG/JPG、CSV、TXT、ZIP · 最大 50 MB
              </p>
            </div>
          ) : (
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`flex items-center justify-between gap-3 rounded-xl border px-3.5 py-3 transition-colors ${
                dragging ? "border-sky-500 bg-sky-50" : "border-sky-200 bg-sky-50/50"
              }`}
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white shadow-2xs ring-1 ring-slate-200/80">
                  <FileKindIcon name={file.name} />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-900" title={file.name}>
                    {file.name}
                  </p>
                  <p className="text-xs text-slate-500">
                    {formatBytes(file.size)} · {extensionOf(file.name).toUpperCase() || "FILE"}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex h-8 items-center rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50"
                >
                  更换文件
                </button>
                <button
                  type="button"
                  aria-label="移除已选文件"
                  onClick={() => {
                    selectFile(null);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-200/60 hover:text-slate-600"
                >
                  <X aria-hidden="true" className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </div>

        <div className={!target ? "grid grid-cols-1 gap-3 sm:grid-cols-3" : "space-y-1.5"}>
          {!target && (
            <div className="space-y-1.5">
              <label htmlFor={categoryId} className="block text-sm font-medium text-slate-700">
                新文件分类
              </label>
              <select
                id={categoryId}
                className={fieldClass}
                value={category}
                onChange={(event) => setCategory(event.target.value as Category)}
              >
                <option value="documents">文档</option>
                <option value="images">图片</option>
                <option value="exports">导出资料</option>
              </select>
            </div>
          )}
          <div className={!target ? "space-y-1.5 sm:col-span-2" : "space-y-1.5"}>
            <label htmlFor={reasonId} className="block text-sm font-medium text-slate-700">
              版本说明
            </label>
            <input
              id={reasonId}
              className={fieldClass}
              maxLength={4000}
              value={reason}
              placeholder={target ? "例如：补充接口字段说明（选填，留空默认「上传新版本」）" : "例如：初版设计稿、接口文档（选填，留空默认「本地上传资料」）"}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
        </div>

        {review && review !== "required" && (
          <p role="status" className="flex items-start gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
            <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-sky-600" />
            <span>当前最新版本为 v{review.latest_version_no}（{review.latestName}）。确认后将追加所选文件。</span>
          </p>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          {onCancel && (
            <button type="button" className={secondaryButtonClass} disabled={busy} onClick={onCancel}>
              取消
            </button>
          )}
          <button className={primaryButtonClass} type="submit" disabled={!file || busy}>
            {busy && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}
            {review === "required" ? "核对最新文件版本" : review ? "确认追加草稿版本" : "上传并保存草稿"}
          </button>
        </div>
      </fieldset>

      {status && (
        <div className="space-y-2 rounded-lg border border-sky-200/80 bg-sky-50/70 px-3.5 py-2.5">
          <div className="flex items-center justify-between gap-2 text-xs font-medium text-sky-900">
            <p role="status" className="flex items-center gap-1.5">
              <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin text-sky-600" />
              <span>
                {status}
                {percent !== null && ` ${percent}%`}
              </span>
            </p>
          </div>
          {percent !== null && (
            <>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-sky-200/70">
                <div
                  className="h-full rounded-full bg-sky-600 transition-all duration-150"
                  style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
                />
              </div>
              <progress aria-label="文件上传进度" value={percent} max={100} className="sr-only" />
            </>
          )}
        </div>
      )}

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
          <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
          <span>{error}</span>
        </div>
      )}
    </form>
  );
}
