"use client";

import Link from "next/link";
import { ArrowRight, BookOpen, RefreshCw, ShieldCheck, UserCheck, Users } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace";
import { cIdentityClient, type IdentityAdminPage, type IdentityAdminUser } from "@/lib/api/c-identity-client";
import { createGovernanceClient } from "@/lib/api/c-governance-client";
import { Box, Empty, Header, Metric } from "@/features/governance/primitives";
import styles from "@/features/governance/governance.module.css";

const governance = createGovernanceClient();
const querySettings = { staleTime: 0, gcTime: 0, retry: false } as const;

function valueOf<T extends { total: number }>(query: { data?: T; isFetching: boolean; isError: boolean }) {
  if (query.isFetching) return "…";
  if (query.isError || !query.data) return "—";
  return query.data.total;
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return <div role="alert" className={styles.notice}><span>数据暂时无法读取。</span><button type="button" className={styles.button} onClick={onRetry}><RefreshCw size={14} />重试</button></div>;
}

function QuickLink({ href, title, description, icon: Icon }: { href: string; title: string; description: string; icon: typeof Users }) {
  return <Link href={href} className="group flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-4 transition hover:border-blue-300 hover:bg-blue-50">
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-blue-50 text-blue-600"><Icon size={18} /></span>
    <span className="min-w-0 flex-1"><strong className="block text-sm text-slate-900">{title}</strong><span className="mt-1 block text-xs text-slate-500">{description}</span></span>
    <ArrowRight size={16} className="shrink-0 text-slate-400 transition group-hover:translate-x-0.5 group-hover:text-blue-600" />
  </Link>;
}

function Distribution({ items, total }: { items: { label: string; value: number | string; color: string }[]; total: number | string }) {
  const denominator = typeof total === "number" && total > 0 ? total : 0;
  return <div className="space-y-4">
    {items.map((item) => {
      const value = typeof item.value === "number" ? item.value : 0;
      const width = denominator ? Math.max(value ? 5 : 0, Math.round((value / denominator) * 100)) : 0;
      return <div key={item.label}>
        <div className="mb-1.5 flex items-center justify-between gap-3 text-sm"><span className="flex items-center gap-2 text-slate-700"><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />{item.label}</span><strong className="text-slate-900">{item.value}</strong></div>
        <div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full transition-all" style={{ width: `${width}%`, backgroundColor: item.color }} /></div>
      </div>;
    })}
  </div>;
}

function ServiceStatus({ label, ready, loading }: { label: string; ready: boolean; loading: boolean }) {
  return <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-3"><span className="text-sm text-slate-700">{label}</span><span className={`inline-flex items-center gap-1.5 text-xs font-medium ${loading ? "text-slate-400" : ready ? "text-emerald-600" : "text-rose-600"}`}><span className={`h-2 w-2 rounded-full ${loading ? "bg-slate-300" : ready ? "bg-emerald-500" : "bg-rose-500"}`} />{loading ? "读取中" : ready ? "已连接" : "不可用"}</span></div>;
}

export function AdminDashboardPage() {
  const { userId } = useWorkspace();
  const users = useQuery({
    queryKey: ["admin-dashboard-users", userId],
    queryFn: () => cIdentityClient.users(new URLSearchParams({ page: "1" })),
    ...querySettings,
  });
  const teachers = useQuery({
    queryKey: ["admin-dashboard-teacher-applications", userId],
    queryFn: () => cIdentityClient.applications(1, "pending"),
    ...querySettings,
  });
  const courses = useQuery({
    queryKey: ["admin-dashboard-courses", userId],
    queryFn: () => governance.courses({ page: 1, page_size: 1 }),
    ...querySettings,
  });
  const requests = useQuery({
    queryKey: ["admin-dashboard-access-requests", userId],
    queryFn: () => governance.accessRequests({ page: 1, page_size: 1, status: "pending" }),
    ...querySettings,
  });
  const roleQueries = {
    student: useQuery<IdentityAdminPage<IdentityAdminUser>>({ queryKey: ["admin-dashboard-role", userId, "student"], queryFn: () => cIdentityClient.users(new URLSearchParams({ page: "1", role: "student" })), ...querySettings }),
    teacher: useQuery<IdentityAdminPage<IdentityAdminUser>>({ queryKey: ["admin-dashboard-role", userId, "teacher"], queryFn: () => cIdentityClient.users(new URLSearchParams({ page: "1", role: "teacher" })), ...querySettings }),
    ta: useQuery<IdentityAdminPage<IdentityAdminUser>>({ queryKey: ["admin-dashboard-role", userId, "ta"], queryFn: () => cIdentityClient.users(new URLSearchParams({ page: "1", role: "ta" })), ...querySettings }),
    admin: useQuery<IdentityAdminPage<IdentityAdminUser>>({ queryKey: ["admin-dashboard-role", userId, "admin"], queryFn: () => cIdentityClient.users(new URLSearchParams({ page: "1", role: "admin" })), ...querySettings }),
  };
  const courseQueries = {
    draft: useQuery({ queryKey: ["admin-dashboard-course-status", userId, "draft"], queryFn: () => governance.courses({ page: 1, page_size: 1, status: "draft" }), ...querySettings }),
    active: useQuery({ queryKey: ["admin-dashboard-course-status", userId, "active"], queryFn: () => governance.courses({ page: 1, page_size: 1, status: "active" }), ...querySettings }),
    ended: useQuery({ queryKey: ["admin-dashboard-course-status", userId, "ended"], queryFn: () => governance.courses({ page: 1, page_size: 1, status: "ended" }), ...querySettings }),
  };

  const refresh = () => {
    void Promise.all([
      users.refetch(), teachers.refetch(), courses.refetch(), requests.refetch(),
      ...Object.values(roleQueries).map((query) => query.refetch()),
      ...Object.values(courseQueries).map((query) => query.refetch()),
    ]);
  };
  const onlyAdmin = users.data?.total === 1 && courses.data?.total === 0;
  const hasError = users.isError || teachers.isError || courses.isError || requests.isError;
  const recentUsers = users.data?.items.slice(0, 5) ?? [];
  const roleTotal = users.data?.total ?? "—";
  const roleItems = [
    { label: "学生", value: roleQueries.student.data?.total ?? "—", color: "#2563eb" },
    { label: "教师", value: roleQueries.teacher.data?.total ?? "—", color: "#7c3aed" },
    { label: "助教", value: roleQueries.ta.data?.total ?? "—", color: "#0d9488" },
    { label: "管理员", value: roleQueries.admin.data?.total ?? "—", color: "#ea580c" },
  ];
  const courseItems = [
    { label: "草稿", value: courseQueries.draft.data?.total ?? "—", color: "#f59e0b" },
    { label: "已发布", value: courseQueries.active.data?.total ?? "—", color: "#10b981" },
    { label: "已结束", value: courseQueries.ended.data?.total ?? "—", color: "#64748b" },
  ];
  const roleLoading = Object.values(roleQueries).some((query) => query.isFetching);
  const courseLoading = Object.values(courseQueries).some((query) => query.isFetching);

  return <main className={styles.page}>
    <Header title="管理总览" description="查看使用端账号和课程治理状态，快速处理待办事项。" action={<button type="button" className={styles.button} onClick={refresh}><RefreshCw size={15} />刷新数据</button>} />
    {hasError && <ErrorState onRetry={refresh} />}
    {onlyAdmin && <div role="status" className={styles.notice}><span>当前数据库只有管理员账号，使用端还没有学生、教师或课程数据。</span><Link className={styles.primaryButton} href="/admin/users">新增账号<ArrowRight size={14} /></Link></div>}
    <div className={styles.metrics}>
      <Metric label="用户总数" value={valueOf(users)} hint="来自统一身份服务" trend="当前环境" icon={Users} />
      <Metric label="待审核教师" value={valueOf(teachers)} hint="需要管理员处理" trend={teachers.data?.total ? "有待办" : "队列为空"} icon={UserCheck} tone={teachers.data?.total ? "amber" : "blue"} />
      <Metric label="课程总数" value={valueOf(courses)} hint="草稿、已发布和已结束" trend="生命周期汇总" icon={BookOpen} />
      <Metric label="待审批访问" value={valueOf(requests)} hint="临时只读授权申请" trend={requests.data?.total ? "有待办" : "暂无待办"} icon={ShieldCheck} tone={requests.data?.total ? "amber" : "blue"} />
    </div>
    <div className={styles.twoColumns}>
      <Box title="最近账号" action={<Link className="gp-link inline-flex items-center gap-1" href="/admin/users">查看用户目录 <ArrowRight size={14} /></Link>}>
        <div className={styles.panelBody}>
          {!users.isFetching && !users.isError && !recentUsers.length && <Empty>暂无使用端账号</Empty>}
          {recentUsers.map((user) => <Link key={user.id} href={`/admin/users?user=${encodeURIComponent(user.id)}`} className="flex items-center justify-between gap-3 border-b border-slate-100 py-3 last:border-0">
            <span className="min-w-0"><strong className="block truncate text-sm text-slate-900">{user.name ?? "未命名账号"}</strong><span className="mt-1 block truncate text-xs text-slate-500">{user.schoolEmail ?? "暂无学校邮箱"}</span></span>
            <span className="shrink-0 text-xs text-slate-500">{user.roles.join("、")} · {user.status}</span>
          </Link>)}
        </div>
      </Box>
      <Box title="待处理事项">
        <div className={styles.panelBody}>
          <QuickLink href="/admin/teacher-verifications" title="教师审核" description={`${teachers.data?.total ?? "—"} 条待审核申请`} icon={UserCheck} />
          <div className="h-3" />
          <QuickLink href="/admin/access-requests" title="访问审批" description={`${requests.data?.total ?? "—"} 条待审批申请`} icon={ShieldCheck} />
        </div>
      </Box>
    </div>
    <div className={styles.equalColumns}>
      <Box title="账号结构">
        <div className={styles.panelBody}><Distribution items={roleItems} total={roleTotal} /></div>
      </Box>
      <Box title="课程状态">
        <div className={styles.panelBody}><Distribution items={courseItems} total={courses.data?.total ?? "—"} /></div>
      </Box>
    </div>
    <Box title="数据连接状态">
      <div className="grid gap-3 p-[18px] sm:grid-cols-2 lg:grid-cols-4">
        <ServiceStatus label="统一身份服务" ready={users.isSuccess && !roleLoading} loading={users.isFetching || roleLoading} />
        <ServiceStatus label="教师审核服务" ready={teachers.isSuccess} loading={teachers.isFetching} />
        <ServiceStatus label="课程治理服务" ready={courses.isSuccess && !courseLoading} loading={courses.isFetching || courseLoading} />
        <ServiceStatus label="访问审批服务" ready={requests.isSuccess} loading={requests.isFetching} />
      </div>
    </Box>
    <Box title="管理入口">
      <div className="grid gap-3 p-[18px] sm:grid-cols-2 lg:grid-cols-3">
        <QuickLink href="/admin/users" title="用户管理" description="创建、查询、停用和恢复账号" icon={Users} />
        <QuickLink href="/admin/teacher-verifications" title="教师审核" description="处理教师身份申请和历史结果" icon={UserCheck} />
        <QuickLink href="/admin/courses" title="课程管理" description="查看课程状态和生命周期" icon={BookOpen} />
        <QuickLink href="/admin/logs" title="系统日志" description="查看认证与业务审计记录" icon={ShieldCheck} />
        <QuickLink href="/admin/ai-usage" title="AI 使用情况" description="查看模型调用和计费完整性" icon={RefreshCw} />
        <QuickLink href="/admin/access-requests" title="异常 / 访问审批" description="处理临时只读授权申请" icon={ShieldCheck} />
      </div>
    </Box>
  </main>;
}
