import type { UseQueryResult } from "@tanstack/react-query";
import { Panel } from "@/components/common";
import type { TaskPlanVersion } from "@/lib/api/c-task-plan-versions";
import { formatDate } from "@/lib/utils";
import { apiButton } from "./c-project-api";

export function TaskPlanHistory({ query }: { query: UseQueryResult<TaskPlanVersion[]> }) {
  return <Panel title="任务计划版本">
    {query.isFetching && <p role="status">正在读取计划版本…</p>}
    {query.isError && <div role="alert">
      <p>暂时无法读取任务计划版本。</p>
      <button type="button" className={apiButton} onClick={() => void query.refetch()}>重试计划版本</button>
    </div>}
    {query.isSuccess && !query.isFetching && (query.data.length === 0 ? <p>暂无已保存的任务计划版本。</p> :
      query.data.map((version) => <details key={version.version_no} className="my-3">
        <summary>v{version.version_no} · {version.snapshot.title} · {formatDate(version.created_at)}</summary>
        {version.created_by?.name && <p>保存人：{version.created_by.name}</p>}
        {version.snapshot.description && <p className="whitespace-pre-wrap">{version.snapshot.description}</p>}
        <h3 className="mt-2 font-semibold">本版验收标准</h3>
        {version.snapshot.criteria.length ? <ul className="list-disc pl-5">{version.snapshot.criteria.map((criterion) =>
          <li key={criterion.id}>{criterion.text}</li>)}</ul> : <p>本版未保存验收标准。</p>}
      </details>))}
  </Panel>;
}
