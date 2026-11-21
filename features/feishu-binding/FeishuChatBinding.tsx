"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Feedback, Panel } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { components } from "@/packages/domain/api.generated";
import { ProjectRequestError, integrationErrorText, projectRequest } from "@/features/github-binding/integration-request";

type LinkedChat = components["schemas"]["LinkedFeishuChatDTO"];
type SyncResult = components["schemas"]["FeishuSyncDTO"];

export function FeishuChatBinding({ projectId, userId, canManage }: {
  projectId: string; userId: string; canManage: boolean;
}) {
  const base = `/api/v1/a/projects/${projectId}/feishu`;
  const linked = useQuery({
    queryKey: ["project-integration-chats", userId, projectId],
    queryFn: ({ signal }) => projectRequest<LinkedChat[]>(`${base}/chats`, { signal }),
    gcTime: 0,
    retry: false,
  });
  const [chatId, setChatId] = useState("");
  const [busy, setBusy] = useState<"bind" | "sync" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const entries = linked.isSuccess ? linked.data : null;
  const writable = canManage && linked.isSuccess;

  async function perform(action: "bind" | "sync") {
    if (!writable || busy) return;
    setBusy(action);
    setFailure(null);
    setNotice(null);
    try {
      if (action === "bind") {
        const normalizedChatId = chatId.trim();
        if (!normalizedChatId) return;
        await projectRequest(`${base}/chats`, { method: "POST", body: { chat_id: normalizedChatId } });
        setChatId("");
        void linked.refetch();
        const result = await projectRequest<SyncResult>(`${base}/sync`, { method: "POST" });
        setNotice(`已接入飞书群并同步 ${result.seen} 条消息。`);
      } else if (action === "sync") {
        const result = await projectRequest<SyncResult>(`${base}/sync`, { method: "POST" });
        setNotice(`同步完成，读取 ${result.seen} 条，新增 ${result.created} 条，更新 ${result.updated} 条。`);
      }
    } catch (error) {
      setFailure(error);
      if (error instanceof ProjectRequestError && [401, 403, 404].includes(error.status)) {
        void linked.refetch();
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel title="飞书群" bodyClassName="space-y-4 min-w-0">
      <p className="text-sm text-[var(--gp-ink-soft)]">同步项目群中的协作消息。</p>
      {linked.isPending && <p role="status">正在读取飞书群绑定…</p>}
      {linked.isError && <Feedback tone="error">{integrationErrorText(linked.error, "飞书", "read")} <button type="button" className="gp-link ml-2" onClick={() => void linked.refetch()}>重试读取</button></Feedback>}
      {entries?.length === 0 && <p className="text-sm text-slate-600">项目还没有绑定飞书群。</p>}
      {!!entries?.length && <ul className="space-y-2">
        {entries.map((chat) => <li key={chat.chat_id} className="rounded-md border border-border p-2 text-sm">
          <p className="break-all font-medium">群 {chat.chat_id}</p>
        </li>)}
      </ul>}
      {writable && <div className="space-y-2">
        <p className="text-sm text-slate-600">把 GroupProof 机器人加入目标群，再粘贴群聊 ID。平台凭证与权限由 GroupProof 后台统一管理。</p>
        <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); if (chatId.trim()) void perform("bind"); }}>
          <label className="block text-sm font-medium" htmlFor="integration-feishu-chat">飞书群聊 ID</label>
          <Input id="integration-feishu-chat" value={chatId} onChange={(event) => setChatId(event.target.value)} placeholder="oc_..." autoComplete="off" disabled={Boolean(busy)} />
          <p className="text-xs text-[var(--gp-ink-soft)]">群聊 ID 以 oc_ 开头；接入时会校验机器人是否已在该群中。</p>
          <Button type="submit" loading={busy === "bind"} disabled={Boolean(busy) || !chatId.trim()}>接入并同步</Button>
        </form>
      </div>}
      {!!failure && <Feedback tone="error">{integrationErrorText(failure, "飞书", "write")}</Feedback>}
      {notice && <Feedback tone="success">{notice}</Feedback>}
      {!!entries?.length && <div className="flex flex-wrap items-center gap-3">
        {writable && <Button type="button" variant="outline" loading={busy === "sync"} disabled={Boolean(busy)} onClick={() => void perform("sync")}>同步协作记录</Button>}
        <Link className="gp-link text-sm" href={`/projects/${projectId}/collaboration`}>查看协作记录</Link>
      </div>}
    </Panel>
  );
}
