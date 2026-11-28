import { z } from "zod";
import { CApiError } from "@/shared/daily-inbox/c-client";
import { apiConfig } from "@/shared/lib/api-config";

const discoveredFromSchema = z.object({
  source_type: z.string().optional(),
  commit_ids: z.array(z.string()).optional(),
  shas: z.array(z.string()).optional(),
  commit_count: z.number().optional(),
  amendment_mode: z.string().optional(),
  reason: z.string().optional(),
  approved_by_name: z.string().optional(),
  approved_at: z.string().optional(),
}).passthrough();

// D's history endpoint includes freshness and human decisions alongside each run.
const historySchema = z.array(z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  task_id: z.string().uuid(),
  result: z.enum(["pending", "passed", "failed", "uncertain"]),
  status: z.string(),
  created_at: z.string().nullable(),
  invalidated_reason: z.string().nullable(),
  formal_outcome_id: z.string().uuid().nullable(),
  responsible_ids: z.array(z.string().uuid()),
  origin: z.string().nullable().optional(),
  is_code_discovered: z.boolean().nullable().optional(),
  discovered_from: discoveredFromSchema.nullable().optional(),
  code_discovered_review_note: z.string().nullable().optional(),
  decisions: z.array(z.object({
    actor_id: z.string().uuid(),
    decision: z.enum(["confirmed", "rejected"]),
    responsibility_share: z.number().nullable(),
    reason: z.string(),
  })),
  criteria: z.array(z.object({
    criterion_id: z.string().uuid(),
    text: z.string(),
    result: z.enum(["passed", "failed", "uncertain", "not_applicable"]),
    reason: z.string().nullable(),
    remediation: z.string().nullable(),
    evidence: z.array(z.object({ id: z.string().uuid(), version: z.number().int().nonnegative() })),
  })),
}));

export type TaskVerification = z.infer<typeof historySchema>[number];

export async function readTaskVerification(projectId: string, taskId: string, signal: AbortSignal) {
  const path = `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/verification/history`;
  const response = await fetch(apiConfig.baseUrl + path, { credentials: "include", cache: "no-store", signal });
  const body = await response.json().catch(() => null);
  const requestId = response.headers.get("X-Request-Id");
  if (!response.ok) {
    throw new CApiError(response.status, body?.error?.code ?? "VERIFICATION_UNAVAILABLE", "无法读取任务验收结果。", requestId);
  }
  const parsed = historySchema.safeParse(body?.data);
  if (!parsed.success || parsed.data.some((run) => run.project_id !== projectId || run.task_id !== taskId)) {
    throw new CApiError(502, "INVALID_API_RESPONSE", "验收结果与当前任务不一致。", requestId);
  }
  return parsed.data;
}
