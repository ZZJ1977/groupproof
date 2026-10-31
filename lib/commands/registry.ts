import { z } from "zod";
import type { MockData } from "@/types/domain";
import { DomainError, type Command, type CommandContext } from "./core.ts";
import { archiveProject, reopenProject, updateProjectSettings, type ArchiveProjectInput, type ReopenProjectInput, type UpdateProjectSettingsInput } from "./project.ts";
import {
  saveCourseRuleDraft,
  setAssistantPermissions,
  updateCourseSettings,
  publishCourseRules,
  type SaveCourseRuleDraftInput,
  type SetAssistantPermissionsInput,
  type UpdateCourseSettingsInput,
  type PublishCourseRulesInput,
} from "./course.ts";
import { createCourseProject, type CreateCourseProjectInput, type CreateCourseProjectResult } from "./project-create.ts";
import {
  confirmBaselineSelf,
  forcePublishBaseline,
  publishBaseline,
  saveBaselineDraft,
  type ConfirmBaselineSelfInput,
  type ForcePublishBaselineInput,
  type PublishBaselineInput,
  type SaveBaselineDraftInput,
} from "./baseline.ts";
import { unlockPlan, type UnlockPlanInput } from "./plan.ts";
import { applyCourseRuleChange, type ApplyCourseRuleChangeInput } from "./rule-change.ts";
import { uploadProjectFile, type FileMetadataInput } from "./files.ts";
import type { RuleChangeReview } from "@/types/domain";
import type { BaselineRevision, FileRecord, PlanRevision } from "@/types/domain";
import type { Course, CourseRuleRevision, Project } from "@/types/domain";

/**
 * 命令注册表：已实现的命令走完整链路；
 * 未实现的操作明确返回错误，不伪造保存成功（由 04–11 阶段补齐）。
 */

export type CommandName =
  | "project.archive"
  | "project.settings.update"
  | "project.draft.edit"
  | "project.confirm.self"
  | "project.plan.unlock"
  | "project.publish"
  | "project.publish.override"
  | "project.files.write"
  | "project.create"
  | "project.reopen"
  | "project.rules.apply"
  | "course.settings.update"
  | "course.rules.edit"
  | "course.rules.publish"
  | "course.staff.manage";

export type RegisteredCommand =
  | Command<ArchiveProjectInput, Project>
  | Command<UpdateProjectSettingsInput, Project>
  | Command<ReopenProjectInput, Project>
  | Command<UpdateCourseSettingsInput, Course>
  | Command<SaveCourseRuleDraftInput, CourseRuleRevision>
  | Command<PublishCourseRulesInput, CourseRuleRevision>
  | Command<SetAssistantPermissionsInput, Course>
  | Command<CreateCourseProjectInput, CreateCourseProjectResult>
  | Command<SaveBaselineDraftInput, BaselineRevision>
  | Command<ConfirmBaselineSelfInput, BaselineRevision>
  | Command<PublishBaselineInput, BaselineRevision>
  | Command<ForcePublishBaselineInput, BaselineRevision>
  | Command<UnlockPlanInput, PlanRevision>
  | Command<ApplyCourseRuleChangeInput, RuleChangeReview>
  | Command<FileMetadataInput, FileRecord>
  | Command<unknown, never>;

const plannedStage: Partial<Record<CommandName, string>> = {
  "project.files.write": "阶段 10",
};

function notImplemented(name: CommandName): Command<unknown, never> {
  return {
    name,
    input: z.unknown(),
    apply(_data: MockData, _context: CommandContext, _input: unknown): { data: MockData; result: never } {
      throw new DomainError("INVALID_STATE", `命令 ${name} 尚未实现（计划：${plannedStage[name] ?? "后续阶段"}），本次未写入任何数据`);
    },
  };
}

export const commands: Record<CommandName, RegisteredCommand> = {
  "project.archive": archiveProject,
  "project.settings.update": updateProjectSettings,
  "project.draft.edit": saveBaselineDraft,
  "project.confirm.self": confirmBaselineSelf,
  "project.plan.unlock": unlockPlan,
  "project.publish": publishBaseline,
  "project.publish.override": forcePublishBaseline,
  "project.files.write": uploadProjectFile,
  "project.create": createCourseProject,
  "project.reopen": reopenProject,
  "project.rules.apply": applyCourseRuleChange,
  "course.settings.update": updateCourseSettings,
  "course.rules.edit": saveCourseRuleDraft,
  "course.rules.publish": publishCourseRules,
  "course.staff.manage": setAssistantPermissions,
};

export type { ArchiveProjectInput };
export {
  archiveProject,
  confirmBaselineSelf,
  createCourseProject,
  forcePublishBaseline,
  publishBaseline,
  reopenProject,
  saveBaselineDraft,
  saveCourseRuleDraft,
  publishCourseRules,
  setAssistantPermissions,
  updateCourseSettings,
  updateProjectSettings,
};
