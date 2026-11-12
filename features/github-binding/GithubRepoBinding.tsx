"use client";

import { useCallback, useEffect, useState } from "react";

type Envelope<T> = { data: T };
type ErrorBody = { error?: { code?: string; message?: string; details?: { install_url?: string } } };
type Repo = { owner: string; repo: string; default_branch: string; linked_at: string; last_synced_at: string | null };
type SyncResult = {
  repos: number;
  files: number;
  fetched: number;
  removed: number;
  skipped: number;
  commits?: number;
  pulls?: number;
  ci_runs?: number;
  deleted_sources?: number;
};
type ActivityKind = "commit" | "pull_request" | "ci_run";
type Activity = {
  id: string;
  kind: ActivityKind;
  title: string;
  state: string | null;
  author_login: string | null;
  author_name: string | null;
  url: string | null;
  occurred_at: string;
  deleted: boolean;
};
type ActivityPage = { items: Activity[]; total: number; page: number; page_size: number };

const kindLabels: Record<ActivityKind, string> = { commit: "提交", pull_request: "合并请求", ci_run: "CI 运行" };

const buttonStyle: React.CSSProperties = {
  padding: "8px 16px",
  border: "1px solid #2563eb",
  borderRadius: 6,
  background: "#2563eb",
  color: "#fff",
  cursor: "pointer",
};
const fieldStyle: React.CSSProperties = { padding: "6px 8px", border: "1px solid #cbd5e1", borderRadius: 6, background: "#fff" };

class RequestError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string, readonly installUrl?: string) {
    super(message);
  }
}

/** 写操作前先取当前会话的 CSRF 令牌（与 lib/api/client.ts 的做法一致）。 */
async function csrfToken(): Promise<string> {
  const response = await fetch("/api/v1/auth/session", { credentials: "include", cache: "no-store" });
  const payload = await response.json().catch(() => null);
  const session = payload?.data ?? payload;
  if (!response.ok || !session?.authenticated || !session.csrfToken) {
    throw new RequestError(401, "请重新登录。");
  }
  return session.csrfToken as string;
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET") headers["X-CSRF-Token"] = await csrfToken();
  const response = await fetch(path, {
    method,
    credentials: "include",
    cache: "no-store",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as (Envelope<T> & ErrorBody) | null;
  if (!response.ok) {
    const error = payload?.error;
    throw new RequestError(response.status, error?.message ?? "操作失败，请稍后重试。", error?.code, error?.details?.install_url);
  }
  return (payload as Envelope<T>).data;
}

function friendly(error: unknown): string {
  if (error instanceof RequestError) {
    if (error.code === "GITHUB_APP_NOT_INSTALLED") return error.message;
    if (error.status === 503) return "GitHub 暂时不可用，请稍后重试。";
    if (error.status === 403) return "只有项目负责人可以绑定或同步仓库。";
    if (error.status === 404) return "项目不存在或你没有访问权限。";
    return error.message;
  }
  return "网络异常，请稍后重试。";
}

function formatTime(value: string | null): string {
  if (!value) return "尚未同步";
  return new Date(value).toLocaleString("zh-CN");
}

export function GithubRepoBinding({ projectId, embedded = false }: { projectId: string; embedded?: boolean }) {
  const base = `/api/v1/a/projects/${projectId}/github`;
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [repoUrl, setRepoUrl] = useState("");
  const [message, setMessage] = useState("");
  const [installUrl, setInstallUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<ActivityPage | null>(null);
  const [kind, setKind] = useState<ActivityKind | "">("");

  const loadActivity = useCallback(async () => {
    try {
      const query = kind ? `?kind=${kind}` : "";
      setActivity(await request<ActivityPage>("GET", `${base}/activity${query}`));
    } catch {
      setActivity({ items: [], total: 0, page: 1, page_size: 20 });
    }
  }, [base, kind]);

  useEffect(() => {
    void loadActivity();
  }, [loadActivity]);

  const load = useCallback(async () => {
    try {
      setRepos(await request<Repo[]>("GET", `${base}/repos`));
    } catch (error) {
      setRepos([]);
      setMessage(friendly(error));
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  async function bind() {
    setBusy(true);
    setMessage("");
    setInstallUrl(null);
    try {
      await request("POST", `${base}/repos`, { repo_url: repoUrl.trim() });
      setRepoUrl("");
      setMessage("已绑定。");
      await load();
    } catch (error) {
      setMessage(friendly(error));
      if (error instanceof RequestError && error.installUrl) setInstallUrl(error.installUrl);
    } finally {
      setBusy(false);
    }
  }

  async function sync() {
    setBusy(true);
    setMessage("");
    try {
      const result = await request<SyncResult>("POST", `${base}/sync`);
      setMessage(
        `同步完成：共 ${result.files} 个文件，下载 ${result.fetched} 个，移除 ${result.removed} 个，跳过 ${result.skipped} 个；` +
          `提交 ${result.commits ?? 0} 条，合并请求 ${result.pulls ?? 0} 条，CI 运行 ${result.ci_runs ?? 0} 条。`,
      );
      await Promise.all([load(), loadActivity()]);
    } catch (error) {
      setMessage(friendly(error));
    } finally {
      setBusy(false);
    }
  }

  const Shell = embedded ? "div" : "main";
  return (
    <Shell style={embedded ? undefined : { maxWidth: 560, margin: "40px auto", padding: "0 16px", fontFamily: "inherit" }}>
      <h1 style={{ fontSize: 22, fontWeight: 600 }}>GitHub 仓库</h1>
      <p style={{ color: "#666", marginTop: 4 }}>绑定项目的代码仓库，之后可以读取代码，用来判断功能是否已经实现。只读访问，不会修改你的仓库。</p>

      <section style={{ marginTop: 24, padding: 16, border: "1px solid #ddd", borderRadius: 8 }}>
        {repos === null && <p role="status">正在读取绑定状态…</p>}

        {repos !== null && repos.length > 0 && (
          <>
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
              {repos.map((repo) => (
                <li key={`${repo.owner}/${repo.repo}`}>
                  <strong>{repo.owner}/{repo.repo}</strong>
                  <span style={{ color: "#666", marginLeft: 8, fontSize: 14 }}>
                    分支 {repo.default_branch} · 上次同步：{formatTime(repo.last_synced_at)}
                  </span>
                </li>
              ))}
            </ul>
            <button type="button" onClick={sync} disabled={busy} style={{ ...buttonStyle, marginTop: 12 }}>
              立即同步
            </button>
          </>
        )}

        {repos !== null && repos.length === 0 && (
          <div style={{ display: "grid", gap: 12 }}>
            <p>还没有绑定仓库。</p>
            <label>
              仓库地址：
              <input
                value={repoUrl}
                onChange={(event) => setRepoUrl(event.target.value)}
                placeholder="https://github.com/owner/repo"
                style={{ ...fieldStyle, width: "100%", marginTop: 4 }}
                disabled={busy}
              />
            </label>
            <p style={{ color: "#666", fontSize: 14 }}>绑定前，请先把 GroupProof 的 GitHub App 安装到该仓库所在的账号。</p>
            <button type="button" onClick={bind} disabled={busy || !repoUrl.trim()} style={buttonStyle}>
              绑定
            </button>
          </div>
        )}

        {message && (
          <p role="status" style={{ marginTop: 12 }}>
            {message}
            {installUrl && (
              <>
                {" "}
                <a href={installUrl} target="_blank" rel="noreferrer" style={{ color: "#2563eb", textDecoration: "underline" }}>去安装</a>
              </>
            )}
          </p>
        )}
      </section>

      {repos !== null && repos.length > 0 && (
        <section style={{ marginTop: 24, padding: 16, border: "1px solid #ddd", borderRadius: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <h2 style={{ fontSize: 16, fontWeight: 600 }}>最近开发活动</h2>
            <select
              aria-label="活动类型"
              value={kind}
              onChange={(event) => setKind(event.target.value as ActivityKind | "")}
              style={fieldStyle}
            >
              <option value="">全部类型</option>
              <option value="commit">提交</option>
              <option value="pull_request">合并请求</option>
              <option value="ci_run">CI 运行</option>
            </select>
          </div>
          {activity === null && <p role="status" style={{ marginTop: 12 }}>正在读取活动…</p>}
          {activity !== null && activity.items.length === 0 && (
            <p style={{ color: "#666", marginTop: 12 }}>暂无活动。点击“立即同步”拉取最近的提交、合并请求和 CI 运行。</p>
          )}
          {activity !== null && activity.items.length > 0 && (
            <ul style={{ listStyle: "none", padding: 0, margin: "12px 0 0", display: "grid", gap: 10 }}>
              {activity.items.map((item) => (
                <li key={item.id} style={{ fontSize: 14, opacity: item.deleted ? 0.6 : 1 }}>
                  <span style={{ color: "#2563eb", marginRight: 8 }}>{kindLabels[item.kind]}</span>
                  {item.url ? (
                    <a href={item.url} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>{item.title}</a>
                  ) : (
                    item.title
                  )}
                  <div style={{ color: "#666", fontSize: 13 }}>
                    {item.author_name || item.author_login || "未知作者"} · {formatTime(item.occurred_at)}
                    {item.state ? ` · ${item.state}` : ""}
                    {item.deleted ? " · 源已删除" : ""}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {activity !== null && activity.total > activity.items.length && (
            <p style={{ color: "#666", fontSize: 13, marginTop: 8 }}>共 {activity.total} 条，仅显示最近 {activity.items.length} 条。</p>
          )}
        </section>
      )}
    </Shell>
  );
}
