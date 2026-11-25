import Link from "next/link";
import type { UseQueryResult } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { StatusBadge } from "@/shared/components/common";
import type { TaskVerification } from "@/student/api/c-task-verification";
import { formatDate } from "@/shared/lib/utils";
import { ApiFailure } from "@/shared/lib/c-project-api";

const results = { pending: "等待结果", passed: "通过", failed: "未通过", uncertain: "待人工复核", not_applicable: "不适用" };
const resultTones: Record<keyof typeof results, "green" | "amber" | "red" | "gray"> = {
  passed: "green",
  uncertain: "amber",
  failed: "red",
  pending: "gray",
  not_applicable: "gray",
};
const statuses: Record<string, string> = { queued: "等待运行", running: "正在运行", failed: "运行失败" };

export function TaskVerificationPanel({
  projectId,
  taskId,
  query,
  members,
}: {
  projectId: string;
  taskId: string;
  query: UseQueryResult<TaskVerification[]>;
  members: { id: string; title: string }[];
}) {
  const taskHref = `/projects/${projectId}/tasks/${taskId}`;

  return (
    <section className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
          <ShieldCheck size={15} className="text-sky-600" />
          任务验收
        </h2>
        <div className="flex flex-wrap gap-3 text-xs">
          <Link className="gp-link" href={`${taskHref}/evidence-check`}>
            证据完整性检查
          </Link>
          <Link className="gp-link" href={`${taskHref}/verification`}>
            打开验收与负责人确认
          </Link>
        </div>
      </div>

      {query.isFetching && (
        <p role="status" className="text-xs text-slate-500">
          正在读取验收结果…
        </p>
      )}
      {query.isError && <ApiFailure error={query.error} retry={() => void query.refetch()} />}
      {query.isSuccess && !query.isFetching && (
        <>
          {query.data.length === 0 && <p className="text-xs text-slate-500">尚无验收记录。</p>}
          <div className="divide-y divide-slate-100">
            {query.data.map((run, index) => (
              <article key={run.id} className="space-y-2.5 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-slate-900">
                    {index === 0 ? "最近一次验收" : "历史验收"} · {run.created_at ? formatDate(run.created_at) : "时间未知"}
                  </h3>
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="text-slate-500">自动验收建议：{results[run.result]}</span>
                    <StatusBadge
                      tone={run.invalidated_reason ? "red" : run.formal_outcome_id ? "green" : "amber"}
                      label={run.invalidated_reason ? `已失效：${run.invalidated_reason}` : run.formal_outcome_id ? "已生成正式成果" : (statuses[run.status] ?? "待负责人确认")}
                    />
                  </div>
                </div>

                {run.decisions.length > 0 && (
                  <div className="space-y-1 rounded-xl bg-slate-50/80 px-3 py-2 text-xs text-slate-700">
                    {run.decisions.map((decision) => (
                      <p key={decision.actor_id}>
                        {members.find((member) => member.id === decision.actor_id)?.title ?? "负责人"} ·{" "}
                        {decision.decision === "confirmed" ? `已确认，承担 ${decision.responsibility_share}%` : "要求补充证据"} · {decision.reason}
                      </p>
                    ))}
                  </div>
                )}

                <div className="space-y-2">
                  {run.criteria.map((criterion) => (
                    <div key={criterion.criterion_id} className="rounded-xl border border-slate-200/75 bg-white px-3 py-2.5 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h4 className="font-semibold text-slate-900">{criterion.text}</h4>
                        <StatusBadge tone={resultTones[criterion.result]} label={`逐项建议：${results[criterion.result]}`} />
                      </div>
                      {criterion.reason && <p className="mt-1 whitespace-pre-wrap text-slate-600">{criterion.reason}</p>}
                      {criterion.remediation && <p className="mt-1 whitespace-pre-wrap text-amber-800">{criterion.remediation}</p>}
                      {criterion.evidence.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-2.5">
                          {criterion.evidence.map((evidence) => (
                            <Link key={evidence.id} className="gp-link" href={`/projects/${projectId}/evidence?evidence=${evidence.id}`}>
                              查看证据（v{evidence.version}）
                            </Link>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
