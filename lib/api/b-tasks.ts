import { bRequest } from "@/lib/api/b-client";
import type { BPerson } from "@/lib/api/b-courses";
import type { BPlanIssue, BPlanOption } from "@/lib/api/b-planning";

export type BTaskView = "tree" | "board" | "list";
export type BTransition = { to: string; kind: "api" | "page"; method: string | null; path: string | null; href: string | null; expected_version: number };
export type BTaskRow = {
  id: string; code: string | null; title: string; module: BPlanOption; parent_task_id: string | null; assignees: BPerson[];
  priority: string; weight: number; status: string; progress_percent: number; milestone_ids: string[]; dependency_ids: string[];
  dependencies_done: boolean; content_version: number; lock_version: number; updated_at: string | null;
  links: { detail: string; submit: string; evidence: string; verification: string };
  transitions: BTransition[]; blocked_reason: string | null; matched: boolean;
};
export type BTasksPage = {
  view: BTaskView; items: BTaskRow[]; total: number; page: number; page_size: number; lock_version: number;
  plan_status: "none" | "draft" | "frozen"; integrity_issues: BPlanIssue[]; columns: { status: string; label: string; count: number }[];
  modules: BPlanOption[]; members: BPerson[]; milestones: BPlanOption[];
};
export type BTaskFilters = { view: BTaskView; q?: string; status?: string; assignee?: string; module?: string; milestone?: string; sort?: string; page?: number; page_size?: number };

export const bTasksApi = {
  list: (projectId: string, filters: BTaskFilters) => bRequest<BTasksPage>({ path: `/api/v1/projects/${encodeURIComponent(projectId)}/tasks`, query: filters }),
};
