import type {
  BaselinePayload,
  BaselineRevision,
  CourseRuleRevision,
  CourseRuleSnapshot,
  FunctionalModule,
  MemberConfirmation,
  MockData,
  PlanPayload,
  PlanRevision,
  Project,
  Requirement,
  Revision,
  Task,
} from "@/types/domain";

/**
 * 版本模型（阶段 02）。
 *
 * - 正式版本（published）一经发布不可原地改写；编辑进入独立草稿（draft），
 *   旧正式内容仍是执行依据。
 * - 个人确认绑定 revisionId + contentVersion + memberRoster；内容或名单变化时旧确认失效。
 * - migrateWorkspace 负责旧浏览器数据的增量迁移，幂等且不伪造历史时间。
 */

export const CURRENT_SCHEMA_VERSION = 1;

/** 全员确认完成：名单内每个成员都有绑定当前 revisionId 与 contentVersion 的确认 */
export function confirmationsComplete<T>(revision: Revision<T>): boolean {
  if (revision.memberRoster.length === 0) return false;
  return revision.memberRoster.every((userId) =>
    revision.confirmations.some((item) =>
      item.userId === userId &&
      item.revisionId === revision.id &&
      item.contentVersion === revision.contentVersion,
    ),
  );
}

/** 单个成员确认：重复确认不产生重复记录；普通确认只增加并发 version */
export function confirmMember<R extends Revision<unknown>>(revision: R, userId: string, confirmedAt: string): R {
  const current: MemberConfirmation = {
    userId,
    revisionId: revision.id,
    contentVersion: revision.contentVersion,
    confirmedAt,
  };
  const duplicate = revision.confirmations.some((item) =>
    item.userId === userId && item.revisionId === revision.id && item.contentVersion === revision.contentVersion,
  );
  if (duplicate) return revision;
  return {
    ...revision,
    confirmations: [...revision.confirmations, current],
    version: revision.version + 1,
    status: revision.status === "draft" && revision.memberRoster.length ? "confirming" : revision.status,
  } as R;
}

/** 内容修改：contentVersion 递增、旧确认失效、回到草稿态；不触碰已发布快照 */
export function applyContentChange<R extends Revision<unknown>>(revision: R, payload: R["payload"]): R {
  return {
    ...revision,
    payload,
    contentVersion: revision.contentVersion + 1,
    confirmations: [],
    status: "draft",
    version: revision.version + 1,
  } as R;
}

/** 确认名单变化：旧确认失效，需要重新确认 */
export function applyMemberRoster<R extends Revision<unknown>>(revision: R, memberRoster: string[]): R {
  const same = memberRoster.length === revision.memberRoster.length && memberRoster.every((id) => revision.memberRoster.includes(id));
  if (same) return revision;
  return {
    ...revision,
    memberRoster: [...memberRoster],
    confirmations: [],
    status: "draft",
    version: revision.version + 1,
  } as R;
}

/** 当前内容版本下已完成有效确认的成员 */
export function confirmedUserIds<T>(revision: Revision<T>): string[] {
  return revision.memberRoster.filter((userId) =>
    revision.confirmations.some((item) =>
      item.userId === userId && item.revisionId === revision.id && item.contentVersion === revision.contentVersion,
    ),
  );
}

/** 旧数据迁移来源确认人（未记录时间，不伪造） */
export function legacyConfirmedUserIds<T>(revision: Revision<T>): string[] {
  return revision.legacy?.confirmedUserIds ?? [];
}

/** 最新已发布课程规则版本（学生/项目可读）；草稿不对外 */
export function publishedCourseRule(data: MockData, courseId: string): CourseRuleRevision | undefined {
  return data.courseRuleRevisions
    .filter((item) => item.courseId === courseId && item.status === "published")
    .sort((a, b) => b.number - a.number)[0];
}

/** 未发布规则草稿（仅供获准编辑者读取） */
export function draftCourseRule(data: MockData, courseId: string): CourseRuleRevision | undefined {
  return data.courseRuleRevisions
    .filter((item) => item.courseId === courseId && item.status !== "published")
    .sort((a, b) => b.number - a.number)[0];
}

export function courseRuleHistory(data: MockData, courseId: string): CourseRuleRevision[] {
  return data.courseRuleRevisions
    .filter((item) => item.courseId === courseId)
    .sort((a, b) => b.number - a.number);
}

export function activeBaseline(data: MockData, projectId: string): BaselineRevision | undefined {
  const project = data.projects.find((item) => item.id === projectId);
  return project?.activeBaselineRevisionId
    ? data.baselineRevisions.find((item) => item.id === project.activeBaselineRevisionId)
    : undefined;
}

/** 未发布的基线草稿（含待确认），最新一份优先 */
export function draftBaseline(data: MockData, projectId: string): BaselineRevision | undefined {
  return data.baselineRevisions
    .filter((item) => item.projectId === projectId && item.status !== "published")
    .sort((a, b) => b.number - a.number || b.contentVersion - a.contentVersion)[0];
}

export function activePlan(data: MockData, projectId: string): PlanRevision | undefined {
  const project = data.projects.find((item) => item.id === projectId);
  return project?.activePlanRevisionId
    ? data.planRevisions.find((item) => item.id === project.activePlanRevisionId)
    : undefined;
}

export function draftPlan(data: MockData, projectId: string): PlanRevision | undefined {
  return data.planRevisions
    .filter((item) => item.projectId === projectId && item.status !== "published")
    .sort((a, b) => b.number - a.number || b.contentVersion - a.contentVersion)[0];
}

export function appliedCourseRule(data: MockData, projectId: string): CourseRuleRevision | undefined {
  const project = data.projects.find((item) => item.id === projectId);
  return project?.appliedCourseRuleRevisionId
    ? data.courseRuleRevisions.find((item) => item.id === project.appliedCourseRuleRevisionId)
    : undefined;
}

export function ruleSnapshotOf(course: {
  projectDeadline: string;
  formationDeadline: string;
  groupingMode: "free" | "approval";
  minGroupSize: number;
  maxGroupSize: number;
  requiredFiles: string[];
  rules: string[];
  milestoneTemplate?: CourseRuleSnapshot["milestoneTemplate"];
}): CourseRuleSnapshot {
  return {
    projectDeadline: course.projectDeadline,
    formationDeadline: course.formationDeadline,
    groupingMode: course.groupingMode,
    minGroupSize: course.minGroupSize,
    maxGroupSize: course.maxGroupSize,
    requiredFiles: [...course.requiredFiles],
    githubRequired: course.rules.some((rule) => rule.includes("GitHub")),
    aiAllowed: !course.rules.some((rule) => rule.includes("不允许") && rule.includes("AI")),
    milestoneTemplate: course.milestoneTemplate?.map((item) => ({ ...item })),
  };
}

function legacyBaselineRevision(project: Project, requirements: Requirement[], modules: FunctionalModule[], sourceFileIds: string[]): BaselineRevision {
  return {
    id: `baseline-${project.id}-legacy`,
    projectId: project.id,
    number: Math.max(1, project.baselineVersion),
    version: 1,
    contentVersion: 1,
    status: "published",
    payload: {
      requirements: requirements.filter((item) => item.projectId === project.id).map((item) => ({ ...item })),
      modules: modules.filter((item) => item.projectId === project.id).map((item) => ({ ...item })),
      sourceFileIds: [...sourceFileIds],
    },
    memberRoster: [...project.memberIds],
    confirmations: [],
    legacy: { confirmedUserIds: [...project.confirmedBy], timestampUnknown: true },
  };
}

function legacyPlanRevision(project: Project, tasks: Task[], criteria: MockData["criteria"], baselineRevisionId: string): PlanRevision {
  const projectTasks = tasks.filter((item) => item.projectId === project.id);
  return {
    id: `plan-${project.id}-legacy`,
    projectId: project.id,
    number: Math.max(1, project.planVersion),
    version: 1,
    contentVersion: 1,
    status: "published",
    payload: {
      tasks: projectTasks.map((item) => ({ ...item })),
      criteria: criteria.filter((item) => projectTasks.some((task) => task.id === item.taskId)).map((item) => ({ ...item })),
      milestoneLinks: projectTasks.map((item) => ({ taskId: item.id, milestoneIds: [...item.milestoneIds] })),
    },
    memberRoster: [...project.memberIds],
    confirmations: [],
    baselineRevisionId,
    basedOnRevisionId: baselineRevisionId,
    legacy: { confirmedUserIds: [...project.confirmedBy], timestampUnknown: true },
  };
}

/**
 * 为旧数据建立初始历史快照（幂等）：
 * frozen 基线 / planConfirmed 计划保留已发布状态，历史确认写入 legacy，不伪造确认时间。
 */
export function buildLegacyRevisions(data: MockData): MockData {
  const baselineRevisions = [...data.baselineRevisions];
  const planRevisions = [...data.planRevisions];
  const courseRuleRevisions = [...data.courseRuleRevisions];
  const projects = data.projects.map((project) => {
    let next: Project = { ...project };
    if (next.setupStatus === "frozen" && !next.activeBaselineRevisionId) {
      const revision = legacyBaselineRevision(next, data.requirements, data.modules, data.files.filter((item) => item.projectId === next.id).map((item) => item.id));
      if (!baselineRevisions.some((item) => item.id === revision.id)) baselineRevisions.push(revision);
      next = { ...next, activeBaselineRevisionId: revision.id };
    }
    const baselineId = next.activeBaselineRevisionId ?? "";
    if (next.planConfirmed && !next.activePlanRevisionId && baselineId) {
      const revision = legacyPlanRevision(next, data.tasks, data.criteria, baselineId);
      if (!planRevisions.some((item) => item.id === revision.id)) planRevisions.push(revision);
      next = { ...next, activePlanRevisionId: revision.id };
    }
    return next;
  });

  for (const course of data.courses) {
    const id = `course-rule-${course.id}-legacy`;
    if (courseRuleRevisions.some((item) => item.id === id)) continue;
    courseRuleRevisions.push({
      id,
      courseId: course.id,
      number: course.version,
      version: 1,
      status: "published",
      snapshot: ruleSnapshotOf(course),
      rulesText: [...course.rules],
      legacy: { timestampUnknown: true },
    });
  }

  const withApplied = projects.map((project) => project.appliedCourseRuleRevisionId || !project.courseId
    ? project
    : { ...project, appliedCourseRuleRevisionId: `course-rule-${project.courseId}-legacy` });

  return { ...data, projects: withApplied, baselineRevisions, planRevisions, courseRuleRevisions };
}

export interface MigrationResult {
  data: MockData;
  migrated: boolean;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 格式校验：核心集合缺失或类型不符时报告错误，由调用方保留原始数据 */
export function validateWorkspace(raw: unknown): { ok: true } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: "工作区数据不是对象" };
  for (const key of ["users", "courses", "groups", "projects", "tasks", "requirements"]) {
    if (!Array.isArray(raw[key])) return { ok: false, error: `工作区数据缺少集合 ${key} 或其不是数组` };
  }
  return { ok: true };
}

/**
 * 旧浏览器数据迁移（幂等）：
 * - schemaVersion 缺失/落后时补齐新集合并建立 legacy 快照；
 * - 已是当前版本时原样返回，不增加版本或快照；
 * - 不修改传入对象，旧字段（confirmedBy/planConfirmed 等）保持可读。
 */
export function migrateWorkspace(raw: unknown): MigrationResult {
  const check = validateWorkspace(raw);
  if (!check.ok) return { data: raw as MockData, migrated: false, error: check.error };
  const source = raw as MockData;
  const schemaVersion = typeof source.schemaVersion === "number" ? source.schemaVersion : 0;
  if (schemaVersion >= CURRENT_SCHEMA_VERSION) return { data: source, migrated: false };

  const data: MockData = {
    ...source,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    baselineRevisions: Array.isArray(source.baselineRevisions) ? source.baselineRevisions : [],
    planRevisions: Array.isArray(source.planRevisions) ? source.planRevisions : [],
    courseRuleRevisions: Array.isArray(source.courseRuleRevisions) ? source.courseRuleRevisions : [],
    ruleChangeReviews: Array.isArray(source.ruleChangeReviews) ? source.ruleChangeReviews : [],
    setupDrafts: Array.isArray(source.setupDrafts) ? source.setupDrafts : [],
  };
  return { data: buildLegacyRevisions(data), migrated: true };
}
