"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ExternalLink, GitBranch, RefreshCw } from "lucide-react";
import { Feedback } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { components } from "@/packages/domain/api.generated";
import { ProjectRequestError, integrationErrorText, projectRequest } from "./integration-request";

type Repo = components["schemas"]["GithubRepoDTO"];
type SyncResult = components["schemas"]["GithubSyncDTO"];

export function GithubRepoBinding({ projectId, userId, canManage }: {
  projectId: string; userId: string; canManage: boolean;
}) {
  const base = `/api/v1/a/projects/${projectId}/github`;
  const repos = useQuery({
    queryKey: ["project-integration-repos", userId, projectId],
    queryFn: ({ signal }) => projectRequest<Repo[]>(`${base}/repos`, { signal }),
    gcTime: 0,
    retry: false,
  });
  const [repoUrl, setRepoUrl] = useState("");
  const [showBindForm, setShowBindForm] = useState(false);
  const [busy, setBusy] = useState<"bind" | "sync" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const entries = repos.isSuccess ? repos.data : null;
  const connected = Boolean(entries && entries.length > 0);
  const installUrl = failure instanceof ProjectRequestError ? failure.installUrl : undefined;
  const writable = canManage && repos.isSuccess;

  async function perform(action: "bind" | "sync") {
    if (!writable || busy) return;
    setBusy(action);
    setFailure(null);
    setNotice(null);
    try {
      if (action === "bind") {
        await projectRequest<Repo>(`${base}/repos`, { method: "POST", body: { repo_url: repoUrl.trim() } });
        setRepoUrl("");
        setShowBindForm(false);
        setNotice("GitHub 仓库已绑定。");
      } else {
        const result = await projectRequest<SyncResult>(`${base}/sync`, { method: "POST" });
        setNotice(`同步完成，读取 ${result.files} 个文件、${result.commits ?? 0} 条提交、${result.pulls ?? 0} 个合并请求和 ${result.ci_runs ?? 0} 次 CI 运行。`);
      }
      await repos.refetch();
    } catch (error) {
      setFailure(error);
      if (error instanceof ProjectRequestError && [401, 403, 404].includes(error.status)) await repos.refetch();
    } finally {
      setBusy(null);
    }
  }

  const bindForm = (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (repoUrl.trim()) void perform("bind");
      }}
    >
      <label className="block text-xs font-semibold text-slate-700" htmlFor="integration-github-repo">
        仓库地址
      </label>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          id="integration-github-repo"
          aria-describedby="integration-github-repo-hint"
          className="h-9 flex-1 rounded-lg border-slate-200/90 text-sm"
          value={repoUrl}
          onChange={(event) => setRepoUrl(event.target.value)}
          placeholder="https://github.com/owner/repo"
          maxLength={400}
          disabled={Boolean(busy)}
        />
        <Button type="submit" className="h-9 shrink-0 rounded-lg px-3.5 text-xs" loading={busy === "bind"} disabled={Boolean(busy) || !repoUrl.trim()}>
          绑定仓库
        </Button>
      </div>
      <p id="integration-github-repo-hint" className="text-[11px] text-slate-500">
        在目标仓库安装 GroupProof GitHub App 后，填写仓库地址即可绑定。
      </p>
    </form>
  );

  return (
    <section aria-labelledby="github-binding-title" className="min-w-0 overflow-hidden rounded-2xl border border-slate-200/85 bg-white shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/60 px-4 py-2.5">
        <h3 id="github-binding-title" className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <GitBranch size={14} className="text-slate-600" aria-hidden="true" />
          GitHub 仓库
        </h3>
        {repos.isPending ? (
          <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">
            读取中…
          </span>
        ) : connected ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200/80 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
            已连接 · {entries?.length}
          </span>
        ) : entries?.length === 0 ? (
          <span className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-500">
            未绑定
          </span>
        ) : null}
      </div>

      <div className="min-w-0 space-y-3 p-4">
        {repos.isPending && <p role="status" className="text-xs text-slate-500">正在读取仓库绑定…</p>}
        {repos.isError && (
          <Feedback tone="error">
            {integrationErrorText(repos.error, "GitHub", "read")}{" "}
            <button type="button" className="gp-link ml-2" onClick={() => void repos.refetch()}>
              重试读取
            </button>
          </Feedback>
        )}

        {connected && entries && (
          <>
            <ul className="space-y-2">
              {entries.map((repo) => (
                <li
                  key={`${repo.owner}/${repo.repo}`}
                  className="rounded-xl border border-emerald-200/75 bg-emerald-50/35 px-3 py-2.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
                      <a
                        href={`https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`}
                        className="gp-link inline-flex min-w-0 items-center gap-1 break-all text-sm font-semibold"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <span>{repo.owner}/{repo.repo}</span>
                        <ExternalLink size={12} className="shrink-0 opacity-70" aria-hidden="true" />
                      </a>
                    </div>
                    <span className="inline-flex shrink-0 items-center rounded-md border border-slate-200/80 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600">
                      默认分支 {repo.default_branch}
                    </span>
                  </div>
                  <p className="mt-1 pl-4 text-xs text-slate-500">
                    {repo.last_synced_at
                      ? `上次同步 ${new Date(repo.last_synced_at).toLocaleString("zh-CN")}`
                      : "尚未同步开发活动"}
                  </p>
                </li>
              ))}
            </ul>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                {writable && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1.5 rounded-lg px-3 text-xs"
                    loading={busy === "sync"}
                    disabled={Boolean(busy)}
                    onClick={() => void perform("sync")}
                  >
                    <RefreshCw size={12} aria-hidden="true" />
                    同步开发活动
                  </Button>
                )}
                <Link
                  className="inline-flex h-8 items-center rounded-lg px-2.5 text-xs font-medium text-[var(--gp-action)] transition-colors hover:bg-sky-50"
                  href={`/projects/${projectId}/github`}
                >
                  查看开发活动
                </Link>
              </div>

              {writable && (
                <button
                  type="button"
                  aria-expanded={showBindForm}
                  className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200/80 bg-white px-2.5 text-xs font-medium text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900"
                  onClick={() => setShowBindForm((open) => !open)}
                >
                  {showBindForm ? "收起" : "更换 / 添加绑定"}
                  <ChevronDown
                    size={13}
                    aria-hidden="true"
                    className={showBindForm ? "rotate-180 transition-transform" : "transition-transform"}
                  />
                </button>
              )}
            </div>

            {writable && showBindForm && (
              <div className="border-t border-slate-100 pt-3">{bindForm}</div>
            )}
          </>
        )}

        {entries?.length === 0 && (
          <>
            <p className="text-xs text-slate-500">
              项目还没有绑定仓库。同步默认分支及活跃分支（含 develop）的提交、PR 与 CI 活动。
            </p>
            {writable && bindForm}
          </>
        )}

        {!!failure && (
          <Feedback tone="error">
            {integrationErrorText(failure, "GitHub", "write")}{" "}
            {installUrl && (
              <a href={installUrl} target="_blank" rel="noopener noreferrer" className="gp-link ml-2">
                打开 GitHub 安装页
              </a>
            )}
          </Feedback>
        )}
        {notice && <Feedback tone="success">{notice}</Feedback>}
      </div>
    </section>
  );
}
