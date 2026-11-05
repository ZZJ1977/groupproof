import { bRequest } from "@/lib/api/b-client";
import type { BPerson } from "@/lib/api/b-courses";
import type { BPriority, BRequirement } from "@/lib/api/b-requirements";

export type BModuleBrief = { id: string; name: string };
export type BRequirementItem = {
  id: string; code: string | null; title: string; module: BModuleBrief; origin: "ai" | "manual"; status: string; priority: string;
  excluded: boolean; version_no: number; task_count: number; updated_at: string;
};
export type BRequirementPage = { items: BRequirementItem[]; total: number; page: number; page_size: number; modules: BModuleBrief[] };
export type BRequirementDetail = { requirement: BRequirement & { code: string | null }; module: BModuleBrief; version_no: number; baseline_frozen: boolean; can_edit: boolean; reason_required: boolean };
export type BImpact = { requirement_id: string; criteria_count: number; tasks: { id: string; title: string; status: string; href: string; criteria: { id: string; key: string; text: string; needs_recheck: boolean }[] }[] };
export type BVersion = { version_no: number; snapshot: Record<string, string | null>; reason: string | null; after_freeze: boolean; created_by: BPerson | null; created_at: string };
export type BVersions = { requirement_id: string; versions: BVersion[]; compare: { from: number; to: number; changes: { field: string; label: string; before: string | null; after: string | null }[] } | null };
export type BTrace = {
  requirement: BRequirement & { code: string | null }; module: BModuleBrief; module_href: string;
  evidence_status: "available" | "unavailable"; evidence_reason: string | null; verification_status: "available" | "unavailable";
  tasks: { id: string; title: string; status: string; href: string; verification: { status: "available" | "unavailable"; state: string | null; href: string };
    criteria: { id: string; key: string; text: string; needs_recheck: boolean; evidence: { id: string; title: string; status: string; href: string }[] }[] }[];
};
export type BRequirementFilters = { code?: string; q?: string; source?: string; module?: string; status?: string; page?: number; page_size?: number };

const id = encodeURIComponent;
const p = (projectId: string, suffix: string) => `/api/v1/projects/${id(projectId)}${suffix}`;
export const bManageApi = {
  list: (projectId: string, filters: BRequirementFilters) => bRequest<BRequirementPage>({ path: p(projectId, "/requirements"), query: filters }),
  detail: (projectId: string, requirementId: string) => bRequest<BRequirementDetail>({ path: p(projectId, `/requirements/${id(requirementId)}`) }),
  impact: (projectId: string, requirementId: string) => bRequest<BImpact>({ method: "POST", path: p(projectId, `/requirements/${id(requirementId)}/impact-preview`) }),
  versions: (projectId: string, requirementId: string, compare?: { from: number; to: number }) =>
    bRequest<BVersions>({ path: p(projectId, `/requirements/${id(requirementId)}/versions`), query: compare ? { from: compare.from, to: compare.to } : undefined }),
  trace: (projectId: string, requirementId: string) => bRequest<BTrace>({ path: p(projectId, `/requirements/${id(requirementId)}/trace`) }),
  update: (projectId: string, row: BRequirement, body: { module_id: string; title: string; description?: string; priority: BPriority; reason?: string }) =>
    bRequest<BRequirement>({ method: "PATCH", path: p(projectId, `/requirements/${id(row.id)}`), body: { ...body, expected_version: row.lock_version } }),
};
