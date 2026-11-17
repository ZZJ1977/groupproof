import Link from "next/link";
import type { UseQueryResult } from "@tanstack/react-query";
import { Panel } from "@/components/common";
import type { TaskVerification } from "@/lib/api/c-task-verification";
import { formatDate } from "@/lib/utils";
import { ApiFailure } from "./c-project-api";

const results = { pending: "等待结果", passed: "通过", failed: "未通过", uncertain: "待人工复核", not_applicable: "不适用" };
const statuses: Record<string, string> = { queued: "等待运行", running: "正在运行", failed: "运行失败" };

export function TaskVerificationPanel({ projectId, taskId, query, members }: {
  projectId: string;
  taskId: string;
  query: UseQueryResult<TaskVerification[]>;
  members: { id: string; title: string }[];
}) {
  const taskHref = `/projects/${projectId}/tasks/${taskId}`;
  return <Panel title="任务验收">
    <div className="mb-3 flex flex-wrap gap-4">
      <Link className="gp-link" href={`${taskHref}/evidence-check`}>证据完整性检查</Link>
      <Link className="gp-link" href={`${taskHref}/verification`}>打开验收与负责人确认</Link>
    </div>
    {query.isFetching && <p role="status">正在读取验收结果…</p>}
    {query.isError && <ApiFailure error={query.error} retry={() => void query.refetch()} />}
    {query.isSuccess && !query.isFetching && <>
      {query.data.length === 0 && <p>尚无验收记录。</p>}
      {query.data.map((run, index) => <article key={run.id} className="my-4 border-t pt-3">
        <h3 className="font-semibold">{index === 0 ? "最近一次验收" : "历史验收"} · {run.created_at ? formatDate(run.created_at) : "时间未知"}</h3>
        <p>自动验收建议：{results[run.result]}</p>
        <p>{run.invalidated_reason ? `已失效：${run.invalidated_reason}` : run.formal_outcome_id ? "已生成正式成果" : statuses[run.status] ?? "待负责人确认"}</p>
        {run.decisions.map((decision) => <p key={decision.actor_id} className="my-2">
          {members.find((member) => member.id === decision.actor_id)?.title ?? "负责人"} · {decision.decision === "confirmed" ? `已确认，承担 ${decision.responsibility_share}%` : "要求补充证据"} · {decision.reason}
        </p>)}
        {run.criteria.map((criterion) => <div key={criterion.criterion_id} className="my-3 rounded border p-3">
          <h4 className="font-medium">{criterion.text}</h4>
          <p>逐项建议：{results[criterion.result]}</p>
          <p className="whitespace-pre-wrap">{criterion.reason}</p>
          {criterion.remediation && <p className="whitespace-pre-wrap">{criterion.remediation}</p>}
          <div className="mt-2 flex flex-wrap gap-3">{criterion.evidence.map((evidence) =>
            <Link key={evidence.id} className="gp-link" href={`/projects/${projectId}/evidence?evidence=${evidence.id}`}>查看证据（v{evidence.version}）</Link>)}
          </div>
        </div>)}
      </article>)}
    </>}
  </Panel>;
}
