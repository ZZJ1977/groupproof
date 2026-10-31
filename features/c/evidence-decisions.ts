import { z } from "zod";
import { can } from "@/lib/access/policy";
import { DomainError, type Command } from "@/lib/commands/core";
import type { Evidence, MockData } from "@/types/domain";

export type EvidenceDecisionAction = "adopt" | "withdraw";
export interface CEvidenceDecision {
  idempotencyKey: string;
  action: EvidenceDecisionAction;
  actorId: string;
  reason: string;
  expectedVersion: number;
  resultVersion: number;
  fromStatus: Evidence["status"];
  toStatus: "formal" | "withdrawn";
  decidedAt: string;
}

/** C-local extension: retain source snapshots and leave D's verification records untouched. */
export type EvidenceWithCDecisions = Evidence & {
  sourceChanged?: boolean;
  cDecisionHistory?: CEvidenceDecision[];
};

export const evidenceSourceChanged = (evidence: Evidence): boolean =>
  (evidence as Evidence & { sourceChanged?: unknown }).sourceChanged === true;

/** Eligibility is recomputed against the latest workspace when executing, not trusted from UI. */
export function canManageEvidence(data: MockData, actorId: string, evidence: Evidence): boolean {
  const project = data.projects.find((item) => item.id === evidence.projectId);
  const actor = data.users.find((item) => item.id === actorId);
  const course = data.courses.find((item) => item.id === project?.courseId);
  const target = { kind: "project" as const, id: evidence.projectId };
  if (!project || !actor?.verified || project.lifecycle !== "active" ||
      (project.courseId && course?.status !== "active") ||
      !can(data, actorId, "project.content.read", target)) return false;
  const member = can(data, actorId, "project.draft.edit", target);
  const teacher = actor.role === "teacher" && course?.teacherId === actorId && actor.teacherStatus === "approved";
  return teacher || (member && (evidence.authorId === actorId || can(data, actorId, "project.settings.update", target)));
}

export function evidenceDecisionBlockReason(data: MockData, actorId: string, evidence: Evidence, action: EvidenceDecisionAction): string | null {
  if (!canManageEvidence(data, actorId, evidence)) return "仅已验证的证据作者、项目组长或所属课程教师可在活动项目中操作。";
  const project = data.projects.find((item) => item.id === evidence.projectId)!;
  if (project.setupStatus !== "frozen") return "项目基线尚未冻结，暂不能进行证据决策。";
  if (action === "withdraw") return evidence.status === "formal" ? null : "只能撤回正式证据。";
  if (evidence.status !== "candidate" && evidence.status !== "pending_confirmation") return "只能采纳候选或待确认证据。";
  if (evidenceSourceChanged(evidence)) return "来源已变化，请重新提交当前来源的候选证据。";
  if (!project.planConfirmed) return "任务计划尚未确认或已解锁，暂不能采纳证据。";
  const task = data.tasks.find((item) => item.id === evidence.taskId && item.projectId === project.id);
  if (!task || !evidence.criterionIds.length || evidence.criterionIds.some((id) => !data.criteria.some((criterion) => criterion.id === id && criterion.taskId === task.id))) {
    return "证据必须关联本项目任务及其有效验收标准。";
  }
  const revisions = data.planRevisions.filter((item) => item.projectId === project.id);
  const latest = revisions.reduce<(typeof revisions)[number] | undefined>((best, item) => !best || item.number > best.number ? item : best, undefined);
  // Legacy seed data has only planConfirmed; migrated workspaces must also match the published snapshot.
  if (project.activePlanRevisionId || latest) {
    const active = revisions.find((item) => item.id === project.activePlanRevisionId);
    if (!active || active.status !== "published" || latest?.id !== active.id ||
        !active.payload.tasks.some((item) => item.id === task.id && item.projectId === project.id) ||
        evidence.criterionIds.some((id) => !active.payload.criteria.some((item) => item.id === id && item.taskId === task.id))) {
      return "任务或验收标准不在当前已发布计划中，请先完成计划确认。";
    }
  }
  return null;
}

const decisionSchema = z.object({
  projectId: z.string().min(1),
  evidenceId: z.string().min(1),
  action: z.enum(["adopt", "withdraw"]),
  reason: z.string().trim().min(1, "请填写决策原因").max(2000),
  expectedVersion: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(1).max(128),
}).strict();
export type DecideEvidenceInput = z.infer<typeof decisionSchema>;

/** Local demonstration command; no remote verification invalidation or notification delivery is implied. */
export const decideEvidence: Command<DecideEvidenceInput, EvidenceWithCDecisions> = {
  name: "c.evidence.decide",
  input: decisionSchema,
  apply(data, context, input) {
    const evidence = data.evidence.find((item) => item.id === input.evidenceId && item.projectId === input.projectId) as EvidenceWithCDecisions | undefined;
    if (!evidence) throw new DomainError("NOT_FOUND", "本项目中没有这条证据。");
    if (!canManageEvidence(data, context.actorId, evidence)) throw new DomainError("FORBIDDEN", "仅已验证的证据作者、项目组长或所属课程教师可在活动项目中操作。");
    const replay = (data.evidence as EvidenceWithCDecisions[]).flatMap((item) => (item.cDecisionHistory ?? []).map((decision) => ({ evidence: item, decision })))
      .find((item) => item.decision.idempotencyKey === input.idempotencyKey);
    if (replay) {
      const previous = replay.decision;
      if (replay.evidence.id !== input.evidenceId || replay.evidence.projectId !== input.projectId ||
          previous.actorId !== context.actorId || previous.action !== input.action ||
          previous.reason !== input.reason || previous.expectedVersion !== input.expectedVersion) {
        throw new DomainError("VERSION_CONFLICT", "此提交标识已用于其他决策，请重新确认。");
      }
      return { data, result: evidence };
    }
    if (evidence.version !== input.expectedVersion) throw new DomainError("VERSION_CONFLICT", "证据已更新，原因已保留；请重新核对证据后确认。", { latestVersion: evidence.version });
    const blocked = evidenceDecisionBlockReason(data, context.actorId, evidence, input.action);
    if (blocked) throw new DomainError("INVALID_STATE", blocked);
    const status = input.action === "adopt" ? "formal" : "withdrawn";
    const decision: CEvidenceDecision = {
      idempotencyKey: input.idempotencyKey, action: input.action, actorId: context.actorId,
      reason: input.reason, expectedVersion: input.expectedVersion, resultVersion: evidence.version + 1,
      fromStatus: evidence.status, toStatus: status, decidedAt: context.now,
    };
    const updated: EvidenceWithCDecisions = {
      ...evidence, status, version: evidence.version + 1,
      cDecisionHistory: [...(evidence.cDecisionHistory ?? []), decision],
    };
    return {
      data: {
        ...data,
        evidence: data.evidence.map((item) => item.id === evidence.id ? updated : item),
        logs: [...data.logs, {
          id: context.logId, actorId: context.actorId,
          action: input.action === "adopt" ? "采纳正式证据" : "撤回正式证据",
          target: evidence.id, result: "success", ip: "mock", createdAt: context.now, detail: input.reason,
        }],
      },
      result: updated,
    };
  },
};
