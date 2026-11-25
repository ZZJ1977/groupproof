import type { UseQueryResult } from "@tanstack/react-query";
import { GitCommitHorizontal } from "lucide-react";
import type { components } from "@/packages/domain/api.generated";
import { formatDate } from "@/shared/lib/utils";
import { ApiFailure, ApiPager, safeHttps } from "@/shared/lib/c-project-api";

type GithubPage = components["schemas"]["ActivityPageDTO"];

export function TaskGithubActivities({
  projectId,
  taskId,
  query,
  changePage,
}: {
  projectId: string;
  taskId: string;
  query: UseQueryResult<GithubPage>;
  changePage: (page: number) => void;
}) {
  const page = query.isSuccess && !query.isFetching ? query.data : undefined;
  const inScope = page?.items.every((row) => row.project_id === projectId && row.task_id === taskId && row.source_type === "github");

  return (
    <section className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
          <GitCommitHorizontal size={15} className="text-sky-600" />
          关联的 GitHub 活动
        </h2>
        {page && inScope && <span className="font-mono text-xs text-slate-500">{page.total} 条</span>}
      </div>
      {query.isFetching && (
        <p role="status" className="text-xs text-slate-500">
          正在读取关联记录…
        </p>
      )}
      {query.isError && <ApiFailure error={query.error} retry={() => void query.refetch()} />}
      {page && !inScope && (
        <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
          无法核对这些记录的任务归属。
        </p>
      )}
      {page && inScope && (
        <>
          {page.items.length > 0 ? (
            <ul className="divide-y divide-slate-100">
              {page.items.map((row) => {
                const href = row.availability === "available" ? safeHttps(row.source_url, true) : null;
                return (
                  <li key={row.source_id} className="py-2.5 first:pt-0 last:pb-0">
                    <div className="text-sm font-medium text-slate-900">
                      {href ? (
                        <a className="gp-link" href={href} target="_blank" rel="noopener noreferrer">
                          {row.title}
                        </a>
                      ) : (
                        <span className="text-slate-600">{row.title} · 来源链接不可用</span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {row.kind} · {row.author_name || "未知作者"} · {formatDate(row.occurred_at)}
                    </p>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-xs text-slate-500">此任务尚未关联 GitHub 活动。</p>
          )}
          {page.total > page.page_size && (
            <ApiPager page={page.page} pageSize={page.page_size} total={page.total} change={changePage} />
          )}
        </>
      )}
    </section>
  );
}
