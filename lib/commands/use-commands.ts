"use client";

import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { mockService } from "@/lib/api/mock-service";
import { scopedWorkspaceKey, useWorkspace } from "@/lib/workspace";
import { seedData } from "@/mocks/seed";
import type { BaselineRevision, Course, CourseRuleRevision, MockData, Project } from "@/types/domain";
import { createCommandRunner, type Command, type CommandOutcome, type WorkspaceRepository } from "./core";
import { archiveProject, reopenProject, updateProjectSettings, type ArchiveProjectInput, type ReopenProjectInput, type UpdateProjectSettingsInput } from "./project";
import {
  publishCourseRules,
  saveCourseRuleDraft,
  setAssistantPermissions,
  updateCourseSettings,
  type PublishCourseRulesInput,
  type SaveCourseRuleDraftInput,
  type SetAssistantPermissionsInput,
  type UpdateCourseSettingsInput,
} from "./course";
import { createCourseProject, type CreateCourseProjectInput, type CreateCourseProjectResult } from "./project-create";
import {
  confirmBaselineSelf,
  forcePublishBaseline,
  publishBaseline,
  saveBaselineDraft,
  submitBaselineForConfirmation,
  createBaselineDraft,
  type ConfirmBaselineSelfInput,
  type CreateBaselineDraftInput,
  type ForcePublishBaselineInput,
  type PublishBaselineInput,
  type SaveBaselineDraftInput,
  type SubmitBaselineForConfirmationInput,
} from "./baseline";
import {
  advanceSetupStep,
  runMockRequirementAnalysis,
  saveSetupDraft,
  type AdvanceSetupStepInput,
  type RunMockRequirementAnalysisInput,
  type SaveSetupDraftInput,
} from "./setup";
import {
  confirmAssignmentSelf,
  createPlanDraft,
  forcePublishPlan,
  publishPlan,
  savePlanDraft,
  unlockPlan,
  type ConfirmAssignmentSelfInput,
  type CreatePlanDraftInput,
  type ForcePublishPlanInput,
  type PublishPlanInput,
  type SavePlanDraftInput,
  type UnlockPlanInput,
} from "./plan";
import { applyCourseRuleChange, type ApplyCourseRuleChangeInput } from "./rule-change";
import { replaceProjectFile, uploadProjectFile, type FileMetadataInput } from "./files";
import type { FileRecord, PlanRevision, RuleChangeReview, SetupDraft } from "@/types/domain";

const mockRepository: WorkspaceRepository = {
  read: () => mockService.getWorkspace(),
  save: (data) => mockService.saveWorkspace(data),
};

/**
 * 公开命令 Hook：返回有类型的操作与 pending 状态；
 * 结果为 { ok, result } 或 { ok: false, error }，保存失败不更新缓存。
 * 内部存储原语（workspace.update/add/remove）不作为受控对象的写入口。
 */
export function useCommands() {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);
  // 缓存键按用户隔离（与 WorkspaceProvider 一致），否则命令结果不回写当前用户视图
  const { userId } = useWorkspace();
  const workspaceQueryKey = useMemo(() => scopedWorkspaceKey(userId), [userId]);

  const runner = useMemo(() => createCommandRunner({
    repository: mockRepository,
    currentActorId: () => (queryClient.getQueryData<MockData>(workspaceQueryKey) ?? seedData).currentUserId,
    onSaved: (next) => queryClient.setQueryData(workspaceQueryKey, next),
  }), [queryClient, workspaceQueryKey]);

  const bind = useCallback(<I, O>(command: Command<I, O>, name: string) =>
    async (input: I): Promise<CommandOutcome<O>> => {
      setPending(name);
      try {
        return await runner(command, input);
      } finally {
        setPending(null);
      }
    }, [runner]);

  return {
    archiveProject: bind(archiveProject, "project.archive") as (input: ArchiveProjectInput) => Promise<CommandOutcome<Project>>,
    updateProjectSettings: bind(updateProjectSettings, "project.settings.update") as (input: UpdateProjectSettingsInput) => Promise<CommandOutcome<Project>>,
    reopenProject: bind(reopenProject, "project.reopen") as (input: ReopenProjectInput) => Promise<CommandOutcome<Project>>,
    createCourseProject: bind(createCourseProject, "project.create") as (input: CreateCourseProjectInput) => Promise<CommandOutcome<CreateCourseProjectResult>>,
    updateCourseSettings: bind(updateCourseSettings, "course.settings.update") as (input: UpdateCourseSettingsInput) => Promise<CommandOutcome<Course>>,
    saveCourseRuleDraft: bind(saveCourseRuleDraft, "course.rules.edit") as (input: SaveCourseRuleDraftInput) => Promise<CommandOutcome<CourseRuleRevision>>,
    publishCourseRules: bind(publishCourseRules, "course.rules.publish") as (input: PublishCourseRulesInput) => Promise<CommandOutcome<CourseRuleRevision>>,
    setAssistantPermissions: bind(setAssistantPermissions, "course.staff.manage") as (input: SetAssistantPermissionsInput) => Promise<CommandOutcome<Course>>,
    createBaselineDraft: bind(createBaselineDraft, "project.draft.edit") as (input: CreateBaselineDraftInput) => Promise<CommandOutcome<BaselineRevision>>,
    saveBaselineDraft: bind(saveBaselineDraft, "project.draft.edit") as (input: SaveBaselineDraftInput) => Promise<CommandOutcome<BaselineRevision>>,
    submitBaselineForConfirmation: bind(submitBaselineForConfirmation, "project.draft.edit") as (input: SubmitBaselineForConfirmationInput) => Promise<CommandOutcome<BaselineRevision>>,
    confirmBaselineSelf: bind(confirmBaselineSelf, "project.confirm.self") as (input: ConfirmBaselineSelfInput) => Promise<CommandOutcome<BaselineRevision>>,
    publishBaseline: bind(publishBaseline, "project.publish") as (input: PublishBaselineInput) => Promise<CommandOutcome<BaselineRevision>>,
    forcePublishBaseline: bind(forcePublishBaseline, "project.publish.override") as (input: ForcePublishBaselineInput) => Promise<CommandOutcome<BaselineRevision>>,
    saveSetupDraft: bind(saveSetupDraft, "project.draft.edit") as (input: SaveSetupDraftInput) => Promise<CommandOutcome<SetupDraft>>,
    advanceSetupStep: bind(advanceSetupStep, "project.draft.edit") as (input: AdvanceSetupStepInput) => Promise<CommandOutcome<SetupDraft>>,
    runMockRequirementAnalysis: bind(runMockRequirementAnalysis, "project.draft.edit") as (input: RunMockRequirementAnalysisInput) => Promise<CommandOutcome<SetupDraft>>,
    createPlanDraft: bind(createPlanDraft, "project.draft.edit") as (input: CreatePlanDraftInput) => Promise<CommandOutcome<PlanRevision>>,
    savePlanDraft: bind(savePlanDraft, "project.draft.edit") as (input: SavePlanDraftInput) => Promise<CommandOutcome<PlanRevision>>,
    confirmAssignmentSelf: bind(confirmAssignmentSelf, "project.confirm.self") as (input: ConfirmAssignmentSelfInput) => Promise<CommandOutcome<PlanRevision>>,
    publishPlan: bind(publishPlan, "project.publish") as (input: PublishPlanInput) => Promise<CommandOutcome<PlanRevision>>,
    forcePublishPlan: bind(forcePublishPlan, "project.publish.override") as (input: ForcePublishPlanInput) => Promise<CommandOutcome<PlanRevision>>,
    unlockPlan: bind(unlockPlan, "project.plan.unlock") as (input: UnlockPlanInput) => Promise<CommandOutcome<PlanRevision>>,
    applyCourseRuleChange: bind(applyCourseRuleChange, "project.rules.apply") as (input: ApplyCourseRuleChangeInput) => Promise<CommandOutcome<RuleChangeReview>>,
    uploadProjectFile: bind(uploadProjectFile, "project.files.write") as (input: FileMetadataInput) => Promise<CommandOutcome<FileRecord>>,
    replaceProjectFile: bind(replaceProjectFile, "project.files.write") as (input: FileMetadataInput) => Promise<CommandOutcome<FileRecord>>,
    pending,
  };
}

export type { CommandOutcome };
