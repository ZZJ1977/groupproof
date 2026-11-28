import { bRequest } from "@/student/api/b-client";

export type BTaskOrigin = "manual" | "ai" | "ai_code";
export type BTaskOriginFilter = "all" | "planned" | "code_discovered";

export type BDiscoveredFrom = {
  source_type?: string;
  commit_ids?: string[];
  shas?: string[];
  commit_count?: number;
  amendment_mode?: string;
  reason?: string;
  approved_by_name?: string;
  approved_at?: string;
};

export type CodeDiscoveryActionType = "merge_existing" | "new_subtask" | "new_top_level";
export type CodeDiscoveryStatus = "pending" | "adopted" | "dismissed";
export type CodeDiscoveryApprovalStatus = "none" | "pending_approval" | "approved" | "rejected";

export type CodeDiscoveryUnmatchedCommit = {
  id: string;
  sha: string;
  title: string;
  author_name: string;
  author_user_id?: string | null;
  occurred_at?: string | null;
  effective_lines: number;
  files_count: number;
};

export type CodeDiscoverySourceCommit = {
  id: string;
  sha: string;
  title: string;
  author_name: string;
  effective_lines: number;
};

export type CodeDiscoveryApproval = {
  user_id: string;
  name: string;
  role: string;
  approved_at: string;
};

export type CodeDiscoveryItem = {
  id: string;
  status: CodeDiscoveryStatus;
  approval_status: CodeDiscoveryApprovalStatus;
  source_type: "github_code";
  action_type: CodeDiscoveryActionType;
  title: string;
  description: string;
  acceptance_criteria: string[];
  suggested_module_id?: string | null;
  suggested_module_name?: string | null;
  suggested_parent_task_id?: string | null;
  suggested_parent_task_title?: string | null;
  target_task_id?: string | null;
  target_task_title?: string | null;
  suggested_assignee_ids: string[];
  suggested_weight: number;
  rationale: string;
  confidence: number;
  source_commits: CodeDiscoverySourceCommit[];
  adopted_task_id?: string | null;
  proposed_by_id?: string | null;
  proposed_by_name?: string | null;
  approvals: CodeDiscoveryApproval[];
  required_approvals: number;
  can_approve: boolean;
  provider: string;
  is_placeholder: boolean;
  created_at: string;
};

export type CodeDiscoveryListResponse = {
  unmatched_commits_count: number;
  unmatched_commits: CodeDiscoveryUnmatchedCommit[];
  pending_count: number;
  pending_approval_count: number;
  items: CodeDiscoveryItem[];
};

export type CodeDiscoveryScanResponse = CodeDiscoveryListResponse & {
  created_count: number;
};

export type CodeDiscoveryAdoptInput = {
  action_type?: CodeDiscoveryActionType;
  title?: string;
  description?: string;
  module_id?: string | null;
  parent_task_id?: string | null;
  target_task_id?: string | null;
  assignee_ids?: string[];
  weight?: number;
  acceptance_criteria?: string[];
  reason?: string;
};

export type CodeDiscoveryActionResponse = {
  item: CodeDiscoveryItem;
  task_id: string | null;
  adopted_immediately: boolean;
  attached_evidence_count: number;
  message: string;
};

export type CodeDiscoveryDismissResponse = {
  item: CodeDiscoveryItem;
};

export function isCodeDiscoveredTask(
  task?: { origin?: string | null; is_code_discovered?: boolean | null } | null,
): boolean {
  return Boolean(task && (task.is_code_discovered === true || task.origin === "ai_code"));
}

const enc = encodeURIComponent;
const basePath = (projectId: string, suffix = "") =>
  `/api/v1/projects/${enc(projectId)}/plan/code-discoveries${suffix}`;

export function listCodeDiscoveries(projectId: string) {
  return bRequest<CodeDiscoveryListResponse>({
    path: basePath(projectId),
  });
}

export function scanCodeDiscoveries(projectId: string, body: { max_commits?: number } = {}) {
  return bRequest<CodeDiscoveryScanResponse>({
    method: "POST",
    path: basePath(projectId),
    body,
  });
}

export function adoptCodeDiscovery(
  projectId: string,
  suggestionId: string,
  body: CodeDiscoveryAdoptInput = {},
) {
  return bRequest<CodeDiscoveryActionResponse>({
    method: "POST",
    path: basePath(projectId, `/${enc(suggestionId)}/adopt`),
    body,
  });
}

export function approveCodeDiscovery(
  projectId: string,
  suggestionId: string,
  body: { reason?: string } = {},
) {
  return bRequest<CodeDiscoveryActionResponse>({
    method: "POST",
    path: basePath(projectId, `/${enc(suggestionId)}/approve`),
    body,
  });
}

export function dismissCodeDiscovery(
  projectId: string,
  suggestionId: string,
  body: { reason?: string } = {},
) {
  return bRequest<CodeDiscoveryDismissResponse>({
    method: "POST",
    path: basePath(projectId, `/${enc(suggestionId)}/dismiss`),
    body,
  });
}

export const bCodeDiscoveriesApi = {
  list: listCodeDiscoveries,
  scan: scanCodeDiscoveries,
  adopt: adoptCodeDiscovery,
  approve: approveCodeDiscovery,
  dismiss: dismissCodeDiscovery,
};
