"use client";

import { useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Clock3,
  Download,
  ExternalLink,
  FileText,
  Filter,
  FolderOpen,
  GitBranch,
  Github,
  MessageCircle,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Upload,
  Users,
} from "lucide-react";
import { Avatar, EmptyState, Feedback, PageHeader, Panel, ProgressBar, SaveState, Stat, StatusBadge } from "@/components/common";
import { can } from "@/lib/access/policy";
import { getProjectSummary } from "@/lib/overview";
import { useCommands } from "@/lib/commands/use-commands";
import { getFileDownload, getFilePreview, getFileVersions } from "@/lib/commands/files";
import { scopedWorkspaceKey, useWorkspace } from "@/lib/workspace";
import { createCommandRunner, type Command } from "@/lib/commands/core";
import { workspaceService } from "@/lib/api/workspace-service";
import { apiMode } from "@/lib/api/config";
import { canMarkDiscussionImportant, canWriteDiscussion, createDiscussion, discussionAsEvidence, discussionMentionTargets, markDiscussionImportant, replyDiscussion } from "@/features/c/discussions";
import { useUrlQuery } from "@/features/c/use-url-query";
import { GithubRecordPanels, FeishuRecordPanel } from "@/features/c/ActivityRecordPanels";
import { feishuActivityFilters } from "@/features/c/activity-records";
import { fileCategories, fileCategoryLabels, fileFilterPatch, filePageSizes, queryProjectFiles, readFileFilters, type FileFilters } from "@/features/c/file-filters";
import { canWriteProjectFiles, designateProjectFile, type FileWithCDecisions } from "@/features/c/file-decisions";
import { ProjectAccessDenied, ProjectPublicSummary } from "@/features/project-core/ProjectPublicSummary";
import type { Contribution, Evidence, FileRecord, GithubActivity, Project, Report, Task, User } from "@/types/domain";

type Workspace = ReturnType<typeof useWorkspace>;
type Screen = 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29;
type ViewProps = { screen: Screen | number; projectId: string; memberId?: string };
type ProjectContext = Workspace & { project: Project; memberId?: string };

const primary = "inline-flex min-h-9 items-center justify-center gap-2 rounded border border-[var(--gp-action)] bg-[var(--gp-action)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--gp-action-hover)] transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const outline = "inline-flex min-h-9 items-center justify-center gap-2 rounded border border-[var(--gp-border)] bg-white px-4 py-2 text-sm font-medium text-[var(--gp-ink-soft)] hover:bg-[var(--gp-canvas)] transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const field = "w-full rounded border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100";
const label = "mb-1.5 block text-xs font-semibold text-slate-600";
const linkClass = "font-medium text-[var(--gp-action)] hover:underline";
const muted = "text-sm text-slate-500";

function id(prefix: string) { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`; }
function find<T extends { id: string }>(items: T[], target: string) { return items.find((item) => item.id === target); }
function date(value: string) { return value ? value.slice(0, 10) : "—"; }
function projectUrl(projectId: string, suffix = "") { return `/projects/${projectId}${suffix}`; }
function memberName(data: Workspace["data"], memberId: string) { return find(data.users, memberId)?.name ?? memberId; }
function taskName(data: Workspace["data"], taskId?: string) { return taskId ? find(data.tasks, taskId)?.title ?? taskId : "—"; }

function Header({ project, title, description, actions, icon: Icon }: { project: Project; title: string; description?: string; actions?: ReactNode; icon?: typeof Github }) {
  return <div className="mb-6"><nav className="mb-3 flex gap-2 text-xs text-slate-400"><Link href="/home" className="hover:text-[var(--gp-action)]">项目</Link><span>/</span><Link href={projectUrl(project.id)} className="hover:text-[var(--gp-action)]">{project.name}</Link><span>/</span><span>{title}</span></nav><PageHeader title={title} description={description} actions={actions} icon={Icon} /></div>;
}
function Notice({ children, tone = "blue" }: { children: ReactNode; tone?: "blue" | "amber" | "green" | "red" }) {
  const styles = { blue: "border-blue-200 bg-blue-50 text-slate-600", amber: "border-amber-200 bg-amber-50 text-amber-800", green: "border-emerald-200 bg-emerald-50 text-emerald-800", red: "border-red-200 bg-red-50 text-red-700" };
  return <div role="status" className={`rounded border px-4 py-3 text-sm ${styles[tone]}`}>{children}</div>;
}
function KV({ title, value }: { title: string; value: ReactNode }) { return <div className="grid gap-2 border-b border-slate-100 py-2 text-sm last:border-b-0 sm:grid-cols-[130px_1fr]"><span className="text-slate-400">{title}</span><span className="text-slate-700">{value}</span></div>; }
function Empty({ title }: { title: string }) { return <EmptyState title={title} />; }
function TabStrip({ items, value, change }: { items: string[]; value: string; change: (next: string) => void }) { return <div role="tablist" className="mb-4 flex flex-wrap gap-5 border-b border-slate-200">{items.map((item) => <button key={item} role="tab" aria-selected={item === value} className={`border-b-2 pb-2 text-sm ${item === value ? "border-blue-600 font-semibold text-[var(--gp-action)]" : "border-transparent text-slate-500"}`} onClick={() => change(item)}>{item}</button>)}</div>; }

export function ProjectSupportView({ screen, projectId, memberId }: ViewProps) {
  const workspace = useWorkspace();
  const project = find(workspace.data.projects, projectId);
  if (!project) return <Empty title="项目不存在" />;
  const actorId = workspace.data.currentUserId;
  const target = { kind: "project" as const, id: project.id };
  if (!can(workspace.data, actorId, "project.content.read", target)) {
    if (can(workspace.data, actorId, "project.summary.read", target)) return <ProjectPublicSummary summary={getProjectSummary(workspace.data, actorId, project.id)} />;
    return <ProjectAccessDenied message="项目内容仅对成员及所属课程教学人员开放。" />;
  }
  const context = { ...workspace, project, memberId };
  switch (screen) {
    case 21: return <GithubPage {...context} />;
    case 22: return <FeishuPage {...context} />;
    case 23: return <FilesPage {...context} />;
    case 24: return <DiscussionsPage {...context} />;
    case 25: return <ContributionOverview {...context} />;
    case 26: return <ContributionMember {...context} />;
    case 27: return <ReportPreview {...context} />;
    case 28: return <ReportExport {...context} />;
    case 29: return <ProjectSettings {...context} />;
    default: return <Empty title="页面不存在" />;
  }
}

function GithubPage({ data, add, update, project }: ProjectContext) {
  const records = data.github.filter((item) => item.projectId === project.id).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const [repoInput, setRepoInput] = useState("");
  const [changing, setChanging] = useState(false);
  const [notice, setNotice] = useState("");
  const lastConnection = records.find((item) => item.type === "sync");
  const repository = lastConnection?.repository || records[0]?.repository || "尚未绑定";
  const disconnected = project.githubEnabled === false || lastConnection?.status === "已解除绑定";
  const sync = () => {
    if (disconnected || repository === "尚未绑定") { setNotice("请先绑定 GitHub 仓库。"); return; }
    const activity: GithubActivity = { id: id("gh"), projectId: project.id, repository, type: "sync", title: "手动同步仓库活动", authorId: data.currentUserId, status: "已同步", timestamp: new Date().toISOString(), url: repository.startsWith("http") ? repository : `https://github.com/${repository}` };
    add("github", activity); setNotice("仓库同步完成，最新活动已更新。");
  };
  const changeRepo = () => {
    const cleaned = repoInput.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(cleaned)) { setNotice("请输入 owner/repository 格式的仓库地址。"); return; }
    add("github", { id: id("gh"), projectId: project.id, repository: cleaned, type: "sync", title: `绑定仓库 ${cleaned}`, authorId: data.currentUserId, status: "已同步", timestamp: new Date().toISOString(), url: `https://github.com/${cleaned}` });
    update("projects", project.id, { githubEnabled: true }); setChanging(false); setRepoInput(""); setNotice("仓库已绑定。");
  };
  const unlink = () => { if (repository === "尚未绑定") return; add("github", { id: id("gh"), projectId: project.id, repository, type: "sync", title: "解除仓库绑定", authorId: data.currentUserId, status: "已解除绑定", timestamp: new Date().toISOString(), url: "" }); update("projects", project.id, { githubEnabled: false }); setNotice("已解除仓库绑定，历史活动仍保留。"); };
  return <div><Header project={project} title="GitHub" description="查看仓库绑定、同步状态与开发活动关联情况。" icon={Github} />{notice && <div className="mb-4"><Notice>{notice}</Notice></div>}
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_310px]"><div className="space-y-4"><Panel title="仓库绑定" action={<div className="flex gap-2"><button className={outline} onClick={() => { setChanging(true); setRepoInput(repository === "尚未绑定" ? "" : repository); }}>更换仓库</button><button className="rounded border border-red-200 px-3 text-sm text-red-600" onClick={unlink} disabled={disconnected}>解除绑定</button></div>}>
      {changing && <div className="mb-4 flex flex-wrap gap-2"><input className={`${field} max-w-md`} aria-label="GitHub 仓库" placeholder="owner/repository" value={repoInput} onChange={(event) => setRepoInput(event.target.value)} /><button className={primary} onClick={changeRepo}>保存绑定</button><button className={outline} onClick={() => setChanging(false)}>取消</button></div>}
      <div className="flex items-center gap-3 text-base font-semibold"><Github size={22} />{repository}<StatusBadge tone={disconnected ? "gray" : "blue"} label={disconnected ? "未连接" : "已连接"} /></div><div className="mt-4 grid gap-4 text-sm sm:grid-cols-4"><div><div className="text-slate-400">默认分支</div><div className="mt-1">main</div></div><div><div className="text-slate-400">上次同步时间</div><div className="mt-1">{date(records[0]?.timestamp ?? "")}</div></div><div><div className="text-slate-400">同步状态</div><StatusBadge status={disconnected ? "disabled" : "current"} label={disconnected ? "未连接" : "已同步"} /></div><div><div className="text-slate-400">仓库链接</div>{!disconnected && <a className={linkClass} target="_blank" rel="noreferrer" href={repository.startsWith("http") ? repository : `https://github.com/${repository}`}>在 GitHub 中打开 <ExternalLink size={13} className="inline" /></a>}</div></div>
      </Panel>
      <GithubRecordPanels projectId={project.id} />
    </div><div className="space-y-4"><Panel title="同步状态"><KV title="上次同步时间" value={date(records[0]?.timestamp ?? "")} /><KV title="同步状态" value={<StatusBadge tone={disconnected ? "gray" : "green"} label={disconnected ? "未连接" : "已同步"} />} /><KV title="同步内容" value="Commit、PR、Issue、CI" /><KV title="最近同步范围" value="最近 30 天的活动" /><button className={`${primary} mt-4 w-full`} onClick={sync} disabled={disconnected}><RefreshCw size={15} />立即同步</button></Panel><Panel title="Webhook 状态" action={<Link href={projectUrl(project.id, "/settings")} className={linkClass}>配置</Link>}><KV title="连接状态" value={disconnected ? "未启用" : "已启用"} /><KV title="最近触发时间" value={date(records[0]?.timestamp ?? "")} /><KV title="触发事件" value="Push、Pull Request、Issue" /></Panel><Panel title="定时兜底同步"><KV title="状态" value="已开启" /><KV title="同步周期" value="每 6 小时" /><KV title="同步范围" value="最近 30 天的活动" /></Panel></div></div>
  </div>;
}

function FeishuPage({ data, add, project }: ProjectContext) {
  const records = data.feishu.filter((item) => item.projectId === project.id).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const groups = [...new Set(records.map((item) => item.groupName))];
  const { query: recordQuery, updateQuery: updateRecordQuery } = useUrlQuery();
  const recordFilters = feishuActivityFilters(recordQuery);
  const groupName = recordFilters.group === "all" ? "全部群组" : recordFilters.group;
  const filter = recordFilters.status === "all" ? "全部记录" : recordFilters.status;
  const setGroupName = (value: string) => updateRecordQuery({ group: value === "全部群组" ? null : value, page: null });
  const setFilter = (value: string) => updateRecordQuery({ status: value === "全部记录" ? null : value, page: null });
  const [notice, setNotice] = useState("");
  const sync = () => { add("feishu", { id: id("feishu"), projectId: project.id, groupName: groupName === "全部群组" ? groups[0] || "项目群组" : groupName, type: "discussion", summary: "本次同步已完成，待确认是否采纳为项目协作记录。", authorId: data.currentUserId, timestamp: new Date().toISOString(), status: "candidate" }); setNotice("同步完成，新增一条待确认记录。"); };
  return <div><Header project={project} title="飞书协作记录" description="保留项目群聊与相关私聊中的关键协作证据。" icon={MessageCircle} />{notice && <div className="mb-4"><Notice>{notice}</Notice></div>}
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]"><div className="space-y-4"><Panel><div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto_auto]"><div><label className={label}>项目群组</label><select className={field} aria-label="项目群组" value={groupName} onChange={(event) => setGroupName(event.target.value)}><option>全部群组</option>{groupName !== "全部群组" && !groups.includes(groupName) && <option value={groupName}>不可用的群组</option>}{groups.map((group) => <option key={group}>{group}</option>)}</select></div><div><label className={label}>关联性筛选</label><select className={field} aria-label="关联性筛选" value={filter} onChange={(event) => setFilter(event.target.value)}><option>全部记录</option><option value="candidate">待确认</option><option value="adopted">已采纳</option><option value="ignored">已忽略</option></select></div><div className="flex items-end"><StatusBadge tone={project.feishuEnabled === false ? "gray" : "green"} label={project.feishuEnabled === false ? "未连接" : "已同步"} /></div><div className="flex items-end"><button className={outline} onClick={sync} disabled={project.feishuEnabled === false}><RefreshCw size={15} />立即同步</button></div></div></Panel>
      <FeishuRecordPanel projectId={project.id} />
    </div><div className="space-y-4"><Panel title="记录说明"><InfoLine title="自动识别关键协作内容" text="基于上下文识别任务、决策、贡献和讨论等关键内容，生成可追溯记录。" /><InfoLine title="关联项目任务与模块" text="记录将与项目任务、模块和里程碑关联，便于后续引用和验收。" /><InfoLine title="人工确认与采纳" text="系统提供候选记录，由成员确认后采纳为正式证据候选。" /></Panel><Panel title="隐私边界"><InfoLine title="仅同步授权范围内内容" text="只同步已加入白名单的项目群聊及相关成员的私聊内容。" /><InfoLine title="敏感信息自动脱敏" text="对个人敏感信息进行脱敏处理。" /><InfoLine title="访问权限控制" text="按照项目成员权限控制记录可见范围。" /></Panel><Panel title="同步统计"><div className="grid grid-cols-3 gap-2 text-center"><div><strong className="text-xl text-[var(--gp-action)]">{records.length}</strong><p className="text-xs text-slate-500">已同步</p></div><div><strong className="text-xl text-emerald-600">{records.filter((item) => item.status === "adopted").length}</strong><p className="text-xs text-slate-500">已采纳</p></div><div><strong className="text-xl text-amber-600">{records.filter((item) => item.status === "candidate").length}</strong><p className="text-xs text-slate-500">待确认</p></div></div></Panel></div></div>
  </div>;
}

function InfoLine({ title, text }: { title: string; text: string }) { return <div className="border-b border-slate-100 py-3 last:border-b-0"><h3 className="text-sm font-semibold text-slate-700">{title}</h3><p className="mt-1 text-xs leading-5 text-slate-500">{text}</p></div>; }

function FilesPage({ data, project, userId }: ProjectContext) {
  const queryClient = useQueryClient();
  const workspaceKey = useMemo(() => scopedWorkspaceKey(userId), [userId]);
  const runner = useMemo(() => createCommandRunner({
    repository: {
      read: async () => queryClient.getQueryData<Workspace["data"]>(workspaceKey) ?? await workspaceService.getWorkspace(),
      save: workspaceService.saveWorkspace,
    },
    currentActorId: () => queryClient.getQueryData<Workspace["data"]>(workspaceKey)?.currentUserId ?? "",
    onSaved: (next) => queryClient.setQueryData(workspaceKey, next),
  }), [queryClient, workspaceKey]);
  const fileInput = useRef<HTMLInputElement>(null);
  const canWrite = apiMode("workspace") === "mock" && canWriteProjectFiles(data, data.currentUserId, project.id);
  const commands = useCommands();
  const [replaceTarget, setReplaceTarget] = useState<string | null>(null);
  const { query: urlQuery, updateQuery } = useUrlQuery();
  const filters = readFileFilters(urlQuery);
  const setFilter = (key: keyof FileFilters, value: string) => updateQuery(fileFilterPatch(key, value));
  const [selected, setSelected] = useState("");
  const [notice, setNotice] = useState("");
  const [designation, setDesignation] = useState<{ fileId: string; expectedProjectVersion: number; idempotencyKey: string } | null>(null);
  const [designationReason, setDesignationReason] = useState("");
  const [savingDesignation, setSavingDesignation] = useState(false);
  const busyDesignation = useRef(false);
  const result = queryProjectFiles(data, data.currentUserId, project.id, filters);
  const { files, items: visible } = result;
  const fileTypes = [...new Set(files.map((item) => item.type.trim().toUpperCase()))].sort();
  const selectedFile = find(files, selected);
  const selectFile = (fileId: string) => {
    if (busyDesignation.current || selected === fileId) return;
    if (designationReason.trim() && !window.confirm("放弃尚未保存的正式版本原因？")) return;
    setSelected(fileId); setDesignation(null); setDesignationReason("");
  };
  const confirmDesignation = async () => {
    if (!designation || !designationReason.trim() || !canWrite || busyDesignation.current) return;
    busyDesignation.current = true; setSavingDesignation(true);
    try {
      const outcome = await runner(designateProjectFile, { projectId: project.id, ...designation, reason: designationReason });
      if (!outcome.ok) { setNotice(outcome.error.message); return; }
      setDesignation(null); setDesignationReason("");
      setNotice("已设为本地正式版本，旧版本、冻结基线引用和原因已保留；真实文件存储与成员通知尚未接入。");
    } catch {
      setNotice("保存失败，原因已保留，请重试。");
    } finally {
      busyDesignation.current = false; setSavingDesignation(false);
    }
  };
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    if (busyDesignation.current || designation) { setNotice("请先完成或取消当前文件版本确认。"); event.target.value = ""; return; }
    if (!canWrite) { setNotice("只有项目成员可以上传或替换项目资料。"); event.target.value = ""; return; }
    const selectedFiles = Array.from(event.target.files ?? []);
    const target = replaceTarget ? find(files, replaceTarget) : undefined;
    event.target.value = "";
    setReplaceTarget(null);
    busyDesignation.current = true;
    let expectedVersion = project.version;
    const results: string[] = [];
    try {
      for (const file of selectedFiles) {
        const input = {
          projectId: project.id,
          name: target ? target.name : file.name,
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          expectedVersion,
          ...(target ? { replacesFileId: target.id } : {}),
        };
        const outcome = target ? await commands.replaceProjectFile(input) : await commands.uploadProjectFile(input);
        if (!outcome.ok) { results.push(`${file.name}：失败（${outcome.error.message}）`); continue; }
        expectedVersion = expectedVersion + 1;
        setSelected(outcome.result.id);
        results.push(`${file.name}：成功 v${outcome.result.version}（模拟上传，仅保存元数据）`);
      }
    } catch {
      results.push("文件记录保存失败，请重试。");
    } finally {
      busyDesignation.current = false;
    }
    if (results.length) setNotice(results.join("；"));
  };
  return <div><Header project={project} title="文件资料" description="集中管理 Proposal、PDF、Word、README 与其他项目资料。" icon={FolderOpen} /><div className="mb-4"><Notice tone="blue">模拟文件环境：上传、预览与下载均为演示操作，仅保存元数据，不存储真实文件字节。</Notice></div>{notice && <div className="mb-4"><Notice tone="green">{notice}</Notice></div>}
    <div className="grid gap-4 xl:grid-cols-[160px_minmax(0,1fr)_280px]"><nav aria-label="文件类别" className="rounded-md border border-slate-200 bg-white p-2">{fileCategories.map((item) => <button key={item} type="button" aria-pressed={filters.category === item} className={`mb-1 w-full rounded px-3 py-2.5 text-left text-sm ${filters.category === item ? "bg-blue-50 font-semibold text-[var(--gp-action)]" : "text-slate-600 hover:bg-slate-50"}`} onClick={() => setFilter("category", item)}>{fileCategoryLabels[item]}</button>)}</nav><Panel noPadding><div className="flex flex-wrap gap-2 border-b border-slate-100 p-4"><input ref={fileInput} className="hidden" type="file" multiple onChange={upload} />{canWrite && <button className={primary} onClick={() => fileInput.current?.click()}><Upload size={15} />上传文件</button>}{!canWrite && <span className="self-center text-xs text-slate-500">只有项目成员可以上传或替换资料。</span>}<div className="relative min-w-[180px] flex-1"><Search size={15} className="absolute left-3 top-3 text-slate-400" /><input className={`${field} pl-9`} placeholder="搜索文件名、来源或上传者" aria-label="搜索文件" value={filters.q} onChange={(event) => setFilter("q", event.target.value)} /></div><select className={`${field} w-auto`} aria-label="文件类型" value={filters.type} onChange={(event) => setFilter("type", event.target.value)}><option value="all">全部类型</option>{filters.type !== "all" && !fileTypes.includes(filters.type) && <option value={filters.type}>不可用的类型：{filters.type}</option>}{fileTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select><select className={`${field} w-auto`} aria-label="排序" value={filters.sort} onChange={(event) => setFilter("sort", event.target.value)}><option value="recent">最近上传</option><option value="name">文件名</option></select><button type="button" className={outline} onClick={() => updateQuery({ category: null, q: null, type: null, sort: null, page: null })}>清除筛选</button></div>
      <div className="overflow-x-auto"><table className="gp-table min-w-[700px]" aria-label="项目文件列表"><thead><tr><th>文件名</th><th>类型</th><th>来源</th><th>上传者</th><th>更新时间</th><th>关联项目 / 任务</th><th>状态</th></tr></thead><tbody>{visible.map((item) => <tr key={item.id}><td><button type="button" className={linkClass} disabled={savingDesignation} onClick={() => selectFile(item.id)}>{item.name}</button><div className="text-xs text-slate-400">{item.size} · v{item.version}</div></td><td>{item.type}</td><td>{item.source}</td><td>{memberName(data, item.uploaderId)}</td><td>{date(item.updatedAt)}</td><td>{project.name}</td><td><StatusBadge label={item.status === "current" ? "正式" : item.status === "draft" ? "草稿" : "已归档"} tone={item.status === "current" ? "green" : item.status === "draft" ? "blue" : "gray"} /></td></tr>)}</tbody></table>{!visible.length && <Empty title="没有符合条件的文件" />}</div>
      <nav aria-label="文件分页" className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 p-4">
        <span className="text-sm text-slate-500" role="status">第 {result.page} / {result.pageCount} 页 · 共 {result.total} 个文件</span>
        <div className="flex items-center gap-2"><select className={`${field} w-auto`} aria-label="每页文件数" value={filters.pageSize} onChange={(event) => setFilter("pageSize", event.target.value)}>{filePageSizes.map((size) => <option key={size} value={size}>{size} / 页</option>)}</select><button type="button" className={outline} disabled={result.page <= 1} onClick={() => setFilter("page", String(result.page - 1))}>上一页</button><button type="button" className={outline} disabled={result.page >= result.pageCount} onClick={() => setFilter("page", String(result.page + 1))}>下一页</button></div>
      </nav></Panel>
      <div className="space-y-4"><Panel title={selectedFile ? "版本管理" : "资料使用说明"}>{selectedFile ? <><h3 className="break-all font-semibold">{selectedFile.name}</h3><p className="mt-1 text-xs text-slate-500">所选版本 v{selectedFile.version}</p><div className="mt-4 space-y-2">{getFileVersions(data, data.currentUserId, selectedFile.id).map((item) => <div key={item.id} className="border-b border-slate-100 py-2 text-sm"><span className="font-medium">v{item.version}</span> · {date(item.updatedAt)}<p className="text-xs text-slate-500">{memberName(data, item.uploaderId)} · {item.size}{item.mimeType ? ` · ${item.mimeType}` : ""} · {item.status === "superseded" ? "历史版本" : item.status === "draft" ? "草稿版本" : "当前正式版本"}</p>{(item as FileWithCDecisions).cDesignationHistory?.map((decision) => <p key={decision.idempotencyKey} className="mt-1 text-xs text-slate-500">设为正式 · {memberName(data, decision.actorId)} · {date(decision.decidedAt)}：{decision.reason}</p>)}</div>)}</div><div className="mt-4 flex gap-2">{canWrite && <button className={outline} disabled={savingDesignation || Boolean(designation)} onClick={() => { setReplaceTarget(selectedFile.id); fileInput.current?.click(); }}>上传新版本</button>}{canWrite && selectedFile.status === "draft" && <button className={outline} disabled={savingDesignation || Boolean(designation)} onClick={() => { setDesignation({ fileId: selectedFile.id, expectedProjectVersion: project.version, idempotencyKey: id("file-designation") }); setDesignationReason(""); setNotice(""); }}>设为正式</button>}{!canWrite && <p className="text-xs text-slate-500">当前身份、课程或项目状态不允许上传、替换或设置正式版本。</p>}</div><div className="mt-3 flex gap-2"><button className={outline} onClick={() => setNotice(getFilePreview(data, data.currentUserId, selectedFile.id).message)}>预览（模拟）</button><button className={outline} onClick={() => setNotice(getFileDownload(data, data.currentUserId, selectedFile.id).message)}>下载（模拟）</button></div></> : <><InfoLine title="版本管理" text="上传同名文件时保留历史版本，方便追溯变更。" /><InfoLine title="支持的文件格式" text="PDF、Word、PPT、Excel、PNG、JPG、ZIP、Markdown 等。" /><InfoLine title="可追溯性" text="记录来源、上传者与更新时间，可关联任务和验收证据。" /></>}</Panel>
      {designation && selectedFile && designation.fileId === selectedFile.id && <Panel title="确认正式文件版本">
        <p className="mb-3 text-sm text-slate-600">{selectedFile.name} v{selectedFile.version} 将成为本地正式版本；保留同名旧版本及冻结基线引用，不会发送真实成员通知。</p>
        <label className={label} htmlFor="c-file-designation-reason">设为正式原因 *</label>
        <textarea id="c-file-designation-reason" className={field} value={designationReason} disabled={savingDesignation} maxLength={2000} onChange={(event) => setDesignationReason(event.target.value)} placeholder="说明为何选择此版本作为当前正式资料" />
        {project.version !== designation.expectedProjectVersion && <button type="button" className={`${outline} mt-2`} disabled={savingDesignation} onClick={() => setDesignation({ ...designation, expectedProjectVersion: project.version, idempotencyKey: id("file-designation") })}>已核对最新项目资料，保留原因</button>}
        <div className="mt-3 flex gap-2"><button type="button" className={outline} disabled={savingDesignation} onClick={() => { if (!designationReason.trim() || window.confirm("放弃尚未保存的正式版本原因？")) { setDesignation(null); setDesignationReason(""); } }}>取消</button><button type="button" className={primary} disabled={savingDesignation || !designationReason.trim() || !canWrite || selectedFile.status !== "draft" || project.version !== designation.expectedProjectVersion} onClick={confirmDesignation}>{savingDesignation ? "保存中…" : "确认设为正式"}</button></div>
      </Panel>}</div></div>
  </div>;
}

function DiscussionsPage({ data, project, userId }: ProjectContext) {
  const queryClient = useQueryClient();
  const workspaceKey = useMemo(() => scopedWorkspaceKey(userId), [userId]);
  const runner = useMemo(() => createCommandRunner({
    repository: {
      read: async () => queryClient.getQueryData<Workspace["data"]>(workspaceKey) ?? await workspaceService.getWorkspace(),
      save: workspaceService.saveWorkspace,
    },
    currentActorId: () => queryClient.getQueryData<Workspace["data"]>(workspaceKey)?.currentUserId ?? "",
    onSaved: (next) => queryClient.setQueryData(workspaceKey, next),
  }), [queryClient, workspaceKey]);
  const { query: urlQuery, updateQuery } = useUrlQuery();
  const threads = data.discussions.filter((item) => item.projectId === project.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const current = find(threads, urlQuery.get("discussion") ?? "") ?? threads[0];
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("最近活动");
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ title: "", body: "", taskId: "", requirementId: "", moduleId: "", milestoneId: "" });
  const createId = useRef("");
  const [replyDrafts, setReplyDrafts] = useState<Record<string, { text: string; mentionedUserIds: string[] }>>({});
  const replyIds = useRef<Record<string, string>>({});
  const evidenceIds = useRef<Record<string, string>>({});
  const [evidenceDrafts, setEvidenceDrafts] = useState<Record<string, { taskId: string; criterionIds: string[] }>>({});
  const [importantReasons, setImportantReasons] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const [notice, setNotice] = useState("");
  const localWorkspace = apiMode("workspace") === "mock";
  const canWrite = localWorkspace && canWriteDiscussion(data, data.currentUserId, project.id);
  const canMark = Boolean(current && localWorkspace && canMarkDiscussionImportant(data, data.currentUserId, current));
  const importantReason = current ? importantReasons[current.id] ?? "" : "";
  const replyDraft = current ? replyDrafts[current.id] ?? { text: "", mentionedUserIds: [] } : { text: "", mentionedUserIds: [] };
  const mentionTargets = discussionMentionTargets(data, project.id);
  const visible = threads.filter((item) => `${item.title} ${item.body} ${memberName(data, item.authorId)}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => sort === "最近活动" ? b.updatedAt.localeCompare(a.updatedAt) : a.title.localeCompare(b.title));
  const eligibleTasks = data.tasks.filter((item) => item.projectId === project.id && (item.status === "in_progress" || item.status === "pending_submission"));
  const evidenceDraft = current ? evidenceDrafts[current.id] ?? { taskId: eligibleTasks.some((item) => item.id === current.taskId) ? current.taskId! : "", criterionIds: [] } : { taskId: "", criterionIds: [] };
  const evidenceCriteria = data.criteria.filter((item) => item.taskId === evidenceDraft.taskId);

  async function perform<I, O>(command: Command<I, O>, input: I) {
    if (!canWrite || busy.current) return null;
    busy.current = true; setSaving(true);
    try {
      const outcome = await runner(command, input);
      if (!outcome.ok) setNotice(outcome.error.message);
      return outcome;
    } catch {
      setNotice("保存失败，输入已保留，请重试。");
      return null;
    } finally {
      busy.current = false; setSaving(false);
    }
  }
  const openCreate = () => {
    if (creating) return;
    createId.current = id("discussion"); setCreating(true);
  };
  const cancelCreate = () => {
    if (Object.values(draft).some(Boolean) && !window.confirm("放弃尚未发布的讨论修改？")) return;
    setDraft({ title: "", body: "", taskId: "", requirementId: "", moduleId: "", milestoneId: "" });
    createId.current = ""; setCreating(false);
  };
  const create = async () => {
    if (!draft.title.trim() || !draft.body.trim()) { setNotice("请填写讨论标题和内容。"); return; }
    const result = await perform(createDiscussion, { projectId: project.id, id: createId.current, title: draft.title, body: draft.body, taskId: draft.taskId || undefined, requirementId: draft.requirementId || undefined, moduleId: draft.moduleId || undefined, milestoneId: draft.milestoneId || undefined });
    if (result?.ok) {
      updateQuery({ discussion: result.result.id });
      setDraft({ title: "", body: "", taskId: "", requirementId: "", moduleId: "", milestoneId: "" });
      setCreating(false); createId.current = ""; setNotice("讨论已保存到本地演示数据；未发送真实成员通知。");
    }
  };
  const send = async () => {
    if (!current || !replyDraft.text.trim()) return;
    const threadId = current.id;
    const inputKey = `${threadId}:${replyDraft.text}:${[...replyDraft.mentionedUserIds].sort().join(",")}`;
    const replyId = replyIds.current[inputKey] ?? (replyIds.current[inputKey] = id("reply"));
    const result = await perform(replyDiscussion, { projectId: project.id, discussionId: threadId, replyId, text: replyDraft.text, mentionedUserIds: replyDraft.mentionedUserIds });
    if (result?.ok) {
      setReplyDrafts((old) => ({ ...old, [threadId]: { text: "", mentionedUserIds: [] } }));
      delete replyIds.current[inputKey];
      setNotice("回复已保存到当前讨论的本地记录；提及信息已保留，真实通知尚未接入。");
    }
  };
  const markImportant = async (important: boolean) => {
    if (!current) return;
    const result = await perform(markDiscussionImportant, { projectId: project.id, discussionId: current.id, important, reason: importantReason });
    if (result?.ok) { setImportantReasons((old) => ({ ...old, [current.id]: "" })); setNotice(important ? "已将此讨论标记为重要，刷新后仍保留。" : "已取消此讨论的重要标记；已有证据快照保留。"); }
  };
  const saveEvidence = async () => {
    if (!current) return;
    const captureKey = `${current.id}:${current.version ?? 0}:${evidenceDraft.taskId}:${[...evidenceDraft.criterionIds].sort().join(",")}`;
    const evidenceId = evidenceIds.current[captureKey] ?? (evidenceIds.current[captureKey] = id("evidence"));
    const result = await perform(discussionAsEvidence, { projectId: project.id, discussionId: current.id, evidenceId, taskId: evidenceDraft.taskId, criterionIds: evidenceDraft.criterionIds });
    if (result?.ok) setNotice("讨论快照已保存为本地候选证据，尚未成为正式证据；真实来源服务与通知未接入。");
  };
  const linkedTask = current?.taskId ? data.tasks.find((item) => item.id === current.taskId && item.projectId === project.id) : undefined;
  const linkedModule = data.modules.find((item) => item.id === (current?.moduleId ?? linkedTask?.moduleId) && item.projectId === project.id);
  const linkedRequirement = data.requirements.find((item) => item.projectId === project.id && (current?.requirementId ? item.id === current.requirementId : linkedTask?.requirementIds.includes(item.id)));
  const linkedMilestone = data.milestones.find((item) => item.projectId === project.id && (current?.milestoneId ? item.id === current.milestoneId : Boolean(linkedTask && item.taskIds.includes(linkedTask.id))));

  return <div><Header project={project} title="讨论区" description="按主题沉淀项目讨论，并关联到任务、需求、模块与里程碑。" icon={MessageCircle} actions={<div className="flex flex-wrap gap-2"><div className="relative"><Search size={15} className="absolute left-3 top-3 text-slate-400" /><input className={`${field} min-w-48 pl-9`} placeholder="搜索讨论标题或内容" aria-label="搜索讨论" value={query} onChange={(event) => setQuery(event.target.value)} /></div><button className={primary} onClick={openCreate} disabled={!canWrite || saving || creating}><Plus size={15} />新建讨论</button></div>} />
    <div className="mb-4"><Notice>{localWorkspace ? "讨论保存在当前账号的浏览器演示数据中；真实多人同步、成员通知与来源服务尚未接入。" : "真实讨论服务尚未接入，当前页面只读。"}</Notice></div>
    {notice && <div className="mb-4"><Notice>{notice}</Notice></div>}
    {creating && <Panel title="新建讨论" className="mb-4"><div className="grid gap-3 md:grid-cols-2">
      <label><span className={label}>讨论标题</span><input className={field} value={draft.title} maxLength={240} onChange={(event) => setDraft((old) => ({ ...old, title: event.target.value }))} disabled={saving} /></label>
      <label><span className={label}>关联任务</span><select className={field} value={draft.taskId} onChange={(event) => setDraft((old) => ({ ...old, taskId: event.target.value }))} disabled={saving}><option value="">暂不关联</option>{data.tasks.filter((item) => item.projectId === project.id).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      <label><span className={label}>关联需求</span><select className={field} value={draft.requirementId} onChange={(event) => setDraft((old) => ({ ...old, requirementId: event.target.value }))} disabled={saving}><option value="">暂不关联</option>{data.requirements.filter((item) => item.projectId === project.id).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      <label><span className={label}>关联模块</span><select className={field} value={draft.moduleId} onChange={(event) => setDraft((old) => ({ ...old, moduleId: event.target.value }))} disabled={saving}><option value="">暂不关联</option>{data.modules.filter((item) => item.projectId === project.id).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label><span className={label}>关联里程碑</span><select className={field} value={draft.milestoneId} onChange={(event) => setDraft((old) => ({ ...old, milestoneId: event.target.value }))} disabled={saving}><option value="">暂不关联</option>{data.milestones.filter((item) => item.projectId === project.id).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
    </div><label className="mt-3 block"><span className={label}>讨论内容</span><textarea className={`${field} min-h-24`} value={draft.body} maxLength={30000} onChange={(event) => setDraft((old) => ({ ...old, body: event.target.value }))} disabled={saving} /></label><div className="mt-3 flex justify-end gap-2"><button className={outline} onClick={cancelCreate} disabled={saving}>取消</button><button className={primary} onClick={() => void create()} disabled={saving || !draft.title.trim() || !draft.body.trim()}>{saving ? "保存中…" : "发布讨论"}</button></div></Panel>}
    <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)_270px]">
      <Panel title={`讨论主题（${visible.length}）`} action={<select className={`${field} w-auto`} value={sort} onChange={(event) => setSort(event.target.value)} aria-label="讨论排序"><option>最近活动</option><option>标题</option></select>} noPadding><div className="divide-y divide-slate-100">{visible.map((item) => <button key={item.id} className={`w-full p-4 text-left hover:bg-slate-50 ${current?.id === item.id ? "border-l-2 border-blue-600 bg-blue-50" : ""}`} aria-label={`打开讨论：${item.title}`} aria-pressed={current?.id === item.id} onClick={() => updateQuery({ discussion: item.id })}><div className="font-semibold text-slate-800">{item.title}{item.important && <span className="ml-2 text-xs text-amber-700">重要</span>}</div><p className="mt-1 line-clamp-2 text-xs text-slate-500">{item.body}</p><p className="mt-2 text-xs text-slate-400">{memberName(data, item.authorId)} · {date(item.updatedAt)} · {item.replies.length} 条回复</p></button>)}{!visible.length && <Empty title="没有匹配的讨论" />}</div></Panel>
      <Panel title={current?.title || "选择讨论"} action={current && <button className={outline} onClick={() => void markImportant(!current.important)} disabled={!canMark || saving || !importantReason.trim()} title="请先在讨论设置填写标记或取消原因">{current.important ? "取消重要标记" : "标记重要"}</button>}>{current ? <><p className="text-xs text-slate-400">由 {memberName(data, current.authorId)} 创建 · {current.createdAt ? `创建于 ${date(current.createdAt)}` : "历史创建时间未记录"} · 最近活动 {date(current.updatedAt)} · {current.replies.length} 条回复</p><p className="my-4 whitespace-pre-wrap text-sm leading-6 text-slate-700">{current.body}</p>{linkedTask && <Link className={linkClass} href={projectUrl(project.id, `/tasks/${linkedTask.id}`)}>{linkedTask.title} <ChevronRight size={13} className="inline" /></Link>}<div className="mt-5 divide-y divide-slate-100 border-t border-slate-100" aria-label="当前讨论回复">{current.replies.map((item) => <div key={item.id} className="flex gap-3 py-4"><Avatar name={memberName(data, item.authorId)} /><div><div className="text-xs text-slate-500">{memberName(data, item.authorId)} · {date(item.at)}</div><p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{item.text}</p>{Boolean(item.mentionedUserIds?.length) && <p className="text-xs text-slate-500">提及：{item.mentionedUserIds?.map((userId) => memberName(data, userId)).join("、")}</p>}</div></div>)}</div>
        <div className="mt-4 flex gap-2"><input className={field} value={replyDraft.text} maxLength={10000} onChange={(event) => setReplyDrafts((old) => ({ ...old, [current.id]: { ...replyDraft, text: event.target.value } }))} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} placeholder="发表回复" aria-label="发表回复" disabled={!canWrite || saving} /><button className={primary} onClick={() => void send()} disabled={!canWrite || saving || !replyDraft.text.trim()}>发送</button></div>
        <div className="mt-2"><select className={field} value="" aria-label="提及成员" disabled={!canWrite || saving} onChange={(event) => { const mentioned = mentionTargets.find((item) => item.id === event.target.value); if (mentioned) setReplyDrafts((old) => ({ ...old, [current.id]: { text: `${replyDraft.text}${replyDraft.text ? " " : ""}@${mentioned.name} `, mentionedUserIds: [...new Set([...replyDraft.mentionedUserIds, mentioned.id])] } })); }}><option value="">选择要提及的项目成员</option>{mentionTargets.map((user) => <option value={user.id} key={user.id}>{user.name}</option>)}</select>{replyDraft.mentionedUserIds.map((userId) => <button key={userId} className="mr-2 mt-2 text-xs text-slate-500" disabled={saving} onClick={() => setReplyDrafts((old) => ({ ...old, [current.id]: { ...replyDraft, mentionedUserIds: replyDraft.mentionedUserIds.filter((value) => value !== userId) } }))}>取消提及 {memberName(data, userId)} ×</button>)}</div>
      </> : <Empty title="选择左侧讨论主题" />}</Panel>
      <div className="space-y-4"><Panel title="关联信息"><KV title="关联需求" value={linkedRequirement ? <Link className={linkClass} href={projectUrl(project.id, "/requirements")}>{linkedRequirement.title}</Link> : "暂无"} /><KV title="关联任务" value={linkedTask ? <Link className={linkClass} href={projectUrl(project.id, `/tasks/${linkedTask.id}`)}>{linkedTask.title}</Link> : "暂无"} /><KV title="关联模块" value={linkedModule?.name ?? "暂无"} /><KV title="关联里程碑" value={linkedMilestone ? <Link className={linkClass} href={projectUrl(project.id, `/milestones/${linkedMilestone.id}`)}>{linkedMilestone.title}</Link> : "暂无"} /></Panel>
        <Panel title="参与者"><div className="space-y-2">{current ? [...new Set([current.authorId, ...current.replies.map((item) => item.authorId)])].map((memberId) => <div key={memberId} className="flex items-center gap-2 text-sm"><Avatar name={memberName(data, memberId)} />{memberName(data, memberId)}</div>) : <p className={muted}>暂无</p>}</div></Panel>
        <Panel title="讨论设置"><label className="mb-3 block"><span className={label}>重要标记原因</span><textarea className={`${field} min-h-20`} value={importantReason} maxLength={2000} disabled={!current || !canMark || saving} onChange={(event) => { if (current) setImportantReasons((old) => ({ ...old, [current.id]: event.target.value })); }} placeholder="说明标记或取消的重要依据" /></label><p className="mb-3 text-xs text-slate-500">仅作者、组长及所属教师可操作，请填写原因。{current?.importantReason && ` 上次原因：${current.importantReason}`}</p><label className="flex items-center justify-between text-sm">标记为重要<input type="checkbox" checked={Boolean(current?.important)} disabled={!current || !canMark || saving || !importantReason.trim()} onChange={(event) => void markImportant(event.target.checked)} /></label></Panel>
        {current?.important && <Panel title="作为证据来源"><p className="mb-3 text-xs text-slate-500">保存当前讨论的本地快照作为候选。真实来源服务未接入；后续回复不会改写已保存快照。</p><label><span className={label}>证据关联任务</span><select className={field} value={evidenceDraft.taskId} disabled={!canWrite || saving} onChange={(event) => setEvidenceDrafts((old) => ({ ...old, [current.id]: { taskId: event.target.value, criterionIds: [] } }))}><option value="">选择可补充证据的任务</option>{eligibleTasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label><div className="my-3 space-y-2">{evidenceCriteria.map((criterion, index) => <label key={criterion.id} className="flex gap-2 text-xs"><input type="checkbox" checked={evidenceDraft.criterionIds.includes(criterion.id)} disabled={!canWrite || saving} onChange={(event) => setEvidenceDrafts((old) => ({ ...old, [current.id]: { ...evidenceDraft, criterionIds: event.target.checked ? [...evidenceDraft.criterionIds, criterion.id] : evidenceDraft.criterionIds.filter((value) => value !== criterion.id) } }))} /><span>AC-{index + 1} · {criterion.text}</span></label>)}</div><button className={outline} disabled={!canWrite || saving || !evidenceDraft.taskId || !evidenceDraft.criterionIds.length} onClick={() => void saveEvidence()}>保存候选证据（演示）</button><Link className={`${linkClass} mt-3 block text-xs`} href={projectUrl(project.id, "/evidence?source=discussion")}>查看讨论来源证据</Link></Panel>}
      </div>
    </div>
  </div>;
}

function ContributionOverview({ data, project }: ProjectContext) {
  const records = data.contributions.filter((item) => item.projectId === project.id);
  const verified = data.tasks.filter((item) => item.projectId === project.id && item.status === "completed").length;
  const total = data.tasks.filter((item) => item.projectId === project.id).length;
  const disputed = records.filter((item) => item.status === "disputed").length;
  return <div><Header project={project} title="贡献总览" description="先展示证据链，再汇总成员贡献结果。" icon={Users} /><div className="mb-4 grid gap-3 sm:grid-cols-4"><Stat label="当前状态" value={disputed ? "待确认" : "已确认"} sub={disputed ? "存在待处理争议" : "正式贡献可追溯"} icon={ShieldCheck} /><Stat label="成员数" value={`${records.length} 人`} sub="参与项目的有效成员" icon={Users} /><Stat label="已完成任务占比" value={total ? `${Math.round(verified / total * 100)}%` : "0%"} sub={`${verified} / ${total} 个任务已完成`} icon={FileText} /><Stat label="待处理争议数" value={`${disputed} 个`} sub="贡献结果需进一步确认" icon={Clock3} /></div>
    <Panel title="成员贡献明细" noPadding><div className="overflow-x-auto"><table className="gp-table min-w-[760px]"><thead><tr><th>成员</th><th>正式任务贡献</th><th>协作贡献</th><th>验收率</th><th>待确认项</th><th>当前贡献占比</th><th>操作</th></tr></thead><tbody>{records.map((record) => { const member = find(data.users, record.memberId); return <tr key={record.id}><td><div className="flex items-center gap-2"><Avatar name={member?.name ?? record.memberId} color={member?.avatarColor} /><span>{member?.name ?? record.memberId}</span></div></td><td>{record.taskCredit} 分<ProgressBar value={record.taskCredit} className="mt-1 w-24" /></td><td>{record.collaborationCredit} 分</td><td>{record.acceptanceRate}%<ProgressBar value={record.acceptanceRate} className="mt-1 w-20" color="#14b87a" /></td><td><StatusBadge tone={record.status === "disputed" ? "amber" : "gray"} label={record.status === "disputed" ? "1 个" : "0 个"} /></td><td className="font-semibold">{record.share}%<ProgressBar value={record.share} className="mt-1 w-24" /></td><td><Link className={linkClass} href={projectUrl(project.id, `/contribution/${record.memberId}`)}>查看证据</Link></td></tr>; })}</tbody></table>{!records.length && <Empty title="暂无贡献记录" />}</div></Panel>
    <Panel title="贡献计算说明" className="mt-4"><div className="grid gap-4 md:grid-cols-3"><InfoLine title="任务权重" text="每个任务根据类型、难度和重要性设置权重，所有任务权重之和为 100%。" /><InfoLine title="实际贡献比例" text="根据证据链判定成员在任务中的实际贡献比例，保留协作记录。" /><InfoLine title="协作贡献上限" text="额外协作贡献可以加分，但不能超过该成员正式任务权重。" /></div><p className="mt-3 rounded bg-blue-50 p-3 text-center text-sm text-slate-700">成员最终贡献值 = Σ（任务权重 × 实际贡献比例）+ 协作贡献值</p></Panel></div>;
}

function ContributionMember({ data, update, project, memberId }: ProjectContext) {
  const selectedMember = memberId || data.currentUserId;
  const record = data.contributions.find((item) => item.projectId === project.id && item.memberId === selectedMember);
  const member = find(data.users, selectedMember);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(record?.note ?? "");
  if (!record) return <Empty title="暂无该成员的贡献记录" />;
  const tasks = record.taskIds.map((taskId) => find(data.tasks, taskId)).filter((item): item is Task => Boolean(item));
  const evidence = record.evidenceIds.map((evidenceId) => find(data.evidence, evidenceId)).filter((item): item is Evidence => Boolean(item));
  const adjustments = data.logs.filter((item) => item.target === selectedMember && item.action.includes("贡献"));
  return <div><Header project={project} title="成员贡献详情" description="查看单个成员的任务贡献、证据链与历史调整记录。" icon={Users} actions={<Link className={outline} href={projectUrl(project.id, "/contribution")}><ArrowLeft size={15} />返回贡献总览</Link>} />
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]"><div className="space-y-4"><Panel><div className="flex flex-wrap items-center justify-between gap-4"><div className="flex items-center gap-4"><Avatar name={member?.name ?? selectedMember} color={member?.avatarColor} size={58} /><div><h2 className="text-xl font-semibold">{member?.name ?? selectedMember}</h2><p className={muted}>项目成员 · {member?.college ?? ""}</p></div></div><div className="min-w-40"><p className="text-xs text-slate-400">当前贡献占比</p><strong className="text-2xl">{record.share}%</strong><ProgressBar value={record.share} /></div></div></Panel>
      <Panel title="相关任务贡献" action={<Link href={projectUrl(project.id, "/tasks?view=list")} className={linkClass}>查看全部任务</Link>} noPadding><div className="overflow-x-auto"><table className="gp-table min-w-[650px]"><thead><tr><th>任务</th><th>权重</th><th>实际贡献比例</th><th>已确认贡献</th><th>验收状态</th><th>关联证据</th></tr></thead><tbody>{tasks.map((task) => <tr key={task.id}><td><Link className={linkClass} href={projectUrl(project.id, `/tasks/${task.id}`)}>{task.title}</Link></td><td>{task.weight}%</td><td>{record.taskRatios?.[task.id] === undefined ? "—" : `${record.taskRatios[task.id]}%`}</td><td>{task.status === "completed" ? "已确认" : "待确认"}</td><td><StatusBadge status={task.status} /></td><td><Link className={linkClass} href={projectUrl(project.id, "/evidence")}>{data.evidence.filter((item) => item.taskId === task.id).length} 条证据</Link></td></tr>)}</tbody></table>{!tasks.length && <Empty title="暂无关联任务" />}</div></Panel>
      <Panel title="证据链记录" action={<Link href={projectUrl(project.id, "/evidence")} className={outline}><Plus size={15} />上传证据</Link>} noPadding><div className="overflow-x-auto"><table className="gp-table min-w-[600px]"><thead><tr><th>证据名称</th><th>类型</th><th>关联任务</th><th>提交时间</th><th>状态</th></tr></thead><tbody>{evidence.map((item) => <tr key={item.id}><td>{item.title}</td><td>{item.source}</td><td>{taskName(data, item.taskId)}</td><td>{date(item.createdAt)}</td><td><StatusBadge status={item.status} /></td></tr>)}</tbody></table>{!evidence.length && <Empty title="暂无关联证据" />}</div></Panel>
      <Panel title="贡献调整记录"><div className="space-y-2">{adjustments.length ? adjustments.map((item) => <div key={item.id} className="grid gap-2 border-b border-slate-100 py-2 text-sm sm:grid-cols-4"><span>{date(item.createdAt)}</span><span>{item.action}</span><span>{item.detail}</span><span>{memberName(data, item.actorId)}</span></div>) : <p className={muted}>暂无历史调整记录。</p>}</div></Panel>
    </div><div className="space-y-4"><Panel title="成员信息"><KV title="姓名" value={member?.name ?? "—"} /><KV title="学号" value={member?.studentId ?? "—"} /><KV title="院系" value={member?.college ?? "—"} /><KV title="邮箱" value={member?.email ?? "—"} /></Panel><Panel title="待确认事项" action={<Link className={linkClass} href="/action-items">查看全部</Link>}><div className="space-y-3">{data.actionItems.filter((item) => item.assigneeId === selectedMember && item.projectId === project.id && item.status === "pending").map((item) => <Link key={item.id} href={item.href} className="block border-b border-slate-100 pb-2 text-sm"><strong>{item.title}</strong><p className="text-xs text-slate-500">{item.description}</p></Link>)}{!data.actionItems.some((item) => item.assigneeId === selectedMember && item.projectId === project.id && item.status === "pending") && <p className={muted}>暂无待确认事项</p>}</div></Panel><Panel title="协作说明" action={(selectedMember === data.currentUserId || data.currentRole === "leader") && <button className={linkClass} onClick={() => setEditing((value) => !value)}>编辑</button>}>{editing ? <><textarea className={`${field} min-h-36`} value={note} onChange={(event) => setNote(event.target.value)} /><button className={`${primary} mt-2`} onClick={() => { update("contributions", record.id, { note }); setEditing(false); }}>保存说明</button></> : <p className="whitespace-pre-wrap text-sm leading-6 text-slate-600">{record.note}</p>}</Panel></div></div>
  </div>;
}

const sectionTitles = ["执行摘要", "项目目标与需求", "里程碑与功能完成情况", "团队协作与贡献", "证据与验收", "结论与后续工作"];
function currentReport(reports: Report[], projectId: string) { return reports.filter((item) => item.projectId === projectId).sort((a, b) => b.version - a.version)[0]; }
function escapeHtml(value: string) { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function reportHtml(report: Report, project: Project, data: Workspace["data"]) {
  const paragraphs = report.sections.map((section, index) => `<section><h2>${index + 1}. ${escapeHtml(section.title)}</h2><p>${escapeHtml(section.body).replace(/\n/g, "<br>")}</p></section>`).join("");
  const evidence = data.evidence.filter((item) => item.projectId === project.id && item.status === "formal");
  const appendix = report.includesAppendix ? `<section><h2>附录：正式证据清单</h2>${evidence.length ? `<ul>${evidence.map((item) => `<li>${escapeHtml(item.title)} · ${escapeHtml(taskName(data, item.taskId))} · ${date(item.createdAt)}</li>`).join("")}</ul>` : "<p>暂无正式证据。</p>"}</section>` : "";
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${escapeHtml(project.name)} 项目报告 v${report.version}</title><style>body{max-width:800px;margin:40px auto;padding:0 32px;color:#1f2937;font:14px/1.7 Arial,sans-serif}h1{font-size:25px;border-bottom:2px solid #2563eb;padding-bottom:12px}h2{font-size:17px;margin-top:28px}p{white-space:normal}section{page-break-inside:avoid}.meta{color:#64748b}@media print{body{margin:0;max-width:none;padding:0}}</style></head><body><h1>${escapeHtml(project.name)} 项目报告</h1><p class="meta">版本 v${report.version} · ${date(report.createdAt)} · ${escapeHtml(project.type)}</p>${paragraphs}${appendix}</body></html>`;
}
function generateSections(data: Workspace["data"], project: Project): Report["sections"] {
  const requirements = data.requirements.filter((item) => item.projectId === project.id);
  const tasks = data.tasks.filter((item) => item.projectId === project.id);
  const milestones = data.milestones.filter((item) => item.projectId === project.id);
  const contributions = data.contributions.filter((item) => item.projectId === project.id);
  const evidence = data.evidence.filter((item) => item.projectId === project.id && item.status === "formal");
  return [
    { id: "summary", title: sectionTitles[0], body: `${project.description}。当前总体进度 ${project.progress}%，核心进度 ${project.coreProgress}%。` },
    { id: "goals", title: sectionTitles[1], body: requirements.map((item) => `${item.title}：${item.description}`).join("\n") || "尚未确认需求基线。" },
    { id: "progress", title: sectionTitles[2], body: milestones.map((item) => `${item.title}：${item.progress}%（${date(item.deadline)}）`).join("\n") || `${tasks.length} 项任务正在推进。` },
    { id: "collaboration", title: sectionTitles[3], body: contributions.map((item) => `${memberName(data, item.memberId)}：贡献占比 ${item.share}%，${item.note}`).join("\n") || "尚无正式贡献记录。" },
    { id: "evidence", title: sectionTitles[4], body: `正式证据 ${evidence.length} 条，已完成任务 ${tasks.filter((item) => item.status === "completed").length} 项。` },
    { id: "conclusion", title: sectionTitles[5], body: "后续工作将继续依据验收标准完善实现、证据与最终交付。" },
  ];
}

function ReportPreview({ data, add, update, project }: ProjectContext) {
  const report = currentReport(data.reports, project.id);
  const [editingId, setEditingId] = useState("");
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("");
  const milestones = data.milestones.filter((item) => item.projectId === project.id);
  const modules = data.modules.filter((item) => item.projectId === project.id);
  const contributions = data.contributions.filter((item) => item.projectId === project.id);
  const formalEvidence = data.evidence.filter((item) => item.projectId === project.id && item.status === "formal");
  const refresh = () => { const next: Report = { id: id("report"), projectId: project.id, version: (report?.version ?? 0) + 1, status: "generated", createdAt: new Date().toISOString(), sections: generateSections(data, project) }; add("reports", next); setNotice(`预览已刷新为 v${next.version}。`); };
  const saveSection = (sectionId: string) => { if (!report) return; update("reports", report.id, { sections: report.sections.map((item) => item.id === sectionId ? { ...item, body: draft } : item) }); setEditingId(""); setNotice("章节文字已保存，报告结构保持不变。"); };
  return <div><Header project={project} title="报告预览" description="按固定模板预览正式项目报告内容。" icon={FileText} />{notice && <div className="mb-4"><Notice tone="green">{notice}</Notice></div>}
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_310px]"><Panel><div className="rounded bg-blue-50 p-5"><h2 className="text-xl font-bold">{project.name} 项目报告</h2><p className="mt-1 text-sm text-slate-500">{project.description}</p><p className="mt-3 text-xs text-slate-500">项目类型：{project.type} · 团队成员：{project.memberIds.length} 人 · 截止日期：{date(project.finalDeadline)}</p></div>
      {(report?.sections ?? generateSections(data, project)).map((section, index) => <section key={section.id} className="mt-5"><div className="mb-2 flex items-center justify-between"><h3 className="font-semibold"><span className="mr-2 inline-flex size-6 items-center justify-center rounded bg-blue-600 text-xs text-white">{index + 1}</span>{section.title}</h3>{report && <button className={linkClass} onClick={() => { setEditingId(section.id); setDraft(section.body); }}>编辑文字</button>}</div>{editingId === section.id ? <div><textarea className={`${field} min-h-28`} value={draft} onChange={(event) => setDraft(event.target.value)} /><div className="mt-2 flex gap-2"><button className={primary} onClick={() => saveSection(section.id)}>保存</button><button className={outline} onClick={() => setEditingId("")}>取消</button></div></div> : <div className="whitespace-pre-wrap rounded border border-slate-100 p-4 text-sm leading-6 text-slate-600">{section.body}</div>}
      {section.id === "progress" && <div className="mt-3 overflow-x-auto"><table className="gp-table min-w-[480px]"><thead><tr><th>里程碑</th><th>截止日期</th><th>进度</th><th>状态</th></tr></thead><tbody>{milestones.map((item) => <tr key={item.id}><td>{item.title}</td><td>{date(item.deadline)}</td><td>{item.progress}%</td><td><StatusBadge status={item.status} /></td></tr>)}</tbody></table><div className="mt-3 grid gap-2 sm:grid-cols-2">{modules.map((item) => <div key={item.id} className="flex items-center gap-2 text-xs"><span className="min-w-24">{item.name}</span><ProgressBar value={item.progress} /><span>{item.progress}%</span></div>)}</div></div>}
      {section.id === "collaboration" && <div className="mt-3 grid gap-2 sm:grid-cols-2">{contributions.map((item) => <div key={item.id} className="flex items-center gap-2 text-xs"><span className="min-w-20">{memberName(data, item.memberId)}</span><ProgressBar value={item.share} /><span>{item.share}%</span></div>)}</div>}
      {section.id === "evidence" && <div className="mt-3 space-y-2 text-xs text-slate-500">{formalEvidence.slice(0, 5).map((item) => <div key={item.id} className="flex justify-between border-b border-slate-100 py-1"><span>{item.title}</span><span>{date(item.createdAt)}</span></div>)}</div>}
      </section>)}
    </Panel><div className="space-y-4"><Panel title="报告信息"><KV title="报告状态" value={<StatusBadge status={report?.status ?? "draft"} />} /><KV title="生成时间" value={report ? date(report.createdAt) : "尚未生成"} /><KV title="版本" value={report ? `v${report.version}` : "—"} /><KV title="项目名称" value={project.name} /><KV title="项目类型" value={project.type} /><KV title="团队成员" value={`${project.memberIds.length} 人`} /></Panel><Panel title="操作"><div className="space-y-2"><button className={`${outline} w-full`} onClick={refresh}><RefreshCw size={15} />刷新预览</button><Link href={projectUrl(project.id, "/reports/export?format=pdf")} className={`${primary} w-full`}><Download size={15} />导出 PDF</Link><Link href={projectUrl(project.id, "/reports/export?format=word")} className={`${outline} w-full`}><Download size={15} />导出 Word</Link></div><div className="mt-4"><Notice>预览内容基于当前项目资料生成。导出后将保持相同的格式与内容。</Notice></div></Panel></div></div>
  </div>;
}

function ReportExport({ data, add, project }: ProjectContext) {
  const search = useSearchParams();
  const reports = data.reports.filter((item) => item.projectId === project.id).sort((a, b) => b.version - a.version);
  const latest = reports[0];
  const [format, setFormat] = useState<"pdf" | "word">(search.get("format") === "word" ? "word" : "pdf");
  const [appendix, setAppendix] = useState(true);
  const [base, setBase] = useState("latest");
  const [notice, setNotice] = useState("");
  const [faq, setFaq] = useState("");
  const download = (report: Report, fileFormat: "pdf" | "word") => {
    const html = reportHtml(report, project, data);
    if (fileFormat === "pdf") {
      const printWindow = window.open("", "_blank");
      if (!printWindow) { setNotice("浏览器拦截了报告窗口，请允许弹出窗口后重试。"); return; }
      printWindow.document.write(html);
      printWindow.document.close();
      printWindow.setTimeout(() => { printWindow.focus(); printWindow.print(); }, 150);
      return;
    }
    const url = URL.createObjectURL(new Blob([html], { type: "application/msword;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `${project.name}-v${report.version}.doc`; link.click(); URL.revokeObjectURL(url);
  };
  const generate = () => {
    const source = reports.find((item) => item.id === base);
    const next: Report = { id: id("report"), projectId: project.id, version: (latest?.version ?? 0) + 1, status: "generated", createdAt: new Date().toISOString(), sections: source?.sections ?? generateSections(data, project), format, includesAppendix: appendix };
    add("reports", next); setNotice(`已生成 v${next.version} ${format === "pdf" ? "PDF" : "Word"} 版本。`); download(next, format);
  };
  return <div><Header project={project} title="报告导出" description="管理报告生成、导出格式与版本记录。" icon={Download} />{notice && <div className="mb-4"><Notice tone="green">{notice}</Notice></div>}
    <div className="mb-4 grid gap-3 sm:grid-cols-3"><Stat label="当前报告版本" value={latest ? `v${latest.version}` : "未生成"} sub="最新版本" icon={FileText} /><Stat label="最后生成时间" value={latest ? date(latest.createdAt) : "—"} icon={Clock3} /><Stat label="当前状态" value={latest ? "已完成" : "待生成"} icon={CheckCircle2} /></div>
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_310px]"><div className="space-y-4"><Panel title="导出记录" noPadding><div className="overflow-x-auto"><table className="gp-table min-w-[650px]"><thead><tr><th>版本</th><th>格式</th><th>生成者</th><th>生成时间</th><th>状态</th><th>下载</th></tr></thead><tbody>{reports.map((item) => <tr key={item.id}><td>v{item.version}</td><td>{item.format === "word" ? "Word" : item.format === "pdf" ? "PDF" : "预览"}</td><td>{memberName(data, data.currentUserId)}</td><td>{date(item.createdAt)}</td><td><StatusBadge status={item.status} /></td><td>{item.format ? <button className={linkClass} onClick={() => download(item, item.format!)}><Download size={14} className="inline" /> 下载</button> : <Link className={linkClass} href={projectUrl(project.id, "/reports")}>预览</Link>}</td></tr>)}</tbody></table>{!reports.length && <Empty title="尚无导出记录" />}</div></Panel>
      <Panel title="导出设置"><p className="mb-4 text-sm text-slate-500">选择导出格式与内容选项，生成新的报告版本。</p><div className="grid gap-4 md:grid-cols-3"><fieldset><legend className={label}>导出格式</legend><label className="mr-3 inline-flex items-center gap-2 text-sm"><input type="radio" checked={format === "pdf"} onChange={() => setFormat("pdf")} />PDF</label><label className="inline-flex items-center gap-2 text-sm"><input type="radio" checked={format === "word"} onChange={() => setFormat("word")} />Word</label></fieldset><div><label className={label}>是否包含附录</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={appendix} onChange={(event) => setAppendix(event.target.checked)} />包含附录</label></div><fieldset><legend className={label}>重新生成选项</legend><label className="mb-2 flex items-center gap-2 text-sm"><input type="radio" checked={base === "latest"} onChange={() => setBase("latest")} />基于最新数据生成</label><label className="flex items-center gap-2 text-sm"><input type="radio" checked={base !== "latest"} onChange={() => setBase(latest?.id ?? "latest")} />基于指定版本生成</label>{base !== "latest" && <select className={`${field} mt-2`} value={base} onChange={(event) => setBase(event.target.value)}>{reports.map((item) => <option key={item.id} value={item.id}>v{item.version}</option>)}</select>}</fieldset></div><div className="mt-5 flex gap-2"><button className={primary} onClick={generate}>生成报告</button><button className={outline} onClick={() => { setFormat("pdf"); setAppendix(true); setBase("latest"); }}>重置</button></div></Panel></div>
      <div className="space-y-4"><Panel title="导出说明"><Notice>报告内容支持编辑，但整体排版结构由系统模板固定，以确保报告格式规范和一致。</Notice></Panel><Panel title="常见问题">{["可以导出哪些格式的报告？", "导出的报告可以修改排版吗？", "附录包含哪些内容？", "如何生成历史版本的报告？"].map((item, index) => <div key={item} className="border-b border-slate-100 py-3 last:border-b-0"><button className="flex w-full items-center justify-between text-left text-sm font-medium" onClick={() => setFaq(faq === item ? "" : item)}>{item}<ChevronRight size={14} /></button>{faq === item && <p className="mt-2 text-xs leading-5 text-slate-500">{["支持 PDF 打印和 Word 文档下载。", "可以修改章节文字，模板结构保持固定。", "附录可包含原始数据、图表明细与参考资料。", "在导出设置中选择指定历史版本。 "][index]}</p>}</div>)}</Panel></div></div>
  </div>;
}

function ProjectSettings({ data, update, project }: ProjectContext) {
  const router = useRouter();
  const [section, setSection] = useState("通用设置");
  const [name, setName] = useState(project.name);
  const [type, setType] = useState(project.type);
  const [language, setLanguage] = useState<Project["language"]>(project.language ?? "zh");
  const [visibility, setVisibility] = useState<Project["visibility"]>(project.visibility ?? "members");
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [notice, setNotice] = useState("");
  const course = project.courseId ? find(data.courses, project.courseId) : undefined;
  const target = { kind: "project" as const, id: project.id };
  const canSettings = can(data, data.currentUserId, "project.settings.update", target);
  const canArchive = can(data, data.currentUserId, "project.archive", target);
  const commands = useCommands();
  const archiving = commands.pending === "project.archive";
  const save = async () => {
    if (!can(data, data.currentUserId, "project.settings.update", target)) { setNotice("只有该项目组长可以修改项目设置。"); return; }
    if (name.trim().length < 2) { setNotice("项目名称至少需要 2 个字符。"); return; }
    const outcome = await commands.updateProjectSettings({ projectId: project.id, name: name.trim(), language: language ?? "zh", visibility: visibility ?? "members", expectedVersion: project.version });
    if (!outcome.ok) { setNotice(outcome.error.code === "VERSION_CONFLICT" ? "项目已被其他操作更新，请重新核对后再试。" : outcome.error.message); return; }
    setNotice("项目设置已保存；成员、课程归属与生效版本由受控流程管理。");
  };
  const archive = async () => {
    setConfirmArchive(false);
    const outcome = await commands.archiveProject({ projectId: project.id, expectedVersion: project.version });
    if (!outcome.ok) {
      const message = outcome.error.code === "VERSION_CONFLICT" ? "项目已被其他操作更新，请重新核对后再试。"
        : outcome.error.code === "STORAGE_ERROR" ? "保存失败，请重试；当前状态未变更。"
          : outcome.error.message;
      setNotice(message);
      return;
    }
    setNotice("项目已归档，历史记录保留为只读。");
  };
  return <div><Header project={project} title="项目设置" description="管理成员、集成、生命周期与项目级控制项。" icon={Settings} />{notice && <div className="mb-4"><Feedback tone={notice.includes("失败") || notice.includes("冲突") || notice.includes("更新") ? "error" : notice.includes("请先") ? "warning" : "success"}>{notice}</Feedback></div>}
    <div className="grid gap-4 xl:grid-cols-[170px_minmax(0,1fr)]"><nav aria-label="项目设置导航" className="h-fit rounded-md border border-slate-200 bg-white p-2">{["通用设置", "成员管理", "集成设置", "生命周期", "危险操作"].map((item) => <button key={item} className={`mb-1 block w-full rounded px-3 py-2.5 text-left text-sm ${section === item ? "bg-blue-50 font-semibold text-[var(--gp-action)]" : "text-slate-600 hover:bg-slate-50"}`} onClick={() => { setSection(item); document.getElementById(`settings-${item}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>{item}</button>)}</nav>
      <div className="space-y-4"><Panel title="通用设置" className="scroll-mt-6" ><div id="settings-通用设置" className="grid gap-4 md:grid-cols-2"><div><label className={label}>项目名称 *</label><input className={field} value={name} onChange={(event) => setName(event.target.value)} /></div><div><label className={label}>项目类型</label><select className={field} value={type} disabled><option>课程项目</option><option>独立项目</option><option>课程报告</option></select><p className="mt-1 text-xs text-slate-400">类型来自课程规则约束，通过规则变更流程调整。</p></div><div><label className={label}>默认语言</label><select className={field} value={language} onChange={(event) => setLanguage(event.target.value as "zh" | "en")}><option value="zh">简体中文</option><option value="en">English</option></select></div><div><label className={label}>课程关联</label><div className={`${field} bg-slate-50`}>{course?.name ?? "独立项目"}</div></div></div><fieldset className="mt-4"><legend className={label}>项目可见范围</legend><label className="mr-6 inline-flex items-center gap-2 text-sm"><input type="radio" checked={visibility === "members"} onChange={() => setVisibility("members")} />仅项目成员可见</label><label className="inline-flex items-center gap-2 text-sm"><input type="radio" checked={visibility === "course"} onChange={() => setVisibility("course")} />课程成员可见</label></fieldset><div className="mt-4 flex items-center gap-3"><button className={primary} onClick={() => void save()} disabled={!canSettings || archiving}>保存设置</button><SaveState state={archiving ? "saving" : "clean"} /></div>{!canSettings && <p className="mt-2 text-xs text-slate-500">只有该项目组长可以修改项目设置。</p>}</Panel>
      <Panel title="成员管理" className="scroll-mt-6"><div id="settings-成员管理" className="flex flex-wrap items-center justify-between gap-2"><p className={muted}>当前成员 {project.memberIds.length} 人。成员变更通过小组管理流程记录。</p>{project.courseId && project.groupId ? <Link className={outline} href={`/courses/${project.courseId}/groups/${project.groupId}`}>管理成员 <ArrowRight size={14} /></Link> : <Link className={outline} href={projectUrl(project.id)}>查看项目 <ArrowRight size={14} /></Link>}</div></Panel>
      <Panel title="集成设置" className="scroll-mt-6"><div id="settings-集成设置" className="space-y-3">{[{ name: "GitHub 集成", key: "githubEnabled" as const, description: "同步代码仓库、提交记录与合并请求。", href: projectUrl(project.id, "/github") }, { name: "飞书集成", key: "feishuEnabled" as const, description: "同步群聊通知、文档与日程，方便团队沟通。", href: projectUrl(project.id, "/collaboration") }].map((item) => <div key={item.key} className="flex flex-wrap items-center justify-between gap-3 rounded bg-slate-50 p-4"><div><h3 className="font-semibold">{item.name}</h3><p className="text-xs text-slate-500">{item.description}</p></div><div className="flex items-center gap-3"><span className="flex items-center gap-2 text-sm text-emerald-600">{project[item.key] !== false ? "已连接" : "未连接"}（集成开关由受控命令管理）</span><Link className={outline} href={item.href}>配置</Link></div></div>)}</div></Panel>
      <Panel title="生命周期" className="scroll-mt-6"><div id="settings-生命周期" className="grid gap-4 text-center sm:grid-cols-4">{["草稿", "进行中", "已定稿", "已归档"].map((item, index) => <div key={item}><span className={`mx-auto mb-2 flex size-8 items-center justify-center rounded-full ${["draft", "active", "finalized", "archived"].indexOf(project.lifecycle) === index ? "bg-blue-600 text-white" : "bg-slate-200 text-slate-500"}`}>{index + 1}</span><p className="text-sm font-medium">{item}</p></div>)}</div></Panel>
      <Panel title="危险操作" className="scroll-mt-6"><div id="settings-危险操作" className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-3 rounded bg-red-50 p-4"><div><h3 className="font-semibold text-slate-800">归档项目</h3><p className="text-xs text-slate-500">将项目设为只读状态，不再接受新的内容提交。</p></div><button className="rounded border border-red-400 px-4 py-2 text-sm text-red-600" onClick={() => setConfirmArchive(true)} disabled={!canArchive || project.lifecycle === "archived" || archiving}>归档项目</button></div><div className="flex flex-wrap items-center justify-between gap-3 rounded bg-amber-50 p-4"><div><h3 className="font-semibold text-slate-800">重新开启项目</h3><p className="text-xs text-slate-500">从已归档的正式版本创建新的修订版本。</p></div>{project.courseId ? <Link className="rounded border border-amber-400 px-4 py-2 text-sm text-amber-700" href={`/courses/${project.courseId}/projects/reopen`}>重新开启项目</Link> : <button className={outline} onClick={() => setNotice("独立项目的重新开启将在项目定稿后开放。")} >查看规则</button>}</div>{confirmArchive && <Notice tone="amber"><p>归档后项目将只读。确认继续？</p><div className="mt-3 flex gap-2"><button className={primary} onClick={archive} disabled={archiving}>{archiving ? "处理中..." : "确认归档"}</button><button className={outline} onClick={() => setConfirmArchive(false)}>取消</button></div></Notice>}</div></Panel></div></div>
  </div>;
}
