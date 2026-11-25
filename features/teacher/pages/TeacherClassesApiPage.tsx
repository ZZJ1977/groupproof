"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, BookOpen, ChevronDown, Plus, Search, Users } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { errorText } from "@/features/b/ui";
import { cn } from "@/lib/utils";
import { InviteCodeCard } from "@/features/teacher/components/InviteCodeCard";
import { TeacherFeedbackPill } from "@/features/teacher/components/TeacherFeedbackPill";
import { TeacherSegmentedTabs } from "@/features/teacher/components/TeacherSegmentedTabs";
import {
  type JoinMode,
  type TeacherClassDetail,
  teacherClassesApi,
  teacherKeys,
} from "@/features/teacher/api/teacher-client";
import { tr } from "@/lib/i18n/tr";
import { useWorkspace } from "@/lib/workspace";

const statusLabels: Record<string, string> = {
  active: "进行中",
  ended: "已结课",
  draft: "草稿",
  pending_approval: "待审批",
  archived: "已归档",
};

const feishuCard =
  "rounded-[12px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-5 shadow-[var(--gp-shadow-card)]";
const feishuInput =
  "w-full rounded-[8px] border border-[var(--gp-border,#dee0e3)] bg-white px-3 py-2 text-sm text-[var(--gp-ink,#1f2329)] outline-none transition-colors focus:border-[var(--gp-action,#3370ff)] focus:ring-2 focus:ring-[#3370ff]/15";
const feishuLabel = "mb-1.5 block text-xs font-semibold text-[var(--gp-ink-soft,#4e5969)]";

export function TeacherClassesApiPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { userId } = useWorkspace();
  const [statusTab, setStatusTab] = useState<"active" | "ended" | "all">("active");
  const [search, setSearch] = useState("");
  const [creatingOpen, setCreatingOpen] = useState(false);
  const [newlyCreated, setNewlyCreated] = useState<TeacherClassDetail | null>(null);

  const [name, setName] = useState("");
  const [semester, setSemester] = useState(() => tr("2026春"));
  const [college, setCollege] = useState(() => tr("计算机科学与工程学院"));
  const [code, setCode] = useState("");
  const [minGroupSize, setMinGroupSize] = useState("2");
  const [maxGroupSize, setMaxGroupSize] = useState("5");
  const [projectDeadline, setProjectDeadline] = useState("2026-12-31T23:59");
  const [formationDeadline, setFormationDeadline] = useState("");
  const [joinMode, setJoinMode] = useState<JoinMode>("direct");
  const [formError, setFormError] = useState<string | null>(null);

  const classesQuery = useQuery({
    queryKey: teacherKeys.classes(userId, statusTab, search.trim()),
    queryFn: () => teacherClassesApi.list(statusTab, search.trim()),
  });

  const allClassesQuery = useQuery({
    queryKey: teacherKeys.classes(userId, "all", ""),
    queryFn: () => teacherClassesApi.list("all", ""),
    staleTime: 60_000,
    retry: false,
  });

  const allClasses = allClassesQuery.data?.items ?? [];
  const activeClasses = allClasses.filter((item) => item.status === "active");
  const endedClasses = allClasses.filter((item) => item.status === "ended");
  const otherClasses = allClasses.filter(
    (item) => item.status !== "active" && item.status !== "ended",
  );

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
        min_group_size: Number(minGroupSize),
        max_group_size: Number(maxGroupSize),
        join_mode: joinMode,
      });
    },
    onSuccess: async (created) => {
      setNewlyCreated(created);
      setCreatingOpen(false);
      setName("");
      setSemester(tr("2026春"));
      setCollege(tr("计算机科学与工程学院"));
      setCode("");
      setMinGroupSize("2");
      setMaxGroupSize("5");
      setFormationDeadline("");
      setFormError(null);
      await qc.invalidateQueries({ queryKey: ["b-teacher-classes", userId] });
    },
  });

  const openCreateDrawer = () => {
    setFormError(null);
    createClass.reset();
    if (semester === "2026春") setSemester(tr("2026春"));
    if (college === "计算机科学与工程学院") setCollege(tr("计算机科学与工程学院"));
    setCreatingOpen(true);
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setFormError(tr("请填写班级名称"));
      return;
    }
    if (!semester.trim()) {
      setFormError(tr("请填写学期"));
      return;
    }
    const minSize = Number(minGroupSize);
    const maxSize = Number(maxGroupSize);
    if (!minGroupSize.trim() || !Number.isInteger(minSize) || minSize < 1 || minSize > 50) {
      setFormError(tr("最小组队人数需为 1–50 之间的整数"));
      return;
    }
    if (!maxGroupSize.trim() || !Number.isInteger(maxSize) || maxSize < 1 || maxSize > 50) {
      setFormError(tr("最大组队人数需为 1–50 之间的整数"));
      return;
    }
    if (minSize > maxSize) {
      setFormError(tr("最小组队人数不能大于最大组队人数"));
      return;
    }
    setFormError(null);
    createClass.mutate();
  };

  return (
    <div className="min-w-0 max-w-full space-y-6">
      <div className={cn(feishuCard, "flex flex-wrap items-center justify-between gap-4")}>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <BookOpen size={20} className="shrink-0 text-[var(--gp-action,#3370ff)]" />
            <h1 className="text-lg font-bold text-[var(--gp-ink,#1f2329)]">我的班级</h1>
          </div>
          <p className="mt-1 text-sm text-[var(--gp-muted,#646a73)]">
            创建班级并生成邀请码，管理班级学生花名册与组队广场。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild id="teacher-classes-course-switcher">
              <Button type="button" variant="outline" size="sm" pill>
                <BookOpen size={15} aria-hidden="true" />
                <span>{tr("选择班级")}</span>
                <ChevronDown size={13} aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="gp-teacher-portal max-h-80 w-64 overflow-y-auto">
              {allClassesQuery.isLoading ? (
                <div className="px-3 py-2 text-[12px] text-[var(--gp-muted,#646a73)]">
                  {tr("正在加载…")}
                </div>
              ) : allClasses.length === 0 ? (
                <div className="px-3 py-2 text-[12px] text-[var(--gp-muted,#646a73)]">
                  {tr("暂无进行中班级")}
                </div>
              ) : (
                <>
                  {activeClasses.length === 0 && (
                    <>
                      <div className="px-3 py-1.5 text-[12px] text-[var(--gp-muted,#646a73)]">
                        {tr("暂无进行中班级")}
                      </div>
                      <div className="my-1 border-t border-[var(--gp-border-subtle,#ebedf0)]" />
                    </>
                  )}
                  {[
                    { key: "active", title: endedClasses.length > 0 || otherClasses.length > 0 ? tr("进行中") : null, items: activeClasses },
                    { key: "ended", title: tr("已结课"), items: endedClasses },
                    { key: "other", title: null, items: otherClasses },
                  ]
                    .filter((group) => group.items.length > 0)
                    .map((group, groupIndex) => (
                      <div key={group.key}>
                        {groupIndex > 0 && (
                          <div className="my-1 border-t border-[var(--gp-border-subtle,#ebedf0)]" />
                        )}
                        {group.title && (
                          <div className="px-3 py-1 text-[11px] font-medium text-[var(--gp-muted,#646a73)]">
                            {group.title}
                          </div>
                        )}
                        {group.items.map((course) => (
                          <DropdownMenuItem
                            key={course.id}
                            onSelect={() => router.push(`/teacher/courses/${course.id}`)}
                          >
                            <span className="truncate font-medium">{course.name}</span>
                            {(course.semester || statusLabels[course.status]) && (
                              <span className="ml-auto shrink-0 text-[11px] text-[var(--gp-muted,#646a73)]">
                                {course.semester || (statusLabels[course.status] ? tr(statusLabels[course.status]) : course.status)}
                              </span>
                            )}
                          </DropdownMenuItem>
                        ))}
                      </div>
                    ))}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button type="button" variant="default" size="sm" pill onClick={openCreateDrawer}>
            <Plus size={15} />
            创建班级
          </Button>
        </div>
      </div>

      {newlyCreated && (
        <div
          role="status"
          data-testid="newly-created-class-banner"
          className="rounded-[12px] border border-[#a7f3d0] bg-[#ecfdf5] p-5 shadow-[var(--gp-shadow-card)]"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1 space-y-1">
              <h2 className="text-base font-semibold text-[#064e3b]">
                {tr("班级「{0}」已创建并启用", { 0: newlyCreated.name })}
              </h2>
              <p className="text-xs text-[#047857]">
                请将下方邀请码或加入链接发送给学生，学生可在「通过邀请码加入课程」页面直接入班。
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={`/teacher/courses/${newlyCreated.id}`}
                data-variant="outline"
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                进入班级首页
              </Link>
              <Link
                href={`/teacher/courses/${newlyCreated.id}/groups`}
                data-variant="default"
                className={buttonVariants({ variant: "default", size: "sm", pill: true })}
              >
                进入学生组队广场
                <ArrowRight size={15} />
              </Link>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setNewlyCreated(null)}
              >
                {tr("关闭")}
              </Button>
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

      <Sheet
        open={creatingOpen}
        onOpenChange={(open) => {
          if (createClass.isPending) return;
          setCreatingOpen(open);
          if (!open) setFormError(null);
        }}
      >
        <SheetContent
          side="right"
          className="flex flex-col justify-between sm:max-w-[520px]"
          onEscapeKeyDown={(event) => {
            if (createClass.isPending) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (createClass.isPending) event.preventDefault();
          }}
        >
          <form onSubmit={handleSubmit} className="flex h-full flex-col justify-between gap-5">
            <div className="space-y-4">
              <SheetHeader className="pr-8">
                <SheetTitle className="text-base font-semibold text-[var(--gp-ink,#1f2329)]">
                  新建班级
                </SheetTitle>
                <SheetDescription className="text-xs text-[var(--gp-muted,#646a73)]">
                  创建班级并生成邀请码，管理班级学生花名册与组队广场。
                </SheetDescription>
              </SheetHeader>

              {formError && (
                <div
                  role="alert"
                  className="rounded-[8px] border border-[#fecaca] bg-[#fef2f2] p-3 text-xs text-[#d93025]"
                >
                  {formError}
                </div>
              )}
              {createClass.error && (
                <div
                  role="alert"
                  className="rounded-[8px] border border-[#fecaca] bg-[#fef2f2] p-3 text-xs text-[#d93025]"
                >
                  {errorText(createClass.error)}
                </div>
              )}

              <div className="space-y-3.5">
                <div>
                  <label className={feishuLabel} htmlFor="create-class-name">
                    班级名称
                  </label>
                  <input
                    id="create-class-name"
                    className={feishuInput}
                    required
                    maxLength={200}
                    placeholder="例如：软件工程实践（周一班）"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className={feishuLabel} htmlFor="create-class-term">
                      学期
                    </label>
                    <input
                      id="create-class-term"
                      className={feishuInput}
                      required
                      maxLength={64}
                      placeholder="例如：2026春"
                      value={semester}
                      onChange={(event) => setSemester(event.target.value)}
                    />
                  </div>
                  <div>
                    <label className={feishuLabel} htmlFor="create-class-code">
                      课程代码（选填）
                    </label>
                    <input
                      id="create-class-code"
                      className={feishuInput}
                      maxLength={64}
                      placeholder="例如：SE-2026-01"
                      value={code}
                      onChange={(event) => setCode(event.target.value)}
                    />
                  </div>
                </div>

                <div>
                  <label className={feishuLabel} htmlFor="create-class-college">
                    学院
                  </label>
                  <input
                    id="create-class-college"
                    className={feishuInput}
                    required
                    maxLength={160}
                    value={college}
                    onChange={(event) => setCollege(event.target.value)}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={feishuLabel} htmlFor="create-class-min-size">
                      最小组队人数
                    </label>
                    <input
                      id="create-class-min-size"
                      type="number"
                      min={1}
                      max={50}
                      className={cn(feishuInput, "gp-tabular")}
                      value={minGroupSize}
                      onChange={(event) => setMinGroupSize(event.target.value)}
                    />
                  </div>
                  <div>
                    <label className={feishuLabel} htmlFor="create-class-max-size">
                      最大组队人数
                    </label>
                    <input
                      id="create-class-max-size"
                      type="number"
                      min={1}
                      max={50}
                      className={cn(feishuInput, "gp-tabular")}
                      value={maxGroupSize}
                      onChange={(event) => setMaxGroupSize(event.target.value)}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className={feishuLabel} htmlFor="create-class-project-deadline">
                      课程结项截止时间
                    </label>
                    <input
                      id="create-class-project-deadline"
                      type="datetime-local"
                      required
                      className={cn(feishuInput, "gp-tabular")}
                      value={projectDeadline}
                      onChange={(event) => setProjectDeadline(event.target.value)}
                    />
                  </div>
                  <div>
                    <label className={feishuLabel} htmlFor="create-class-deadline">
                      组队截止时间（选填）
                    </label>
                    <input
                      id="create-class-deadline"
                      type="datetime-local"
                      className={cn(feishuInput, "gp-tabular")}
                      value={formationDeadline}
                      onChange={(event) => setFormationDeadline(event.target.value)}
                    />
                  </div>
                </div>

                <div>
                  <label className={feishuLabel} htmlFor="create-class-join-mode">
                    入班方式
                  </label>
                  <select
                    id="create-class-join-mode"
                    className={feishuInput}
                    value={joinMode}
                    onChange={(event) => setJoinMode(event.target.value as JoinMode)}
                  >
                    <option value="direct">直接加入</option>
                    <option value="approval">教师审批</option>
                  </select>
                </div>
              </div>
            </div>

            <SheetFooter className="border-t border-[var(--gp-border-subtle,#ebedf0)] pt-4">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={createClass.isPending}
                onClick={() => setCreatingOpen(false)}
              >
                取消
              </Button>
              <Button
                type="submit"
                variant="default"
                size="sm"
                pill
                loading={createClass.isPending}
                preserveWidth
              >
                {createClass.isPending ? tr("正在创建…") : tr("确认创建并生成邀请码")}
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <TeacherSegmentedTabs
          variant="segmented"
          size="sm"
          ariaLabel={tr("状态筛选")}
          activeId={statusTab}
          onChange={setStatusTab}
          items={[
            { id: "active", label: tr("进行中") },
            { id: "ended", label: tr("已结课") },
            { id: "all", label: tr("全部") },
          ]}
        />

        <div className="relative w-full max-w-xs">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--gp-subtle,#8f959e)]"
          />
          <input
            type="search"
            aria-label="搜索班级名称或代码"
            className={cn(feishuInput, "pl-8")}
            placeholder="搜索班级名称或代码"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </div>

      {classesQuery.isLoading && (
        <div role="status" className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <span className="sr-only">{tr("正在加载…")}</span>
          {[0, 1].map((idx) => (
            <div key={idx} className={cn(feishuCard, "animate-pulse space-y-4")}>
              <div className="h-5 w-48 rounded bg-[var(--gp-surface-hover,#eff0f1)]" />
              <div className="h-16 rounded-[8px] bg-[var(--gp-surface-subtle,#f8f9fa)]" />
              <div className="h-8 w-full rounded bg-[var(--gp-surface-subtle,#f8f9fa)]" />
            </div>
          ))}
        </div>
      )}

      {classesQuery.error && (
        <div
          role="alert"
          className={cn(feishuCard, "flex flex-wrap items-center justify-between gap-3")}
        >
          <TeacherFeedbackPill tone="error" message={errorText(classesQuery.error)} />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void classesQuery.refetch()}
          >
            重试
          </Button>
        </div>
      )}

      {!classesQuery.isLoading && !classesQuery.error && (
        <>
          {(classesQuery.data?.items.length ?? 0) === 0 ? (
            <div className={cn(feishuCard, "py-12 text-center")}>
              <p className="text-sm font-medium text-[var(--gp-ink-soft,#4e5969)]">
                当前暂无匹配的班级
              </p>
              <p className="mt-1 text-xs text-[var(--gp-muted,#646a73)]">
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
                    className={cn(feishuCard, "min-w-0 flex flex-col justify-between gap-4")}
                  >
                    <div className="min-w-0 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <Link
                            href={`/teacher/courses/${item.id}`}
                            title={item.name}
                            className="block truncate text-base font-bold text-[var(--gp-ink,#1f2329)] hover:text-[var(--gp-action,#3370ff)]"
                          >
                            {item.name}
                          </Link>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--gp-muted,#646a73)]">
                            <span>{item.semester}</span>
                            <span className="truncate">{item.college}</span>
                            {item.code && <span className="font-mono">{item.code}</span>}
                          </div>
                        </div>
                        <span
                          className={cn(
                            "shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium",
                            item.status === "active"
                              ? "bg-[#ecfdf5] text-[#008a5c]"
                              : "bg-[var(--gp-surface-hover,#eff0f1)] text-[var(--gp-ink-soft,#4e5969)]",
                          )}
                        >
                          {statusLabels[item.status] ? tr(statusLabels[item.status]) : item.status}
                        </span>
                      </div>

                      <div className="gp-tabular grid grid-cols-4 gap-2 rounded-[8px] bg-[var(--gp-surface-subtle,#f8f9fa)] p-3 text-center">
                        <div>
                          <div className="text-xs text-[var(--gp-muted,#646a73)]">学生总数</div>
                          <div className="mt-0.5 text-sm font-bold text-[var(--gp-ink,#1f2329)]">
                            {item.student_count}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-[var(--gp-muted,#646a73)]">已组队</div>
                          <div className="mt-0.5 text-sm font-bold text-[#008a5c]">
                            {groupedCount}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-[var(--gp-muted,#646a73)]">未组队</div>
                          <div className="mt-0.5 text-sm font-bold text-[var(--gp-action,#3370ff)]">
                            {item.ungrouped_count}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-[var(--gp-muted,#646a73)]">队伍数</div>
                          <div className="mt-0.5 text-sm font-bold text-[var(--gp-ink,#1f2329)]">
                            {item.group_count}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--gp-border-subtle,#ebedf0)] pt-3">
                      <Link
                        href={`/teacher/courses/${item.id}`}
                        data-variant="outline"
                        className={buttonVariants({ variant: "outline", size: "sm" })}
                      >
                        班级首页
                      </Link>
                      <Link
                        href={`/teacher/courses/${item.id}/groups`}
                        data-variant="tonal"
                        className={buttonVariants({ variant: "tonal", size: "sm", pill: true })}
                      >
                        <Users size={14} />
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
