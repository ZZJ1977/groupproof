import type { UseQueryResult } from "@tanstack/react-query";
import type { components } from "@/packages/domain/api.generated";
import { Panel } from "@/components/common";
import { formatDate } from "@/lib/utils";
import { ApiFailure, ApiPager, safeHttps } from "./c-project-api";

type GithubPage = components["schemas"]["ActivityPageDTO"];

export function TaskGithubActivities({ projectId, taskId, query, changePage }: {
  projectId: string;
  taskId: string;
  query: UseQueryResult<GithubPage>;
  changePage: (page: number) => void;
}) {
  const page = query.isSuccess && !query.isFetching ? query.data : undefined;
  const inScope = page?.items.every((row) => row.project_id === projectId && row.task_id === taskId && row.source_type === "github");
  return <Panel title="关联的 GitHub 活动">
    {query.isFetching && <p role="status">正在读取关联记录…</p>}
    {query.isError && <ApiFailure error={query.error} retry={() => void query.refetch()} />}
    {page && !inScope && <p role="alert">无法核对这些记录的任务归属。</p>}
    {page && inScope && <>
      <ul>{page.items.map((row) => {
        const href = row.availability === "available" ? safeHttps(row.source_url, true) : null;
        return <li key={row.source_id} className="mb-3">
          {href ? <a className="gp-link" href={href} target="_blank" rel="noopener noreferrer">{row.title}</a> : <span>{row.title} · 来源链接不可用</span>}
          <p className="text-sm text-slate-600">{row.kind} · {row.author_name || "未知作者"} · {formatDate(row.occurred_at)}</p>
        </li>;
      })}</ul>
      {!page.items.length && <p>此任务尚未关联 GitHub 活动。</p>}
      <ApiPager page={page.page} pageSize={page.page_size} total={page.total} change={changePage} />
    </>}
  </Panel>;
}
