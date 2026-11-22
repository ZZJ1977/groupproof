"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Crown, FileText, Lock, Upload, UserMinus, UserPlus } from "lucide-react";
import { Avatar, EmptyState, Feedback, PageHeader, Panel, ProgressBar, Stat, StatusBadge } from "@/components/common";
import { BApiError, newIdempotencyKey } from "@/lib/api/b-client";
import { projectRequest } from "@/features/github-binding/integration-request";
import { bGroupsApi } from "@/lib/api/b-groups";
import { bProjectsApi, type BMaterial, type BProjectDraft, type BProjectSetup } from "@/lib/api/b-projects";
import { bRequirementsApi } from "@/lib/api/b-requirements";
import { useWorkspace } from "@/lib/workspace";
import { useBErrorMessage } from "@/features/b/use-b-error";
import { ProjectSetupCenter } from "@/features/b/ProjectSetupCenter";
import { button, dateOnly, input, label, queryPolicy, secondary } from "@/features/b/ui";
import { useUiText } from "@/lib/i18n/use-ui-text";

type Notice = { tone: "success" | "error" | "warning" | "info"; text: string } | undefined;

function Loading({ text }: { text?: string }) { const tr = useUiText(); return <div role="status" className="gp-empty">{text ?? tr("正在加载…")}</div>; }
function LoadError({ error, onRetry }: { error: unknown; onRetry?: () => void }) { const tr = useUiText(); const errorText = useBErrorMessage(); return <div role="alert"><Feedback tone="error">{errorText(error)}</Feedback>{onRetry && <button type="button" className={`${secondary} mt-3`} onClick={onRetry}>{tr("重试")}</button>}</div>; }
function fieldOf(error: unknown): string | undefined { return error instanceof BApiError && typeof error.details.field === "string" ? error.details.field : undefined; }

const wizardSteps = ["项目名称和类型", "项目简介", "确认创建"];

/** Page 35 (B3-01): the group's create-project wizard; every step is saved on the server. */
export function NewProjectApiPage({ courseId }: { courseId: string }) {
  const tr = useUiText();
  const router = useRouter();
  const cache = useQueryClient();
  const errorText = useBErrorMessage();
  const { userId } = useWorkspace();
  const [notice, setNotice] = useState<Notice>();
  const groups = useQuery({ queryKey: ["b-groups", userId, courseId], queryFn: () => bGroupsApi.list(courseId), ...queryPolicy });
  const groupId = groups.data?.my_group_id ?? null;
  const group = useQuery({ queryKey: ["b-group", userId, groupId], queryFn: () => bGroupsApi.detail(groupId!), enabled: Boolean(groupId), ...queryPolicy });
  const draft = useQuery({ queryKey: ["b-project-draft", userId, groupId], queryFn: () => bProjectsApi.draft(groupId!), enabled: Boolean(groupId), ...queryPolicy });
  const template = useQuery({ queryKey: ["b-project-template", userId, courseId], queryFn: () => bProjectsApi.template(courseId), enabled: Boolean(groupId), ...queryPolicy });
  const [form, setForm] = useState<BProjectDraft["payload"]>({});
  const [step, setStep] = useState(0);
  const [version, setVersion] = useState(0);
  const [loadedGroup, setLoadedGroup] = useState<string | null>(null);
  const [createKey, setCreateKey] = useState(newIdempotencyKey);
  useEffect(() => {
    if (!draft.data || loadedGroup === groupId) return;
    setForm(draft.data.payload); setStep(Math.min(draft.data.step, wizardSteps.length - 1)); setVersion(draft.data.lock_version); setLoadedGroup(groupId);
  }, [draft.data, groupId, loadedGroup]);
  const save = useMutation({
    mutationFn: (next: number) => bProjectsApi.saveDraft(groupId!, { payload: form, step: next, lock_version: version }),
    onSuccess: (row) => { setVersion(row.lock_version); setStep(row.step); setNotice(undefined); },
    onError: async (error) => {
      setNotice({ tone: "error", text: errorText(error) });
      if (error instanceof BApiError && error.code === "VERSION_CONFLICT") {
        const fresh = await draft.refetch();
        if (fresh.data) {
          setForm(fresh.data.payload); setVersion(fresh.data.lock_version); setStep(Math.min(fresh.data.step, wizardSteps.length - 1));
          setNotice({ tone: "error", text: tr("组员刚刚也修改了草稿，已载入最新内容，请确认后继续。") });
        }
      }
    },
  });
  const create = useMutation({
    mutationFn: () => bProjectsApi.create(groupId!, { name: (form.name ?? "").trim(), project_type: form.project_type?.trim() || undefined, description: form.description?.trim() || undefined, expected_group_version: group.data?.lock_version, expected_course_rule_version_id: template.data?.course_rule_version_id ?? undefined }, createKey),
    onSuccess: (row) => { for (const key of ["b-group", "b-my-courses", "c-home-summary"]) void cache.invalidateQueries({ queryKey: [key] }); router.push(row.href); },
    onError: (error) => { setNotice({ tone: "error", text: errorText(error) }); setCreateKey(newIdempotencyKey()); for (const key of ["b-project-draft", "b-group", "b-project-template"]) void cache.invalidateQueries({ queryKey: [key, userId] }); },
  });

  if (groups.isPending || (groupId && (group.isPending || draft.isPending))) return <Loading />;
  if (groups.isError) return <LoadError error={groups.error} onRetry={() => void groups.refetch()} />;
  if (!groupId) return <div><PageHeader title={tr("创建项目")} description={tr("项目以小组为单位创建。")} /><Panel className="mt-5"><EmptyState title={tr("你还没有加入小组")} description={tr("先创建或加入一个小组，再由组长创建项目。")} action={<Link className={button} href={`/courses/${courseId}/groups`}>{tr("去组队")}</Link>} /></Panel></div>;
  if (group.isError) return <LoadError error={group.error} onRetry={() => void group.refetch()} />;
  if (draft.isError) return <LoadError error={draft.error} onRetry={() => void draft.refetch()} />;
  const existing = draft.data?.project_id ?? group.data?.project_id;
  if (existing) return <div><PageHeader title={tr("创建项目")} /><Panel className="mt-5"><EmptyState title={tr("本组已经创建了项目")} description={tr("每个小组只有一个项目。")} action={<Link className={button} href={`/projects/${existing}`}>{tr("进入项目")}<ArrowRight size={15} /></Link>} /></Panel></div>;
  if (template.isPending) return <Loading />;
  if (template.isError) return <LoadError error={template.error} onRetry={() => void template.refetch()} />;
  const missingRules = !template.data.course_rule_version_id;
  const memberCount = group.data?.member_count ?? 0;
  const invalidSize = memberCount < template.data.min_group_size || memberCount > template.data.max_group_size;
  const isLeader = group.data?.leader?.id === userId;
  const set = (key: keyof BProjectDraft["payload"]) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value });
  return <div>
    <PageHeader title={tr("创建项目")} description={tr("{0} · 保存后的草稿与组员共享", { 0: group.data?.name ?? "" })} actions={<Link href={`/courses/${courseId}/groups/${groupId}`} className={secondary}>{tr("返回小组")}</Link>} />
    <div className="mx-auto mt-5 max-w-[760px] space-y-4">
      <ol className="flex flex-wrap gap-2 text-xs" aria-label={tr("创建步骤")}>{wizardSteps.map((title, index) => <li key={title} aria-current={index === step ? "step" : undefined} className={`flex-1 rounded border px-3 py-2 ${index === step ? "border-blue-500 bg-blue-50 font-semibold text-blue-700" : index < step ? "border-green-200 text-green-700" : "border-slate-200 text-slate-500"}`}>{index + 1}. {tr(title)}</li>)}</ol>
      {notice && <Feedback tone={notice.tone}>{notice.text}</Feedback>}
      {missingRules ? <Feedback tone="warning">{tr("课程尚未发布规则，请联系任课教师发布后再创建项目。")}</Feedback>
        : <Feedback tone={invalidSize ? "warning" : "info"}>
          {tr("课程规则 v{0} · 当前 {1} 人，要求 {2}–{3} 人", { 0: template.data.course_rule_version, 1: memberCount, 2: template.data.min_group_size, 3: template.data.max_group_size })}
          {invalidSize && <Link className="ml-2 underline" href={`/courses/${courseId}/groups/${groupId}`}>{tr("前往小组完善成员")}</Link>}
        </Feedback>}
      <Panel title={tr(wizardSteps[step])}>
        {step === 0 && <div className="space-y-3">
          <div><label className={label} htmlFor="b-project-name">{tr("项目名称")}</label><input id="b-project-name" className={input} maxLength={200} value={form.name ?? ""} disabled={save.isPending} onChange={set("name")} /></div>
          <div><label className={label} htmlFor="b-project-type">{tr("项目类型（可选）")}</label><input id="b-project-type" className={input} maxLength={80} placeholder={tr("如：软件开发、调研报告")} value={form.project_type ?? ""} disabled={save.isPending} onChange={set("project_type")} /></div>
        </div>}
        {step === 1 && <div><label className={label} htmlFor="b-project-description">{tr("项目简介（可选）")}</label><textarea id="b-project-description" className={input} rows={6} maxLength={5000} value={form.description ?? ""} disabled={save.isPending} onChange={set("description")} /></div>}
        {step === 2 && <dl className="space-y-2 text-sm">
          <div className="flex gap-3"><dt className="w-20 text-slate-500">{tr("名称")}</dt><dd>{form.name || "—"}</dd></div>
          <div className="flex gap-3"><dt className="w-20 text-slate-500">{tr("类型")}</dt><dd>{form.project_type || tr("未填写")}</dd></div>
          <div className="flex gap-3"><dt className="w-20 text-slate-500">{tr("简介")}</dt><dd className="whitespace-pre-wrap">{form.description || tr("未填写")}</dd></div>
          <p className="pt-2 text-xs text-slate-500">{tr("创建后会自动带上本组全部成员、课程截止日期和课程里程碑模板。")}</p>
          {!isLeader && <p className="text-xs text-amber-700">{tr("只有组长可以创建项目，你可以先把草稿填好。")}</p>}
        </dl>}
        <div className="mt-4 flex justify-between gap-2">
          <button type="button" className={secondary} disabled={step === 0 || save.isPending} onClick={() => save.mutate(step - 1)}>{tr("上一步")}</button>
          {step < wizardSteps.length - 1
            ? <button type="button" className={button} disabled={save.isPending || (step === 0 && !form.name?.trim())} onClick={() => save.mutate(step + 1)}>{save.isPending ? tr("正在保存…") : tr("保存并下一步")}</button>
            : <button type="button" className={button} disabled={!isLeader || missingRules || invalidSize || group.isFetching || template.isFetching || create.isPending || !form.name?.trim()} onClick={() => create.mutate()}>{create.isPending ? tr("正在创建…") : tr("创建项目")}</button>}
        </div>
      </Panel>
    </div>
  </div>;
}

const setupLabel: Record<string, string> = { not_initialized: "未初始化", draft: "初始化中", pending_confirmation: "等待组员确认", frozen: "基线已冻结" };

/** Page 07 (B3-02): entry by project state plus live server-side stats. */
export function ProjectOverviewApiPage({ projectId }: { projectId: string }) {
  const tr = useUiText();
  const { userId } = useWorkspace();
  const overview = useQuery({ queryKey: ["b-project-overview", userId, projectId], queryFn: () => bProjectsApi.overview(projectId), ...queryPolicy });
  if (overview.isPending) return <Loading />;
  if (overview.isError) return <LoadError error={overview.error} onRetry={() => void overview.refetch()} />;
  const project = overview.data;
  const stats = project.stats;
  const progressText = stats.progress_status === "available" ? `${stats.progress}%` : stats.progress_status === "no_weighted_tasks" ? tr("暂无任务") : tr("任务结构异常");
  return <div>
    <PageHeader title={project.name} description={project.description ?? tr("未填写简介")}
      actions={<div className="flex items-center gap-2">
        {project.entry === "readonly" && <StatusBadge tone="gray" label={project.lifecycle === "archived" ? tr("已归档 · 只读") : tr("已定稿 · 只读")} />}
        <Link className={secondary} href={`/projects/${projectId}/settings`}>{tr("项目设置")}</Link>
        {project.entry !== "readonly" && <Link className={button} href={`/projects/${projectId}/planning`}>{tr("开始规划")} <ArrowRight size={15} /></Link>}
      </div>} />
    <div className="mt-5 grid gap-3 md:grid-cols-4">
      <Stat label={tr("任务")} value={stats.task_count} sub={tr("已完成 {0}", { 0: stats.completed_count })} />
      <Stat label={tr("总进度")} value={progressText} />
      <Stat label={tr("成员")} value={stats.member_count} />
      <Stat label={tr("里程碑")} value={stats.milestone_count} sub={project.next_milestone ? tr("下一个：{0}", { 0: project.next_milestone.title }) : undefined} />
    </div>
    {stats.progress_status === "available" && <ProgressBar className="mt-3" value={stats.progress ?? 0} />}
    <ProjectSetupCenter projectId={projectId} overview={project} />
    <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Panel title={tr("项目状态")}><dl className="space-y-2 text-sm">
        <div className="flex gap-3"><dt className="w-24 text-slate-500">{tr("初始化")}</dt><dd>{tr("{0}（第 {1} 步）", { 0: tr(setupLabel[project.setup_status]) ?? project.setup_status, 1: project.setup_step })}</dd></div>
        <div className="flex gap-3"><dt className="w-24 text-slate-500">{tr("截止日期")}</dt><dd>{dateOnly(project.final_deadline, tr("未设置"))}</dd></div>
        {project.next_milestone && <div className="flex gap-3"><dt className="w-24 text-slate-500">{tr("下一个里程碑")}</dt><dd>{project.next_milestone.title} · {dateOnly(project.next_milestone.deadline, tr("未设置"))}</dd></div>}
        {!project.can_edit && <p className="flex items-center gap-1 pt-2 text-xs text-slate-500"><Lock size={13} />{tr("你可以查看，但不能修改这个项目。")}</p>}
      </dl></Panel>
      <div id="project-members" className="scroll-mt-20">
        <ProjectMembersPanel projectId={projectId} project={project} currentUserId={userId} />
      </div>
    </div>
  </div>;
}

function ProjectMembersPanel({
  projectId,
  project,
  currentUserId,
}: {
  projectId: string;
  project: {
    course_id: string | null;
    group_id: string | null;
    lifecycle: string;
    is_leader: boolean;
    members: { id: string; name: string | null; role?: string | null }[];
  };
  currentUserId: string;
}) {
  const tr = useUiText();
  const cache = useQueryClient();
  const [identifier, setIdentifier] = useState("");
  const [memberNotice, setMemberNotice] = useState<Notice>();
  const isPersonal = !project.course_id && !project.group_id;
  const canManage = isPersonal && project.is_leader && project.lifecycle === "active";

  const refreshMembers = () =>
    Promise.all([
      cache.invalidateQueries({ queryKey: ["b-project-overview"] }),
      cache.invalidateQueries({ queryKey: ["b-plan"] }),
      cache.invalidateQueries({ queryKey: ["c-project-context"] }),
    ]);

  const addMember = useMutation({
    mutationFn: () =>
      projectRequest<{ user_id: string; name: string | null }>(
        `/api/v1/a/projects/${encodeURIComponent(projectId)}/members`,
        { method: "POST", body: { identifier: identifier.trim() } },
      ),
    onSuccess: async (added) => {
      setIdentifier("");
      setMemberNotice({ tone: "success", text: tr("已将 {0} 加入项目，现在可以在任务计划中分配任务。", { 0: added.name ?? tr("成员") }) });
      await refreshMembers();
    },
    onError: (err) => {
      setMemberNotice({ tone: "error", text: err instanceof Error ? err.message : tr("添加队友失败，请核对学号、用户名或邮箱。") });
    },
  });

  const removeMember = useMutation({
    mutationFn: (memberId: string) =>
      projectRequest(`/api/v1/a/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(memberId)}`, {
        method: "DELETE",
      }),
    onSuccess: async () => {
      setMemberNotice({ tone: "info", text: tr("已移除该成员。") });
      await refreshMembers();
    },
    onError: (err) => {
      setMemberNotice({ tone: "error", text: err instanceof Error ? err.message : tr("移除成员失败。") });
    },
  });

  const transferLeader = useMutation({
    mutationFn: (newLeaderId: string) =>
      projectRequest(`/api/v1/a/projects/${encodeURIComponent(projectId)}/leader`, {
        method: "POST",
        body: { new_leader_id: newLeaderId },
      }),
    onSuccess: async () => {
      setMemberNotice({ tone: "success", text: tr("组长身份已转让。") });
      await refreshMembers();
    },
    onError: (err) => {
      setMemberNotice({ tone: "error", text: err instanceof Error ? err.message : tr("转让组长失败。") });
    },
  });

  return (
    <Panel title={tr("项目成员")}>
      {isPersonal && <p className="mb-3 text-xs text-slate-500">{tr("独立项目可直接按学号、用户名或邮箱邀请队友")}</p>}
      {memberNotice && <div className="mb-3"><Feedback tone={memberNotice.tone}>{memberNotice.text}</Feedback></div>}
      <ul className="divide-y divide-slate-100 text-sm">
        {project.members.map((member) => {
          const isSelf = member.id === currentUserId;
          const isMemberLeader = member.role === "leader" || (project.is_leader && isSelf);
          return (
            <li key={member.id} className="flex items-center justify-between gap-2 py-2.5">
              <div className="flex min-w-0 items-center gap-2.5">
                <Avatar name={member.name || "成"} />
                <span className="truncate font-medium text-slate-800">{member.name ?? tr("未命名")}</span>
                {isMemberLeader && <span className="gp-pill shrink-0">{tr("组长")}</span>}
              </div>
              {canManage && !isSelf && (
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800"
                    disabled={transferLeader.isPending || removeMember.isPending}
                    title={tr("转让组长")}
                    onClick={() => transferLeader.mutate(member.id)}
                  >
                    <Crown size={12} />
                    {tr("设为组长")}
                  </button>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-rose-600 transition-colors hover:bg-rose-50"
                    disabled={removeMember.isPending || transferLeader.isPending}
                    title={tr("移除成员")}
                    onClick={() => removeMember.mutate(member.id)}
                  >
                    <UserMinus size={12} />
                    {tr("移除")}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {canManage && (
        <form
          className="mt-3.5 border-t border-slate-100 pt-3.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (identifier.trim() && !addMember.isPending) addMember.mutate();
          }}
        >
          <label className={label} htmlFor="personal-member-identifier">{tr("邀请队友加入")}</label>
          <div className="mt-1.5 flex gap-2">
            <input
              id="personal-member-identifier"
              className={input}
              placeholder={tr("输入学号、用户名或邮箱")}
              value={identifier}
              maxLength={320}
              disabled={addMember.isPending}
              onChange={(event) => setIdentifier(event.target.value)}
            />
            <button type="submit" className={`${button} shrink-0`} disabled={!identifier.trim() || addMember.isPending}>
              <UserPlus size={14} />
              {addMember.isPending ? tr("添加中…") : tr("添加")}
            </button>
          </div>
        </form>
      )}
    </Panel>
  );
}

const extractLabel: Record<BMaterial["extract_status"], { tone: "green" | "amber" | "red" | "gray"; text: string }> = {
  ready: { tone: "green", text: "正文已就绪" }, pending: { tone: "amber", text: "正文提取中" }, failed: { tone: "red", text: "正文提取失败" }, unavailable: { tone: "gray", text: "正文暂不可用" },
};

/** Legacy /setup deep link now opens the non-blocking setup center and preserves editable project details/materials. */
export function ProjectSetupApiPage({ projectId }: { projectId: string }) {
  const tr = useUiText();
  const { userId } = useWorkspace();
  const setup = useQuery({ queryKey: ["b-project-setup", userId, projectId], queryFn: () => bProjectsApi.setup(projectId), ...queryPolicy });
  const overview = useQuery({ queryKey: ["b-project-overview", userId, projectId], queryFn: () => bProjectsApi.overview(projectId), ...queryPolicy });
  const hasBaselineRef = Boolean(overview.data?.course_id) && (setup.data?.setup_status === "frozen" || setup.data?.setup_status === "pending_confirmation");
  const currentBaseline = useQuery({
    queryKey: ["b-project-baseline-current", userId, projectId],
    queryFn: () => bRequirementsApi.current(projectId),
    enabled: hasBaselineRef,
    ...queryPolicy,
  });
  if (setup.isPending || overview.isPending) return <Loading />;
  if (setup.isError) return <LoadError error={setup.error} onRetry={() => void setup.refetch()} />;
  if (overview.isError) return <LoadError error={overview.error} onRetry={() => void overview.refetch()} />;
  const data = setup.data;
  const courseId = overview.data.course_id;
  const frozenCourseFiles = currentBaseline.data?.snapshot?.course_files ?? [];
  return <div>
    <PageHeader title={data.name} description={`${tr("项目设置中心")} · ${tr(setupLabel[data.setup_status]) ?? data.setup_status}`} actions={<Link href={`/projects/${projectId}`} className={secondary}>{tr("项目总览")}</Link>} />
    <ProjectSetupCenter projectId={projectId} overview={overview.data} initialSetup={data} />
    <div className="mx-auto mt-5 max-w-[960px] space-y-4">
      {!data.can_edit && <Feedback tone="info">{data.setup_status === "frozen" ? tr("需求基线已冻结，项目信息只能查看。") : data.setup_status === "pending_confirmation" ? tr("基线正在等待组员确认，暂时不能修改。") : tr("你可以查看项目信息，但不能修改。")}</Feedback>}
      {courseId && frozenCourseFiles.length > 0 && (
        <Panel title={tr("基线冻结引用的课程资料")}>
          <ul className="divide-y divide-slate-100 text-sm">
            {frozenCourseFiles.map((item) => (
              <li key={`${item.file_id}:${item.version_id}`} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <span className="flex items-center gap-2">
                  <FileText size={14} className="text-slate-500" />
                  <strong>{item.name}</strong>
                  <span className="text-xs text-slate-500">v{item.version_no}</span>
                </span>
                {item.source === "b_material" ? (
                  <a
                    className="text-xs font-medium text-blue-700 hover:underline"
                    href={`/api/v1/courses/${encodeURIComponent(courseId)}/materials/${encodeURIComponent(item.file_id)}/download?version_no=${item.version_no}`}
                  >
                    {tr("下载冻结引用版本 v{0}", { 0: item.version_no })}
                  </a>
                ) : (
                  <Link
                    className="text-xs font-medium text-blue-700 hover:underline"
                    href={`/courses/${encodeURIComponent(courseId)}/files?file=${encodeURIComponent(item.file_id)}&version=${encodeURIComponent(item.version_id)}`}
                  >
                    {tr("查看冻结引用版本 v{0}", { 0: item.version_no })}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <div id="project-details" className="scroll-mt-20"><BasicInfoStep projectId={projectId} data={data} onSaved={() => void overview.refetch()} /></div>
      <div id="project-materials" className="scroll-mt-20"><MaterialsStep projectId={projectId} data={data} /></div>
    </div>
  </div>;
}

function BasicInfoStep({ projectId, data, onSaved }: { projectId: string; data: BProjectSetup; onSaved: () => void }) {
  const tr = useUiText();
  const cache = useQueryClient();
  const errorText = useBErrorMessage();
  const { userId } = useWorkspace();
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({ name: data.name, project_type: data.project_type ?? "", description: data.description ?? "", start_date: data.start_date ?? today, end_date: data.end_date ?? data.course_deadline ?? today });
  const [notice, setNotice] = useState<Notice>();
  const [field, setField] = useState<string>();
  const save = useMutation({
    mutationFn: () => bProjectsApi.saveBasic(projectId, { name: form.name.trim(), project_type: form.project_type.trim() || undefined, description: form.description.trim() || undefined, start_date: form.start_date, end_date: form.end_date }, data.lock_version),
    onSuccess: (row) => { cache.setQueryData(["b-project-setup", userId, projectId], row); void cache.invalidateQueries({ queryKey: ["b-project-overview", userId, projectId] }); onSaved(); },
    onError: (error) => { setField(fieldOf(error)); setNotice({ tone: "error", text: errorText(error) }); if (error instanceof BApiError && error.code === "VERSION_CONFLICT") void cache.invalidateQueries({ queryKey: ["b-project-setup", userId, projectId] }); },
  });
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => { setForm({ ...form, [key]: event.target.value }); if (field === key) setField(undefined); };
  const invalid = (key: string) => (field === key ? "border-red-400 ring-2 ring-red-100" : "");
  return <Panel title={tr("基本信息")}><form className="space-y-3" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
    {notice && <Feedback tone={notice.tone}>{notice.text}</Feedback>}
    <fieldset disabled={!data.can_edit} className="space-y-3">
      <div><label className={label} htmlFor="b-setup-name">{tr("项目名称")}</label><input id="b-setup-name" aria-invalid={field === "name"} className={`${input} ${invalid("name")}`} maxLength={200} value={form.name} onChange={set("name")} required /></div>
      <div><label className={label} htmlFor="b-setup-type">{tr("项目类型")}</label><input id="b-setup-type" className={input} maxLength={80} value={form.project_type} onChange={set("project_type")} /></div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div><label className={label} htmlFor="b-setup-start">{tr("开始日期")}</label><input id="b-setup-start" type="date" aria-invalid={field === "start_date"} className={`${input} ${invalid("start_date")}`} value={form.start_date} onChange={set("start_date")} required /></div>
        <div><label className={label} htmlFor="b-setup-end">{tr("结束日期")}</label><input id="b-setup-end" type="date" aria-invalid={field === "end_date"} aria-describedby="b-setup-end-hint" className={`${input} ${invalid("end_date")}`} value={form.end_date} onChange={set("end_date")} required />
          <p id="b-setup-end-hint" className="mt-1 text-xs text-slate-500">{tr("不晚于课程截止日期 {0}", { 0: dateOnly(data.course_deadline, tr("未设置")) })}</p></div>
      </div>
      <div><label className={label} htmlFor="b-setup-description">{tr("项目简介")}</label><textarea id="b-setup-description" className={input} rows={4} maxLength={5000} value={form.description} onChange={set("description")} /></div>
    </fieldset>
    {data.can_edit && <div className="flex justify-end"><button type="submit" className={button} disabled={save.isPending || !form.name.trim()}>{save.isPending ? tr("正在保存…") : tr("保存基本信息")}</button></div>}
  </form></Panel>;
}

function MaterialsStep({ projectId, data }: { projectId: string; data: BProjectSetup }) {
  const tr = useUiText();
  const cache = useQueryClient();
  const errorText = useBErrorMessage();
  const { userId } = useWorkspace();
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<Notice>();
  const [openId, setOpenId] = useState<string | null>(null);
  const refresh = () => void cache.invalidateQueries({ queryKey: ["b-project-setup", userId, projectId] });
  const addText = useMutation({
    mutationFn: () => bProjectsApi.addText(projectId, { title: title.trim() || undefined, text }),
    onSuccess: () => { setTitle(""); setText(""); setNotice({ tone: "success", text: tr("已添加文本资料") }); refresh(); },
    onError: (error) => setNotice({ tone: "error", text: errorText(error) }),
  });
  const addFile = useMutation({
    mutationFn: (file: File) => bProjectsApi.addFile(projectId, file),
    onSuccess: (row) => { setNotice({ tone: row.extract_status === "ready" ? "success" : "warning", text: row.extract_status === "ready" ? tr("已添加「{0}」", { 0: row.title }) : tr("已添加「{0}」，{1}{2}", { 0: row.title, 1: tr(extractLabel[row.extract_status].text), 2: row.extract_reason ? `：${row.extract_reason}` : "" }) }); refresh(); },
    onError: (error) => setNotice({ tone: "error", text: errorText(error) }),
  });
  const detail = useQuery({ queryKey: ["b-material", userId, projectId, openId], queryFn: () => bProjectsApi.material(projectId, openId!), enabled: Boolean(openId), ...queryPolicy });
  return <div className="space-y-4">
    {notice && <Feedback tone={notice.tone}>{notice.text}</Feedback>}
    <Panel title={tr("已添加的资料（{0}）", { 0: data.materials.length })}>
      {data.materials.length === 0 ? <EmptyState title={tr("还没有资料")} description={tr("粘贴课程要求、需求说明等文本，或上传文件。")} /> : <ul className="divide-y divide-slate-100">{data.materials.map((row) => <li key={row.id} className="py-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-2">{row.kind === "file" ? <Upload size={14} /> : <FileText size={14} />}<strong>{row.title}</strong><span className="text-xs text-slate-400">{row.created_by?.name ?? ""} · {dateOnly(row.created_at, tr("未设置"))}</span></span>
          <span className="flex items-center gap-2"><StatusBadge tone={extractLabel[row.extract_status].tone} label={tr(extractLabel[row.extract_status].text)} />
            {row.extract_status === "ready" && <button type="button" className={secondary} onClick={() => setOpenId(openId === row.id ? null : row.id)}>{openId === row.id ? tr("收起正文") : tr("查看正文（{0} 字）", { 0: row.text_length })}</button>}</span>
        </div>
        {row.extract_status !== "ready" && row.extract_reason && <p className="mt-1 text-xs text-slate-500">{row.extract_reason}</p>}
        {openId === row.id && <div className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs text-slate-700" data-testid="b-material-text">{detail.isPending ? tr("正在加载正文…") : detail.isError ? errorText(detail.error) : detail.data?.text}</div>}
      </li>)}</ul>}
    </Panel>
    {data.can_edit && <>
      <Panel title={tr("添加文本资料")}><form className="space-y-3" onSubmit={(event) => { event.preventDefault(); addText.mutate(); }}>
        <div><label className={label} htmlFor="b-material-title">{tr("标题（可选，默认取第一行）")}</label><input id="b-material-title" className={input} maxLength={255} value={title} onChange={(event) => setTitle(event.target.value)} /></div>
        <div><label className={label} htmlFor="b-material-text">{tr("正文")}</label><textarea id="b-material-text" className={input} rows={6} maxLength={200000} value={text} onChange={(event) => setText(event.target.value)} /></div>
        <div className="flex justify-end"><button type="submit" className={button} disabled={addText.isPending || !text.trim()}>{addText.isPending ? tr("正在添加…") : tr("添加文本资料")}</button></div>
      </form></Panel>
      <Panel title={tr("上传文件")}>
        <label className={label} htmlFor="b-material-file">{tr("选择文件")}</label>
        <input id="b-material-file" type="file" className="text-sm" disabled={addFile.isPending} onChange={(event) => { const file = event.target.files?.[0]; if (file) addFile.mutate(file); event.target.value = ""; }} />
        <p className="mt-2 text-xs text-slate-500">{addFile.isPending ? tr("正在上传…") : tr("支持 PDF、DOCX、MD、TXT 自动提取正文供需求分析使用；无法读取时会明确提示原因，不会用假正文代替。")}</p>
      </Panel>
    </>}
  </div>;
}
