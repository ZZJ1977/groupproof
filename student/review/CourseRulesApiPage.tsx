"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchWithSession } from "@/shared/lib/api-client";
import { apiConfig } from "@/shared/lib/api-config";

type Version = { id: string; version: number; reason: string; effective_at: string;
  rules: { template?: { milestones: { name: string; required_materials: string[]; weight: number }[] }; settings?: Record<string, unknown> } };
type CourseData = { course: { name: string; status: string; grouping_mode: string; min_group_size: number;
  max_group_size: number; project_deadline: string | null; formation_deadline: string | null };
  versions: Version[]; projects: { id: string; name: string; lifecycle: string; confirmed: boolean }[] };

async function api<T>(path: string, payload?: unknown): Promise<T> {
  const response = await fetchWithSession(new Request(new URL(apiConfig.baseUrl + path, window.location.origin), {
    method: payload ? "POST" : "GET", credentials: "include", cache: "no-store",
    headers: payload ? { "Content-Type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  }));
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? "请求失败");
  return result.data as T;
}

export function CourseRulesApiPage({ courseId, teacher, settingsView }: { courseId: string; teacher: boolean; settingsView: boolean }) {
  const [data, setData] = useState<CourseData | null>(null);
  const [reason, setReason] = useState("");
  const [name, setName] = useState("");
  const [minSize, setMinSize] = useState(1);
  const [maxSize, setMaxSize] = useState(8);
  const [grouping, setGrouping] = useState("free");
  const [deadline, setDeadline] = useState("");
  const [formation, setFormation] = useState("");
  const [milestones, setMilestones] = useState([{ name: "", required_materials: "", weight: 100 }]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    const next = await api<CourseData>(`/api/v1/courses/${courseId}/teacher-rules`);
    setData(next);
    setName(next.course.name); setMinSize(next.course.min_group_size); setMaxSize(next.course.max_group_size);
    setGrouping(next.course.grouping_mode);
    setDeadline(next.course.project_deadline?.slice(0, 16) ?? "");
    setFormation(next.course.formation_deadline?.slice(0, 16) ?? "");
  }, [courseId]);
  useEffect(() => { void refresh().catch((failure) => setError(failure.message)); }, [refresh]);
  async function send(path: string, payload: unknown) {
    setBusy(true); setError("");
    try { await api(path, payload); await refresh(); setReason(""); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  const latest = data?.versions[0];
  return <main className="space-y-4 p-6"><h1 className="text-2xl font-semibold">{settingsView ? "课程设置" : "课程规则与变更"}</h1>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {data && <><p>{data.course.name} · {data.course.status} · 当前规则 v{latest?.version ?? 0}</p>
      {teacher && data.course.status !== "ended" && settingsView && <section className="space-y-2 rounded border bg-white p-4">
        <h2 className="font-semibold">修改课程设置</h2>
        <input aria-label="课程名" value={name} onChange={(event) => setName(event.target.value)} />
        <select aria-label="组队方式" value={grouping} onChange={(event) => setGrouping(event.target.value)}><option value="free">自由组队</option><option value="approval">审批组队</option></select>
        <label>最少人数 <input type="number" min={1} value={minSize} onChange={(event) => setMinSize(Number(event.target.value))} /></label>
        <label>最多人数 <input type="number" min={1} value={maxSize} onChange={(event) => setMaxSize(Number(event.target.value))} /></label>
        <label>项目截止 <input type="datetime-local" value={deadline} onChange={(event) => setDeadline(event.target.value)} /></label>
        <label>组队截止 <input type="datetime-local" value={formation} onChange={(event) => setFormation(event.target.value)} /></label>
        <input aria-label="修改原因" placeholder="修改原因" value={reason} onChange={(event) => setReason(event.target.value)} />
        <button disabled={busy || !reason.trim()} onClick={() => void send(`/api/v1/courses/${courseId}/teacher-settings`, {
          name, grouping_mode: grouping, min_group_size: minSize, max_group_size: maxSize,
          project_deadline: deadline ? new Date(deadline).toISOString() : null,
          formation_deadline: formation ? new Date(formation).toISOString() : null, reason,
        })}>保存设置并通知组长</button></section>}
      {teacher && data.course.status !== "ended" && !settingsView && <section className="space-y-2 rounded border bg-white p-4"><h2 className="font-semibold">新项目模板</h2>
        {milestones.map((item, index) => <div key={index} className="flex gap-2"><input aria-label={`里程碑 ${index + 1}`} value={item.name} onChange={(event) => setMilestones(milestones.map((entry, i) => i === index ? { ...entry, name: event.target.value } : entry))} /><input aria-label={`必交材料 ${index + 1}`} placeholder="材料，用逗号分隔" value={item.required_materials} onChange={(event) => setMilestones(milestones.map((entry, i) => i === index ? { ...entry, required_materials: event.target.value } : entry))} /><input aria-label={`权重 ${index + 1}`} type="number" min={0} max={100} value={item.weight} onChange={(event) => setMilestones(milestones.map((entry, i) => i === index ? { ...entry, weight: Number(event.target.value) } : entry))} /></div>)}
        <button onClick={() => setMilestones([...milestones, { name: "", required_materials: "", weight: 0 }])}>增加里程碑</button>
        <input aria-label="模板修改原因" placeholder="修改原因" value={reason} onChange={(event) => setReason(event.target.value)} />
        <button disabled={busy || !reason.trim()} onClick={() => void send(`/api/v1/courses/${courseId}/teacher-template`, { reason,
          milestones: milestones.map((item) => ({ name: item.name, weight: item.weight,
            required_materials: item.required_materials.split(/[,，]/).map((part) => part.trim()).filter(Boolean) })) })}>保存模板并通知组长</button></section>}
      {teacher && settingsView && data.course.status === "active" && <section className="rounded border bg-white p-4"><h2 className="font-semibold">课程结课</h2><p>结课会归档本课程全部项目。</p><input aria-label="结课原因" value={reason} onChange={(event) => setReason(event.target.value)} /><button disabled={busy || !reason.trim()} onClick={() => void send(`/api/v1/courses/${courseId}/teacher-end`, { reason })}>结课并归档</button></section>}
      {!teacher && latest && <section className="rounded border bg-white p-4"><h2 className="font-semibold">最新规则的项目确认</h2>{data.projects.map((project) => <div key={project.id}>{project.name} · {project.confirmed ? "已确认" : "待确认"} {project.lifecycle === "active" && !project.confirmed && <button disabled={busy} onClick={() => void send(`/api/v1/courses/${courseId}/teacher-rules/${latest.id}/projects/${project.id}/confirm`, {})}>确认规则</button>}</div>)}</section>}
      <h2 className="font-semibold">规则历史</h2>{data.versions.map((version) => <section className="rounded border bg-white p-4" key={version.id}><h3>v{version.version} · {version.effective_at}</h3><p>修改原因：{version.reason}</p>{version.rules.template?.milestones.map((item, index) => <p key={index}>{item.name} · 权重 {item.weight}% · 必交材料 {item.required_materials.join("、") || "无"}</p>)}{version.rules.settings && <p>课程设置：{JSON.stringify(version.rules.settings)}</p>}</section>)}
    </>}
  </main>;
}
