"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, FileText, Folder, Search } from "lucide-react";
import { EmptyState, Feedback, PageHeader, Panel } from "@/components/common";
import { dateOnly, input, queryPolicy, secondary } from "@/features/b/ui";
import { useBErrorMessage } from "@/features/b/use-b-error";
import { teacherFilesApi, teacherFilesKeys } from "@/lib/api/teacher-files-client";
import { useUiText } from "@/lib/i18n/use-ui-text";
import { useWorkspace } from "@/lib/workspace";

function Loading({ text }: { text?: string }) {
  const tr = useUiText();
  return (
    <div role="status" className="gp-empty">
      {text ?? tr("正在加载…")}
    </div>
  );
}

function LoadError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const tr = useUiText();
  const errorText = useBErrorMessage();
  return (
    <div role="alert">
      <Feedback tone="error">{errorText(error)}</Feedback>
      {onRetry && (
        <button type="button" className={`${secondary} mt-3`} onClick={onRetry}>
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
    <div className="space-y-4">
      <PageHeader
        title={tr("课程文件")}
        description={
          data.is_grouped
            ? tr("当前已加入课程小组，可查看全班公开资料与仅分组可见资料。")
            : tr("当前尚未加入课程小组，仅显示全班公开资料；加入小组后可查看分组资料。")
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href={`/courses/${encodeURIComponent(courseId)}/rules`} className={secondary}>
              {tr("查看课程规则")}
            </Link>
            <Link href={`/courses/${encodeURIComponent(courseId)}/groups`} className={secondary}>
              {tr("小组广场")}
            </Link>
            <Link href="/courses" className={secondary}>
              {tr("我的课程")}
            </Link>
          </div>
        }
      />

      <Panel title={tr("资料筛选")}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setFolderFilter("all")}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                folderFilter === "all"
                  ? "bg-blue-600 text-white"
                  : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              {tr("全部资料")}
            </button>
            {folders.length > 0 && (
              <button
                type="button"
                onClick={() => setFolderFilter("root")}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  folderFilter === "root"
                    ? "bg-blue-600 text-white"
                    : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
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
                className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  folderFilter === folder.id
                    ? "bg-blue-600 text-white"
                    : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                <Folder size={13} />
                {folder.name}
              </button>
            ))}
          </div>
          <div className="relative w-full sm:w-64">
            <Search size={14} className="pointer-events-none absolute left-3 top-2.5 text-slate-400" />
            <input
              type="search"
              aria-label={tr("搜索课程资料")}
              placeholder={tr("搜索课程资料")}
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              className={`${input} pl-8`}
            />
          </div>
        </div>
      </Panel>

      <Panel title={tr("已发布课程资料（{0}）", { 0: visibleItems.length })}>
        {visibleItems.length === 0 ? (
          <EmptyState
            title={tr("暂无可见课程资料")}
            description={tr("教师发布课程大纲、模板或参考文档后，将在此处展示并支持直接下载。")}
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {visibleItems.map((item) => {
              const folderLabel = item.folder_id ? folderNameById.get(item.folder_id) : null;
              return (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <FileText size={15} className="shrink-0 text-blue-600" />
                      <strong className="truncate font-semibold text-slate-900">{item.name}</strong>
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                        v{item.latest_version_no}
                      </span>
                      {folderLabel && (
                        <span className="inline-flex items-center gap-1 rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-700">
                          <Folder size={11} />
                          {folderLabel}
                        </span>
                      )}
                      {item.visibility === "grouped" && (
                        <span className="rounded bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">
                          {tr("仅已分组学生")}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500">
                      {formatBytes(item.size_bytes, tr)} ·{" "}
                      {item.uploader_name ?? tr("课程教师")} ·{" "}
                      {dateOnly(item.updated_at, tr("未设置"))}
                    </p>
                  </div>
                  <a
                    href={item.download_href}
                    className={`${secondary} inline-flex items-center gap-1.5 text-xs`}
                  >
                    <Download size={13} />
                    {tr("下载")}
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
