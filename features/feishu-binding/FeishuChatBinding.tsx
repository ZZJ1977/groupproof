"use client";

import { useCallback, useEffect, useState } from "react";

type Envelope<T> = { data: T };
type ErrorBody = { error?: { code?: string; message?: string } };
type LinkedChat = { chat_id: string; linked_at: string };
type AvailableChat = { chat_id: string; name: string };
type SyncResult = { chats: number; created: number; updated: number; deleted: number; seen: number };

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
  constructor(readonly status: number, message: string) {
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
  const payload = (await response.json().catch(() => null)) as Envelope<T> & ErrorBody;
  if (!response.ok) {
    throw new RequestError(response.status, payload?.error?.message ?? "操作失败，请稍后重试。");
  }
  return payload.data;
}

/** 将后端的错误状态转换成用户能理解的提示。 */
function friendly(error: unknown): string {
  if (error instanceof RequestError) {
    if (error.status === 503) return "飞书暂时不可用，请稍后重试。";
    if (error.status === 403) return "只有项目负责人可以绑定飞书群。";
    if (error.status === 404) return "项目不存在或你没有访问权限。";
    return error.message;
  }
  return "网络异常，请稍后重试。";
}

export function FeishuChatBinding({ projectId }: { projectId: string }) {
  const base = `/api/v1/a/projects/${projectId}/feishu`;
  const [linked, setLinked] = useState<LinkedChat[] | null>(null);
  const [available, setAvailable] = useState<AvailableChat[] | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [message, setMessage] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const loadLinked = useCallback(async () => {
    try {
      setLinked(await request<LinkedChat[]>("GET", `${base}/chats`));
    } catch (error) {
      setMessage(friendly(error));
    }
  }, [base]);

  useEffect(() => {
    void loadLinked();
  }, [loadLinked]);

  async function loadAvailable() {
    setBusy(true);
    setMessage("");
    try {
      const chats = await request<AvailableChat[]>("GET", `${base}/available-chats`);
      setAvailable(chats);
      setSelected(chats[0]?.chat_id ?? "");
      if (chats.length === 0) {
        setMessage("机器人还不在任何群里，请先在飞书群里添加机器人，然后再试一次。");
      }
    } catch (error) {
      setMessage(friendly(error));
    } finally {
      setBusy(false);
    }
  }

  async function bind() {
    if (!selected) return;
    setBusy(true);
    setMessage("");
    try {
      await request("POST", `${base}/chats`, { chat_id: selected });
      setAvailable(null);
      setMessage("已绑定。");
      await loadLinked();
    } catch (error) {
      setMessage(friendly(error));
    } finally {
      setBusy(false);
    }
  }

  async function sync() {
    setBusy(true);
    setMessage("");
    try {
      const result = await request<SyncResult>("POST", `${base}/sync`);
      setMessage(`同步完成：读取 ${result.seen} 条，新增 ${result.created} 条，更新 ${result.updated} 条。`);
    } catch (error) {
      setMessage(friendly(error));
    } finally {
      setBusy(false);
    }
  }

  const bound = linked !== null && linked.length > 0;

  return (
    <main style={{ maxWidth: 560, margin: "40px auto", padding: "0 16px", fontFamily: "inherit" }}>
      <h1 style={{ fontSize: 22, fontWeight: 600 }}>飞书群</h1>
      <p style={{ color: "#666", marginTop: 4 }}>把项目绑定到一个飞书群，之后可以同步群里的消息作为协作证据。</p>

      <section style={{ marginTop: 24, padding: 16, border: "1px solid #ddd", borderRadius: 8 }}>
        {linked === null && <p role="status">正在读取绑定状态…</p>}

        {linked !== null && bound && (
          <>
            <p>已绑定 {linked.length} 个群。</p>
            <button type="button" onClick={sync} disabled={busy} style={buttonStyle}>
              立即同步
            </button>
          </>
        )}

        {linked !== null && !bound && (
          <>
            <p>还没有绑定飞书群。</p>
            <p style={{ color: "#666", fontSize: 14 }}>请先把机器人拉进要同步的群，再点下面的按钮。</p>
            {available === null && (
              <button type="button" onClick={loadAvailable} disabled={busy} style={buttonStyle}>
                选择群
              </button>
            )}
            {available !== null && available.length > 0 && (
              <div style={{ display: "grid", gap: 12, marginTop: 8 }}>
                <label>
                  选择群：
                  <select value={selected} onChange={(event) => setSelected(event.target.value)} disabled={busy} style={fieldStyle}>
                    {available.map((chat) => (
                      <option key={chat.chat_id} value={chat.chat_id}>
                        {chat.name || "未命名的群"}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" onClick={bind} disabled={busy || !selected} style={buttonStyle}>
                  绑定
                </button>
              </div>
            )}
          </>
        )}

        {message && (
          <p role="status" style={{ marginTop: 12 }}>
            {message}
          </p>
        )}
      </section>
    </main>
  );
}
