import type { UseQueryResult } from "@tanstack/react-query";
import { Panel } from "@/components/common";
import type { CriterionRecheck } from "@/lib/api/c-criterion-rechecks";
import { apiButton } from "./c-project-api";

type Props = {
  criteria: { id: string; text: string }[];
  requirements: { id: string; title: string }[];
  rechecks: UseQueryResult<CriterionRecheck[]>;
};

export function TaskCriteriaPanel({ criteria, requirements, rechecks }: Props) {
  const current = rechecks.isSuccess && !rechecks.isFetching ? rechecks.data : [];
  const byCriterion = new Map(current.map((row) => [row.criterion_id, row]));
  const titles = new Map(requirements.map((requirement) => [requirement.id, requirement.title]));
  return <Panel title="当前验收标准">
    {criteria.length === 0 && <p>暂无验收标准。</p>}
    <ul>{criteria.map((criterion) => {
      const row = byCriterion.get(criterion.id);
      return <li key={criterion.id} className="my-3">
        <p>{criterion.text}</p>
        {row && <div className="mt-1 border-l-2 border-amber-500 pl-3 text-sm">
          <strong>需要重新检查</strong>
          <p>{titles.get(row.requirement_id) ?? "关联需求"} · 需求版本 {row.requirement_version_no}</p>
          {row.reason && <p>{row.reason}</p>}
          <p>{row.verification_notified ? "已通知验收方" : "待通知验收方"}</p>
        </div>}
      </li>;
    })}</ul>
    {rechecks.isFetching && <p role="status">正在读取复核记录…</p>}
    {rechecks.isError && <div role="alert"><p>暂时无法读取验收标准的复核状态。</p>
      <button className={apiButton} onClick={() => void rechecks.refetch()}>重试复核记录</button>
    </div>}
  </Panel>;
}
