"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, MessageSquare, RefreshCw } from "lucide-react";
import { Feedback } from "@/components/common";
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
  const [showBindForm, setShowBindForm] = useState(false);
  const [busy, setBusy] = useState<"bind" | "sync" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const entries = linked.isSuccess ? linked.data : null;
  const connected = Boolean(entries && entries.length > 0);
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
        setShowBindForm(false);
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

  const bindForm = (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (chatId.trim()) void perform("bind");
      }}
    >
      <label className="block text-xs font-semibold text-slate-700" htmlFor="integration-feishu-chat">
        飞书群聊 ID
      </label>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          id="integration-feishu-chat"
          aria-describedby="integration-feishu-chat-hint"
          className="h-9 flex-1 rounded-lg border-slate-200/90 text-sm"
          value={chatId}
          onChange={(event) => setChatId(event.target.value)}
          placeholder="oc_..."
          autoComplete="off"
          disabled={Boolean(busy)}
        />
        <Button type="submit" className="h-9 shrink-0 rounded-lg px-3.5 text-xs" loading={busy === "bind"} disabled={Boolean(busy) || !chatId.trim()}>
          接入并同步
        </Button>
      </div>
      <p id="integration-feishu-chat-hint" className="text-[11px] text-slate-500">
        将 GroupProof 机器人拉入目标群后填写以 oc_ 开头的群聊 ID；平台凭证由后台统一管理。
      </p>
    </form>
  );

  return (
    <section aria-labelledby="feishu-binding-title" className="min-w-0 overflow-hidden rounded-2xl border border-slate-200/85 bg-white shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/60 px-4 py-2.5">
        <h3 id="feishu-binding-title" className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <MessageSquare size={14} className="text-slate-600" aria-hidden="true" />
          飞书群
        </h3>
        {linked.isPending ? (
          <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">
            读取中…
          </span>
        ) : connected ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200/80 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
            已接入 · {entries?.length}
          </span>
        ) : entries?.length === 0 ? (
          <span className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-500">
            未接入
          </span>
        ) : null}
      </div>

      <div className="min-w-0 space-y-3 p-4">
        {linked.isPending && <p role="status" className="text-xs text-slate-500">正在读取飞书群绑定…</p>}
        {linked.isError && (
          <Feedback tone="error">
            {integrationErrorText(linked.error, "飞书", "read")}{" "}
            <button type="button" className="gp-link ml-2" onClick={() => void linked.refetch()}>
              重试读取
            </button>
          </Feedback>
        )}

        {connected && entries && (
          <>
            <ul className="space-y-2">
              {entries.map((chat) => (
                <li
                  key={chat.chat_id}
                  className="rounded-xl border border-emerald-200/75 bg-emerald-50/35 px-3 py-2.5"
                >
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
                    <p className="break-all text-sm font-semibold text-slate-900">群 {chat.chat_id}</p>
                  </div>
                  <p className="mt-1 pl-4 text-xs text-slate-500">
                    {chat.linked_at
                      ? `接入时间 ${new Date(chat.linked_at).toLocaleString("zh-CN")}`
                      : "已连接项目群协作消息同步"}
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
                    同步协作记录
                  </Button>
                )}
                <Link
                  className="inline-flex h-8 items-center rounded-lg px-2.5 text-xs font-medium text-[var(--gp-action)] transition-colors hover:bg-sky-50"
                  href={`/projects/${projectId}/collaboration`}
                >
                  查看协作记录
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
            <p className="text-xs text-slate-500">项目还没有绑定飞书群。同步项目群中的协作消息。</p>
            {writable && bindForm}
          </>
        )}

        {!!failure && <Feedback tone="error">{integrationErrorText(failure, "飞书", "write")}</Feedback>}
        {notice && <Feedback tone="success">{notice}</Feedback>}
      </div>
    </section>
  );
}
