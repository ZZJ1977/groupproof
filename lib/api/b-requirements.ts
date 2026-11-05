import { bRequest } from "@/lib/api/b-client";
import type { BPerson } from "@/lib/api/b-courses";

export type BAnalysisRun = {
  id: string; status: "processing" | "succeeded" | "failed" | "unavailable"; error_code: string | null; error_message: string | null;
  summary: Record<string, number> | null; is_placeholder: boolean; created_at: string; finished_at: string | null;
};
export type BSource = { material_id: string | null; material_title: string | null; segment_id: string | null; quote: string | null };
export type BModule = { id: string; name: string; description: string | null; owner: BPerson | null; origin: "ai" | "manual"; requirement_count: number; lock_version: number };
export type BPriority = "high" | "medium" | "low";
export type BRequirement = {
  id: string; module_id: string; title: string; description: string | null; priority: BPriority; status: string;
  origin: "ai" | "manual"; edited_by_human: boolean; excluded: boolean; sources: BSource[]; lock_version: number;
};
export type BConflict = {
  id: string; left: BRequirement; right: BRequirement; description: string | null; status: "open" | "resolved" | "ignored";
  resolution: { decision: "keep_left" | "keep_right" | "merge"; reason: string; resolved_by: BPerson | null; created_at: string } | null;
};
export type BRequirementsBoard = {
  project_id: string; setup_status: string; setup_step: number; editable: boolean; latest_run: BAnalysisRun | null;
  modules: BModule[]; requirements: BRequirement[]; conflicts: BConflict[]; open_conflicts: number;
};
export type BChecklist = {
  project_id: string; ready: boolean; in_scope: string; out_of_scope: string; scope_version: number;
  items: { key: string; label: string; kind: "rule" | "manual"; passed: boolean; detail: string | null; checked_by: BPerson | null }[];
};
export type BBaseline = {
  id: string; version_no: number; status: "draft" | "confirmed" | "frozen" | "archived"; created_by: BPerson | null; created_at: string;
  frozen_at: string | null; waiting_for: BPerson[]; lock_version: number;
  confirmations: { user: BPerson; status: "pending" | "confirmed" | "rejected"; comment: string | null; confirmed_at: string | null }[];
  snapshot: { requirements?: { id: string; title: string }[]; modules?: { id: string; name: string }[]; scope?: { in_scope: string; out_of_scope: string } };
};
export type BRequirementInput = { module_id: string; title: string; description?: string; priority: BPriority };

const id = encodeURIComponent;
const p = (projectId: string, suffix: string) => `/api/v1/projects/${id(projectId)}${suffix}`;
export const bRequirementsApi = {
  board: (projectId: string) => bRequest<BRequirementsBoard>({ path: p(projectId, "/setup/requirements") }),
  analyse: (projectId: string) => bRequest<BAnalysisRun>({ method: "POST", path: p(projectId, "/analysis") }),
  run: (projectId: string, runId: string) => bRequest<BAnalysisRun>({ path: p(projectId, `/analysis/${id(runId)}`) }),
  createModule: (projectId: string, body: { name: string; owner_id?: string | null }) =>
    bRequest<BModule>({ method: "POST", path: p(projectId, "/modules"), body }),
  updateModule: (projectId: string, module: BModule, changes: { name?: string; description?: string | null; owner_id?: string | null }) =>
    bRequest<BModule>({ method: "PATCH", path: p(projectId, `/modules/${id(module.id)}`), body: { name: module.name, description: module.description, owner_id: module.owner?.id ?? null, ...changes, expected_version: module.lock_version } }),
  deleteModule: (projectId: string, moduleId: string) => bRequest({ method: "DELETE", path: p(projectId, `/modules/${id(moduleId)}`) }),
  createRequirement: (projectId: string, body: BRequirementInput) => bRequest<BRequirement>({ method: "POST", path: p(projectId, "/requirements"), body }),
  updateRequirement: (projectId: string, row: BRequirement, body: BRequirementInput) =>
    bRequest<BRequirement>({ method: "PATCH", path: p(projectId, `/requirements/${id(row.id)}`), body: { ...body, expected_version: row.lock_version } }),
  resolve: (projectId: string, conflictId: string, body: { decision: "keep_left" | "keep_right" | "merge"; reason: string; merged_title?: string; merged_description?: string }) =>
    bRequest<BConflict>({ method: "POST", path: p(projectId, `/conflicts/${id(conflictId)}/resolution`), body }),
  advance: (projectId: string, fromStep: 2 | 3 | 4) => bRequest<{ setup_step: number }>({ method: "POST", path: p(projectId, "/setup/advance"), body: { from_step: fromStep } }),
  checklist: (projectId: string) => bRequest<BChecklist>({ path: p(projectId, "/baseline/checklist") }),
  saveScope: (projectId: string, body: { in_scope: string; out_of_scope: string }, version: number) =>
    bRequest<BChecklist>({ method: "PUT", path: p(projectId, "/baseline/scope"), body: { ...body, expected_version: version } }),
  check: (projectId: string, key: string, checked: boolean) => bRequest<BChecklist>({ method: "PUT", path: p(projectId, `/baseline/checklist/${id(key)}`), body: { checked } }),
  current: (projectId: string) => bRequest<BBaseline | null>({ path: p(projectId, "/baselines/current") }),
  submit: (projectId: string) => bRequest<BBaseline>({ method: "POST", path: p(projectId, "/baselines") }),
  confirm: (projectId: string, baselineId: string, userId: string, decision: "confirm" | "reject", comment?: string) =>
    bRequest<BBaseline>({ method: "PUT", path: p(projectId, `/baselines/${id(baselineId)}/confirmations/${id(userId)}`), body: { decision, comment } }),
  forceFreeze: (projectId: string, baselineId: string, reason: string) =>
    bRequest<BBaseline>({ method: "POST", path: p(projectId, `/baselines/${id(baselineId)}/force-freeze`), body: { reason } }),
};
