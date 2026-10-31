import { listProjectFiles } from "@/lib/commands/files";
import type { FileRecord, MockData } from "@/types/domain";
import type { QueryPatch } from "./url-filters";

export const fileCategories = ["all", "documents", "images", "exports", "archived"] as const;
export const fileCategoryLabels: Record<(typeof fileCategories)[number], string> = {
  all: "全部资料", documents: "正式文档", images: "图片截图", exports: "导出文件", archived: "已归档",
};
export const fileSorts = ["recent", "name"] as const;
export const filePageSizes = [10, 20, 50] as const;

export interface FileFilters {
  category: (typeof fileCategories)[number];
  q: string;
  type: string;
  sort: (typeof fileSorts)[number];
  page: number;
  pageSize: (typeof filePageSizes)[number];
}

function positiveInteger(value: string | null, fallback: number): number {
  if (!value || !/^[1-9]\d*$/.test(value)) return fallback;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : fallback;
}

export function readFileFilters(query: Pick<URLSearchParams, "get">): FileFilters {
  const rawType = query.get("type")?.trim();
  return {
    category: fileCategories.find((value) => value === query.get("category")) ?? "all",
    q: query.get("q") ?? "",
    type: !rawType || rawType.toLowerCase() === "all" ? "all" : rawType.toUpperCase(),
    sort: fileSorts.find((value) => value === query.get("sort")) ?? "recent",
    page: positiveInteger(query.get("page"), 1),
    pageSize: filePageSizes.find((value) => value === positiveInteger(query.get("pageSize"), 10)) ?? 10,
  };
}

/** Every changed filter/sort/page-size starts at page one; leave unrelated query and hash intact. */
export function fileFilterPatch(key: keyof FileFilters, value: string): QueryPatch {
  const defaults: Record<keyof FileFilters, string> = { category: "all", q: "", type: "all", sort: "recent", page: "1", pageSize: "10" };
  return { ...(key === "page" ? {} : { page: null }), [key]: value === defaults[key] || !value ? null : value };
}

function isImage(file: FileRecord): boolean {
  return ["PNG", "JPG", "JPEG", "GIF", "WEBP", "SVG", "AVIF", "BMP"].includes(file.type.trim().toUpperCase()) || Boolean(file.mimeType?.toLowerCase().startsWith("image/"));
}

/** The current list keeps historic versions under the archive category, matching the existing file page. */
export function filterProjectFiles(files: readonly FileRecord[], filters: FileFilters, uploaderName: (id: string) => string): FileRecord[] {
  const query = filters.q.trim().toLocaleLowerCase();
  const visible = files.filter((item) => {
    if (filters.category === "archived" ? item.status !== "superseded" : item.status === "superseded") return false;
    const categoryMatches = filters.category === "all" || filters.category === "archived"
      || (filters.category === "documents" && item.status === "current" && !isImage(item))
      || (filters.category === "images" && isImage(item))
      || (filters.category === "exports" && item.source === "报告导出");
    return categoryMatches && (filters.type === "all" || item.type.trim().toUpperCase() === filters.type)
      && (!query || `${item.name} ${item.source} ${uploaderName(item.uploaderId)}`.toLocaleLowerCase().includes(query));
  });
  const timestamp = (value: string) => { const time = Date.parse(value); return Number.isFinite(time) ? time : 0; };
  const nameOrder = (a: FileRecord, b: FileRecord) => a.name.localeCompare(b.name, "zh-CN", { numeric: true, sensitivity: "base" });
  return visible.sort((a, b) => {
    const recent = timestamp(b.updatedAt) - timestamp(a.updatedAt);
    const names = nameOrder(a, b);
    return (filters.sort === "name" ? names || recent : recent || names) || a.id.localeCompare(b.id);
  });
}

/** Enforce project content visibility before filtering, options, totals or pagination are exposed. */
export function queryProjectFiles(data: MockData, actorId: string, projectId: string, filters: FileFilters) {
  const files = listProjectFiles(data, actorId, projectId);
  const matching = filterProjectFiles(files, filters, (id) => data.users.find((user) => user.id === id)?.name ?? id);
  const pageCount = Math.max(1, Math.ceil(matching.length / filters.pageSize));
  const page = Math.min(filters.page, pageCount);
  return {
    files,
    items: matching.slice((page - 1) * filters.pageSize, page * filters.pageSize),
    total: matching.length,
    page,
    pageSize: filters.pageSize,
    pageCount,
  };
}
