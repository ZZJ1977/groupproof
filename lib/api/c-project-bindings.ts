import { z } from "zod";
import type { components } from "@/packages/domain/api.generated";
import { apiClient } from "./client";
import { CApiError, type ActivitySourceType } from "./c-client";

const timestamp = z.string().datetime({ offset: true });
const repositoryName = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/).refine((s) => s !== "." && s !== "..");
const chats = z.array(z.object({
  chat_id: z.string().trim().min(1), linked_at: timestamp,
})) satisfies z.ZodType<components["schemas"]["LinkedFeishuChatDTO"][]>;
const repos = z.array(z.object({
  owner: repositoryName, repo: repositoryName, default_branch: z.string().min(1),
  linked_at: timestamp, last_synced_at: timestamp.nullable(),
})) satisfies z.ZodType<components["schemas"]["GithubRepoDTO"][]>;
const envelope = z.object({ meta: z.object({ request_id: z.string().min(1) }), data: z.unknown() });
const errorEnvelope = z.object({ error: z.object({ code: z.string().min(1) }) });

// A owns these read routes and the storage behind them. Never infer a binding from an activity.
export async function readProjectBindings(projectId: string, source: ActivitySourceType, signal: AbortSignal) {
  const path = source === "feishu"
    ? "/api/v1/a/projects/{project_id}/feishu/chats"
    : "/api/v1/a/projects/{project_id}/github/repos";
  const { response, error } = await apiClient.GET(path, {
    params: { path: { project_id: projectId } }, cache: "no-store", signal, parseAs: "stream",
  });
  const requestId = response.headers.get("X-Request-Id");
  if (!response.ok) {
    const parsed = errorEnvelope.safeParse(error);
    throw new CApiError(response.status, parsed.success ? parsed.data.error.code : "BINDINGS_UNAVAILABLE", "暂时无法读取项目绑定。", requestId);
  }
  const payload = await response.json().catch(() => null);
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
