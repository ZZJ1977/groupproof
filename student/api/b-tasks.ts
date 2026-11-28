import { bRequest } from "@/student/api/b-client";
import type { BDiscoveredFrom, BTaskOrigin, BTaskOriginFilter } from "@/student/api/b-code-discoveries";
import type { BPerson } from "@/student/api/b-courses";
import type { BPlanIssue, BPlanOption } from "@/student/api/b-planning";

export type BTaskView = "tree" | "board" | "list";
export type BTransition = { to: string; kind: "api" | "page"; method: string | null; path: string | null; href: string | null; expected_version: number };
export type BTaskRow = {
  id: string; code: string | null; title: string; module: BPlanOption; parent_task_id: string | null; assignees: BPerson[];
  priority: string; weight: number; status: string; progress_percent: number; milestone_ids: string[]; dependency_ids: string[];
  dependencies_done: boolean; content_version: number; lock_version: number; updated_at: string | null;
  links: { detail: string; submit: string; evidence: string; verification: string };
  transitions: BTransition[]; blocked_reason: string | null; matched: boolean;
  matched_commits?: number; latest_commit_at?: string | null;
  criteria_total?: number; criteria_evidenced?: number; criteria_confirmed?: number; evidence_count?: number;
  origin?: BTaskOrigin | string;
  is_code_discovered?: boolean;
  discovered_from?: BDiscoveredFrom | null;
};
export type BCodeProgressSync = {
  commits_scanned: number; commits_matched: number; tasks_updated: number; milestones_updated: number;
  evidences_created?: number; criteria_covered?: number;
};
export type BCompleteByCriteriaResult = { status: string; task_status: string; progress_percent: number };
export type BTasksPage = {
  view: BTaskView; items: BTaskRow[]; total: number; page: number; page_size: number; lock_version: number;
  plan_status: "none" | "draft" | "frozen"; integrity_issues: BPlanIssue[]; columns: { status: string; label: string; count: number }[];
  modules: BPlanOption[]; members: BPerson[]; milestones: BPlanOption[];
};
export type BTaskFilters = {
  view: BTaskView;
  q?: string;
  status?: string;
  assignee?: string;
  module?: string;
  milestone?: string;
  origin?: BTaskOriginFilter;
  sort?: string;
  page?: number;
  page_size?: number;
};

export const bTasksApi = {
  list: (projectId: string, filters: BTaskFilters) => bRequest<BTasksPage>({ path: `/api/v1/projects/${encodeURIComponent(projectId)}/tasks`, query: filters }),
  syncCodeProgress: (projectId: string) => bRequest<BCodeProgressSync>({ method: "POST", path: `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/sync-code-progress` }),
  completeByCriteria: (projectId: string, taskId: string, reason?: string, autoAdoptCandidates = false) =>
    bRequest<BCompleteByCriteriaResult>({
      method: "POST",
      path: `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/complete-by-criteria`,
      body: { reason: reason ?? "", auto_adopt_candidates: autoAdoptCandidates },
    }),
};
