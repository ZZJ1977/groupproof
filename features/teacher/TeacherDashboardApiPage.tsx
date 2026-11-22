"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle, ArrowRight, BookOpen, CheckSquare } from "lucide-react";
import { button, card, errorText, secondary } from "@/features/b/ui";
import { teacherDashboardApi, teacherDashboardKeys } from "@/lib/api/teacher-dashboard-client";
import { tr } from "@/lib/i18n/tr";
import { useWorkspace } from "@/lib/workspace";

export function TeacherDashboardApiPage() {
  const { userId } = useWorkspace();

  const dashQ = useQuery({
    queryKey: teacherDashboardKeys.overview(userId),
    queryFn: () => teacherDashboardApi.overview(),
    enabled: Boolean(userId),
  });
  const actionsQ = useQuery({
    queryKey: teacherDashboardKeys.actions(userId),
    queryFn: () => teacherDashboardApi.actions(),
    enabled: Boolean(userId),
  });
  const risksQ = useQuery({
    queryKey: teacherDashboardKeys.risks(userId),
    queryFn: () => teacherDashboardApi.risks(),
    enabled: Boolean(userId),
  });

  const data = dashQ.data;

  return (
    <div className="space-y-6">
      <div className={`${card} flex flex-wrap items-center justify-between gap-3`}>
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-900">
            <Activity size={20} className="text-blue-600" />
            {tr("教师工作台")}
          </h1>
          <p className="mt-1 text-xs text-slate-500">
            {tr("跨班级聚合展示待审批事项、风险预警队伍与近期教学活动流。")}
          </p>
        </div>
        <Link href="/teacher/courses" className={`${button} inline-flex items-center gap-1.5`}>
          <BookOpen size={15} />
          {tr("管理我的班级")}
        </Link>
      </div>

      {dashQ.isLoading ? (
        <div className={card}>{tr("正在加载教师工作台数据…")}</div>
      ) : dashQ.isError ? (
        <div className={`${card} text-sm text-red-600`}>{errorText(dashQ.error)}</div>
      ) : (
        data && (
          <>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <div className={card}>
                <div className="text-xs text-slate-500">{tr("跨班待处理事项")}</div>
                <div className="mt-1 text-2xl font-bold text-blue-600">
                  {data.total_pending_actions}
                </div>
              </div>
              <div className={card}>
                <div className="text-xs text-slate-500">{tr("我管理的班级")}</div>
                <div className="mt-1 text-2xl font-bold text-slate-900">{data.total_classes}</div>
                <div className="mt-1 text-xs text-slate-500">
                  {tr("学生 {0} 人 · 小组 {1} 支", {
                    0: data.total_students,
                    1: data.total_groups,
                  })}
                </div>
              </div>
              <div className={card}>
                <div className="text-xs text-slate-500">{tr("在研项目总数")}</div>
                <div className="mt-1 text-2xl font-bold text-slate-900">{data.total_projects}</div>
              </div>
              <div className={card}>
                <div className="text-xs text-slate-500">{tr("全局风险队伍")}</div>
                <div className="mt-1 text-2xl font-bold text-red-600">
                  {data.high_risk_groups + data.medium_risk_groups}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  {tr("高风险 {0} · 中风险 {1}", {
                    0: data.high_risk_groups,
                    1: data.medium_risk_groups,
                  })}
                </div>
              </div>
            </div>

            <div className={`${card} space-y-3`}>
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-slate-900">{tr("授课班级概览")}</h2>
                <Link href="/teacher/courses" className={`${secondary} text-xs`}>
                  {tr("全部班级")}
                </Link>
              </div>
              {data.classes.length === 0 ? (
                <p className="py-6 text-center text-sm text-slate-500">
                  {tr("尚未创建或加入管理任何班级")}
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {data.classes.map((cls) => (
                    <Link
                      key={cls.course_id}
                      href={cls.href}
                      className="block rounded-xl border border-slate-200 p-4 transition hover:border-blue-300 hover:bg-blue-50/20"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="font-semibold text-slate-900">{cls.name}</div>
                          <div className="mt-0.5 text-xs text-slate-500">{cls.semester}</div>
                        </div>
                        {cls.pending_actions > 0 && (
                          <span className="rounded-full bg-red-500 px-2 py-0.5 text-[11px] font-bold text-white">
                            {cls.pending_actions}
                          </span>
                        )}
                      </div>
                      <div className="mt-3 flex flex-wrap gap-3 text-xs text-slate-600">
                        <span>{tr("{0} 名学生", { 0: cls.student_count })}</span>
                        <span>{tr("{0} 支队伍", { 0: cls.group_count })}</span>
                        <span>
                          {tr("进度 {0}%", { 0: cls.overall_progress ?? "—" })}
                        </span>
                      </div>
                      {cls.risk_count > 0 && (
                        <div className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-amber-700">
                          <AlertTriangle size={12} />
                          {tr("{0} 支队伍存在预警", { 0: cls.risk_count })}
                        </div>
                      )}
                    </Link>
                  ))}
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              <div className={`${card} space-y-3`}>
                <div className="flex items-center gap-2 text-base font-semibold text-slate-900">
                  <CheckSquare size={17} className="text-blue-600" />
                  {tr("跨班级待处理事项")}
                </div>
                {actionsQ.isLoading ? (
                  <p className="text-xs text-slate-500">{tr("加载中…")}</p>
                ) : (actionsQ.data?.items.length ?? 0) === 0 ? (
                  <p className="py-4 text-sm text-slate-500">{tr("所有班级待办均已清零")}</p>
                ) : (
                  <div className="divide-y divide-slate-100">
                    {actionsQ.data?.items.slice(0, 8).map((act) => (
                      <div key={act.id} className="flex items-center justify-between gap-2 py-2.5">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-slate-900">
                            {act.title}
                          </div>
                          <div className="truncate text-xs text-slate-500">{act.description}</div>
                        </div>
                        <Link
                          href={act.href}
                          className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-blue-600 hover:underline"
                        >
                          {tr("去处理")}
                          <ArrowRight size={12} />
                        </Link>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className={`${card} space-y-3`}>
                <div className="flex items-center gap-2 text-base font-semibold text-slate-900">
                  <AlertTriangle size={17} className="text-amber-600" />
                  {tr("全局风险与近期动态")}
                </div>
                {(risksQ.data?.items.length ?? 0) > 0 && (
                  <div className="space-y-1.5">
                    {risksQ.data?.items.slice(0, 4).map((r) => (
                      <div
                        key={r.group_id}
                        className="rounded-lg border border-red-200 bg-red-50/70 px-3 py-2 text-xs text-red-900"
                      >
                        <span className="font-semibold">{r.group_name}</span> ·{" "}
                        {r.reasons[0] ?? r.risk_level}
                      </div>
                    ))}
                  </div>
                )}
                {data.recent_activity.length === 0 ? (
                  <p className="py-4 text-sm text-slate-500">{tr("暂无近期跨班动态")}</p>
                ) : (
                  <div className="divide-y divide-slate-100">
                    {data.recent_activity.slice(0, 8).map((ev) => (
                      <Link
                        key={ev.id}
                        href={ev.href}
                        className="flex items-center justify-between gap-2 py-2 text-xs hover:bg-slate-50"
                      >
                        <div className="min-w-0">
                          <span className="mr-1.5 rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-600">
                            {ev.course_name}
                          </span>
                          <span className="font-medium text-slate-800">{ev.title}</span>
                        </div>
                        <span className="shrink-0 text-slate-400">
                          {ev.occurred_at.slice(0, 10)}
                        </span>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )
      )}
    </div>
  );
}
