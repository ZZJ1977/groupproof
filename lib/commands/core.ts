import type { z } from "zod";
import type { MockData } from "@/types/domain";

/**
 * 业务命令层（阶段 03）。
 *
 * - 页面只提交目标 ID、允许修改的字段和 expectedVersion；
 *   actorId、时间、日志 ID 由执行器内部注入，UI 不能指定他人身份。
 * - 执行顺序：输入校验 → 读取最新状态与会话 → 权限/版本/业务状态校验
 *   → 不可变生成新状态与日志 → 同一次保存 → 成功后更新缓存。
 * - 本地队列只保证当前执行器内串行，不代表生产多用户事务。
 * - 未来 HTTP 适配边界：服务端会话确定身份，数据库事务与条件版本更新执行同等规则。
 */

export type CommandErrorCode =
  | "VALIDATION_ERROR" | "NOT_FOUND" | "FORBIDDEN"
  | "INVALID_STATE" | "VERSION_CONFLICT" | "STORAGE_ERROR";

export class DomainError extends Error {
  readonly code: CommandErrorCode;
  readonly fieldErrors?: Record<string, string[]>;
  readonly latestVersion?: number;

  constructor(
    code: CommandErrorCode,
    message: string,
    extra?: { fieldErrors?: Record<string, string[]>; latestVersion?: number },
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.fieldErrors = extra?.fieldErrors;
    this.latestVersion = extra?.latestVersion;
  }
}

export interface CommandContext {
  actorId: string;
  now: string;
  logId: string;
}

export interface WorkspaceRepository {
  read(): Promise<MockData>;
  save(data: MockData): Promise<void>;
}

export interface Command<I, O> {
  name: string;
  input: z.ZodType<I>;
  apply(data: MockData, context: CommandContext, input: I): { data: MockData; result: O };
}

export type CommandOutcome<O> =
  | { ok: true; result: O }
  | { ok: false; error: { code: CommandErrorCode; message: string; fieldErrors?: Record<string, string[]>; latestVersion?: number } };

function fieldErrorsOf(error: z.ZodError): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    (result[key] ??= []).push(issue.message);
  }
  return result;
}

export interface CommandRunnerOptions {
  repository: WorkspaceRepository;
  /** 当前会话身份；执行时读取，不允许输入指定 */
  currentActorId: () => string;
  now?: () => string;
  makeLogId?: () => string;
  /** 保存成功后更新缓存；保存失败不调用 */
  onSaved?: (data: MockData) => void;
}

export function createCommandRunner(options: CommandRunnerOptions) {
  const { repository, currentActorId, onSaved } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const makeLogId = options.makeLogId ?? (() => `log-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`);
  let queue: Promise<unknown> = Promise.resolve();

  async function execute<I, O>(command: Command<I, O>, input: unknown): Promise<CommandOutcome<O>> {
    const parsed = command.input.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: { code: "VALIDATION_ERROR", message: "输入校验未通过", fieldErrors: fieldErrorsOf(parsed.error) } };
    }
    const data = await repository.read();
    const context: CommandContext = { actorId: currentActorId(), now: now(), logId: makeLogId() };
    let next: MockData;
    let result: O;
    try {
      const applied = command.apply(data, context, parsed.data);
      next = applied.data;
      result = applied.result;
    } catch (error) {
      if (error instanceof DomainError) {
        return { ok: false, error: { code: error.code, message: error.message, fieldErrors: error.fieldErrors, latestVersion: error.latestVersion } };
      }
      throw error;
    }
    try {
      await repository.save(next);
    } catch {
      return { ok: false, error: { code: "STORAGE_ERROR", message: "保存失败，请重试；当前状态未变更。" } };
    }
    onSaved?.(next);
    return { ok: true, result };
  }

  /** 本地串行队列：连续写按读取到的最新版本处理 */
  return function run<I, O>(command: Command<I, O>, input: unknown): Promise<CommandOutcome<O>> {
    const task = queue.then(() => execute(command, input));
    queue = task.then(() => undefined, () => undefined);
    return task;
  };
}
