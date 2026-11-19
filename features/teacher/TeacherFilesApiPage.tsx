"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Download,
  Edit3,
  FileText,
  Folder,
  FolderPlus,
  History,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import { button, card, errorText, input, label, secondary } from "@/features/b/ui";
import {
  type CourseFolder,
  type MaterialVisibility,
  fileToBase64,
  teacherFilesApi,
  teacherFilesKeys,
} from "@/lib/api/teacher-files-client";
import { useTeacherPermissions } from "@/lib/hooks/use-teacher-permissions";
import { tr } from "@/lib/i18n/tr";
import { useWorkspace } from "@/lib/workspace";

const dangerBtn =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50";

const visibilityLabel: Record<MaterialVisibility, string> = {
  all: "全部学生可见",
  grouped: "仅已分组学生",
  staff: "仅教职可见",
};

const visibilityTone: Record<MaterialVisibility, string> = {
  all: "bg-emerald-50 text-emerald-700",
  grouped: "bg-blue-50 text-blue-700",
  staff: "bg-amber-50 text-amber-800",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return tr("{0} B", { 0: bytes });
  if (bytes < 1024 * 1024) return tr("{0} KB", { 0: Math.round(bytes / 102.4) / 10 });
  return tr("{0} MB", { 0: Math.round((bytes / (1024 * 1024)) * 10) / 10 });
}

export function TeacherFilesApiPage({ courseId }: { courseId: string }) {
  const qc = useQueryClient();
  const { userId } = useWorkspace();
  const perms = useTeacherPermissions(courseId);

  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [visFilter, setVisFilter] = useState<"all_filter" | MaterialVisibility>("all_filter");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [activeMaterialId, setActiveMaterialId] = useState<string | null>(null);

  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [renamingFolder, setRenamingFolder] = useState<CourseFolder | null>(null);
  const [renameText, setRenameText] = useState("");

  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadVis, setUploadVis] = useState<MaterialVisibility>("all");
  const [uploadNote, setUploadNote] = useState("");

  const [newVersionFile, setNewVersionFile] = useState<File | null>(null);
  const [newVersionNote, setNewVersionNote] = useState("");
  const [batchTargetFolder, setBatchTargetFolder] = useState<string>("root");
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; text: string } | null>(
    null,
  );

  const filterKey = `${currentFolderId ?? "root"}:${search}:${visFilter}`;
  const treeQuery = useQuery({
    queryKey: teacherFilesKeys.tree(userId, courseId, filterKey),
    queryFn: () =>
      teacherFilesApi.list(courseId, {
        folder_id: currentFolderId,
        q: search.trim() || undefined,
        visibility: visFilter === "all_filter" ? undefined : visFilter,
      }),
    enabled: Boolean(courseId),
  });

  const detailQuery = useQuery({
    queryKey: teacherFilesKeys.versions(userId, courseId, activeMaterialId ?? ""),
    queryFn: () => teacherFilesApi.versions(courseId, activeMaterialId as string),
    enabled: Boolean(courseId && activeMaterialId),
  });

  const invalidate = async () => {
    setSelectedIds([]);
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["b-teacher-files", userId, courseId] }),
      activeMaterialId
        ? qc.invalidateQueries({
            queryKey: teacherFilesKeys.versions(userId, courseId, activeMaterialId),
          })
        : Promise.resolve(),
    ]);
  };

  const canManage = treeQuery.data?.can_manage ?? perms.manageFiles;

  const createFolderMut = useMutation({
    mutationFn: () =>
      teacherFilesApi.createFolder(courseId, {
        name: folderName.trim(),
        parent_id: currentFolderId,
      }),
    onSuccess: async () => {
      setFolderName("");
      setNewFolderOpen(false);
      setFeedback({ tone: "success", text: tr("文件夹已创建") });
      await invalidate();
    },
    onError: (err) => setFeedback({ tone: "error", text: errorText(err) }),
  });

  const renameFolderMut = useMutation({
    mutationFn: () =>
      teacherFilesApi.updateFolder(courseId, (renamingFolder as CourseFolder).id, {
        name: renameText.trim(),
      }),
    onSuccess: async () => {
      setRenamingFolder(null);
      setRenameText("");
      setFeedback({ tone: "success", text: tr("文件夹名称已更新") });
      await invalidate();
    },
    onError: (err) => setFeedback({ tone: "error", text: errorText(err) }),
  });

  const deleteFolderMut = useMutation({
    mutationFn: (folderId: string) => teacherFilesApi.deleteFolder(courseId, folderId),
    onSuccess: async (_res, folderId) => {
      if (currentFolderId === folderId) setCurrentFolderId(null);
      setFeedback({ tone: "success", text: tr("文件夹已删除，内部资料已上移") });
      await invalidate();
    },
    onError: (err) => setFeedback({ tone: "error", text: errorText(err) }),
  });

  const uploadMut = useMutation({
    mutationFn: async () => {
      const content_base64 = uploadFile ? await fileToBase64(uploadFile) : undefined;
      return teacherFilesApi.upload(courseId, {
        name: (uploadName.trim() || uploadFile?.name || "").trim(),
        folder_id: currentFolderId,
        visibility: uploadVis,
        status: "published",
        mime_type: uploadFile?.type || "application/octet-stream",
        size_bytes: uploadFile?.size ?? 0,
        content_base64,
        change_note: uploadNote.trim() || undefined,
      });
    },
    onSuccess: async (res) => {
      setUploadOpen(false);
      setUploadName("");
      setUploadFile(null);
      setUploadNote("");
      setActiveMaterialId(res.item.id);
      setFeedback({ tone: "success", text: tr("资料上传成功") });
      await invalidate();
    },
    onError: (err) => setFeedback({ tone: "error", text: errorText(err) }),
  });

  const newVersionMut = useMutation({
    mutationFn: async () => {
      const matId = activeMaterialId as string;
      const content_base64 = newVersionFile ? await fileToBase64(newVersionFile) : undefined;
      return teacherFilesApi.appendVersion(courseId, matId, {
        original_name: newVersionFile?.name || undefined,
        mime_type: newVersionFile?.type || undefined,
        size_bytes: newVersionFile?.size ?? 0,
        content_base64,
        change_note: newVersionNote.trim() || undefined,
      });
    },
    onSuccess: async () => {
      setNewVersionFile(null);
      setNewVersionNote("");
      setFeedback({ tone: "success", text: tr("已发布新版本") });
      await invalidate();
    },
    onError: (err) => setFeedback({ tone: "error", text: errorText(err) }),
  });

  const updateVisMut = useMutation({
    mutationFn: (vars: { materialId: string; visibility: MaterialVisibility }) =>
      teacherFilesApi.updateMaterial(courseId, vars.materialId, { visibility: vars.visibility }),
    onSuccess: async () => {
      setFeedback({ tone: "success", text: tr("可见范围已更新") });
      await invalidate();
    },
    onError: (err) => setFeedback({ tone: "error", text: errorText(err) }),
  });

  const deleteMaterialMut = useMutation({
    mutationFn: (materialId: string) => teacherFilesApi.deleteMaterial(courseId, materialId),
    onSuccess: async (_r, materialId) => {
      if (activeMaterialId === materialId) setActiveMaterialId(null);
      setFeedback({ tone: "success", text: tr("资料已删除") });
      await invalidate();
    },
    onError: (err) => setFeedback({ tone: "error", text: errorText(err) }),
  });

  const batchMut = useMutation({
    mutationFn: (payload: {
      action: "move" | "set_visibility" | "delete";
      folder_id?: string | null;
      visibility?: MaterialVisibility;
    }) =>
      teacherFilesApi.batch(courseId, {
        ids: selectedIds,
        action: payload.action,
        folder_id: payload.folder_id,
        visibility: payload.visibility,
      }),
    onSuccess: async (res) => {
      setFeedback({ tone: "success", text: tr("已批量处理 {0} 份资料", { 0: res.affected }) });
      await invalidate();
    },
    onError: (err) => setFeedback({ tone: "error", text: errorText(err) }),
  });

  const sortedFolders = useMemo(() => {
    const folders = treeQuery.data?.folders ?? [];
    const byParent = new Map<string | null, CourseFolder[]>();
    for (const f of folders) {
      const key = f.parent_id ?? null;
      byParent.set(key, [...(byParent.get(key) ?? []), f]);
    }
    const flat: { folder: CourseFolder; depth: number }[] = [];
    const walk = (parentId: string | null, depth: number) => {
      for (const f of byParent.get(parentId) ?? []) {
        flat.push({ folder: f, depth });
        walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    return flat;
  }, [treeQuery.data?.folders]);

  const items = treeQuery.data?.items ?? [];

  const toggleSelect = (materialId: string) => {
    setSelectedIds((prev) =>
      prev.includes(materialId) ? prev.filter((id) => id !== materialId) : [...prev, materialId],
    );
  };

  return (
    <div className="space-y-5">
      <div className={`${card} flex flex-wrap items-center justify-between gap-3`}>
        <div>
          <h1 className="text-lg font-semibold text-slate-900">{tr("课程资料中心")}</h1>
          <p className="mt-0.5 text-xs text-slate-500">
            {tr("按文件夹整理课程大纲与参考资料，控制学生可见范围并保留历史版本。")}
          </p>
        </div>
        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setNewFolderOpen((v) => !v)}
              className={`${secondary} inline-flex items-center gap-1.5`}
            >
              <FolderPlus size={15} />
              {tr("新建文件夹")}
            </button>
            <button
              type="button"
              onClick={() => setUploadOpen(true)}
              className={`${button} inline-flex items-center gap-1.5`}
            >
              <Upload size={15} />
              {tr("上传资料")}
            </button>
          </div>
        )}
      </div>

      {feedback && (
        <div
          role={feedback.tone === "error" ? "alert" : "status"}
          className={`rounded-xl border px-4 py-3 text-sm ${
            feedback.tone === "error"
              ? "border-red-200 bg-red-50 text-red-700"
              : "border-emerald-200 bg-emerald-50 text-emerald-700"
          }`}
        >
          {feedback.text}
        </div>
      )}

      {newFolderOpen && canManage && (
        <div className={`${card} flex flex-wrap items-end gap-3 bg-slate-50`}>
          <div className="min-w-[220px] flex-1">
            <label className={label} htmlFor="new-folder-name">
              {tr("新文件夹名称")}
            </label>
            <input
              id="new-folder-name"
              className={input}
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              placeholder={tr("例如：教学大纲、第 1 周课件")}
            />
          </div>
          <button
            type="button"
            disabled={!folderName.trim() || createFolderMut.isPending}
            onClick={() => createFolderMut.mutate()}
            className={button}
          >
            {createFolderMut.isPending ? tr("创建中…") : tr("确认创建")}
          </button>
          <button
            type="button"
            onClick={() => setNewFolderOpen(false)}
            className={secondary}
          >
            {tr("取消")}
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[260px_1fr]">
        <aside className={`${card} space-y-1.5`}>
          <div className="pb-1 text-xs font-semibold text-slate-500">{tr("目录结构")}</div>
          <button
            type="button"
            onClick={() => setCurrentFolderId(null)}
            className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs font-medium ${
              currentFolderId === null
                ? "bg-blue-50 text-blue-700"
                : "text-slate-700 hover:bg-slate-100"
            }`}
          >
            <span className="inline-flex items-center gap-1.5">
              <Folder size={14} />
              {tr("全部根目录资料")}
            </span>
          </button>

          {sortedFolders.map(({ folder, depth }) => (
            <div key={folder.id} className="group flex items-center gap-1">
              <button
                type="button"
                onClick={() => setCurrentFolderId(folder.id)}
                style={{ paddingLeft: `${10 + depth * 14}px` }}
                className={`flex min-w-0 flex-1 items-center justify-between rounded-lg py-1.5 pr-2 text-left text-xs font-medium ${
                  currentFolderId === folder.id
                    ? "bg-blue-50 text-blue-700"
                    : "text-slate-700 hover:bg-slate-100"
                }`}
              >
                <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
                  <Folder size={14} className="shrink-0" />
                  <span className="truncate">{folder.name}</span>
                </span>
                <span className="ml-1 shrink-0 text-[11px] text-slate-400">
                  {folder.item_count}
                </span>
              </button>
              {canManage && (
                <div className="flex shrink-0 items-center gap-0.5 opacity-80 group-hover:opacity-100">
                  <button
                    type="button"
                    aria-label={tr("重命名文件夹")}
                    onClick={() => {
                      setRenamingFolder(folder);
                      setRenameText(folder.name);
                    }}
                    className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                  >
                    <Edit3 size={12} />
                  </button>
                  <button
                    type="button"
                    aria-label={tr("删除文件夹")}
                    onClick={() => deleteFolderMut.mutate(folder.id)}
                    className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </aside>

        <div className="space-y-4">
          <div className={`${card} space-y-3`}>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
              <div className="flex flex-wrap items-center gap-1 text-xs text-slate-600">
                <button
                  type="button"
                  onClick={() => setCurrentFolderId(null)}
                  className="font-medium hover:text-blue-600"
                >
                  {tr("全部资料")}
                </button>
                {(treeQuery.data?.breadcrumbs ?? []).map((crumb) => (
                  <span key={crumb.id} className="inline-flex items-center gap-1">
                    <span>/</span>
                    <button
                      type="button"
                      onClick={() => setCurrentFolderId(crumb.id)}
                      className="font-medium hover:text-blue-600"
                    >
                      {crumb.name}
                    </button>
                  </span>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
                  <input
                    className={`${input} w-44 pl-8 text-xs`}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={tr("搜索资料名称")}
                  />
                </div>
                <select
                  aria-label={tr("按可见范围筛选")}
                  className={`${input} w-36 text-xs`}
                  value={visFilter}
                  onChange={(e) =>
                    setVisFilter(e.target.value as "all_filter" | MaterialVisibility)
                  }
                >
                  <option value="all_filter">{tr("全部可见范围")}</option>
                  <option value="all">{tr("全部学生可见")}</option>
                  <option value="grouped">{tr("仅已分组学生")}</option>
                  <option value="staff">{tr("仅教职可见")}</option>
                </select>
              </div>
            </div>

            {canManage && selectedIds.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-blue-50 px-3 py-2 text-xs">
                <span className="font-medium text-blue-800">
                  {tr("已选中 {0} 份资料", { 0: selectedIds.length })}
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    aria-label={tr("批量移动目标")}
                    className="rounded border border-blue-200 bg-white px-2 py-1 text-xs"
                    value={batchTargetFolder}
                    onChange={(e) => setBatchTargetFolder(e.target.value)}
                  >
                    <option value="root">{tr("根目录")}</option>
                    {sortedFolders.map(({ folder }) => (
                      <option key={folder.id} value={folder.id}>
                        {folder.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() =>
                      batchMut.mutate({
                        action: "move",
                        folder_id: batchTargetFolder === "root" ? null : batchTargetFolder,
                      })
                    }
                    className={secondary}
                  >
                    {tr("移动到此处")}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      batchMut.mutate({ action: "set_visibility", visibility: "grouped" })
                    }
                    className={secondary}
                  >
                    {tr("设为仅已分组")}
                  </button>
                  <button
                    type="button"
                    onClick={() => batchMut.mutate({ action: "delete" })}
                    className={dangerBtn}
                  >
                    {tr("批量删除")}
                  </button>
                </div>
              </div>
            )}

            {treeQuery.isLoading ? (
              <p className="py-8 text-center text-sm text-slate-500">{tr("正在加载课程资料…")}</p>
            ) : treeQuery.isError ? (
              <p className="py-4 text-sm text-red-600">{errorText(treeQuery.error)}</p>
            ) : items.length === 0 ? (
              <div className="py-10 text-center text-sm text-slate-500">
                {tr("当前目录暂无资料")}
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {items.map((item) => {
                  const checked = selectedIds.includes(item.id);
                  const active = activeMaterialId === item.id;
                  return (
                    <div
                      key={item.id}
                      className={`flex flex-wrap items-center justify-between gap-3 py-3 ${
                        active ? "bg-slate-50/80" : ""
                      }`}
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        {canManage && (
                          <input
                            type="checkbox"
                            aria-label={item.name}
                            checked={checked}
                            onChange={() => toggleSelect(item.id)}
                          />
                        )}
                        <FileText size={18} className="shrink-0 text-slate-400" />
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => setActiveMaterialId(active ? null : item.id)}
                              className="truncate text-sm font-semibold text-slate-900 hover:text-blue-600"
                            >
                              {item.name}
                            </button>
                            <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600">
                              v{item.latest_version_no}
                            </span>
                            <span
                              className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                                visibilityTone[item.visibility]
                              }`}
                            >
                              {tr(visibilityLabel[item.visibility])}
                            </span>
                          </div>
                          <div className="mt-0.5 text-xs text-slate-500">
                            {formatBytes(item.size_bytes)} ·{" "}
                            {item.uploader_name ?? tr("课程教师")}
                          </div>
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        <a
                          href={item.download_href}
                          download={item.name}
                          className={`${secondary} inline-flex items-center gap-1 text-xs`}
                        >
                          <Download size={13} />
                          {tr("下载")}
                        </a>
                        <button
                          type="button"
                          onClick={() => setActiveMaterialId(active ? null : item.id)}
                          className={`${secondary} inline-flex items-center gap-1 text-xs`}
                        >
                          <History size={13} />
                          {tr("详情与版本")}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {activeMaterialId && detailQuery.data && (
            <div className={`${card} space-y-4 border-blue-200 bg-slate-50/40`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">
                    {detailQuery.data.item.name}
                  </h2>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {tr("当前最新版本 v{0} · 上传者：{1}", {
                      0: detailQuery.data.item.latest_version_no,
                      1: detailQuery.data.item.uploader_name ?? tr("教师"),
                    })}
                  </p>
                </div>
                {canManage && (
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      aria-label={tr("修改资料可见范围")}
                      className={`${input} w-40 text-xs`}
                      value={detailQuery.data.item.visibility}
                      onChange={(e) =>
                        updateVisMut.mutate({
                          materialId: detailQuery.data.item.id,
                          visibility: e.target.value as MaterialVisibility,
                        })
                      }
                    >
                      <option value="all">{tr("全部学生可见")}</option>
                      <option value="grouped">{tr("仅已分组学生")}</option>
                      <option value="staff">{tr("仅教职可见")}</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => deleteMaterialMut.mutate(detailQuery.data.item.id)}
                      className={dangerBtn}
                    >
                      <Trash2 size={13} />
                      {tr("删除资料")}
                    </button>
                  </div>
                )}
              </div>

              {canManage && (
                <div className="rounded-lg border border-slate-200 bg-white p-3">
                  <div className="mb-2 text-xs font-semibold text-slate-700">
                    {tr("发布新版本")}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="file"
                      onChange={(e) => setNewVersionFile(e.target.files?.[0] ?? null)}
                      className="text-xs text-slate-600"
                    />
                    <input
                      className={`${input} min-w-[200px] flex-1 text-xs`}
                      value={newVersionNote}
                      onChange={(e) => setNewVersionNote(e.target.value)}
                      placeholder={tr("版本更新说明（选填）")}
                    />
                    <button
                      type="button"
                      disabled={newVersionMut.isPending}
                      onClick={() => newVersionMut.mutate()}
                      className={button}
                    >
                      {newVersionMut.isPending ? tr("上传中…") : tr("发布新版")}
                    </button>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <div className="text-xs font-semibold text-slate-700">{tr("版本历史")}</div>
                {detailQuery.data.versions.map((ver) => (
                  <div
                    key={ver.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs"
                  >
                    <div>
                      <span className="font-mono font-semibold text-slate-900">
                        v{ver.version_no}
                      </span>
                      <span className="ml-2 text-slate-700">{ver.original_name}</span>
                      <span className="ml-2 text-slate-400">
                        ({formatBytes(ver.size_bytes)})
                      </span>
                      {ver.change_note && (
                        <span className="ml-2 text-slate-500">· {ver.change_note}</span>
                      )}
                    </div>
                    <a
                      href={`${detailQuery.data.item.download_href}?version_no=${ver.version_no}`}
                      download={ver.original_name}
                      className="font-medium text-blue-600 hover:underline"
                    >
                      {tr("下载此版本")}
                    </a>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {renamingFolder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm space-y-4 rounded-xl bg-white p-5 shadow-xl">
            <h3 className="text-base font-semibold text-slate-900">{tr("重命名文件夹")}</h3>
            <input
              className={input}
              value={renameText}
              onChange={(e) => setRenameText(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRenamingFolder(null)}
                className={secondary}
              >
                {tr("取消")}
              </button>
              <button
                type="button"
                disabled={!renameText.trim() || renameFolderMut.isPending}
                onClick={() => renameFolderMut.mutate()}
                className={button}
              >
                {tr("保存")}
              </button>
            </div>
          </div>
        </div>
      )}

      {uploadOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md space-y-4 rounded-xl bg-white p-5 shadow-xl">
            <h3 className="text-base font-semibold text-slate-900">{tr("上传课程资料")}</h3>
            <div className="space-y-3">
              <div>
                <label className={label} htmlFor="mat-file-input">
                  {tr("选择文件")}
                </label>
                <input
                  id="mat-file-input"
                  type="file"
                  onChange={(e) => {
                    const file = e.target.files?.[0] ?? null;
                    setUploadFile(file);
                    if (file && !uploadName.trim()) setUploadName(file.name);
                  }}
                  className="text-xs text-slate-600"
                />
              </div>
              <div>
                <label className={label} htmlFor="mat-name-input">
                  {tr("资料显示名称")}
                </label>
                <input
                  id="mat-name-input"
                  className={input}
                  value={uploadName}
                  onChange={(e) => setUploadName(e.target.value)}
                  placeholder={tr("例如：课程说明.pdf")}
                />
              </div>
              <div>
                <label className={label} htmlFor="mat-vis-select">
                  {tr("学生可见范围")}
                </label>
                <select
                  id="mat-vis-select"
                  className={input}
                  value={uploadVis}
                  onChange={(e) => setUploadVis(e.target.value as MaterialVisibility)}
                >
                  <option value="all">{tr("全部学生可见")}</option>
                  <option value="grouped">{tr("仅已分组学生")}</option>
                  <option value="staff">{tr("仅教职可见")}</option>
                </select>
              </div>
              <div>
                <label className={label} htmlFor="mat-note-input">
                  {tr("备注说明（选填）")}
                </label>
                <input
                  id="mat-note-input"
                  className={input}
                  value={uploadNote}
                  onChange={(e) => setUploadNote(e.target.value)}
                  placeholder={tr("例如：初版教学大纲")}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setUploadOpen(false)}
                className={secondary}
              >
                {tr("取消")}
              </button>
              <button
                type="button"
                disabled={!(uploadName.trim() || uploadFile) || uploadMut.isPending}
                onClick={() => uploadMut.mutate()}
                className={button}
              >
                {uploadMut.isPending ? tr("上传中…") : tr("确认上传")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
