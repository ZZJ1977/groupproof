"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Feedback, Panel } from "@/components/common";
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
  const [busy, setBusy] = useState<"bind" | "sync" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const entries = repos.isSuccess ? repos.data : null;
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

  return (
    <Panel title="GitHub 仓库" bodyClassName="space-y-4 min-w-0">
      <p className="text-sm text-[var(--gp-ink-soft)]">同步默认分支代码与活跃分支（含 develop）的提交、PR 及 CI 活动。</p>
      {repos.isPending && <p role="status">正在读取仓库绑定…</p>}
      {repos.isError && <Feedback tone="error">{integrationErrorText(repos.error, "GitHub", "read")} <button type="button" className="gp-link ml-2" onClick={() => void repos.refetch()}>重试读取</button></Feedback>}
      {entries?.length === 0 && <p className="text-sm text-slate-600">项目还没有绑定仓库。</p>}
      {!!entries?.length && <ul className="space-y-2">
        {entries.map((repo) => (
          <li key={`${repo.owner}/${repo.repo}`} className="rounded-md border border-border p-2 text-sm">
            <a href={`https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`} className="gp-link break-all font-medium" target="_blank" rel="noopener noreferrer">{repo.owner}/{repo.repo}</a>
            <p className="mt-1 break-words text-[var(--gp-ink-soft)]">默认分支 {repo.default_branch} · {repo.last_synced_at ? `上次同步 ${new Date(repo.last_synced_at).toLocaleString("zh-CN")}` : "尚未同步"}</p>
          </li>
        ))}
      </ul>}
      {writable && <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); if (repoUrl.trim()) void perform("bind"); }}>
        <label className="block text-sm font-medium" htmlFor="integration-github-repo">仓库地址</label>
        <p id="integration-github-repo-hint" className="text-sm text-slate-600">在目标仓库安装 GroupProof GitHub App 后，填写仓库地址。</p>
        <Input id="integration-github-repo" aria-describedby="integration-github-repo-hint" value={repoUrl} onChange={(event) => setRepoUrl(event.target.value)} placeholder="https://github.com/owner/repo" maxLength={400} disabled={Boolean(busy)} />
        <Button type="submit" loading={busy === "bind"} disabled={Boolean(busy) || !repoUrl.trim()}>绑定仓库</Button>
      </form>}
      {!!failure && <Feedback tone="error">{integrationErrorText(failure, "GitHub", "write")} {installUrl && <a href={installUrl} target="_blank" rel="noopener noreferrer" className="gp-link ml-2">打开 GitHub 安装页</a>}</Feedback>}
      {notice && <Feedback tone="success">{notice}</Feedback>}
      {!!entries?.length && <div className="flex flex-wrap items-center gap-3">
        {writable && <Button type="button" variant="outline" loading={busy === "sync"} disabled={Boolean(busy)} onClick={() => void perform("sync")}>同步开发活动</Button>}
        <Link className="gp-link text-sm" href={`/projects/${projectId}/github`}>查看开发活动</Link>
      </div>}
    </Panel>
  );
}
