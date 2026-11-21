import { bRequest } from "@/lib/api/b-client";
import type { BPerson } from "@/lib/api/b-courses";
import type { BPriority } from "@/lib/api/b-requirements";

export type BPlanCriterion = { id: string; key: string; text: string; needs_recheck: boolean };
export type BPlanTask = {
  id: string; code: string | null; title: string; description: string; module_id: string; parent_task_id: string | null;
  requirement_ids: string[]; assignees: BPerson[]; dependency_ids: string[]; milestone_ids: string[];
  priority: BPriority; weight: number; criteria: BPlanCriterion[]; status: string; progress_percent: number;
  content_version: number; origin: "manual" | "ai"; href: string;
};
export type BPlanIssue = { code: string; message: string; task_id: string | null; field: string | null; task_ids: string[] };
export type BConfirmState = "confirmed" | "stale" | "pending";
export type BPlanOption = { id: string; name: string; code?: string | null; module_id?: string | null };
export type BPlan = {
  project_id: string; id: string | null; version_no: number; status: "none" | "draft" | "frozen"; lock_version: number;
  baseline_frozen: boolean; baseline_version_no: number | null; frozen_at: string | null;
  tasks: BPlanTask[]; issues: BPlanIssue[];
  confirmations: { user: BPerson; state: BConfirmState; confirmed_at: string | null; task_count: number }[];
  my_task_versions: Record<string, number>; my_state: BConfirmState | null;
  can_edit: boolean; can_lead: boolean; root_weight_total: number;
  modules: BPlanOption[]; requirements: BPlanOption[]; milestones: BPlanOption[]; members: BPerson[];
  history: { id: string; version_no: number; status: string; frozen_at: string | null; created_at: string }[];
};
export type BTaskInput = {
  title: string; description: string; module_id: string; parent_task_id: string | null; requirement_ids: string[];
  assignee_ids: string[]; dependency_ids: string[]; milestone_ids: string[]; priority: BPriority; weight: number;
  criteria: { id?: string; text: string }[];
};
export type BTaskVersion = { version_no: number; snapshot: Record<string, unknown>; created_by: BPerson | null; created_at: string };
export type BSuggestion = {
  id: string; requirement_id: string; requirement_code: string | null; requirement_title: string; title: string; description: string;
  acceptance_criteria: string[]; status: "pending" | "adopted" | "dismissed"; is_placeholder: boolean; adopted_task_id: string | null; created_at: string;
};
export type BSuggestionBatch = { created: number; duplicates: number; uncovered_requirement_ids: string[]; is_placeholder: boolean; suggestions: BSuggestion[] };

const id = encodeURIComponent;
const p = (projectId: string, suffix: string) => `/api/v1/projects/${id(projectId)}/plan${suffix}`;
export const bPlanningApi = {
  plan: (projectId: string) => bRequest<BPlan>({ path: p(projectId, "") }),
  createTask: (projectId: string, body: BTaskInput) => bRequest<BPlanTask>({ method: "POST", path: p(projectId, "/tasks"), body }),
  updateTask: (projectId: string, task: BPlanTask, body: BTaskInput) =>
    bRequest<BPlanTask>({ method: "PUT", path: p(projectId, `/tasks/${id(task.id)}`), body: { ...body, expected_version: task.content_version } }),
  deleteTask: (projectId: string, task: BPlanTask) =>
    bRequest<{ id: string; deleted: boolean }>({ method: "DELETE", path: p(projectId, `/tasks/${id(task.id)}`), query: { expected_version: task.content_version } }),
  versions: (projectId: string, taskId: string) => bRequest<BTaskVersion[]>({ path: p(projectId, `/tasks/${id(taskId)}/versions`) }),
  confirm: (projectId: string, taskVersions: Record<string, number>) =>
    bRequest<BPlan>({ method: "POST", path: p(projectId, "/confirmations/me"), body: { task_versions: taskVersions } }),
  freeze: (projectId: string, plan: BPlan) => bRequest<BPlan>({ method: "POST", path: p(projectId, "/freeze"), body: { expected_version: plan.lock_version } }),
  unlock: (projectId: string, plan: BPlan, reason: string) =>
    bRequest<BPlan>({ method: "POST", path: p(projectId, "/unlock"), body: { expected_version: plan.lock_version, reason } }),
  suggestions: (projectId: string) => bRequest<BSuggestion[]>({ path: p(projectId, "/suggestions") }),
  generate: (projectId: string) => bRequest<BSuggestionBatch>({ method: "POST", path: p(projectId, "/suggestions") }),
  adopt: (projectId: string, suggestionId: string, weight: number) =>
    bRequest<BPlanTask>({ method: "POST", path: p(projectId, `/suggestions/${id(suggestionId)}/adopt`), body: { weight } }),
  dismiss: (projectId: string, suggestionId: string) => bRequest<BSuggestion>({ method: "POST", path: p(projectId, `/suggestions/${id(suggestionId)}/dismiss`) }),
};
