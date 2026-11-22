"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Group = { project_id: string; group_id: string | null; project_name: string; group_name: string | null; tasks: number; completed: number; progress: number | null; risks: number };
type Module = { id: string; name: string; progress: number };
type ModuleDetail = { module: string; tasks: { id: string; title: string; status: string; progress: number; formal_evidence: number; formal_acceptance: number }[] };
type Action = { id: string; title: string; category: string; priority: string; due_at: string | null; target: { kind: string; id: string; course_id?: string; project_id?: string } };

async function read<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "include", cache: "no-store" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? "读取失败");
  return result.data as T;
}

export function TeacherWorkspaceApiPage({ courseId, groupId, screen }: { courseId: string; groupId?: string; screen: 42 | 43 | 44 }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState("name");
  const [search, setSearch] = useState("");
  const [projectId, setProjectId] = useState("");
  const [modules, setModules] = useState<Module[]>([]);
  const [details, setDetails] = useState<Record<string, ModuleDetail>>({});
  const [actions, setActions] = useState<Action[]>([]);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    if (screen === 42) {
      const result = await read<{ total: number; items: Group[] }>(`/api/v1/courses/${courseId}/teacher-groups?page=${page}&size=20&sort=${sort}&search=${encodeURIComponent(search)}`);
      setGroups(result.items); setTotal(result.total);
    } else if (screen === 43 && groupId) {
      const project = await read<{ project_id: string }>(`/api/v1/courses/${courseId}/groups/${groupId}/teacher-project`);
      setProjectId(project.project_id);
      setModules(await read<Module[]>(`/api/v1/projects/${project.project_id}/teacher-modules`));
    } else if (screen === 44) {
      setActions(await read<Action[]>(`/api/v1/courses/${courseId}/teacher-actions`));
    }
  }, [courseId, groupId, page, screen, search, sort]);
  useEffect(() => { void refresh().catch((failure) => setError(failure.message)); }, [refresh]);
  async function openModule(id: string) {
    if (details[id]) return;
    try { const detail = await read<ModuleDetail>(`/api/v1/projects/${projectId}/teacher-modules/${id}`); setDetails((previous) => ({ ...previous, [id]: detail })); }
    catch (failure) { setError((failure as Error).message); }
  }
  function targetHref(item: Action): string {
    if (item.target.kind === "appeal") return `/teacher/courses/${courseId}/appeals?appeal=${item.target.id}`;
    if (item.target.kind === "member_change") return `/teacher/courses/${courseId}/member-changes`;
    if (item.target.kind === "rule_change") return `/courses/${courseId}/rule-changes`;
    if (item.target.project_id) return `/projects/${item.target.project_id}`;
    return `/teacher/courses/${courseId}`;
  }
  return <main className="space-y-5 p-6"><h1 className="text-2xl font-semibold">{screen === 42 ? "教师小组列表" : screen === 43 ? "小组概况" : "待处理中"}</h1>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {screen === 42 && <><div className="flex flex-wrap gap-2"><input aria-label="搜索小组" className="rounded border p-2" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} /><select aria-label="排序" value={sort} onChange={(event) => { setSort(event.target.value); setPage(1); }}><option value="name">名称</option><option value="progress">进度</option><option value="risk">风险</option></select></div>
      {groups.map((group) => <article className="rounded border bg-white p-4" key={group.project_id}>{group.group_id ? <Link className="text-blue-700" href={`/teacher/courses/${courseId}/groups/${group.group_id}`}>{group.group_name ?? group.project_name}</Link> : group.project_name}<p>任务完成 {group.completed}/{group.tasks} · 进度 {group.progress ?? 0}% · 风险 {group.risks}</p></article>)}
      <p>共 {total} 组 · 第 {page} 页</p><button disabled={page === 1} onClick={() => setPage(page - 1)}>上一页</button><button disabled={page * 20 >= total} onClick={() => setPage(page + 1)}>下一页</button></>}
    {screen === 43 && modules.map((module) => <details key={module.id} className="rounded border bg-white p-4" onToggle={(event) => { if (event.currentTarget.open) void openModule(module.id); }}><summary>{module.name} · 计划进度 {module.progress}%</summary>{details[module.id] ? details[module.id].tasks.map((task) => <p key={task.id}><Link className="text-blue-700" href={`/projects/${projectId}/tasks/${task.id}`}>{task.title}</Link> · {task.status} · 正式证据 {task.formal_evidence} · 正式验收 {task.formal_acceptance}</p>) : <p>展开后读取真实任务与验收…</p>}</details>)}
    {screen === 44 && <>{actions.map((item) => <article className="rounded border bg-white p-4" key={item.id}><h2 className="font-semibold">{item.title}</h2><p>优先级 {item.priority} · 截止 {item.due_at ?? "未设置"}</p><Link className="text-blue-700" href={targetHref(item)}>查看并处理</Link></article>)}{!actions.length && <p>暂无待处理事项。</p>}</>}
  </main>;
}
