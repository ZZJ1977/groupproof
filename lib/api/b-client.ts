import { apiConfig } from "@/lib/api/config";
import { createSessionFetch } from "@/lib/api/client";

/**
 * B module API client.
 *
 * B endpoints land stage by stage (see docs/plans/2026-11-05-b-module-staged-development-plan.md),
 * so until each one is in the generated OpenAPI types this client speaks the shared
 * envelope directly: `{ data, meta.request_id }` on success, `{ error: { code, message } }`
 * on failure. Writes always send `Idempotency-Key`; optimistic locking follows C's
 * convention of an `expected_version` (lock_version) field in the request body.
 * The session fetch adds the CSRF token.
 */

export class BApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "BApiError";
  }
}

type QueryValue = string | number | boolean | readonly string[] | null | undefined;

export type BRequest = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function buildBUrl(baseUrl: string, path: string, query: BRequest["query"] = {}): string {
  if (!path.startsWith("/api/")) throw new Error(`B API path must start with /api/: ${path}`);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value)) { if (value.length) params.set(key, value.join(",")); }
    else params.set(key, String(value));
  }
  const search = params.toString();
  return `${baseUrl}${path}${search ? `?${search}` : ""}`;
}

export function newIdempotencyKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createBClient(options: { baseUrl?: string; fetch?: typeof fetch } = {}) {
  const send = createSessionFetch(options.fetch);
  const baseUrl = options.baseUrl ?? apiConfig.baseUrl;
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;

  return async function request<T>(input: BRequest): Promise<T> {
    const method = input.method ?? "GET";
    const headers = new Headers({ Accept: "application/json" });
    if (method !== "GET") {
      headers.set("Idempotency-Key", input.idempotencyKey ?? newIdempotencyKey());
    }
    if (input.body !== undefined) headers.set("Content-Type", "application/json");
    const url = new URL(buildBUrl(baseUrl, input.path, input.query), origin);
    let response: Response;
    try {
      response = await send(new Request(url, {
        method, headers, credentials: "include", signal: input.signal,
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
      }));
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new BApiError(0, "NETWORK_ERROR", "网络连接失败，请检查网络后重试。", null);
    }
    const envelope = record(await response.json().catch(() => null));
    const meta = record(envelope.meta);
    const requestId = typeof meta.request_id === "string" ? meta.request_id : null;
    if (response.ok && Object.hasOwn(envelope, "data") && !Object.hasOwn(envelope, "error")) return envelope.data as T;
    const error = record(envelope.error);
    throw new BApiError(
      response.status,
      !response.ok && typeof error.code === "string" ? error.code : "INVALID_API_RESPONSE",
      typeof error.message === "string" ? error.message : "服务暂不可用，请重试。",
      requestId,
      record(error.details),
    );
  };
}

export const bRequest = createBClient();
