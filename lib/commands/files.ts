import { z } from "zod";
import type { FileRecord, MockData } from "@/types/domain";
import { can } from "../access/policy.ts";
import { DomainError, type Command, type CommandContext } from "./core.ts";

/**
 * 项目资料与文件版本（阶段 10）。
 *
 * - 当前为 Mock 文件契约：只保存元数据（原始字节数 + MIME），模拟上传/预览/下载，
 *   不声称浏览器元数据等于真实文件保存。
 * - 读取按 project.content.read；上传/替换按 project.files.write 且要求 active 项目。
 * - 同名文件关联逻辑文件，替换生成新 FileRecord 版本，旧版本保留；正式基线 sourceFileId 引用不被改写。
 * - 真实文件服务适配边界（后续替换本模块）：
 *   输入 = 上传会话（元数据 + 服务端校验格式/字节数）与上传完成确认；
 *   输出 = 受授权的预览/下载信息（短时签名 URL）；
 *   授权 = 服务端按 project.content.read / files.write 校验，条件版本更新保证替换原子性。
 */

export const ALLOWED_EXTENSIONS = ["pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "md", "txt", "zip", "png", "jpg", "jpeg"] as const;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export function validateUploadSize(sizeBytes: number): void {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_FILE_BYTES) {
    throw new DomainError("VALIDATION_ERROR", "单文件大小必须在 0–50MB 范围内", {
      fieldErrors: { sizeBytes: ["单文件大小必须在 0–50MB 范围内"] },
    });
  }
}

export function validateUploadName(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  if (!ALLOWED_EXTENSIONS.includes(extension as (typeof ALLOWED_EXTENSIONS)[number])) {
    throw new DomainError("VALIDATION_ERROR", `不支持的文件格式：${extension || "未知"}`, {
      fieldErrors: { name: [`支持的格式：${ALLOWED_EXTENSIONS.join("、")}`] },
    });
  }
  return extension;
}

function formatSize(sizeBytes: number): string {
  return sizeBytes >= 1024 * 1024 ? `${(sizeBytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
}

const fileInputSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().trim().min(1, "文件名不能为空"),
  mimeType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative(),
  expectedVersion: z.number().int().nonnegative(),
  replacesFileId: z.string().optional(),
});

export type FileMetadataInput = z.infer<typeof fileInputSchema>;

function findProjectOrThrow(data: MockData, projectId: string) {
  const project = data.projects.find((item) => item.id === projectId);
  if (!project) throw new DomainError("NOT_FOUND", "项目不存在");
  return project;
}

function applyUpload(
  data: MockData,
  context: CommandContext,
  input: FileMetadataInput,
): { data: MockData; result: FileRecord } {
  const project = findProjectOrThrow(data, input.projectId);
  if (!can(data, context.actorId, "project.files.write", { kind: "project", id: project.id })) {
    throw new DomainError("FORBIDDEN", "只有项目成员可以上传或替换项目资料");
  }
  if (project.version !== input.expectedVersion) {
    throw new DomainError("VERSION_CONFLICT", "项目已更新，请刷新后重试", { latestVersion: project.version });
  }
  if (project.lifecycle !== "active") {
    throw new DomainError("INVALID_STATE", "归档或定稿项目不再接受资料写入");
  }
  const extension = validateUploadName(input.name);
  validateUploadSize(input.sizeBytes);

  let replaces: FileRecord | undefined;
  if (input.replacesFileId) {
    replaces = data.files.find((item) => item.id === input.replacesFileId);
    if (!replaces) throw new DomainError("NOT_FOUND", "被替换的文件版本不存在");
    if (replaces.projectId !== project.id) {
      throw new DomainError("VALIDATION_ERROR", "替换对象不属于该项目", {
        fieldErrors: { replacesFileId: ["跨项目引用无效"] },
      });
    }
    if (replaces.name !== input.name) {
      throw new DomainError("VALIDATION_ERROR", "替换需保持同一逻辑文件名", {
        fieldErrors: { name: ["与被替换文件同名才能生成新版本"] },
      });
    }
  }

  // 同名文件关联逻辑文件；替换/再上传生成新版本，旧 current 标记 superseded
  const logical = data.files.filter((item) => item.projectId === project.id && item.name === input.name);
  const previousVersion = Math.max(0, ...logical.map((item) => item.version));
  const record: FileRecord = {
    id: `file-${project.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    projectId: project.id,
    name: input.name,
    type: extension.toUpperCase(),
    source: replaces ? "版本替换" : "手动上传",
    uploaderId: context.actorId,
    version: previousVersion + 1,
    status: "current",
    updatedAt: context.now.slice(0, 10),
    size: formatSize(input.sizeBytes),
    sizeBytes: input.sizeBytes,
    mimeType: input.mimeType ?? "application/octet-stream",
  };
  const files = data.files
    .map((item) => item.projectId === project.id && item.name === input.name && item.status === "current" ? { ...item, status: "superseded" as const } : item)
    .concat(record);
  return {
    data: {
      ...data,
      files,
      projects: data.projects.map((item) => (item.id === project.id ? { ...item, version: item.version + 1 } : item)),
      logs: [...data.logs, {
        id: context.logId,
        actorId: context.actorId,
        action: replaces ? "替换项目资料版本" : "上传项目资料",
        target: record.id,
        result: "success",
        ip: "mock",
        createdAt: context.now,
        detail: `${project.id} / ${record.name} v${record.version}（${record.size}，${record.mimeType}）；模拟上传，未存储真实字节`,
      }],
    },
    result: record,
  };
}

export const uploadProjectFile: Command<FileMetadataInput, FileRecord> = {
  name: "project.files.write",
  input: fileInputSchema,
  apply(data, context, input) {
    if (input.replacesFileId) {
      throw new DomainError("VALIDATION_ERROR", "上传新文件不应指定替换对象", {
        fieldErrors: { replacesFileId: ["请使用替换接口"] },
      });
    }
    return applyUpload(data, context, input);
  },
};

export const replaceProjectFile: Command<FileMetadataInput, FileRecord> = {
  name: "project.files.write",
  input: fileInputSchema,
  apply(data, context, input) {
    if (!input.replacesFileId) {
      throw new DomainError("VALIDATION_ERROR", "替换需要指定被替换的文件版本", {
        fieldErrors: { replacesFileId: ["缺少替换对象"] },
      });
    }
    return applyUpload(data, context, input);
  },
};

// ── 查询契约（读取按 project.content.read） ───────────────────────

export function listProjectFiles(data: MockData, actorId: string, projectId: string): FileRecord[] {
  if (!can(data, actorId, "project.content.read", { kind: "project", id: projectId })) {
    throw new DomainError("FORBIDDEN", "无权读取该项目资料");
  }
  return data.files.filter((item) => item.projectId === projectId);
}

/** 同一逻辑文件（同项目同名）的全部版本，新版本在前 */
export function getFileVersions(data: MockData, actorId: string, fileId: string): FileRecord[] {
  const file = data.files.find((item) => item.id === fileId);
  if (!file) throw new DomainError("NOT_FOUND", "文件记录不存在");
  const all = listProjectFiles(data, actorId, file.projectId ?? "");
  return all.filter((item) => item.name === file.name).sort((a, b) => b.version - a.version);
}

export interface MockFileContent {
  fileId: string;
  kind: "mock";
  message: string;
}

function mockContent(data: MockData, actorId: string, fileId: string, action: string): MockFileContent {
  const file = data.files.find((item) => item.id === fileId);
  if (!file) throw new DomainError("NOT_FOUND", "文件记录不存在");
  if (!file.projectId || !can(data, actorId, "project.content.read", { kind: "project", id: file.projectId })) {
    throw new DomainError("FORBIDDEN", "无权访问该项目资料");
  }
  return {
    fileId,
    kind: "mock",
    message: `演示环境：${action}为模拟操作（${file.name} v${file.version}，${file.size}${file.mimeType ? `，${file.mimeType}` : ""}）。未存储真实文件字节；真实服务将返回受授权的内容或短时下载链接。`,
  };
}

export function getFilePreview(data: MockData, actorId: string, fileId: string): MockFileContent {
  return mockContent(data, actorId, fileId, "预览");
}

export function getFileDownload(data: MockData, actorId: string, fileId: string): MockFileContent {
  return mockContent(data, actorId, fileId, "下载");
}
