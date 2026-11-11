import { z } from "zod";
import { apiConfig } from "@/lib/api/config";
import { CApiError } from "@/lib/api/c-client";

// B's read-only criteria-rechecks route (manage_router.py / RecheckDTO).
const responseSchema = z.object({
  meta: z.object({ request_id: z.string() }),
  data: z.array(z.object({
    criterion_id: z.string().uuid(),
    task_id: z.string().uuid(),
    requirement_id: z.string().uuid(),
    requirement_version_no: z.number().int().nonnegative(),
    reason: z.string().nullable(),
    verification_notified: z.boolean(),
  })),
});

export type CriterionRecheck = z.infer<typeof responseSchema>["data"][number];

export async function readCriterionRechecks(projectId: string, taskId: string, signal: AbortSignal) {
  const query = new URLSearchParams({ task_id: taskId });
  const path = `/api/v1/projects/${encodeURIComponent(projectId)}/criteria-rechecks?${query}`;
  const response = await fetch(apiConfig.baseUrl + path, { credentials: "include", cache: "no-store", signal });
  const requestId = response.headers.get("X-Request-Id");
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const code = typeof payload?.error?.code === "string" ? payload.error.code : "RECHECKS_UNAVAILABLE";
    throw new CApiError(response.status, code, "无法读取复核记录。", requestId);
  }
  const parsed = responseSchema.safeParse(await response.json());
  if (!parsed.success || parsed.data.data.some((row) => row.task_id !== taskId)) {
    throw new CApiError(502, "INVALID_API_RESPONSE", "复核记录与当前任务不一致。", requestId);
  }
  return parsed.data.data;
}
