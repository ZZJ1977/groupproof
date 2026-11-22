"use client";

import Link from "next/link";
import { ArrowRight, BookOpen, RefreshCw, ShieldCheck, UserCheck, Users } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace";
import { cIdentityClient } from "@/lib/api/c-identity-client";
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

  const refresh = () => {
    void Promise.all([users.refetch(), teachers.refetch(), courses.refetch(), requests.refetch()]);
  };
  const onlyAdmin = users.data?.total === 1 && courses.data?.total === 0;
  const hasError = users.isError || teachers.isError || courses.isError || requests.isError;
  const recentUsers = users.data?.items.slice(0, 5) ?? [];

  return <main className={styles.page}>
    <Header title="管理总览" description="查看使用端账号和课程治理状态，快速处理待办事项。" action={<button type="button" className={styles.button} onClick={refresh}><RefreshCw size={15} />刷新数据</button>} />
    {hasError && <ErrorState onRetry={refresh} />}
    {onlyAdmin && <div role="status" className={styles.notice}><span>当前数据库只有管理员账号，使用端还没有学生、教师或课程数据。</span><Link className={styles.primaryButton} href="/admin/users">新增账号<ArrowRight size={14} /></Link></div>}
    <div className={styles.metrics}>
      <Metric label="用户总数" value={valueOf(users)} hint="来自统一身份服务" icon={Users} />
      <Metric label="待审核教师" value={valueOf(teachers)} hint="需要管理员处理" icon={UserCheck} tone={teachers.data?.total ? "amber" : "blue"} />
      <Metric label="课程总数" value={valueOf(courses)} hint="草稿、已发布和已结束" icon={BookOpen} />
      <Metric label="待审批访问" value={valueOf(requests)} hint="临时只读授权申请" icon={ShieldCheck} tone={requests.data?.total ? "amber" : "blue"} />
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
