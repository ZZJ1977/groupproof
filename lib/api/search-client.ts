import { apiConfig } from "./config";

export type SearchItemKind = "course" | "project" | "task" | "evidence" | "file" | "user";

export interface SearchResultItem {
  id: string;
  kind: SearchItemKind;
  title: string;
  subtitle?: string | null;
  href: string;
}

export interface GlobalSearchResponse {
  query: string;
  items: SearchResultItem[];
}

export const globalSearchApi = {
  async search(query: string, signal?: AbortSignal): Promise<GlobalSearchResponse> {
    const trimmed = query.trim();
    if (!trimmed) return { query: "", items: [] };
    const params = new URLSearchParams({ q: trimmed, limit: "12" });
    const response = await fetch(`${apiConfig.baseUrl}/api/v1/search?${params.toString()}`, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      signal,
      headers: { Accept: "application/json" },
    });
    const body = (await response.json().catch(() => null)) as {
      data?: GlobalSearchResponse;
      error?: { message?: string };
    } | null;
    if (!response.ok || !body?.data) {
      throw new Error(body?.error?.message ?? "搜索请求失败");
    }
    return body.data;
  },
};
