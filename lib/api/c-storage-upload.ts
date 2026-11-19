import { apiClient } from "./client";
import { CApiError, unwrap } from "./c-client";

type Scope = "course" | "project";
const formats: Record<string, string> = {
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", zip: "application/zip",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
export const uploadAccept = Object.keys(formats).map((extension) => "." + extension).join(",");

export async function sendFile(scope: Scope, scopeId: string, file: File, signal: AbortSignal, progress: (count: number) => void) {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!file.name.includes(".") || file.name !== file.name.trim() || file.name.length > 255 ||
      !Object.hasOwn(formats, extension) || !file.size || file.size > 50 * 1024 * 1024) {
    throw new Error("请选择支持格式的非空文件，最大 50 MB。");
  }
  const mime = formats[extension];
  const ticket = unwrap(await apiClient.POST("/api/v1/storage/uploads", {
    body: { scope, scope_id: scopeId, filename: file.name, size_bytes: file.size, mime_type: mime }, signal,
  }));
  if (!ticket || typeof ticket.upload_url !== "string" || !URL.canParse(ticket.upload_url)) {
    throw new Error("上传链接无效或已过期，请重试。");
  }
  const expires = Date.parse(ticket.expires_at);
  const url = new URL(ticket.upload_url);
  // A constructs the signed URL on its configured Supabase host. The object
  // must also belong to this ticket and workspace before we send any bytes.
  const parts = url.pathname.split("/");
  const objectMatchesTicket = parts.at(-4) === scope && parts.at(-3) === scopeId.toLowerCase() &&
    parts.at(-2) === ticket.receipt_id && Boolean(parts.at(-1));
  if (ticket.method !== "PUT" || typeof ticket.receipt_id !== "string" ||
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(ticket.receipt_id) ||
      !Number.isFinite(expires) || expires <= Date.now() || url.protocol !== "https:" ||
      url.username || url.password || url.hash || url.origin === window.location.origin ||
      !url.pathname.includes("/storage/v1/object/upload/sign/") || !objectMatchesTicket || !url.searchParams.get("token")) {
    throw new Error("上传链接无效或已过期，请重试。");
  }
  await new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    signal.addEventListener("abort", abort, { once: true });
    xhr.onloadend = () => signal.removeEventListener("abort", abort);
    xhr.open("PUT", url.href);
    xhr.timeout = 5 * 60_000;
    xhr.withCredentials = false;
    xhr.setRequestHeader("Content-Type", mime);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) progress(Math.round(event.loaded * 100 / event.total));
    };
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error("文件传输失败，请重试。"));
    xhr.onerror = xhr.ontimeout = () => reject(new Error("文件传输未完成，请重试。"));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    xhr.send(file);
  });
  return ticket.receipt_id;
}

export async function verifyFile(scope: Scope, scopeId: string, file: File, receipt: string, signal: AbortSignal) {
  const result = unwrap(await apiClient.POST("/api/v1/storage/uploads/{receipt_id}/complete", {
    params: { path: { receipt_id: receipt } }, signal,
  }));
  const expectedMime = formats[file.name.split(".").pop()?.toLowerCase() ?? ""];
  if (!result || result.receipt_id !== receipt || result.scope !== scope || result.scope_id !== scopeId.toLowerCase() ||
      result.status !== "completed" || result.filename !== file.name || result.size_bytes !== file.size ||
      result.mime_type !== expectedMime || typeof result.content_hash !== "string" || !/^[a-f0-9]{64}$/.test(result.content_hash)) {
    throw new CApiError(422, "UPLOAD_RECEIPT_INVALID", "文件未通过存储校验，请重新选择文件。", null);
  }
}
