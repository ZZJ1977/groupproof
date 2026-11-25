import { apiClient } from "@/shared/lib/api-client";
import { apiConfig } from "@/shared/lib/api-config";
import { CApiError, unwrap } from "@/shared/daily-inbox/c-client";

type Scope = "course" | "project";
const formats: Record<string, string> = {
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", zip: "application/zip",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
export const uploadAccept = Object.keys(formats).map((extension) => "." + extension).join(",");

export class DirectPutFallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectPutFallbackError";
  }
}

function resolveMime(file: File): string {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!file.name.includes(".") || file.name !== file.name.trim() || file.name.length > 255 ||
      !Object.hasOwn(formats, extension) || !file.size || file.size > 50 * 1024 * 1024) {
    throw new Error("请选择支持格式的非空文件，最大 50 MB。");
  }
  return formats[extension];
}

export async function sendFile(scope: Scope, scopeId: string, file: File, signal: AbortSignal, progress: (count: number) => void) {
  const mime = resolveMime(file);
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
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300
      ? resolve()
      : reject(new DirectPutFallbackError("文件传输失败，请重试。"));
    xhr.onerror = xhr.ontimeout = () => reject(new DirectPutFallbackError("文件传输未完成，请重试。"));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    xhr.send(file);
  });
  return ticket.receipt_id;
}

async function computeSha256Hex(file: File, signal: AbortSignal): Promise<string> {
  if (!crypto.subtle) throw new Error("请通过 HTTPS 或本机地址打开页面，以校验上传文件。");
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  signal.throwIfAborted();
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sendFileDirect(
  scope: Scope,
  scopeId: string,
  file: File,
  signal: AbortSignal,
  progress: (count: number) => void,
): Promise<string> {
  const mime = resolveMime(file);
  const baseUrl = apiConfig.baseUrl.replace(/\/$/, "");
  const sessionResponse = await fetch(`${baseUrl}/api/v1/auth/session`, {
    credentials: "include",
    cache: "no-store",
    signal,
  });
  if (!sessionResponse.ok) {
    throw new CApiError(sessionResponse.status, "AUTH_SESSION_UNAVAILABLE", "暂时无法验证会话，请重试。", null);
  }
  const sessionPayload = await sessionResponse.json().catch(() => null);
  const session = sessionPayload?.data ?? sessionPayload;
  if (!session || !session.authenticated || typeof session.csrfToken !== "string" || !session.csrfToken) {
    throw new CApiError(401, "UNAUTHENTICATED", "请重新登录。", null);
  }
  const params = new URLSearchParams({ scope, scope_id: scopeId, filename: file.name });
  const endpoint = `${baseUrl}/api/v1/storage/uploads/direct?${params.toString()}`;
  const result = await new Promise<{
    receipt_id?: string;
    scope?: string;
    scope_id?: string;
    status?: string;
    filename?: string;
    size_bytes?: number;
    mime_type?: string;
    content_hash?: string;
  }>((resolve, reject) => {
    signal.throwIfAborted();
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    signal.addEventListener("abort", abort, { once: true });
    xhr.onloadend = () => signal.removeEventListener("abort", abort);
    xhr.open("POST", endpoint);
    xhr.timeout = 5 * 60_000;
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", mime);
    xhr.setRequestHeader("X-CSRF-Token", session.csrfToken);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) progress(Math.round(event.loaded * 100 / event.total));
    };
    xhr.onload = () => {
      let body: Record<string, unknown> | null = null;
      try { body = JSON.parse(xhr.responseText); } catch { body = null; }
      if (xhr.status >= 200 && xhr.status < 300 && body && typeof body.data === "object" && body.data !== null) {
        resolve(body.data as Record<string, unknown>);
        return;
      }
      const err = (body?.error && typeof body.error === "object" ? body.error : {}) as Record<string, unknown>;
      const meta = (body?.meta && typeof body.meta === "object" ? body.meta : {}) as Record<string, unknown>;
      const code = typeof err.code === "string" ? err.code : "UPLOAD_FAILED";
      const details = (err.details && typeof err.details === "object" ? err.details : null) as Record<string, unknown> | null;
      const reason = typeof details?.reason === "string" ? details.reason : "";
      const rejectedMessage: Record<string, string> = {
        content_does_not_match_extension: "文件内容与扩展名不符，请确认文件未损坏且扩展名正确。",
        executable_content: "出于安全限制，暂不支持上传可执行程序。",
        archive_contains_executable: "出于安全限制，压缩包中不能包含可执行程序。",
        binary_text_file: "文本类文件（TXT/MD/CSV）不能包含二进制内容。",
        text_not_utf8: "文本类文件（TXT/MD/CSV）需使用 UTF-8 编码。",
        corrupt_archive: "压缩包或 Office 文档已损坏，无法通过校验。",
        archive_too_large_when_extracted: "压缩包解压后体积超出安全限制。",
      };
      const message =
        (code === "UPLOAD_REJECTED" && reason && rejectedMessage[reason]) ||
        (typeof err.message === "string" ? err.message : "上传失败，请重试。");
      reject(new CApiError(
        xhr.status || 503,
        code,
        message,
        typeof meta.request_id === "string" ? meta.request_id : null,
      ));
    };
    xhr.onerror = xhr.ontimeout = () => reject(new Error("文件传输未完成，请重试。"));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    xhr.send(file);
  });
  if (!result || typeof result.receipt_id !== "string" || result.scope !== scope ||
      result.scope_id?.toLowerCase() !== scopeId.toLowerCase() || result.status !== "completed" ||
      result.filename !== file.name || result.size_bytes !== file.size || result.mime_type !== mime ||
      typeof result.content_hash !== "string" || !/^[a-f0-9]{64}$/.test(result.content_hash)) {
    throw new CApiError(422, "UPLOAD_RECEIPT_INVALID", "文件未通过存储校验，请重新选择文件。", null);
  }
  const localHash = await computeSha256Hex(file, signal);
  if (localHash !== result.content_hash) {
    throw new CApiError(422, "UPLOAD_RECEIPT_INVALID", "存储内容与所选文件不一致，请重新上传。", null);
  }
  return result.receipt_id;
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
  const localHash = await computeSha256Hex(file, signal);
  if (localHash !== result.content_hash) {
    throw new CApiError(422, "UPLOAD_RECEIPT_INVALID", "存储内容与所选文件不一致，请重新上传。", null);
  }
}
