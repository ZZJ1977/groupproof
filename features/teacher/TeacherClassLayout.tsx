"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, BarChart3, Bell, CheckSquare, ClipboardList, Folder, Home, ListTree, Settings, Shield, ShieldCheck, UserCog, Users } from "lucide-react";
import { ClassRosterSidebar } from "@/features/teacher/ClassRosterSidebar";
import { teacherActionsApi, teacherActionsKeys } from "@/lib/api/teacher-actions-client";
import { teacherClassesApi, teacherKeys } from "@/lib/api/teacher-client";
import { useTeacherPermissions } from "@/lib/hooks/use-teacher-permissions";
import { useWorkspace } from "@/lib/workspace";

const statusLabels: Record<string, string> = {
  active: "进行中",
  ended: "已结课",
  draft: "草稿",
  pending_approval: "待审批",
  archived: "已归档",
};

export function TeacherClassLayout({
  courseId,
  activeTab,
  children,
}: {
  courseId: string;
  activeTab: "home" | "groups" | "detail" | "actions" | "projects" | "reports" | "rules" | "files" | "announcements" | "appeals" | "settings" | "staff";
  children: ReactNode;
}) {
  const { userId } = useWorkspace();
  const perms = useTeacherPermissions(courseId);
  const badgeQuery = useQuery({
    queryKey: teacherActionsKeys.badge(userId, courseId),
    queryFn: () => teacherActionsApi.list(courseId, { status: "pending", page: 1, page_size: 1 }),
    enabled: Boolean(courseId),
    refetchInterval: 60_000,
    retry: false,
  });
  const pendingActions = badgeQuery.data?.pending_count ?? 0;
  const detail = useQuery({
    queryKey: teacherKeys.classDetail(userId, courseId),
    queryFn: () => teacherClassesApi.detail(courseId),
    enabled: Boolean(courseId),
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-5 py-3.5">
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/teacher/courses"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
          >
            <ArrowLeft size={14} />
            我的班级
          </Link>
          {detail.data && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-slate-900">{detail.data.name}</span>
              <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                {detail.data.semester}
              </span>
              {detail.data.code && (
                <span className="font-mono text-xs text-slate-500">{detail.data.code}</span>
              )}
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                  detail.data.status === "active"
                    ? "bg-emerald-50 text-emerald-700"
                    : "bg-slate-100 text-slate-600"
                }`}
              >
                {statusLabels[detail.data.status] ?? detail.data.status}
              </span>
            </div>
          )}
        </div>

        <nav aria-label="班级管理子导航" className="flex flex-wrap items-center gap-1.5">
          <Link
            href={`/teacher/courses/${courseId}`}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              activeTab === "home"
                ? "bg-blue-600 text-white"
                : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            }`}
          >
            <Home size={14} />
            班级首页
          </Link>
          <Link
            href={`/teacher/courses/${courseId}/groups`}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              activeTab === "groups" || activeTab === "detail"
                ? "bg-blue-600 text-white"
                : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            }`}
          >
            <Users size={14} />
            学生组队广场
          </Link>
          <Link
            href={`/teacher/courses/${courseId}/actions`}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              activeTab === "actions"
                ? "bg-blue-600 text-white"
                : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            }`}
          >
            <CheckSquare size={14} />
            操作中心
            {pendingActions > 0 && (
              <span className="rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
                {pendingActions}
              </span>
            )}
          </Link>
          <Link
            href={`/teacher/courses/${courseId}/projects`}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              activeTab === "projects"
                ? "bg-blue-600 text-white"
                : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            }`}
          >
            <ListTree size={14} />
            项目总览
          </Link>
          <Link
            href={`/teacher/courses/${courseId}/reports`}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              activeTab === "reports"
                ? "bg-blue-600 text-white"
                : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            }`}
          >
            <BarChart3 size={14} />
            班级报告
          </Link>
          <Link
            href={`/teacher/courses/${courseId}/rules`}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              activeTab === "rules"
                ? "bg-blue-600 text-white"
                : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            }`}
          >
            <ClipboardList size={14} />
            课程规则
          </Link>
          <Link
            href={`/teacher/courses/${courseId}/files`}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              activeTab === "files"
                ? "bg-blue-600 text-white"
                : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            }`}
          >
            <Folder size={14} />
            课程资料
          </Link>
          <Link
            href={`/teacher/courses/${courseId}/announcements`}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              activeTab === "announcements"
                ? "bg-blue-600 text-white"
                : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            }`}
          >
            <Bell size={14} />
            课程公告
          </Link>
          <Link
            href={`/teacher/courses/${courseId}/appeals`}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              activeTab === "appeals"
                ? "bg-blue-600 text-white"
                : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            }`}
          >
            <ShieldCheck size={14} />
            申诉处理
          </Link>
          <Link
            href={`/teacher/courses/${courseId}/member-changes`}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
          >
            <UserCog size={14} />
            成员变动
          </Link>
          {perms.isOwner && (
            <Link
              href={`/teacher/courses/${courseId}/staff`}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                activeTab === "staff"
                  ? "bg-blue-600 text-white"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              }`}
            >
              <Shield size={14} />
              助教管理
            </Link>
          )}
          <Link
            href={`/teacher/courses/${courseId}/settings`}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              activeTab === "settings"
                ? "bg-blue-600 text-white"
                : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            }`}
          >
            <Settings size={14} />
            班级设置
          </Link>
        </nav>
      </div>

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[300px_1fr]">
        <ClassRosterSidebar courseId={courseId} />
        <div className="min-w-0 space-y-5">{children}</div>
      </div>
    </div>
  );
}
