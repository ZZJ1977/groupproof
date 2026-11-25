import { bRequest, newIdempotencyKey } from "@/student/api/b-client";

export type RuleMilestoneItem = {
  title: string;
  description: string;
  deadline?: string | null;
  deadline_offset_days?: number | null;
  weight?: number | null;
};

export type ContributionWeights = {
  task_weight: number;
  verification_weight: number;
  collaboration_weight: number;
};

export type CourseRulesData = {
  grouping_mode: "free" | "approval";
  min_group_size: number;
  max_group_size: number;
  formation_deadline?: string | null;
  post_deadline_policy: "teacher_approval" | "forbidden" | "free";
  allow_cross_group_transfer: boolean;
  project_deadline?: string | null;
  milestone_template: RuleMilestoneItem[];
  require_baseline_review: boolean;
  require_plan_review: boolean;
  auto_contribution: boolean;
  contribution_weights: ContributionWeights;
  appeal_window_days: number;
  required_deliverables: string[];
  final_presentation: boolean;
};

export type RuleVersionBrief = {
  version_no: number;
  status: "draft" | "published" | "archived";
  change_summary: string;
  published_by: string | null;
  published_at: string | null;
  created_at: string;
};

export type RuleVersionData = RuleVersionBrief & {
  rules: CourseRulesData;
};

export type CourseRulesOverview = {
  course_id: string;
  course_status: string;
  can_edit: boolean;
  current_published: RuleVersionData | null;
  draft: RuleVersionData | null;
  effective_rules: CourseRulesData;
  versions: RuleVersionBrief[];
};

const id = encodeURIComponent;

export const teacherRulesKeys = {
  overview: (userId: string, courseId: string) => ["b-teacher-rules", userId, courseId] as const,
  version: (userId: string, courseId: string, versionNo: number) =>
    ["b-teacher-rule-version", userId, courseId, versionNo] as const,
};

export const teacherRulesApi = {
  overview: (courseId: string) =>
    bRequest<CourseRulesOverview>({ path: `/api/v1/teacher/classes/${id(courseId)}/rules` }),
  version: (courseId: string, versionNo: number) =>
    bRequest<RuleVersionData>({
      path: `/api/v1/teacher/classes/${id(courseId)}/rules/${versionNo}`,
    }),
  saveDraft: (
    courseId: string,
    body: { rules: CourseRulesData; change_summary: string },
    idempotencyKey?: string,
  ) =>
    bRequest<RuleVersionData>({
      method: "PUT",
      path: `/api/v1/teacher/classes/${id(courseId)}/rules/draft`,
      body,
      idempotencyKey,
    }),
  publish: (
    courseId: string,
    body: { change_summary: string; rules?: CourseRulesData },
    idempotencyKey?: string,
  ) =>
    bRequest<RuleVersionData>({
      method: "POST",
      path: `/api/v1/teacher/classes/${id(courseId)}/rules/publish`,
      body,
      idempotencyKey,
    }),
};

export { newIdempotencyKey };
