"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { EmptyState, PageHeader, Panel, StatusBadge } from "@/components/common";
import { createCClient } from "@/lib/api/c-client";
import { useWorkspace } from "@/lib/workspace";

const client = createCClient();

/** The existing summary returns authorized courses, capped at the latest ten. */
export function MyCoursesApiPage() {
  const { userId } = useWorkspace();
  const result = useQuery({
    queryKey: ["c-home-summary", userId], queryFn: () => client.homeSummary(),
    staleTime: 0, gcTime: 0, retry: false,
  });
  const data = result.isSuccess && !result.isFetching ? result.data : undefined;
  return <>
    <PageHeader title="我的课程" description="查看你已加入或参与教学的课程。" />
    {result.isFetching && <p role="status">正在读取课程…</p>}
    {result.isError && <Panel><div role="alert">
      <p>暂时无法读取课程，请稍后重试。</p>
      <button type="button" className="gp-link mt-3" onClick={() => void result.refetch()}>重试</button>
    </div></Panel>}
    {data && <Panel>
      {data.courses.length ? <>
        <p className="mb-4 text-sm text-slate-500">共 {data.course_count} 门课程，显示最近更新的最多 10 门。</p>
        <div className="divide-y divide-slate-100">{data.courses.map((course) => <div key={course.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div><span className="mr-3 font-semibold">{course.name}</span><StatusBadge status={course.status} /></div>
          <Link className="gp-link text-sm" href={`/courses/${encodeURIComponent(course.id)}/rules`}>查看课程</Link>
        </div>)}</div>
      </> : <EmptyState title="暂无课程" description="加入课程后，可以在这里查看课程信息。" />}
    </Panel>}
  </>;
}
