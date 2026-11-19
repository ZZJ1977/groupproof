"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, BookOpen, Plus, Search, Users } from "lucide-react";
import {
  button,
  card,
  errorText,
  input,
  label,
  secondary,
} from "@/features/b/ui";
import { InviteCodeCard } from "@/features/teacher/InviteCodeCard";
import {
  type JoinMode,
  type TeacherClassDetail,
  teacherClassesApi,
  teacherKeys,
} from "@/lib/api/teacher-client";
import { tr } from "@/lib/i18n/tr";
import { useWorkspace } from "@/lib/workspace";

const statusLabels: Record<string, string> = {
  active: "进行中",
  ended: "已结课",
  draft: "草稿",
  pending_approval: "待审批",
  archived: "已归档",
};

export function TeacherClassesApiPage() {
  const qc = useQueryClient();
  const { userId } = useWorkspace();
  const [statusTab, setStatusTab] = useState<"active" | "ended" | "all">("active");
  const [search, setSearch] = useState("");
  const [creatingOpen, setCreatingOpen] = useState(false);
  const [newlyCreated, setNewlyCreated] = useState<TeacherClassDetail | null>(null);

  const [name, setName] = useState("");
  const [semester, setSemester] = useState("2026春");
  const [college, setCollege] = useState("计算机科学与工程学院");
  const [code, setCode] = useState("");
  const [minGroupSize, setMinGroupSize] = useState(2);
  const [maxGroupSize, setMaxGroupSize] = useState(5);
  const [projectDeadline, setProjectDeadline] = useState("2026-12-31T23:59");
  const [formationDeadline, setFormationDeadline] = useState("");
  const [joinMode, setJoinMode] = useState<JoinMode>("direct");
  const [formError, setFormError] = useState<string | null>(null);

  const classesQuery = useQuery({
    queryKey: teacherKeys.classes(userId, statusTab, search.trim()),
    queryFn: () => teacherClassesApi.list(statusTab, search.trim()),
  });

  const createClass = useMutation({
    mutationFn: () => {
      const projectDeadlineIso = projectDeadline
        ? new Date(projectDeadline).toISOString()
        : new Date(Date.now() + 90 * 86400 * 1000).toISOString();
      const formationDeadlineIso = formationDeadline
        ? new Date(formationDeadline).toISOString()
        : null;
      return teacherClassesApi.create({
        name: name.trim(),
        semester: semester.trim(),
        college: college.trim(),
        code: code.trim() || null,
        project_deadline: projectDeadlineIso,
        formation_deadline: formationDeadlineIso,
        min_group_size: minGroupSize,
        max_group_size: maxGroupSize,
        join_mode: joinMode,
      });
    },
    onSuccess: async (created) => {
      setNewlyCreated(created);
      setCreatingOpen(false);
      setName("");
      setCode("");
      setFormationDeadline("");
      setFormError(null);
      await qc.invalidateQueries({ queryKey: ["b-teacher-classes", userId] });
    },
  });

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setFormError("请填写班级名称");
      return;
    }
    if (!semester.trim()) {
      setFormError("请填写学期");
      return;
    }
    if (minGroupSize > maxGroupSize) {
      setFormError("最小组队人数不能大于最大组队人数");
      return;
    }
    setFormError(null);
    createClass.mutate();
  };

  return (
    <div className="space-y-6">
      <div className={`${card} flex flex-wrap items-center justify-between gap-4`}>
        <div>
          <div className="flex items-center gap-2">
            <BookOpen size={20} className="text-blue-600" />
            <h1 className="text-lg font-bold text-slate-900">我的班级</h1>
          </div>
          <p className="mt-1 text-sm text-slate-500">
            创建班级并生成邀请码，管理班级学生花名册与组队广场。
          </p>
        </div>
        <button
          type="button"
          className={button}
          onClick={() => setCreatingOpen((prev) => !prev)}
        >
          <Plus size={16} />
          创建班级
        </button>
      </div>

      {newlyCreated && (
        <div
          role="status"
          data-testid="newly-created-class-banner"
          className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-5"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-emerald-950">
                {tr("班级「{0}」已创建并启用", { 0: newlyCreated.name })}
              </h2>
              <p className="text-xs text-emerald-800">
                请将下方邀请码或加入链接发送给学生，学生可在「通过邀请码加入课程」页面直接入班。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link href={`/teacher/courses/${newlyCreated.id}`} className={secondary}>
                进入班级首页
              </Link>
              <Link href={`/teacher/courses/${newlyCreated.id}/groups`} className={button}>
                进入学生组队广场
                <ArrowRight size={15} />
              </Link>
            </div>
          </div>
          <div className="mt-4 max-w-xl">
            <InviteCodeCard
              inviteCode={newlyCreated.invite_code}
              joinUrl={newlyCreated.join_url}
              canManage={newlyCreated.can_manage}
            />
          </div>
        </div>
      )}

      {creatingOpen && (
        <form onSubmit={handleSubmit} className={`${card} space-y-4`}>
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <h2 className="text-base font-semibold text-slate-900">新建班级</h2>
            <button
              type="button"
              className="text-xs text-slate-500 hover:text-slate-700"
              onClick={() => setCreatingOpen(false)}
            >
              收起
            </button>
          </div>

          {formError && (
            <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-700">
              {formError}
            </div>
          )}
          {createClass.error && (
            <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-700">
              {errorText(createClass.error)}
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <div>
              <label className={label} htmlFor="create-class-name">
                班级名称
              </label>
              <input
                id="create-class-name"
                className={input}
                required
                maxLength={200}
                placeholder="例如：软件工程实践（周一班）"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div>
              <label className={label} htmlFor="create-class-term">
                学期
              </label>
              <input
                id="create-class-term"
                className={input}
                required
                maxLength={64}
                placeholder="例如：2026春"
                value={semester}
                onChange={(event) => setSemester(event.target.value)}
              />
            </div>
            <div>
              <label className={label} htmlFor="create-class-college">
                学院
              </label>
              <input
                id="create-class-college"
                className={input}
                required
                maxLength={160}
                value={college}
                onChange={(event) => setCollege(event.target.value)}
              />
            </div>
            <div>
              <label className={label} htmlFor="create-class-code">
                课程代码（选填）
              </label>
              <input
                id="create-class-code"
                className={input}
                maxLength={64}
                placeholder="例如：SE-2026-01"
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
            <div>
              <label className={label} htmlFor="create-class-min-size">
                最小组队人数
              </label>
              <input
                id="create-class-min-size"
                type="number"
                min={1}
                max={50}
                className={input}
                value={minGroupSize}
                onChange={(event) => setMinGroupSize(Number(event.target.value) || 1)}
              />
            </div>
            <div>
              <label className={label} htmlFor="create-class-max-size">
                最大组队人数
              </label>
              <input
                id="create-class-max-size"
                type="number"
                min={1}
                max={50}
                className={input}
                value={maxGroupSize}
                onChange={(event) => setMaxGroupSize(Number(event.target.value) || 1)}
              />
            </div>
            <div>
              <label className={label} htmlFor="create-class-project-deadline">
                课程结项截止时间
              </label>
              <input
                id="create-class-project-deadline"
                type="datetime-local"
                required
                className={input}
                value={projectDeadline}
                onChange={(event) => setProjectDeadline(event.target.value)}
              />
            </div>
            <div>
              <label className={label} htmlFor="create-class-deadline">
                组队截止时间（选填）
              </label>
              <input
                id="create-class-deadline"
                type="datetime-local"
                className={input}
                value={formationDeadline}
                onChange={(event) => setFormationDeadline(event.target.value)}
              />
            </div>
            <div>
              <label className={label} htmlFor="create-class-join-mode">
                入班方式
              </label>
              <select
                id="create-class-join-mode"
                className={input}
                value={joinMode}
                onChange={(event) => setJoinMode(event.target.value as JoinMode)}
              >
                <option value="direct">直接加入</option>
                <option value="approval">教师审批</option>
              </select>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              className={secondary}
              onClick={() => setCreatingOpen(false)}
            >
              取消
            </button>
            <button type="submit" className={button} disabled={createClass.isPending}>
              {createClass.isPending ? "正在创建…" : "确认创建并生成邀请码"}
            </button>
          </div>
        </form>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg border border-slate-200 bg-white p-1 text-xs font-semibold">
          <button
            type="button"
            onClick={() => setStatusTab("active")}
            className={`rounded-md px-3 py-1.5 transition ${
              statusTab === "active"
                ? "bg-blue-600 text-white"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            进行中
          </button>
          <button
            type="button"
            onClick={() => setStatusTab("ended")}
            className={`rounded-md px-3 py-1.5 transition ${
              statusTab === "ended"
                ? "bg-blue-600 text-white"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            已结课
          </button>
          <button
            type="button"
            onClick={() => setStatusTab("all")}
            className={`rounded-md px-3 py-1.5 transition ${
              statusTab === "all"
                ? "bg-blue-600 text-white"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            全部
          </button>
        </div>

        <div className="relative w-full max-w-xs">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <input
            type="search"
            aria-label="搜索班级名称或代码"
            className={`${input} mt-0 pl-8`}
            placeholder="搜索班级名称或代码"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </div>

      {classesQuery.isLoading && (
        <div role="status" className="gp-empty">
          正在加载…
        </div>
      )}

      {classesQuery.error && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-700">
          <p>{errorText(classesQuery.error)}</p>
          <button
            type="button"
            className={`${secondary} mt-3`}
            onClick={() => void classesQuery.refetch()}
          >
            重试
          </button>
        </div>
      )}

      {!classesQuery.isLoading && !classesQuery.error && (
        <>
          {(classesQuery.data?.items.length ?? 0) === 0 ? (
            <div className={`${card} py-12 text-center`}>
              <p className="text-sm font-medium text-slate-700">当前暂无匹配的班级</p>
              <p className="mt-1 text-xs text-slate-500">
                点击右上角「创建班级」即可生成班级邀请码并邀请学生加入。
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              {classesQuery.data?.items.map((item) => {
                const groupedCount = Math.max(0, item.student_count - item.ungrouped_count);
                return (
                  <div
                    key={item.id}
                    data-testid={`teacher-class-card-${item.id}`}
                    className={`${card} flex flex-col justify-between gap-4`}
                  >
                    <div className="space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <Link
                            href={`/teacher/courses/${item.id}`}
                            className="text-base font-bold text-slate-900 hover:text-blue-600"
                          >
                            {item.name}
                          </Link>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                            <span>{item.semester}</span>
                            <span>{item.college}</span>
                            {item.code && <span className="font-mono">{item.code}</span>}
                          </div>
                        </div>
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                            item.status === "active"
                              ? "bg-emerald-50 text-emerald-700"
                              : "bg-slate-100 text-slate-600"
                          }`}
                        >
                          {statusLabels[item.status] ?? item.status}
                        </span>
                      </div>

                      <div className="grid grid-cols-4 gap-2 rounded-lg bg-slate-50 p-3 text-center">
                        <div>
                          <div className="text-xs text-slate-500">学生总数</div>
                          <div className="mt-0.5 text-sm font-bold text-slate-900">
                            {item.student_count}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-slate-500">已组队</div>
                          <div className="mt-0.5 text-sm font-bold text-emerald-700">
                            {groupedCount}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-slate-500">未组队</div>
                          <div className="mt-0.5 text-sm font-bold text-blue-700">
                            {item.ungrouped_count}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-slate-500">队伍数</div>
                          <div className="mt-0.5 text-sm font-bold text-slate-900">
                            {item.group_count}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
                      <Link href={`/teacher/courses/${item.id}`} className={secondary}>
                        班级首页
                      </Link>
                      <Link href={`/teacher/courses/${item.id}/groups`} className={button}>
                        <Users size={15} />
                        学生组队广场
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
