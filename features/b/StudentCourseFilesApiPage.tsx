"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, FileText, Folder, Search } from "lucide-react";
import { EmptyState, Feedback, PageHeader } from "@/components/common";
import { dateOnly, queryPolicy, secondary } from "@/features/b/ui";
import { useBErrorMessage } from "@/features/b/use-b-error";
import { teacherFilesApi, teacherFilesKeys } from "@/lib/api/teacher-files-client";
import { useUiText } from "@/lib/i18n/use-ui-text";
import { useWorkspace } from "@/lib/workspace";

function Loading({ text }: { text?: string }) {
  const tr = useUiText();
  return (
    <div role="status" className="gp-empty !py-8">
      {text ?? tr("正在加载…")}
    </div>
  );
}

function LoadError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const tr = useUiText();
  const errorText = useBErrorMessage();
  return (
    <div role="alert" className="rounded-2xl border border-rose-200/85 bg-white p-4 shadow-xs">
      <Feedback tone="error">{errorText(error)}</Feedback>
      {onRetry && (
        <button type="button" className={`${secondary} mt-3 !min-h-8 !text-xs`} onClick={onRetry}>
          {tr("重试")}
        </button>
      )}
    </div>
  );
}

function formatBytes(bytes: number, tr: ReturnType<typeof useUiText>): string {
  if (bytes < 1024) return tr("{0} B", { 0: bytes });
  if (bytes < 1024 * 1024) return tr("{0} KB", { 0: Math.round(bytes / 102.4) / 10 });
  return tr("{0} MB", { 0: Math.round((bytes / (1024 * 1024)) * 10) / 10 });
}

export function StudentCourseFilesApiPage({ courseId }: { courseId: string }) {
  const tr = useUiText();
  const { userId } = useWorkspace();
  const [folderFilter, setFolderFilter] = useState<string>("all");
  const [keyword, setKeyword] = useState("");

  const materials = useQuery({
    queryKey: teacherFilesKeys.student(userId, courseId),
    queryFn: () => teacherFilesApi.studentList(courseId),
    ...queryPolicy,
  });

  const folders = useMemo(() => materials.data?.folders ?? [], [materials.data?.folders]);
  const folderNameById = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder.name])),
    [folders],
  );

  const visibleItems = useMemo(() => {
    const allItems = materials.data?.items ?? [];
    const term = keyword.trim().toLowerCase();
    return allItems.filter((item) => {
      if (folderFilter === "root" && item.folder_id !== null) return false;
      if (folderFilter !== "all" && folderFilter !== "root" && item.folder_id !== folderFilter) {
        return false;
      }
      if (term && !item.name.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [materials.data?.items, folderFilter, keyword]);

  if (materials.isPending) return <Loading text={tr("正在读取课程资料…")} />;
  if (materials.isError) {
    return <LoadError error={materials.error} onRetry={() => void materials.refetch()} />;
  }

  const data = materials.data;

  return (
    <div className="space-y-3.5 [&_.gp-page-header]:!mb-0">
      <PageHeader
        title={tr("课程文件")}
        description={
          data.is_grouped
            ? tr("当前已加入课程小组，可查看全班公开资料与仅分组可见资料。")
            : tr("当前尚未加入课程小组，仅显示全班公开资料；加入小组后可查看分组资料。")
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href={`/courses/${encodeURIComponent(courseId)}/rules`} className={`${secondary} !min-h-9 !px-3 !text-xs`}>
              {tr("查看课程规则")}
            </Link>
            <Link href={`/courses/${encodeURIComponent(courseId)}/groups`} className={`${secondary} !min-h-9 !px-3 !text-xs`}>
              {tr("小组广场")}
            </Link>
            <Link href="/courses" className={`${secondary} !min-h-9 !px-3 !text-xs`}>
              {tr("我的课程")}
            </Link>
          </div>
        }
      />

      {/* 单行紧凑文件夹筛选 + 搜索栏 */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-2xl border border-slate-200/85 bg-white px-3.5 py-2.5 shadow-xs">
        <div className="flex flex-wrap items-center gap-1.5" aria-label={tr("资料筛选")}>
          <button
            type="button"
            onClick={() => setFolderFilter("all")}
            className={`inline-flex h-8 items-center rounded-lg px-2.5 text-xs font-medium transition ${
              folderFilter === "all"
                ? "bg-[var(--gp-action)] text-white shadow-2xs"
                : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            {tr("全部资料")}
          </button>
          {folders.length > 0 && (
            <button
              type="button"
              onClick={() => setFolderFilter("root")}
              className={`inline-flex h-8 items-center rounded-lg px-2.5 text-xs font-medium transition ${
                folderFilter === "root"
                  ? "bg-[var(--gp-action)] text-white shadow-2xs"
                  : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {tr("未归档")}
            </button>
          )}
          {folders.map((folder) => (
            <button
              key={folder.id}
              type="button"
              onClick={() => setFolderFilter(folder.id)}
              className={`inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-xs font-medium transition ${
                folderFilter === folder.id
                  ? "bg-[var(--gp-action)] text-white shadow-2xs"
                  : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              <Folder size={12} />
              {folder.name}
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-60">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            aria-label={tr("搜索课程资料")}
            placeholder={tr("搜索课程资料")}
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            className="h-9 w-full rounded-lg border border-slate-200/90 bg-slate-50/50 pl-8 pr-3 text-xs text-slate-900 placeholder:text-slate-400 outline-none transition focus:border-sky-500 focus:bg-white focus:ring-2 focus:ring-sky-500/15"
          />
        </div>
      </div>

      {/* 紧凑文件清单 */}
      <section className="overflow-hidden rounded-2xl border border-slate-200/85 bg-white shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/50 px-4 py-2.5">
          <h2 className="text-sm font-bold text-slate-900">
            {tr("已发布课程资料（{0}）", { 0: visibleItems.length })}
          </h2>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
            {data.is_grouped ? tr("全班 + 分组可见") : tr("仅全班公开")}
          </span>
        </div>

        {visibleItems.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title={tr("暂无可见课程资料")}
              description={tr("教师发布课程大纲、模板或参考文档后，将在此处展示并支持直接下载。")}
            />
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {visibleItems.map((item) => {
              const folderLabel = item.folder_id ? folderNameById.get(item.folder_id) : null;
              return (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 transition hover:bg-slate-50/70"
                >
                  <div className="flex min-w-0 flex-1 items-start gap-2.5">
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sky-50 text-sky-700">
                      <FileText size={15} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <strong className="truncate text-sm font-semibold text-slate-900">{item.name}</strong>
                        <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">
                          v{item.latest_version_no}
                        </span>
                        {folderLabel && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700">
                            <Folder size={10} />
                            {folderLabel}
                          </span>
                        )}
                        {item.visibility === "grouped" && (
                          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                            {tr("仅已分组学生")}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {formatBytes(item.size_bytes, tr)} · {item.uploader_name ?? tr("课程教师")} · {dateOnly(item.updated_at, tr("未设置"))}
                      </p>
                    </div>
                  </div>
                  <a
                    href={item.download_href}
                    className={`${secondary} !min-h-8 shrink-0 !px-2.5 !text-xs`}
                  >
                    <Download size={12} />
                    {tr("下载")}
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
