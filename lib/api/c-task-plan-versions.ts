import { z } from "zod";
import { CApiError, unwrap } from "@/lib/api/c-client";
import { apiConfig } from "@/lib/api/config";

// B's TaskVersionDTO contains the plan as it was saved, including the criteria
// of that version. Resolve historical labels from the snapshot itself.
const versionsSchema = z.array(z.object({
  version_no: z.number().int().positive(),
  created_at: z.string().datetime({ offset: true }),
  created_by: z.object({ id: z.string().uuid(), name: z.string().nullable() }).nullable(),
  snapshot: z.object({
    title: z.string(),
    description: z.string(),
    criteria: z.array(z.object({ id: z.string().uuid(), text: z.string() })),
  }),
}));

export type TaskPlanVersion = z.infer<typeof versionsSchema>[number];

export async function readTaskPlanVersions(projectId: string, taskId: string, signal: AbortSignal) {
  const path = `/api/v1/projects/${encodeURIComponent(projectId)}/plan/tasks/${encodeURIComponent(taskId)}/versions`;
  const response = await fetch(apiConfig.baseUrl + path, { credentials: "include", cache: "no-store", signal });
  const payload = await response.json().catch(() => null);
  const data = unwrap<unknown>({ response, data: payload, error: payload });
  const parsed = versionsSchema.safeParse(data);
  if (!parsed.success) {
    throw new CApiError(502, "INVALID_API_RESPONSE", "无法读取任务计划版本。", response.headers.get("X-Request-Id"));
  }
  return parsed.data;
}
