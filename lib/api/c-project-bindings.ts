import { z } from "zod";
import { apiConfig } from "./config";
import { CApiError, type ActivitySourceType } from "./c-client";

const timestamp = z.string().datetime({ offset: true });
const repositoryName = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/).refine((s) => s !== "." && s !== "..");
const chats = z.array(z.object({ chat_id: z.string().trim().min(1), linked_at: timestamp }));
const repos = z.array(z.object({
  owner: repositoryName, repo: repositoryName, default_branch: z.string().min(1),
  linked_at: timestamp, last_synced_at: timestamp.nullable(),
}));
const envelope = z.object({ meta: z.object({ request_id: z.string().min(1) }), data: z.unknown() });

// A owns these read routes and the storage behind them. Never infer a binding from an activity.
export async function readProjectBindings(projectId: string, source: ActivitySourceType, signal: AbortSignal) {
  const path = source === "feishu" ? "feishu/chats" : "github/repos";
  const url = apiConfig.baseUrl + "/api/v1/a/projects/" + encodeURIComponent(projectId) + "/" + path;
  const response = await fetch(url, { credentials: "include", cache: "no-store", signal });
  const payload = await response.json().catch(() => null);
  const requestId = response.headers.get("X-Request-Id");
  if (!response.ok) {
    throw new CApiError(response.status, payload?.error?.code || "BINDINGS_UNAVAILABLE", "暂时无法读取项目绑定。", requestId);
  }
  const result = envelope.safeParse(payload);
  if (result.success) {
    if (source === "feishu") {
      const parsed = chats.safeParse(result.data.data);
      if (parsed.success) return { kind: "feishu" as const, items: parsed.data };
    } else {
      const parsed = repos.safeParse(result.data.data);
      if (parsed.success) return { kind: "github" as const, items: parsed.data };
    }
  }
  throw new CApiError(502, "INVALID_PROJECT_BINDINGS", "无法解析项目绑定。", requestId);
}
