"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { CApiError } from "@/lib/api/c-client";
import { courseFilesApi } from "@/lib/api/c-course-files-client";
import { sendFile, uploadAccept, verifyFile } from "@/lib/api/c-storage-upload";
import { apiButton, apiInput, projectApi, useCommandKey } from "./c-project-api";

type Category = "documents" | "images" | "exports";
type Props = {
  scope: "course" | "project";
  scopeId: string;
  target?: { id: string; lock_version: number; name: string };
  saved: () => void;
  denied: (error: CApiError) => void;
};

export function FileUploadForm({ scope, scopeId, target, saved, denied }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [reason, setReason] = useState("");
  const [category, setCategory] = useState<Category>("documents");
  const [status, setStatus] = useState("");
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState("");
  const receipt = useRef<string | null>(null);
  const operation = useRef<AbortController | null>(null);
  const commandKey = useCommandKey();
  const busy = Boolean(status);
  useEffect(() => () => operation.current?.abort(), []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file || !reason.trim() || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setError("");
    try {
      if (!receipt.current) {
        setStatus("正在上传文件"); setPercent(0);
        receipt.current = await sendFile(scope, scopeId, file, controller.signal, setPercent);
      }
      setPercent(null); setStatus("正在校验文件");
      await verifyFile(scope, scopeId, file, receipt.current, controller.signal);
      controller.signal.throwIfAborted();
      setStatus("正在保存草稿版本");
      const common = { reason: reason.trim(), receipt_id: receipt.current };
      if (target) {
        const input = { ...common, expected_version: target.lock_version };
        const key = commandKey({ scope, scopeId, fileId: target.id, input });
        if (scope === "project") await projectApi.appendFileVersion(scopeId, target.id, input, key, controller.signal);
        else await courseFilesApi.appendVersion(scopeId, target.id, input, key, controller.signal);
      } else {
        const input = { ...common, category };
        const key = commandKey({ scope, scopeId, input });
        if (scope === "project") await projectApi.registerFile(scopeId, input, key, controller.signal);
        else await courseFilesApi.registerFile(scopeId, input, key, controller.signal);
      }
      if (!controller.signal.aborted) { receipt.current = null; commandKey.reset(); saved(); }
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (failure instanceof CApiError) {
        if (failure.status === 401 || failure.status === 403) { receipt.current = null; denied(failure); return; }
        if (["UPLOAD_NOT_FOUND", "UPLOAD_REJECTED", "UPLOAD_RECEIPT_INVALID", "UPLOAD_RECEIPT_EXPIRED"].includes(failure.code)) receipt.current = null;
        setError(failure.status === 404 || failure.status === 503 ? "上传服务暂不可用，请稍后重试。" : failure.message);
      } else {
        setError(failure instanceof Error ? failure.message : "上传失败，请重试。");
      }
    } finally {
      operation.current = null;
      if (!controller.signal.aborted) { setStatus(""); setPercent(null); }
    }
  }
  return <form className="my-4 space-y-3 rounded-md border p-4" onSubmit={submit}>
    <fieldset disabled={busy} className="space-y-2">
      <legend className="font-semibold">{target ? "上传新版本 · " + target.name : "上传文件"}</legend>
      <label className="block">选择文件<input type="file" required className="block" accept={uploadAccept}
        onChange={(event) => { setFile(event.target.files?.[0] ?? null); receipt.current = null; setError(""); commandKey.reset(); }} /></label>
      {!target && <label className="block">新文件分类<select className={apiInput} value={category} onChange={(event) => setCategory(event.target.value as Category)}>
        <option value="documents">文档</option><option value="images">图片</option><option value="exports">导出资料</option>
      </select></label>}
      <label className="block">版本说明<input className={apiInput} required maxLength={4000} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      <button className={apiButton} type="submit" disabled={!file || !reason.trim()}>上传并保存草稿</button>
    </fieldset>
    {status && <p role="status">{status}{percent !== null && " " + percent + "%"}</p>}
    {percent !== null && <progress aria-label="文件上传进度" value={percent} max={100} />}
    {error && <p role="alert">{error}</p>}
  </form>;
}
