import { z } from "zod";
import type { AssistantGrant, Course, CourseRulePayload, CourseRuleRevision, DelegatedPermission, MockData } from "@/types/domain";
import { can } from "../access/policy.ts";
import { draftCourseRule, publishedCourseRule } from "../versioning.ts";
import { DomainError, type Command, type CommandContext } from "./core.ts";

/**
 * 课程规则与模板、助教授权命令（阶段 04）。
 * - 规则草稿不覆盖已发布版本；发布创建历史快照并通知关联小组复核。
 * - 课程 ended 后业务规则只读，授权撤销仍可处理。
 * - 评分说明仅管理展示，不实现贡献或评分算法。
 */

export const editableCourseActions: DelegatedPermission[] = [
  "course.settings.update",
  "course.rules.edit",
  "course.rules.publish",
];

export function validateGrant(permissions: string[]): void {
  if (permissions.some((item) => !editableCourseActions.includes(item as DelegatedPermission))) {
    throw new DomainError("VALIDATION_ERROR", "包含不允许授予助教的权限", {
      fieldErrors: { permissions: ["只允许授予课程设置修改、规则编辑、规则发布"] },
    });
  }
}

const dateText = z.string().regex(/^\d{4}-\d{2}/, "请填写日期");

export const courseRulePayloadSchema = z.object({
  projectDeadline: dateText,
  formationDeadline: dateText,
  groupingMode: z.enum(["free", "approval"]),
  minGroupSize: z.number().int().min(1, "最少人数至少为 1"),
  maxGroupSize: z.number().int().min(1, "最多人数至少为 1"),
  requiredFiles: z.array(z.string().trim().min(1, "必交材料名称不能为空")),
  gradingNotes: z.string(),
  githubRequired: z.boolean(),
  aiAllowed: z.boolean(),
  rulesText: z.array(z.string()),
  milestoneTemplate: z.array(z.object({
    id: z.string().min(1),
    title: z.string().trim().min(1, "阶段名称不能为空"),
    description: z.string(),
    deadline: dateText,
  })),
});

export type CourseRulePayloadInput = z.infer<typeof courseRulePayloadSchema>;

function validatePayload(payload: CourseRulePayloadInput): void {
  const fieldErrors: Record<string, string[]> = {};
  if (payload.maxGroupSize < payload.minGroupSize) {
    fieldErrors.maxGroupSize = ["最多人数不能小于最少人数"];
  }
  if (payload.formationDeadline > payload.projectDeadline) {
    fieldErrors.formationDeadline = ["组队截止不能晚于项目截止"];
  }
  if (payload.milestoneTemplate.some((item) => !item.title.trim() || !item.deadline)) {
    fieldErrors.milestoneTemplate = ["每个阶段需要名称与截止日期"];
  }
  if (payload.requiredFiles.some((item) => !item.trim())) {
    fieldErrors.requiredFiles = ["必交材料名称不能为空"];
  }
  if (Object.keys(fieldErrors).length) {
    throw new DomainError("VALIDATION_ERROR", "课程规则内容校验未通过", { fieldErrors });
  }
}

function findCourseOrThrow(data: MockData, courseId: string): Course {
  const course = data.courses.find((item) => item.id === courseId);
  if (!course) throw new DomainError("NOT_FOUND", "课程不存在");
  return course;
}

function assertWritableCourse(course: Course): void {
  if (course.status === "ended") {
    throw new DomainError("INVALID_STATE", "已结束课程的业务规则保持只读");
  }
}

function payloadOf(revision: CourseRuleRevision): CourseRulePayload {
  return {
    projectDeadline: revision.snapshot.projectDeadline,
    formationDeadline: revision.snapshot.formationDeadline,
    groupingMode: revision.snapshot.groupingMode,
    minGroupSize: revision.snapshot.minGroupSize,
    maxGroupSize: revision.snapshot.maxGroupSize,
    requiredFiles: [...revision.snapshot.requiredFiles],
    gradingNotes: revision.snapshot.gradingNotes ?? "",
    githubRequired: revision.snapshot.githubRequired,
    aiAllowed: revision.snapshot.aiAllowed,
    rulesText: [...revision.rulesText],
    milestoneTemplate: (revision.snapshot.milestoneTemplate ?? []).map((item) => ({ ...item })),
  };
}

function snapshotOfPayload(payload: CourseRulePayloadInput) {
  return {
    projectDeadline: payload.projectDeadline,
    formationDeadline: payload.formationDeadline,
    groupingMode: payload.groupingMode,
    minGroupSize: payload.minGroupSize,
    maxGroupSize: payload.maxGroupSize,
    requiredFiles: [...payload.requiredFiles],
    gradingNotes: payload.gradingNotes,
    githubRequired: payload.githubRequired,
    aiAllowed: payload.aiAllowed,
    milestoneTemplate: payload.milestoneTemplate.map((item) => ({ ...item })),
  };
}

// ── 课程设置 ─────────────────────────────────────────────────────

export const updateCourseSettingsInput = z.object({
  courseId: z.string().min(1),
  name: z.string().trim().min(2, "课程名称至少 2 个字符"),
  projectDeadline: dateText,
  formationDeadline: dateText,
  groupingMode: z.enum(["free", "approval"]),
  minGroupSize: z.number().int().min(1),
  maxGroupSize: z.number().int().min(1),
  reason: z.string().trim().min(1, "请填写变更原因"),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

export type UpdateCourseSettingsInput = z.infer<typeof updateCourseSettingsInput>;

export const updateCourseSettings: Command<UpdateCourseSettingsInput, Course> = {
  name: "course.settings.update",
  input: updateCourseSettingsInput,
  apply(data, context, input) {
    const course = findCourseOrThrow(data, input.courseId);
    if (!can(data, context.actorId, "course.settings.update", { kind: "course", id: course.id })) {
      throw new DomainError("FORBIDDEN", "当前用户没有课程设置修改授权");
    }
    if (course.version !== input.expectedVersion) {
      throw new DomainError("VERSION_CONFLICT", "课程已更新，请刷新后重试", { latestVersion: course.version });
    }
    assertWritableCourse(course);
    if (input.maxGroupSize < input.minGroupSize) {
      throw new DomainError("VALIDATION_ERROR", "课程规则内容校验未通过", { fieldErrors: { maxGroupSize: ["最多人数不能小于最少人数"] } });
    }
    if (input.formationDeadline > input.projectDeadline) {
      throw new DomainError("VALIDATION_ERROR", "课程规则内容校验未通过", { fieldErrors: { formationDeadline: ["组队截止不能晚于项目截止"] } });
    }
    const next: Course = {
      ...course,
      name: input.name,
      projectDeadline: input.projectDeadline,
      formationDeadline: input.formationDeadline,
      groupingMode: input.groupingMode,
      minGroupSize: input.minGroupSize,
      maxGroupSize: input.maxGroupSize,
      version: course.version + 1,
    };
    return {
      data: {
        ...data,
        courses: data.courses.map((item) => (item.id === course.id ? next : item)),
        logs: [...data.logs, {
          id: context.logId,
          actorId: context.actorId,
          action: "课程设置变更",
          target: course.id,
          result: "success",
          ip: "mock",
          createdAt: context.now,
          detail: `v${course.version} → v${next.version}；${input.reason}`,
        }],
      },
      result: next,
    };
  },
};

// ── 规则草稿 ─────────────────────────────────────────────────────

export const saveCourseRuleDraftInput = z.object({
  courseId: z.string().min(1),
  payload: courseRulePayloadSchema,
  reason: z.string().trim().min(1, "请填写规则变更原因"),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

export type SaveCourseRuleDraftInput = z.infer<typeof saveCourseRuleDraftInput>;

export const saveCourseRuleDraft: Command<SaveCourseRuleDraftInput, CourseRuleRevision> = {
  name: "course.rules.edit",
  input: saveCourseRuleDraftInput,
  apply(data, context, input) {
    const course = findCourseOrThrow(data, input.courseId);
    if (!can(data, context.actorId, "course.rules.edit", { kind: "course", id: course.id })) {
      throw new DomainError("FORBIDDEN", "当前用户没有规则编辑授权");
    }
    if (course.version !== input.expectedVersion) {
      throw new DomainError("VERSION_CONFLICT", "课程已更新，请刷新后重试", { latestVersion: course.version });
    }
    assertWritableCourse(course);
    validatePayload(input.payload);

    const published = publishedCourseRule(data, course.id);
    const draft = draftCourseRule(data, course.id);
    const revision: CourseRuleRevision = draft
      ? {
          ...draft,
          version: draft.version + 1,
          snapshot: snapshotOfPayload(input.payload),
          rulesText: [...input.payload.rulesText],
          reason: input.reason,
        }
      : {
          id: `course-rule-${course.id}-${Date.now().toString(36)}`,
          courseId: course.id,
          number: (published?.number ?? course.version) + 1,
          version: 1,
          status: "draft",
          snapshot: snapshotOfPayload(input.payload),
          rulesText: [...input.payload.rulesText],
          reason: input.reason,
          basedOnRevisionId: published?.id,
        };
    const kept = data.courseRuleRevisions.filter((item) => item.id !== revision.id);
    return {
      data: { ...data, courseRuleRevisions: [...kept, revision] },
      result: revision,
    };
  },
};

// ── 发布规则 ─────────────────────────────────────────────────────

export const publishCourseRulesInput = z.object({
  courseId: z.string().min(1),
  revisionId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

export type PublishCourseRulesInput = z.infer<typeof publishCourseRulesInput>;

export const publishCourseRules: Command<PublishCourseRulesInput, CourseRuleRevision> = {
  name: "course.rules.publish",
  input: publishCourseRulesInput,
  apply(data, context, input) {
    const course = findCourseOrThrow(data, input.courseId);
    if (!can(data, context.actorId, "course.rules.publish", { kind: "course", id: course.id })) {
      throw new DomainError("FORBIDDEN", "当前用户没有规则发布授权");
    }
    if (course.version !== input.expectedVersion) {
      throw new DomainError("VERSION_CONFLICT", "课程已更新，请刷新后重试", { latestVersion: course.version });
    }
    assertWritableCourse(course);
    const draft = data.courseRuleRevisions.find((item) => item.id === input.revisionId && item.courseId === course.id);
    if (!draft) throw new DomainError("NOT_FOUND", "规则草稿不存在");
    if (draft.status === "published") throw new DomainError("INVALID_STATE", "该版本已发布，不能重复发布");
    if (!draft.reason?.trim()) {
      throw new DomainError("VALIDATION_ERROR", "发布前需要填写变更原因", { fieldErrors: { reason: ["请填写规则变更原因"] } });
    }
    validatePayload({ ...draft.snapshot, rulesText: draft.rulesText, milestoneTemplate: draft.snapshot.milestoneTemplate ?? [] } as CourseRulePayloadInput);

    const published: CourseRuleRevision = {
      ...draft,
      status: "published",
      version: draft.version + 1,
      publishedBy: context.actorId,
      publishedAt: context.now,
    };
    const payload = payloadOf(published);
    const nextCourse: Course = {
      ...course,
      projectDeadline: payload.projectDeadline,
      formationDeadline: payload.formationDeadline,
      groupingMode: payload.groupingMode,
      minGroupSize: payload.minGroupSize,
      maxGroupSize: payload.maxGroupSize,
      requiredFiles: [...payload.requiredFiles],
      rules: [...payload.rulesText],
      milestoneTemplate: payload.milestoneTemplate.map((item) => ({ ...item })),
      version: course.version + 1,
    };

    // 关联小组生成复核待处理项；重复发布请求不重复生成提醒
    const groups = data.groups.filter((item) => item.courseId === course.id);
    const additions = groups
      .filter((group) => !data.actionItems.some((item) => item.type === `rule-review:${published.id}` && item.groupId === group.id))
      .map((group, index) => ({
        id: `${context.logId}-action-${index}`,
        assigneeId: group.leaderId,
        courseId: course.id,
        projectId: group.projectId,
        groupId: group.id,
        type: `rule-review:${published.id}`,
        title: `复核 ${course.name} 课程规则 v${published.number}`,
        description: `规则版本 v${published.number} 已发布（${draft.reason}），请检查对小组项目的影响。`,
        status: "pending" as const,
        dueAt: course.projectDeadline,
        href: `/courses/${course.id}/rule-changes`,
        priority: "medium" as const,
      }));

    return {
      data: {
        ...data,
        courses: data.courses.map((item) => (item.id === course.id ? nextCourse : item)),
        courseRuleRevisions: data.courseRuleRevisions.map((item) => (item.id === published.id ? published : item)),
        actionItems: [...data.actionItems, ...additions],
        logs: [...data.logs, {
          id: context.logId,
          actorId: context.actorId,
          action: "课程规则发布",
          target: course.id,
          result: "success",
          ip: "mock",
          createdAt: context.now,
          detail: `发布规则 v${published.number}（${published.id}）；${draft.reason}`,
        }],
      },
      result: published,
    };
  },
};

// ── 助教授权 ─────────────────────────────────────────────────────

export const setAssistantPermissionsInput = z.object({
  courseId: z.string().min(1),
  assistantId: z.string().min(1),
  permissions: z.array(z.enum(["course.settings.update", "course.rules.edit", "course.rules.publish"])),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

export type SetAssistantPermissionsInput = z.infer<typeof setAssistantPermissionsInput>;

export const setAssistantPermissions: Command<SetAssistantPermissionsInput, Course> = {
  name: "course.staff.manage",
  input: setAssistantPermissionsInput,
  apply(data, context, input) {
    const course = findCourseOrThrow(data, input.courseId);
    if (!can(data, context.actorId, "course.staff.manage", { kind: "course", id: course.id })) {
      throw new DomainError("FORBIDDEN", "只有课程负责人可以管理助教授权");
    }
    if (course.version !== input.expectedVersion) {
      throw new DomainError("VERSION_CONFLICT", "课程已更新，请刷新后重试", { latestVersion: course.version });
    }
    const assistant = data.users.find((item) => item.id === input.assistantId);
    if (!assistant) throw new DomainError("NOT_FOUND", "助教账号不存在");
    if (assistant.role !== "ta") {
      throw new DomainError("VALIDATION_ERROR", "目标账号必须是助教", { fieldErrors: { assistantId: ["目标账号必须是助教"] } });
    }
    validateGrant(input.permissions);

    const grants = course.assistantGrants ?? [];
    const entry: AssistantGrant = { userId: input.assistantId, permissions: [...input.permissions] };
    const nextGrants = grants.some((item) => item.userId === input.assistantId)
      ? grants.map((item) => (item.userId === input.assistantId ? entry : item))
      : [...grants, entry];
    const next: Course = { ...course, assistantGrants: nextGrants, version: course.version + 1 };
    return {
      data: {
        ...data,
        courses: data.courses.map((item) => (item.id === course.id ? next : item)),
        logs: [...data.logs, {
          id: context.logId,
          actorId: context.actorId,
          action: input.permissions.length ? "授予助教权限" : "撤销助教权限",
          target: `${course.id}:${input.assistantId}`,
          result: "success",
          ip: "mock",
          createdAt: context.now,
          detail: input.permissions.length ? `授予 ${input.permissions.join("、")}` : "撤销全部操作授权，保留课程归属（只读）",
        }],
      },
      result: next,
    };
  },
};
