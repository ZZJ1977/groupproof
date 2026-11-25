"use client";

import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale } from "next-intl";
import {
  Bell,
  ClipboardList,
  Download,
  Edit3,
  FileText,
  Folder,
  FolderPlus,
  History,
  Search,
  Settings,
  Shield,
  Trash2,
  Upload,
} from "lucide-react";
import { Button, buttonVariants } from "@/shared/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/shared/components/ui/sheet";
import { errorText } from "@/shared/lib/b-ui";
import { TeacherConfirmDialog } from "@/teacher/components/TeacherConfirmDialog";
import { TeacherFeedbackPill } from "@/teacher/components/TeacherFeedbackPill";
import { TeacherSegmentedTabs } from "@/teacher/components/TeacherSegmentedTabs";
import {
  type CourseFolder,
  type MaterialVisibility,
  fileToBase64,
  teacherFilesApi,
  teacherFilesKeys,
} from "@/teacher/api/teacher-files-client";
import { useTeacherPermissions } from "@/teacher/hooks/use-teacher-permissions";
import { tr } from "@/shared/i18n/tr";
import { useWorkspace } from "@/shared/lib/workspace";

const panelClass =
  "rounded-[12px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-5 shadow-[var(--gp-shadow-card)]";
const inputClass =
  "w-full rounded-[8px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] px-3 py-2 text-sm text-[var(--gp-ink,#1f2329)] outline-none transition-colors focus:border-[var(--gp-action,#3370ff)] focus:ring-2 focus:ring-[var(--gp-action-soft,#e8f0fe)] disabled:cursor-not-allowed disabled:bg-[var(--gp-surface-subtle,#f8f9fa)] disabled:text-[var(--gp-muted,#646a73)]";
const labelClass = "mb-1.5 block text-xs font-semibold text-[var(--gp-ink-soft,#4e5969)]";

const visibilityLabel: Record<MaterialVisibility, string> = {
  all: "全部学生可见",
  grouped: "仅已分组学生",
  staff: "仅教职可见",
};

const visibilityTone: Record<MaterialVisibility, string> = {
  all: "bg-emerald-50 text-[var(--gp-success,#008a5c)]",
  grouped: "bg-[var(--gp-action-soft,#e8f0fe)] text-[var(--gp-action-on-soft,#1d4ed8)]",
  staff: "bg-amber-50 text-amber-800",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return tr("{0} B", { 0: bytes });
  if (bytes < 1024 * 1024) return tr("{0} KB", { 0: Math.round(bytes / 102.4) / 10 });
  return tr("{0} MB", { 0: Math.round((bytes / (1024 * 1024)) * 10) / 10 });
}

type DeleteConfirmAction =
  | { kind: "folder"; folder: CourseFolder }
  | { kind: "material"; materialId: string; name: string }
  | { kind: "batch"; count: number }
  | null;

export function TeacherFilesApiPage({ courseId }: { courseId: string }) {
  const qc = useQueryClient();
  const locale = useLocale();
  const { userId } = useWorkspace();
  const perms = useTeacherPermissions(courseId);

  const confirmDeleteLabel = [tr("确认"), tr("删除")].join(locale === "en" ? " " : "");

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
  const uploadFileInputRef = useRef<HTMLInputElement | null>(null);

  const resetUploadForm = () => {
    setUploadName("");
    setUploadFile(null);
    setUploadVis("all");
    setUploadNote("");
    if (uploadFileInputRef.current) {
      uploadFileInputRef.current.value = "";
    }
  };

  const closeUploadSheet = () => {
    setUploadOpen(false);
    resetUploadForm();
  };

  const [newVersionFile, setNewVersionFile] = useState<File | null>(null);
  const [newVersionNote, setNewVersionNote] = useState("");
  const [batchTargetFolder, setBatchTargetFolder] = useState<string>("root");
  const [confirmAction, setConfirmAction] = useState<DeleteConfirmAction>(null);
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

  const invalidate = async (opts?: { skipVersions?: boolean; deletedIds?: string[] }) => {
    setSelectedIds([]);
    const shouldInvalidateVersions =
      !opts?.skipVersions &&
      Boolean(activeMaterialId) &&
      !(opts?.deletedIds?.includes(activeMaterialId as string));
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["b-teacher-files", userId, courseId] }),
      shouldInvalidateVersions && activeMaterialId
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
      const activeInDeletedFolder =
        Boolean(activeMaterialId) &&
        (Boolean(
          treeQuery.data?.items.some(
            (item) => item.id === activeMaterialId && item.folder_id === folderId,
          ),
        ) ||
          detailQuery.data?.item.folder_id === folderId);
      const deletedActiveId =
        activeInDeletedFolder && activeMaterialId ? activeMaterialId : null;
      if (deletedActiveId) {
        await qc.cancelQueries({
          queryKey: teacherFilesKeys.versions(userId, courseId, deletedActiveId),
        });
        qc.removeQueries({
          queryKey: teacherFilesKeys.versions(userId, courseId, deletedActiveId),
        });
        setActiveMaterialId(null);
      }
      if (currentFolderId === folderId) setCurrentFolderId(null);
      setConfirmAction(null);
      setFeedback({ tone: "success", text: tr("文件夹已删除，内部资料已上移") });
      await invalidate(
        deletedActiveId ? { skipVersions: true, deletedIds: [deletedActiveId] } : undefined,
      );
    },
    onError: (err) => {
      setConfirmAction(null);
      setFeedback({ tone: "error", text: errorText(err) });
    },
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
      resetUploadForm();
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
      await qc.cancelQueries({
        queryKey: teacherFilesKeys.versions(userId, courseId, materialId),
      });
      qc.removeQueries({
        queryKey: teacherFilesKeys.versions(userId, courseId, materialId),
      });
      if (activeMaterialId === materialId) setActiveMaterialId(null);
      setSelectedIds((prev) => prev.filter((id) => id !== materialId));
      setConfirmAction(null);
      setFeedback({ tone: "success", text: tr("资料已删除") });
      await invalidate({
        skipVersions: activeMaterialId === materialId,
        deletedIds: [materialId],
      });
    },
    onError: (err) => {
      setConfirmAction(null);
      setFeedback({ tone: "error", text: errorText(err) });
    },
  });

  const batchMut = useMutation({
    mutationFn: (payload: {
      action: "move" | "set_visibility" | "delete";
      ids: string[];
      folder_id?: string | null;
      visibility?: MaterialVisibility;
    }) =>
      teacherFilesApi.batch(courseId, {
        ids: payload.ids,
        action: payload.action,
        folder_id: payload.folder_id,
        visibility: payload.visibility,
      }),
    onSuccess: async (res, vars) => {
      const deletedActive =
        vars.action === "delete" && Boolean(activeMaterialId && vars.ids.includes(activeMaterialId));
      if (vars.action === "delete") {
        await Promise.all(
          vars.ids.map((id) =>
            qc.cancelQueries({ queryKey: teacherFilesKeys.versions(userId, courseId, id) }),
          ),
        );
        for (const id of vars.ids) {
          qc.removeQueries({ queryKey: teacherFilesKeys.versions(userId, courseId, id) });
        }
        if (deletedActive) setActiveMaterialId(null);
      }
      setConfirmAction(null);
      setFeedback({ tone: "success", text: tr("已批量处理 {0} 份资料", { 0: res.affected }) });
      await invalidate(
        vars.action === "delete"
          ? { skipVersions: deletedActive, deletedIds: vars.ids }
          : undefined,
      );
    },
    onError: (err) => {
      setConfirmAction(null);
      setFeedback({ tone: "error", text: errorText(err) });
    },
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
  const deletePending =
    deleteFolderMut.isPending || deleteMaterialMut.isPending || batchMut.isPending;

  const toggleSelect = (materialId: string) => {
    setSelectedIds((prev) =>
      prev.includes(materialId) ? prev.filter((id) => id !== materialId) : [...prev, materialId],
    );
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TeacherSegmentedTabs
          variant="segmented"
          size="sm"
          ariaLabel={tr("切换子页面")}
          testId="hub5-segmented-tabs"
          activeId="files"
          items={[
            {
              id: "settings",
              label: tr("基础设置"),
              href: `/teacher/courses/${courseId}/settings`,
              icon: Settings,
            },
            {
              id: "rules",
              label: tr("规则与模板"),
              href: `/teacher/courses/${courseId}/rules`,
              icon: ClipboardList,
            },
            {
              id: "files",
              label: tr("课程资料"),
              href: `/teacher/courses/${courseId}/files`,
              icon: Folder,
            },
            {
              id: "announcements",
              label: tr("课程公告"),
              href: `/teacher/courses/${courseId}/announcements`,
              icon: Bell,
            },
            {
              id: "staff",
              label: tr("助教管理"),
              href: `/teacher/courses/${courseId}/staff`,
              icon: Shield,
              hidden: !perms.isOwner,
            },
          ]}
        />
        <TeacherFeedbackPill
          tone={feedback?.tone ?? "idle"}
          message={feedback?.text}
          autoHideMs={3000}
          onDismiss={() => setFeedback(null)}
        />
      </div>

      <div className={`${panelClass} flex flex-wrap items-center justify-between gap-3`}>
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-[var(--gp-ink,#1f2329)]">
            {tr("课程资料中心")}
          </h1>
          <p className="mt-0.5 text-xs text-[var(--gp-muted,#646a73)]">
            {tr("按文件夹整理课程大纲与参考资料，控制学生可见范围并保留历史版本。")}
          </p>
        </div>
        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setNewFolderOpen((v) => !v)}
            >
              <FolderPlus size={15} aria-hidden="true" />
              {tr("新建文件夹")}
            </Button>
            <Button
              type="button"
              variant="default"
              size="sm"
              pill
              onClick={() => setUploadOpen(true)}
            >
              <Upload size={15} aria-hidden="true" />
              {tr("上传资料")}
            </Button>
          </div>
        )}
      </div>

      {newFolderOpen && canManage && (
        <div
          className={`${panelClass} flex flex-wrap items-end gap-3 bg-[var(--gp-surface-subtle,#f8f9fa)]`}
        >
          <div className="min-w-0 flex-1 sm:min-w-[220px]">
            <label className={labelClass} htmlFor="new-folder-name">
              {tr("新文件夹名称")}
            </label>
            <input
              id="new-folder-name"
              className={inputClass}
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              placeholder={tr("例如：教学大纲、第 1 周课件")}
            />
          </div>
          <Button
            type="button"
            variant="default"
            size="sm"
            pill
            loading={createFolderMut.isPending}
            preserveWidth
            disabled={!folderName.trim() || createFolderMut.isPending}
            onClick={() => createFolderMut.mutate()}
          >
            {tr("确认创建")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={createFolderMut.isPending}
            onClick={() => setNewFolderOpen(false)}
          >
            {tr("取消")}
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className={`${panelClass} min-w-0 space-y-1.5`}>
          <div className="pb-1 text-xs font-semibold text-[var(--gp-muted,#646a73)]">
            {tr("目录结构")}
          </div>
          <button
            type="button"
            onClick={() => setCurrentFolderId(null)}
            className={`flex w-full items-center justify-between rounded-[8px] px-2.5 py-2 text-left text-xs font-medium transition-colors ${
              currentFolderId === null
                ? "bg-[var(--gp-action-soft,#e8f0fe)] text-[var(--gp-action-on-soft,#1d4ed8)]"
                : "text-[var(--gp-ink-soft,#4e5969)] hover:bg-[var(--gp-surface-hover,#eff0f1)]"
            }`}
          >
            <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
              <Folder size={14} className="shrink-0" aria-hidden="true" />
              <span className="truncate">{tr("全部根目录资料")}</span>
            </span>
          </button>

          {sortedFolders.map(({ folder, depth }) => (
            <div key={folder.id} className="group flex min-w-0 items-center gap-1">
              <button
                type="button"
                onClick={() => setCurrentFolderId(folder.id)}
                style={{ paddingLeft: `${10 + depth * 14}px` }}
                className={`flex min-w-0 flex-1 items-center justify-between rounded-[8px] py-1.5 pr-2 text-left text-xs font-medium transition-colors ${
                  currentFolderId === folder.id
                    ? "bg-[var(--gp-action-soft,#e8f0fe)] text-[var(--gp-action-on-soft,#1d4ed8)]"
                    : "text-[var(--gp-ink-soft,#4e5969)] hover:bg-[var(--gp-surface-hover,#eff0f1)]"
                }`}
              >
                <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
                  <Folder size={14} className="shrink-0" aria-hidden="true" />
                  <span title={folder.name} className="truncate">
                    {folder.name}
                  </span>
                </span>
                <span className="gp-tabular ml-1 shrink-0 text-[11px] text-[var(--gp-subtle,#8f959e)]">
                  {folder.item_count}
                </span>
              </button>
              {canManage && (
                <div className="flex shrink-0 items-center gap-0.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label={tr("重命名文件夹")}
                    title={tr("重命名文件夹")}
                    onClick={() => {
                      setRenamingFolder(folder);
                      setRenameText(folder.name);
                    }}
                  >
                    <Edit3 size={12} aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-[var(--gp-muted,#646a73)] hover:bg-red-50 hover:text-[var(--gp-danger,#d93025)]"
                    disabled={deleteFolderMut.isPending}
                    aria-label={tr("删除文件夹")}
                    title={tr("删除文件夹")}
                    onClick={() => setConfirmAction({ kind: "folder", folder })}
                  >
                    <Trash2 size={12} aria-hidden="true" />
                  </Button>
                </div>
              )}
            </div>
          ))}
        </aside>

        <div className="min-w-0 space-y-4">
          <div className={`${panelClass} min-w-0 space-y-3`}>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--gp-border-subtle,#ebedf0)] pb-3">
              <div className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-[var(--gp-ink-soft,#4e5969)]">
                <button
                  type="button"
                  onClick={() => setCurrentFolderId(null)}
                  className="font-medium hover:text-[var(--gp-action,#3370ff)]"
                >
                  {tr("全部资料")}
                </button>
                {(treeQuery.data?.breadcrumbs ?? []).map((crumb) => (
                  <span key={crumb.id} className="inline-flex items-center gap-1">
                    <span>/</span>
                    <button
                      type="button"
                      onClick={() => setCurrentFolderId(crumb.id)}
                      className="font-medium hover:text-[var(--gp-action,#3370ff)]"
                    >
                      {crumb.name}
                    </button>
                  </span>
                ))}
              </div>

              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                <div className="relative w-full sm:w-44">
                  <Search
                    size={14}
                    className="pointer-events-none absolute left-2.5 top-2.5 text-[var(--gp-subtle,#8f959e)]"
                    aria-hidden="true"
                  />
                  <input
                    className={`${inputClass} w-full pl-8 text-xs`}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={tr("搜索资料名称")}
                  />
                </div>
                <select
                  aria-label={tr("按可见范围筛选")}
                  className={`${inputClass} w-full text-xs sm:w-36`}
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
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] bg-[var(--gp-action-soft,#e8f0fe)] px-3 py-2 text-xs">
                <span className="gp-tabular font-medium text-[var(--gp-action-on-soft,#1d4ed8)]">
                  {tr("已选中 {0} 份资料", { 0: selectedIds.length })}
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    aria-label={tr("批量移动目标")}
                    disabled={batchMut.isPending}
                    className="rounded-[6px] border border-blue-200 bg-white px-2 py-1 text-xs disabled:opacity-50"
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
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    loading={batchMut.isPending && batchMut.variables?.action === "move"}
                    preserveWidth
                    disabled={batchMut.isPending}
                    onClick={() =>
                      batchMut.mutate({
                        action: "move",
                        ids: [...selectedIds],
                        folder_id: batchTargetFolder === "root" ? null : batchTargetFolder,
                      })
                    }
                  >
                    {tr("移动到此处")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    loading={
                      batchMut.isPending && batchMut.variables?.action === "set_visibility"
                    }
                    preserveWidth
                    disabled={batchMut.isPending}
                    onClick={() =>
                      batchMut.mutate({
                        action: "set_visibility",
                        ids: [...selectedIds],
                        visibility: "grouped",
                      })
                    }
                  >
                    {tr("设为仅已分组")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={batchMut.isPending}
                    className="border-red-200 text-[var(--gp-danger,#d93025)] hover:bg-red-50 hover:text-[var(--gp-danger,#d93025)]"
                    onClick={() => setConfirmAction({ kind: "batch", count: selectedIds.length })}
                  >
                    {tr("批量删除")}
                  </Button>
                </div>
              </div>
            )}

            {treeQuery.isLoading ? (
              <p role="status" className="py-8 text-center text-sm text-[var(--gp-muted,#646a73)]">
                {tr("正在加载课程资料…")}
              </p>
            ) : treeQuery.isError ? (
              <div role="alert" className="flex flex-wrap items-center justify-between gap-3 py-4 text-sm text-[var(--gp-danger,#d93025)]">
                <p>{errorText(treeQuery.error)}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void treeQuery.refetch()}
                >
                  {tr("重试")}
                </Button>
              </div>
            ) : items.length === 0 ? (
              <div className="py-10 text-center text-sm text-[var(--gp-muted,#646a73)]">
                {tr("当前目录暂无资料")}
              </div>
            ) : (
              <div className="divide-y divide-[var(--gp-border-subtle,#ebedf0)]">
                {items.map((item) => {
                  const checked = selectedIds.includes(item.id);
                  const active = activeMaterialId === item.id;
                  return (
                    <div
                      key={item.id}
                      className={`flex flex-wrap items-center justify-between gap-3 py-3 ${
                        active ? "bg-[var(--gp-surface-subtle,#f8f9fa)]" : ""
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
                        <FileText
                          size={18}
                          className="shrink-0 text-[var(--gp-subtle,#8f959e)]"
                          aria-hidden="true"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => setActiveMaterialId(active ? null : item.id)}
                              title={item.name}
                              className="max-w-full truncate text-left text-sm font-semibold text-[var(--gp-ink,#1f2329)] hover:text-[var(--gp-action,#3370ff)]"
                            >
                              {item.name}
                            </button>
                            <span className="gp-tabular shrink-0 rounded bg-[var(--gp-surface-hover,#eff0f1)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--gp-ink-soft,#4e5969)]">
                              v{item.latest_version_no}
                            </span>
                            <span
                              className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                                visibilityTone[item.visibility]
                              }`}
                            >
                              {tr(visibilityLabel[item.visibility])}
                            </span>
                          </div>
                          <div className="gp-tabular mt-0.5 text-xs text-[var(--gp-muted,#646a73)]">
                            {formatBytes(item.size_bytes)} ·{" "}
                            {item.uploader_name ?? tr("课程教师")}
                          </div>
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        <a
                          href={item.download_href}
                          download={item.name}
                          className={buttonVariants({ variant: "outline", size: "sm" })}
                        >
                          <Download size={13} aria-hidden="true" />
                          {tr("下载")}
                        </a>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setActiveMaterialId(active ? null : item.id)}
                        >
                          <History size={13} aria-hidden="true" />
                          {tr("详情与版本")}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {activeMaterialId && (
            <div
              className={`${panelClass} min-w-0 space-y-4 border-blue-200 bg-[var(--gp-surface-subtle,#f8f9fa)]`}
            >
              {detailQuery.isLoading ? (
                <p role="status" className="text-xs text-[var(--gp-muted,#646a73)]">
                  {tr("正在加载版本…")}
                </p>
              ) : detailQuery.isError ? (
                <div role="alert" className="space-y-2 text-xs text-[var(--gp-danger,#d93025)]">
                  <p>{errorText(detailQuery.error)}</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void detailQuery.refetch()}
                  >
                    {tr("重试")}
                  </Button>
                </div>
              ) : (
                detailQuery.data && (
                  <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <h2
                    title={detailQuery.data.item.name}
                    className="truncate text-base font-semibold text-[var(--gp-ink,#1f2329)]"
                  >
                    {detailQuery.data.item.name}
                  </h2>
                  <p className="gp-tabular mt-0.5 text-xs text-[var(--gp-muted,#646a73)]">
                    {tr("当前最新版本 v{0} · 上传者：{1}", {
                      0: detailQuery.data.item.latest_version_no,
                      1: detailQuery.data.item.uploader_name ?? tr("教师"),
                    })}
                  </p>
                </div>
                {canManage && (
                  <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                    <select
                      aria-label={tr("修改资料可见范围")}
                      disabled={updateVisMut.isPending}
                      className={`${inputClass} w-full text-xs sm:w-40`}
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
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={deleteMaterialMut.isPending}
                      className="border-red-200 text-[var(--gp-danger,#d93025)] hover:bg-red-50 hover:text-[var(--gp-danger,#d93025)]"
                      onClick={() =>
                        setConfirmAction({
                          kind: "material",
                          materialId: detailQuery.data.item.id,
                          name: detailQuery.data.item.name,
                        })
                      }
                    >
                      <Trash2 size={13} aria-hidden="true" />
                      {tr("删除资料")}
                    </Button>
                  </div>
                )}
              </div>

              {canManage && (
                <div className="rounded-[10px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-3">
                  <div className="mb-2 text-xs font-semibold text-[var(--gp-ink-soft,#4e5969)]">
                    {tr("发布新版本")}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="file"
                      disabled={newVersionMut.isPending}
                      onChange={(e) => setNewVersionFile(e.target.files?.[0] ?? null)}
                      className="w-full min-w-0 max-w-full text-xs text-[var(--gp-muted,#646a73)] sm:w-auto"
                    />
                    <input
                      className={`${inputClass} w-full min-w-0 text-xs sm:min-w-[200px] sm:flex-1`}
                      value={newVersionNote}
                      onChange={(e) => setNewVersionNote(e.target.value)}
                      placeholder={tr("版本更新说明（选填）")}
                    />
                    <Button
                      type="button"
                      variant="default"
                      size="sm"
                      pill
                      loading={newVersionMut.isPending}
                      preserveWidth
                      disabled={
                        newVersionMut.isPending || (!newVersionFile && !newVersionNote.trim())
                      }
                      onClick={() => newVersionMut.mutate()}
                    >
                      {tr("发布新版")}
                    </Button>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <div className="text-xs font-semibold text-[var(--gp-ink-soft,#4e5969)]">
                  {tr("版本历史")}
                </div>
                {detailQuery.data.versions.map((ver) => (
                  <div
                    key={ver.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-[8px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] px-3 py-2 text-xs"
                  >
                    <div className="min-w-0 flex-1 break-all">
                      <span className="gp-tabular font-mono font-semibold text-[var(--gp-ink,#1f2329)]">
                        v{ver.version_no}
                      </span>
                      <span className="ml-2 text-[var(--gp-ink-soft,#4e5969)]">
                        {ver.original_name}
                      </span>
                      <span className="gp-tabular ml-2 text-[var(--gp-muted,#646a73)]">
                        ({formatBytes(ver.size_bytes)})
                      </span>
                      {ver.change_note && (
                        <span className="ml-2 text-[var(--gp-muted,#646a73)]">
                          · {ver.change_note}
                        </span>
                      )}
                    </div>
                    <a
                      href={`${detailQuery.data.item.download_href}?version_no=${ver.version_no}`}
                      download={ver.original_name}
                      className="shrink-0 font-medium text-[var(--gp-action,#3370ff)] hover:underline"
                    >
                      {tr("下载此版本")}
                    </a>
                  </div>
                ))}
              </div>
                  </>
                )
              )}
            </div>
          )}
        </div>
      </div>

      <Dialog
        open={Boolean(renamingFolder)}
        onOpenChange={(open) => {
          if (renameFolderMut.isPending && !open) return;
          if (!open) setRenamingFolder(null);
        }}
      >
        <DialogContent
          onEscapeKeyDown={(event) => {
            if (renameFolderMut.isPending) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (renameFolderMut.isPending) event.preventDefault();
          }}
        >
          <DialogHeader className="pr-8">
            <DialogTitle className="text-base font-semibold text-[var(--gp-ink,#1f2329)]">
              {tr("重命名文件夹")}
            </DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!renameText.trim() || renameFolderMut.isPending) return;
              renameFolderMut.mutate();
            }}
          >
            <input
              className={inputClass}
              value={renameText}
              onChange={(e) => setRenameText(e.target.value)}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={renameFolderMut.isPending}
                onClick={() => setRenamingFolder(null)}
              >
                {tr("取消")}
              </Button>
              <Button
                type="submit"
                variant="default"
                size="sm"
                pill
                loading={renameFolderMut.isPending}
                preserveWidth
                disabled={!renameText.trim() || renameFolderMut.isPending}
              >
                {tr("保存")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Sheet
        open={uploadOpen}
        onOpenChange={(open) => {
          if (uploadMut.isPending && !open) return;
          if (!open) {
            closeUploadSheet();
          } else {
            setUploadOpen(true);
          }
        }}
      >
        <SheetContent
          side="right"
          className="flex flex-col justify-between"
          onEscapeKeyDown={(event) => {
            if (uploadMut.isPending) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (uploadMut.isPending) event.preventDefault();
          }}
        >
          <div className="space-y-4">
            <SheetHeader className="pr-8">
              <SheetTitle className="text-base font-semibold text-[var(--gp-ink,#1f2329)]">
                {tr("上传课程资料")}
              </SheetTitle>
              <SheetDescription className="text-xs text-[var(--gp-muted,#646a73)]">
                {tr("按文件夹整理课程大纲与参考资料，控制学生可见范围并保留历史版本。")}
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-3">
              <div>
                <label className={labelClass} htmlFor="mat-file-input">
                  {tr("选择文件")}
                </label>
                <input
                  ref={uploadFileInputRef}
                  id="mat-file-input"
                  type="file"
                  disabled={uploadMut.isPending}
                  onChange={(e) => {
                    const file = e.target.files?.[0] ?? null;
                    setUploadFile(file);
                    if (file && !uploadName.trim()) setUploadName(file.name);
                  }}
                  className="w-full min-w-0 max-w-full text-xs text-[var(--gp-muted,#646a73)]"
                />
              </div>
              <div>
                <label className={labelClass} htmlFor="mat-name-input">
                  {tr("资料显示名称")}
                </label>
                <input
                  id="mat-name-input"
                  className={inputClass}
                  value={uploadName}
                  onChange={(e) => setUploadName(e.target.value)}
                  placeholder={tr("例如：课程说明.pdf")}
                />
              </div>
              <div>
                <label className={labelClass} htmlFor="mat-vis-select">
                  {tr("学生可见范围")}
                </label>
                <select
                  id="mat-vis-select"
                  className={inputClass}
                  value={uploadVis}
                  onChange={(e) => setUploadVis(e.target.value as MaterialVisibility)}
                >
                  <option value="all">{tr("全部学生可见")}</option>
                  <option value="grouped">{tr("仅已分组学生")}</option>
                  <option value="staff">{tr("仅教职可见")}</option>
                </select>
              </div>
              <div>
                <label className={labelClass} htmlFor="mat-note-input">
                  {tr("备注说明（选填）")}
                </label>
                <input
                  id="mat-note-input"
                  className={inputClass}
                  value={uploadNote}
                  onChange={(e) => setUploadNote(e.target.value)}
                  placeholder={tr("例如：初版教学大纲")}
                />
              </div>
            </div>
          </div>

          <SheetFooter className="border-t border-[var(--gp-border-subtle,#ebedf0)] pt-4">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={uploadMut.isPending}
              onClick={closeUploadSheet}
            >
              {tr("取消")}
            </Button>
            <Button
              type="button"
              variant="default"
              size="sm"
              pill
              loading={uploadMut.isPending}
              preserveWidth
              disabled={!(uploadName.trim() || uploadFile) || uploadMut.isPending}
              onClick={() => uploadMut.mutate()}
            >
              {tr("确认上传")}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <TeacherConfirmDialog
        open={Boolean(confirmAction)}
        onOpenChange={(open) => {
          if (!open && !deletePending) setConfirmAction(null);
        }}
        tone="danger"
        title={
          confirmAction?.kind === "folder"
            ? tr("删除文件夹")
            : confirmAction?.kind === "batch"
              ? tr("批量删除")
              : tr("删除资料")
        }
        description={
          confirmAction?.kind === "folder"
            ? confirmAction.folder.name
            : confirmAction?.kind === "batch"
              ? tr("已选中 {0} 份资料", { 0: confirmAction.count })
              : confirmAction?.name
        }
        confirmLabel={confirmDeleteLabel}
        loading={deletePending}
        onConfirm={() => {
          if (!confirmAction) return;
          if (confirmAction.kind === "folder") {
            deleteFolderMut.mutate(confirmAction.folder.id);
          } else if (confirmAction.kind === "material") {
            deleteMaterialMut.mutate(confirmAction.materialId);
          } else if (confirmAction.kind === "batch") {
            batchMut.mutate({ action: "delete", ids: [...selectedIds] });
          }
        }}
      />
    </div>
  );
}
