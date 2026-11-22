"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Project = {
  project_id: string;
  project_name: string;
  group_name: string | null;
  tasks: number;
  completed_tasks: number;
  progress: number | null;
  risks: { total: number; high: number; medium: number; low: number };
  recent_activity_at: string | null;
};

export function TeacherOverviewApiPage({ courseId }: { courseId: string }) {
  const [overview, setOverview] = useState<{ course_name: string; projects: Project[] } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    fetch(`/api/v1/courses/${courseId}/teacher-overview`, { credentials: "include", cache: "no-store" })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error?.message ?? "课程数据读取失败");
        return result.data as { course_name: string; projects: Project[] };
      })
      .then((result) => { if (active) setOverview(result); })
      .catch((failure) => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [courseId]);
  if (error) return <p role="alert" className="p-6 text-red-700">{error}</p>;
  if (!overview) return <p role="status" className="p-6">正在读取教师总览…</p>;
  return <main className="space-y-5 p-6"><h1 className="text-2xl font-semibold">{overview.course_name} · 教师总览</h1>
    <p>小组项目 {overview.projects.length} 个 · 活跃风险 {overview.projects.reduce((sum, item) => sum + item.risks.total, 0)} 项</p>
    <div className="overflow-x-auto"><table className="min-w-full border-collapse text-left text-sm"><thead><tr><th className="border p-2">小组 / 项目</th><th className="border p-2">任务进度</th><th className="border p-2">风险</th><th className="border p-2">最近任务活动</th></tr></thead><tbody>
      {overview.projects.map((item) => <tr key={item.project_id}><td className="border p-2"><Link className="text-blue-700 underline" href={`/projects/${item.project_id}/milestones`}>{item.group_name ?? "未分组"} · {item.project_name}</Link></td><td className="border p-2">{item.progress === null ? "暂无任务" : `${item.progress}%`} · 已完成 {item.completed_tasks}/{item.tasks}</td><td className="border p-2">{item.risks.total} 项，高 {item.risks.high} / 中 {item.risks.medium} / 低 {item.risks.low}</td><td className="border p-2">{item.recent_activity_at ?? "暂无"}</td></tr>)}
    </tbody></table></div>
  </main>;
}
