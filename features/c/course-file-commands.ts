import { z } from "zod";
import { can } from "@/lib/access/policy";
import { DomainError, type Command } from "@/lib/commands/core";
import type { FileRecord, MockData } from "@/types/domain";

export interface CourseFileChange {
  action: "upload" | "replace" | "publish";
  idempotencyKey: string;
  inputSignature: string;
  actorId: string;
  reason: string;
  expectedCourseVersion: number;
  resultCourseVersion: number;
  supersededFileIds: string[];
  changedAt: string;
}
export type CourseFileRecord = FileRecord & { cCourseFileHistory?: CourseFileChange[] };

/** Explicit course ownership; global administrator status grants no content access. */
export function courseFileAccess(data: MockData, actorId: string, courseId: string | undefined) {
  const course = data.courses.find((item) => item.id === courseId);
  const actor = data.users.find((item) => item.id === actorId);
  const readable = Boolean(course && actor && ["teacher", "ta"].includes(actor.role)
    && can(data, actorId, "course.read", { kind: "course", id: course.id }));
  return { course, readable, writable: Boolean(readable && actor?.role === "teacher"
    && actor.verified && course?.status !== "ended") };
}

export function listCourseFiles(data: MockData, actorId: string, courseId: string): CourseFileRecord[] {
  const access = courseFileAccess(data, actorId, courseId);
  if (!access.course) throw new DomainError("NOT_FOUND", "课程不存在。");
  if (!access.readable) throw new DomainError("FORBIDDEN", "仅所属教师或该课程助教可以查看课程资料。");
  return data.files.filter((item) => item.courseId === courseId && !item.projectId);
}

const allowedExtensions = ["pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "md", "txt"];
const baseInput = z.object({
  courseId: z.string().min(1),
  fileId: z.string().min(1).max(128),
  expectedCourseVersion: z.number().int().nonnegative(),
  reason: z.string().trim().min(1, "请填写资料更新原因").max(2000),
  idempotencyKey: z.string().min(1).max(128),
});
const draftFields = {
  name: z.string().trim().min(1).max(255).refine((name) => !/[\\/\u0000-\u001f\u007f]/.test(name), "文件名不能含路径或控制字符"),
  sizeBytes: z.number().int().min(1).max(50 * 1024 * 1024),
  mimeType: z.string().max(200),
};
const courseFileInput = z.discriminatedUnion("action", [
  baseInput.extend({ action: z.literal("upload"), ...draftFields }).strict(),
  baseInput.extend({ action: z.literal("replace"), replacesFileId: z.string().min(1), ...draftFields }).strict(),
  baseInput.extend({ action: z.literal("publish") }).strict(),
]);
export type CourseFileInput = z.infer<typeof courseFileInput>;

/** Local metadata only. One transaction-like workspace save; A/B/D records are untouched. */
export const changeCourseFile: Command<CourseFileInput, CourseFileRecord> = {
  name: "c.course-files.change",
  input: courseFileInput,
  apply(data, context, input) {
    const access = courseFileAccess(data, context.actorId, input.courseId);
    if (!access.course) throw new DomainError("NOT_FOUND", "课程不存在。");
    if (!access.writable) throw new DomainError("FORBIDDEN", "仅已验证的所属教师可修改未结束课程的资料；助教只读。");
    const course = access.course;
    const files = listCourseFiles(data, context.actorId, course.id);
    const { idempotencyKey, ...payload } = input;
    const signature = JSON.stringify(payload);
    const replay = (data.files as CourseFileRecord[]).flatMap((file) =>
      (file.cCourseFileHistory ?? []).map((change) => ({ file, change })))
      .find(({ change }) => change.idempotencyKey === idempotencyKey);
    if (replay) {
      if (replay.change.actorId !== context.actorId || replay.change.inputSignature !== signature) {
        throw new DomainError("VERSION_CONFLICT", "此提交标识已用于其他资料操作，请重新确认。");
      }
      // Replay does not restore a file superseded by a newer publication.
      return { data, result: replay.file };
    }
    if (course.version !== input.expectedCourseVersion) {
      throw new DomainError("VERSION_CONFLICT", "课程资料已变化；输入已保留，请核对最新版本后重试。", { latestVersion: course.version });
    }
    let result: CourseFileRecord;
    let supersededFileIds: string[] = [];
    if (input.action === "publish") {
      const file = files.find((item) => item.id === input.fileId);
      if (!file) throw new DomainError("NOT_FOUND", "该课程中没有此资料版本。");
      if (file.status !== "draft") throw new DomainError("INVALID_STATE", "只能发布草稿版本。");
      const logical = files.filter((item) => item.name === file.name);
      if (logical.some((item) => item.version > file.version)) throw new DomainError("INVALID_STATE", "已有更新的资料版本，请选择最新草稿。");
      supersededFileIds = logical.filter((item) => item.id !== file.id && item.status !== "superseded").map((item) => item.id).sort();
      result = { ...file, status: "current", updatedAt: context.now };
    } else {
      if (data.files.some((item) => item.id === input.fileId)) throw new DomainError("VERSION_CONFLICT", "此文件标识已存在，请重新选择文件。");
      const extension = input.name.split(".").pop()?.toLowerCase() ?? "";
      if (!allowedExtensions.includes(extension)) throw new DomainError("VALIDATION_ERROR", "不支持此文件格式。");
      let name = input.name;
      if (input.action === "replace") {
        const target = files.find((item) => item.id === input.replacesFileId);
        if (!target) throw new DomainError("NOT_FOUND", "被替换资料不属于此课程。");
        if (target.status === "superseded" || files.some((item) => item.name === target.name && item.version > target.version)) {
          throw new DomainError("INVALID_STATE", "请替换最新资料版本，历史版本保持不变。");
        }
        if (target.name.split(".").pop()?.toLowerCase() !== extension) throw new DomainError("VALIDATION_ERROR", "替换文件须保持原文件格式；更换格式请新增资料。");
        name = target.name;
        if (target.status === "draft") supersededFileIds = [target.id];
      } else if (files.some((item) => item.name === name)) {
        throw new DomainError("INVALID_STATE", "同名课程资料已存在，请使用替换操作。");
      }
      result = {
        id: input.fileId, courseId: course.id, name, type: extension.toUpperCase(),
        source: "课程文件（演示元数据）", uploaderId: context.actorId,
        version: Math.max(0, ...files.filter((item) => item.name === name).map((item) => item.version)) + 1,
        status: "draft", updatedAt: context.now, sizeBytes: input.sizeBytes, mimeType: input.mimeType,
        size: input.sizeBytes >= 1048576 ? `${(input.sizeBytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(input.sizeBytes / 1024))} KB`,
      };
    }
    const change: CourseFileChange = {
      action: input.action, idempotencyKey, inputSignature: signature, actorId: context.actorId,
      reason: input.reason, expectedCourseVersion: course.version, resultCourseVersion: course.version + 1,
      supersededFileIds, changedAt: context.now,
    };
    result = { ...result, cCourseFileHistory: [...(result.cCourseFileHistory ?? []), change] };
    const nextFiles = data.files.map((item) => item.id === result.id ? result
      : supersededFileIds.includes(item.id) ? { ...item, status: "superseded" as const } : item);
    if (input.action !== "publish") nextFiles.push(result);
    return {
      data: { ...data, files: nextFiles,
        courses: data.courses.map((item) => item.id === course.id ? { ...item, version: item.version + 1 } : item),
        logs: [...data.logs, { id: context.logId, actorId: context.actorId,
          action: input.action === "publish" ? "发布课程资料版本" : input.action === "replace" ? "替换课程资料草稿" : "新增课程资料草稿",
          target: result.id, result: "success", ip: "mock", createdAt: context.now,
          detail: `${course.id} / ${result.name} v${result.version}；${input.reason}；仅本地演示元数据，未存储文件字节或发送通知；冻结引用保持原版本`,
        }],
      }, result,
    };
  },
};
