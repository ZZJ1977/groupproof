"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Feedback, Panel } from "@/components/common";
import { Button } from "@/components/ui/button";
import type { components } from "@/packages/domain/api.generated";
import { ProjectRequestError, integrationErrorText, projectRequest } from "@/features/github-binding/integration-request";

type LinkedChat = components["schemas"]["LinkedFeishuChatDTO"];
type AvailableChat = components["schemas"]["FeishuAvailableChatDTO"];
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
  const [available, setAvailable] = useState<AvailableChat[] | null>(null);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState<"list" | "bind" | "sync" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const entries = linked.isSuccess ? linked.data : null;
  const writable = canManage && linked.isSuccess;
  const choices = available?.filter((chat) => !entries?.some((row) => row.chat_id === chat.chat_id)) ?? [];
  const chosen = choices.find((chat) => chat.chat_id === selected);

  async function perform(action: "list" | "bind" | "sync") {
    if (!writable || busy) return;
    setBusy(action);
    setFailure(null);
    setNotice(null);
    try {
      if (action === "list") {
        setAvailable(null);
        setSelected("");
        setAvailable(await projectRequest<AvailableChat[]>(`${base}/available-chats`));
      } else if (action === "bind" && chosen) {
        await projectRequest(`${base}/chats`, { method: "POST", body: { chat_id: chosen.chat_id } });
        setSelected("");
        setNotice(`已绑定飞书群 ${chosen.name || chosen.chat_id}。`);
        await linked.refetch();
      } else if (action === "sync") {
        const result = await projectRequest<SyncResult>(`${base}/sync`, { method: "POST" });
        setNotice(`同步完成，读取 ${result.seen} 条，新增 ${result.created} 条，更新 ${result.updated} 条。`);
      }
    } catch (error) {
      setFailure(error);
      if (error instanceof ProjectRequestError && [401, 403, 404].includes(error.status)) {
        setAvailable(null);
        setSelected("");
        await linked.refetch();
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
        {entries.map((chat) => {
          const name = available?.find((item) => item.chat_id === chat.chat_id)?.name;
          return <li key={chat.chat_id} className="rounded-md border border-border p-2 text-sm">
            <p className="break-all font-medium">{name || "群 " + chat.chat_id}</p>
            {name && <p className="mt-1 break-all text-[var(--gp-ink-soft)]">{chat.chat_id}</p>}
          </li>;
        })}
      </ul>}
      {writable && <div className="space-y-2">
        <p className="text-sm text-slate-600">把 GroupProof 机器人加入目标群，再读取可绑定的群列表。</p>
        <Button type="button" variant="outline" loading={busy === "list"} disabled={Boolean(busy)} onClick={() => void perform("list")}>{available === null ? "读取可绑定的群" : "刷新群列表"}</Button>
        {available && choices.length === 0 && <p className="text-sm text-slate-600">{available.length === 0 ? "机器人当前没有可读取的飞书群。" : "已绑定列表中所有可选群。"}</p>}
        {choices.length > 0 && <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); if (chosen) void perform("bind"); }}>
          <label className="block text-sm font-medium" htmlFor="integration-feishu-chat">选择飞书群</label>
          <select id="integration-feishu-chat" value={chosen?.chat_id ?? ""} onChange={(event) => setSelected(event.target.value)} disabled={Boolean(busy)} className="w-full rounded-md border border-border bg-white px-2 py-2 text-sm">
            <option value="">请选择群</option>
            {choices.map((chat) => <option key={chat.chat_id} value={chat.chat_id}>{chat.name || chat.chat_id}</option>)}
          </select>
          <Button type="submit" loading={busy === "bind"} disabled={Boolean(busy) || !chosen}>绑定飞书群</Button>
        </form>}
      </div>}
      {!!failure && <Feedback tone="error">{integrationErrorText(failure, "飞书", busy === "list" ? "read" : "write")}</Feedback>}
      {notice && <Feedback tone="success">{notice}</Feedback>}
      {!!entries?.length && <div className="flex flex-wrap items-center gap-3">
        {writable && <Button type="button" variant="outline" loading={busy === "sync"} disabled={Boolean(busy)} onClick={() => void perform("sync")}>同步协作记录</Button>}
        <Link className="gp-link text-sm" href={`/projects/${projectId}/collaboration`}>查看协作记录</Link>
      </div>}
    </Panel>
  );
}
