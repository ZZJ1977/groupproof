import { z } from "zod";
import { can } from "@/lib/access/policy";
import { DomainError, type Command } from "@/lib/commands/core";
import type { FileRecord, MockData } from "@/types/domain";

export interface CFileDesignation {
  idempotencyKey: string;
  actorId: string;
  reason: string;
  expectedProjectVersion: number;
  resultProjectVersion: number;
  fileVersion: number;
  supersededFileIds: string[];
  decidedAt: string;
}
export type FileWithCDecisions = FileRecord & { cDesignationHistory?: CFileDesignation[] };

/** Existing project.files.write membership remains authoritative; teaching readers have no implied write grant. */
export function canWriteProjectFiles(data: MockData, actorId: string, projectId: string): boolean {
  const project = data.projects.find((item) => item.id === projectId);
  const actor = data.users.find((item) => item.id === actorId);
  const course = data.courses.find((item) => item.id === project?.courseId);
  return Boolean(project && actor?.verified && project.lifecycle === "active"
    && (!project.courseId || course?.status === "active")
    && can(data, actorId, "project.files.write", { kind: "project", id: projectId }));
}

const designationSchema = z.object({
  projectId: z.string().min(1),
  fileId: z.string().min(1),
  expectedProjectVersion: z.number().int().nonnegative(),
  reason: z.string().trim().min(1, "设为正式前请填写原因").max(2000),
  idempotencyKey: z.string().min(1).max(128),
}).strict();
export type DesignateProjectFileInput = z.infer<typeof designationSchema>;

/** Atomic local metadata decision; it neither uploads bytes nor delivers member notifications. */
export const designateProjectFile: Command<DesignateProjectFileInput, FileWithCDecisions> = {
  name: "c.file.designate",
  input: designationSchema,
  apply(data, context, input) {
    const project = data.projects.find((item) => item.id === input.projectId);
    const file = data.files.find((item) => item.id === input.fileId && item.projectId === input.projectId) as FileWithCDecisions | undefined;
    if (!project || !file) throw new DomainError("NOT_FOUND", "本项目中没有这份文件版本。");
    if (!canWriteProjectFiles(data, context.actorId, project.id)) throw new DomainError("FORBIDDEN", "仅已验证的项目成员可在活动课程与项目中设置正式文件版本。");
    const replay = (data.files as FileWithCDecisions[])
      .flatMap((item) => (item.cDesignationHistory ?? []).map((decision) => ({ file: item, decision })))
      .find((item) => item.decision.idempotencyKey === input.idempotencyKey);
    if (replay) {
      if (replay.file.id !== file.id || replay.file.projectId !== project.id ||
          replay.decision.actorId !== context.actorId || replay.decision.reason !== input.reason ||
          replay.decision.expectedProjectVersion !== input.expectedProjectVersion) {
        throw new DomainError("VERSION_CONFLICT", "此提交标识已用于其他文件决策，请重新确认。");
      }
      // A later replacement may have superseded this version; a replay must never promote it again.
      return { data, result: file };
    }
    if (project.version !== input.expectedProjectVersion) throw new DomainError("VERSION_CONFLICT", "项目资料已更新，原因已保留；请核对最新版本后重新确认。", { latestVersion: project.version });
    if (file.status !== "draft") throw new DomainError("INVALID_STATE", "只能将草稿文件版本设为正式。");
    const supersededFileIds = data.files.filter((item) => item.projectId === project.id && item.name === file.name && item.status === "current").map((item) => item.id).sort();
    const decision: CFileDesignation = {
      idempotencyKey: input.idempotencyKey, actorId: context.actorId, reason: input.reason,
      expectedProjectVersion: input.expectedProjectVersion, resultProjectVersion: project.version + 1,
      fileVersion: file.version, supersededFileIds, decidedAt: context.now,
    };
    const updated: FileWithCDecisions = {
      ...file, status: "current", updatedAt: context.now,
      cDesignationHistory: [...(file.cDesignationHistory ?? []), decision],
    };
    return {
      data: {
        ...data,
        files: data.files.map((item) => item.id === file.id ? updated : supersededFileIds.includes(item.id) ? { ...item, status: "superseded" as const } : item),
        projects: data.projects.map((item) => item.id === project.id ? { ...item, version: project.version + 1 } : item),
        logs: [...data.logs, {
          id: context.logId, actorId: context.actorId, action: "设为正式文件版本", target: file.id,
          result: "success", ip: "mock", createdAt: context.now,
          detail: `${file.name} v${file.version}；${input.reason}；本地元数据决策，未发送真实成员通知`,
        }],
      },
      result: updated,
    };
  },
};
