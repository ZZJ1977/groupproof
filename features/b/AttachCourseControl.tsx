"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, BookOpen, CheckCircle2, FolderInput } from "lucide-react";
import { Feedback } from "@/components/common";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useBErrorMessage } from "@/features/b/use-b-error";
import { button, queryPolicy, secondary } from "@/features/b/ui";
import { bCoursesApi } from "@/lib/api/b-courses";
import { bProjectsApi, type BAttachCourseResult } from "@/lib/api/b-projects";
import { useUiText } from "@/lib/i18n/use-ui-text";
import { useWorkspace } from "@/lib/workspace";

interface AttachCourseControlProps {
  projectId: string;
  projectName: string;
  variant?: "button" | "card" | "compact";
  onAttached?: (result: BAttachCourseResult) => void;
}

/** 「移入课程」控件：允许独立项目组长将已有项目关联到自己已加入的进行中课程。 */
export function AttachCourseControl({
  projectId,
  projectName,
  variant = "button",
  onAttached,
}: AttachCourseControlProps) {
  const tr = useUiText();
  const cache = useQueryClient();
  const errorText = useBErrorMessage();
  const { userId } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [selectedCourseId, setSelectedCourseId] = useState("");
  const [result, setResult] = useState<BAttachCourseResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const coursesQuery = useQuery({
    queryKey: ["b-my-courses", userId, "attach-course"],
    queryFn: () => bCoursesApi.myCourses({ tab: "active", q: "", page: 1, page_size: 50 }),
    enabled: open,
    ...queryPolicy,
  });

  const activeCourses = (coursesQuery.data?.items ?? []).filter((c) => c.status === "active");
  const effectiveCourseId =
    selectedCourseId && activeCourses.some((c) => c.id === selectedCourseId)
      ? selectedCourseId
      : (activeCourses[0]?.id ?? "");

  const attach = useMutation({
    mutationFn: () => bProjectsApi.attachCourse(projectId, { course_id: effectiveCourseId }),
    onSuccess: async (data) => {
      setErrorMsg(null);
      setResult(data);
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["b-project-overview"] }),
        cache.invalidateQueries({ queryKey: ["b-project-setup"] }),
        cache.invalidateQueries({ queryKey: ["b-my-courses"] }),
        cache.invalidateQueries({ queryKey: ["c-home-summary"] }),
        cache.invalidateQueries({ queryKey: ["c-project-context"] }),
        cache.invalidateQueries({ queryKey: ["d-project-settings"] }),
      ]);
      onAttached?.(data);
    },
    onError: (err) => {
      setErrorMsg(errorText(err));
    },
  });

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setErrorMsg(null);
      setResult(null);
    }
  };

  const trigger =
    variant === "card" ? (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-200/80 bg-sky-50/40 px-4 py-3">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
            <BookOpen size={15} className="shrink-0 text-[var(--gp-action)]" aria-hidden="true" />
            <span>{tr("将独立项目移入课程")}</span>
          </div>
          <p className="text-xs text-slate-600">
            {tr("已加入课程？可将当前独立项目直接关联到课程班级，保留现有任务、进度、证据与集成绑定，教师端将同步可见。")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => handleOpenChange(true)}
          className={`${button} shrink-0 !min-h-8 !px-3 !text-xs`}
        >
          <FolderInput size={14} aria-hidden="true" />
          {tr("移入课程")}
        </button>
      </div>
    ) : variant === "compact" ? (
      <button
        type="button"
        onClick={() => handleOpenChange(true)}
        className="inline-flex items-center gap-1 rounded-md border border-sky-200/90 bg-sky-50/70 px-2 py-0.5 text-[11px] font-medium text-sky-700 transition hover:border-sky-300 hover:bg-sky-100/70"
      >
        <FolderInput size={11} aria-hidden="true" />
        {tr("移入课程")}
      </button>
    ) : (
      <button
        type="button"
        onClick={() => handleOpenChange(true)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-sky-200/90 bg-sky-50/70 px-3 py-1.5 text-xs font-medium text-sky-700 transition-colors hover:border-sky-300 hover:bg-sky-100/70"
      >
        <FolderInput size={13} aria-hidden="true" />
        {tr("移入课程")}
      </button>
    );

  return (
    <>
      {trigger}
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FolderInput size={17} className="text-[var(--gp-action)]" aria-hidden="true" />
              <span>{tr("移入课程")}</span>
            </DialogTitle>
            <DialogDescription>
              {tr("将「{0}」关联到你已加入的进行中课程。项目内所有任务、需求、证据及 GitHub/飞书绑定将完整保留。", {
                0: projectName,
              })}
            </DialogDescription>
          </DialogHeader>

          {result ? (
            <div className="space-y-3 py-2">
              <Feedback tone="success">
                <span className="inline-flex items-center gap-1.5">
                  <CheckCircle2 size={15} aria-hidden="true" />
                  {tr("已移入课程并关联小组「{0}」", { 0: result.group_name })}
                  {result.members_synced > 0
                    ? tr("（已自动同步 {0} 位同课程队友）", { 0: result.members_synced })
                    : ""}
                </span>
              </Feedback>
              <DialogFooter>
                <button
                  type="button"
                  className={button}
                  onClick={() => handleOpenChange(false)}
                >
                  {tr("完成")}
                </button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-4">
              {errorMsg && <Feedback tone="error">{errorMsg}</Feedback>}

              {coursesQuery.isPending ? (
                <p role="status" className="py-4 text-center text-xs text-slate-500">
                  {tr("正在加载已加入的课程…")}
                </p>
              ) : coursesQuery.isError ? (
                <div className="space-y-2">
                  <Feedback tone="error">{errorText(coursesQuery.error)}</Feedback>
                  <button
                    type="button"
                    className={`${secondary} !min-h-8 !text-xs`}
                    onClick={() => void coursesQuery.refetch()}
                  >
                    {tr("重试")}
                  </button>
                </div>
              ) : activeCourses.length === 0 ? (
                <div className="space-y-3 rounded-lg border border-dashed border-slate-200 bg-slate-50/70 p-4 text-center">
                  <p className="text-xs text-slate-600">
                    {tr("你还没有加入任何进行中的课程。请先使用教师提供的邀请码加入课程，再将项目移入。")}
                  </p>
                  <Link
                    href="/courses/join"
                    onClick={() => handleOpenChange(false)}
                    className={`${button} !min-h-8 !text-xs`}
                  >
                    {tr("使用邀请码加入课程")}
                    <ArrowRight size={13} aria-hidden="true" />
                  </Link>
                </div>
              ) : (
                <div className="space-y-2">
                  <label
                    htmlFor={`attach-course-select-${projectId}`}
                    className="block text-xs font-medium text-slate-700"
                  >
                    {tr("选择目标课程")}
                  </label>
                  <select
                    id={`attach-course-select-${projectId}`}
                    value={effectiveCourseId}
                    disabled={attach.isPending}
                    onChange={(event) => {
                      setSelectedCourseId(event.target.value);
                      setErrorMsg(null);
                    }}
                    className="h-9 w-full rounded-lg border border-slate-200/90 bg-white px-3 text-xs text-slate-900 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/15"
                  >
                    {activeCourses.map((course) => (
                      <option key={course.id} value={course.id}>
                        {course.name}（{course.code} · {course.semester}）
                        {course.group ? ` — ${tr("当前小组：{0}", { 0: course.group.name })}` : ""}
                      </option>
                    ))}
                  </select>
                  <p className="text-[11px] text-slate-500">
                    {tr("若你在该课程已有未立项小组将自动复用；否则自动以当前项目名称创建小组并同步同课程队友。")}
                  </p>
                </div>
              )}

              <DialogFooter>
                <button
                  type="button"
                  className={secondary}
                  disabled={attach.isPending}
                  onClick={() => handleOpenChange(false)}
                >
                  {tr("取消")}
                </button>
                {activeCourses.length > 0 && (
                  <button
                    type="button"
                    className={button}
                    disabled={!effectiveCourseId || attach.isPending}
                    onClick={() => attach.mutate()}
                  >
                    {attach.isPending ? tr("正在移入…") : tr("移入所选课程")}
                  </button>
                )}
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
