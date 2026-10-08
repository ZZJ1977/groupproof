import { z } from "zod";
import type { Milestone, Project } from "@/types/domain";
import { can } from "../access/policy.ts";
import { publishedCourseRule } from "../versioning.ts";
import { DomainError, type Command } from "./core.ts";

/**
 * 课程项目创建命令（阶段 05）。
 *
 * - 创建资格依据目标小组的成员/组长关系（project.create 的 group 目标），不信任表单身份。
 * - 课程强制约束始终适用；templateMode 只控制可选模板（里程碑）初始化。
 * - 已有当前项目时返回现有项目入口，不产生第二个同组项目。
 * - 项目、里程碑、组关联与日志同批提交，失败不留下孤立项目或里程碑。
 */

export const createCourseProjectInput = z.object({
  groupId: z.string().min(1, "缺少小组 ID"),
  name: z.string().trim().min(2, "项目名称至少需要 2 个字符"),
  description: z.string().trim().min(1, "请填写项目简介"),
  templateMode: z.enum(["course", "blank"]),
  expectedGroupVersion: z.number().int().nonnegative(),
  expectedCourseRuleRevisionId: z.string().min(1, "缺少课程规则版本"),
}).strict();

export type CreateCourseProjectInput = z.infer<typeof createCourseProjectInput>;

export interface CreateCourseProjectResult {
  project: Project;
  alreadyExists: boolean;
}

export const createCourseProject: Command<CreateCourseProjectInput, CreateCourseProjectResult> = {
  name: "project.create",
  input: createCourseProjectInput,
  apply(data, context, input) {
    const group = data.groups.find((item) => item.id === input.groupId);
    if (!group) throw new DomainError("NOT_FOUND", "小组不存在");
    const course = data.courses.find((item) => item.id === group.courseId);
    if (!course) throw new DomainError("NOT_FOUND", "小组未关联课程");

    const target = { kind: "group", id: input.groupId } as const;
    if (!can(data, context.actorId, "project.create", target)) {
      throw new DomainError("FORBIDDEN", "只有该小组组长可以创建项目");
    }

    const existing = data.projects.find((item) => item.id === group.projectId);
    if (existing) return { data, result: { project: existing, alreadyExists: true } };

    if (course.status !== "active") {
      throw new DomainError("INVALID_STATE", "只有进行中的课程可以创建课程项目");
    }
    const rule = publishedCourseRule(data, course.id);
    if (!rule) {
      throw new DomainError("INVALID_STATE", "课程尚无已发布规则，无法创建课程项目");
    }
    if (rule.id !== input.expectedCourseRuleRevisionId) {
      throw new DomainError("VERSION_CONFLICT", "课程规则版本已变化，请重新确认规则后再创建", { latestVersion: course.version });
    }
    if (group.version !== input.expectedGroupVersion) {
      throw new DomainError("VERSION_CONFLICT", "小组信息已更新，请刷新后重试", { latestVersion: group.version });
    }
    const size = group.memberIds.length;
    if (size < rule.snapshot.minGroupSize || size > rule.snapshot.maxGroupSize) {
      throw new DomainError("INVALID_STATE", `小组人数需在 ${rule.snapshot.minGroupSize}–${rule.snapshot.maxGroupSize} 人之间`);
    }

    const projectId = `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const project: Project = {
      id: projectId,
      courseId: course.id,
      groupId: group.id,
      name: input.name,
      description: input.description,
      type: "课程项目",
      visibility: "members",
      finalDeadline: rule.snapshot.projectDeadline,
      setupStep: 0,
      setupStatus: "not_initialized",
      baselineVersion: 0,
      planVersion: 0,
      planConfirmed: false,
      confirmedBy: [],
      lifecycle: "active",
      progress: 0,
      coreProgress: 0,
      memberIds: [...group.memberIds],
      version: 1,
      appliedCourseRuleRevisionId: rule.id,
    };
    // 模板模式只决定可选的里程碑初始化；每个里程碑归属新项目，不引用旧项目的实际里程碑
    const milestones: Milestone[] = input.templateMode === "course"
      ? (rule.snapshot.milestoneTemplate ?? []).map((item, index) => ({
          id: `${projectId}-m${index + 1}`,
          projectId,
          title: item.title,
          description: item.description,
          deadline: item.deadline,
          status: "not_started",
          progress: 0,
          taskIds: [],
          deliverables: [],
        }))
      : [];

    return {
      data: {
        ...data,
        projects: [...data.projects, project],
        milestones: [...data.milestones, ...milestones],
        groups: data.groups.map((item) => (item.id === group.id ? { ...item, projectId, version: item.version + 1 } : item)),
        logs: [...data.logs, {
          id: context.logId,
          actorId: context.actorId,
          action: "创建课程项目",
          target: projectId,
          result: "success",
          ip: "mock",
          createdAt: context.now,
          detail: `小组 ${group.name} 创建 ${project.name}；规则版本 ${rule.id}；模板 ${input.templateMode}；里程碑 ${milestones.length} 个`,
        }],
      },
      result: { project, alreadyExists: false },
    };
  },
};
