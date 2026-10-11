import { z } from "zod";
import { DomainError, type Command } from "@/lib/commands/core";
import type { MockData, Notification } from "@/types/domain";

const readInput = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("all"), read: z.literal(true) }).strict(),
  z.object({ scope: z.literal("one"), id: z.string().min(1), read: z.boolean() }).strict(),
]);
export type NotificationReadInput = z.infer<typeof readInput>;

/** Local workspace command. A's persistent notification service remains the real adapter. */
export const setNotificationRead: Command<NotificationReadInput, number> = {
  name: "c.notifications.read",
  input: readInput,
  apply(data, context, input) {
    const actor = data.users.find((user) => user.id === context.actorId);
    if (!actor || actor.status !== "active") throw new DomainError("FORBIDDEN", "当前账户不能处理通知。");
    if (input.scope === "one") {
      const target = data.notifications.find((item) => item.id === input.id);
      if (!target || target.userId !== actor.id) throw new DomainError("FORBIDDEN", "只能处理发给自己的通知。");
    }
    let changed = 0;
    const notifications = data.notifications.map((item) => {
      if (item.userId !== actor.id || (input.scope === "one" && item.id !== input.id) || item.read === input.read) return item;
      changed += 1;
      return { ...item, read: input.read };
    });
    return { data: { ...data, notifications }, result: changed };
  },
};

export function notificationPage(data: MockData, actorId: string, tab: string, requestedPage: number) {
  const mine = data.notifications.filter((item) => item.userId === actorId);
  const timestamp = (value: string) => { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : 0; };
  const filtered = mine.filter((item) => tab === "all" || (tab === "unread" ? !item.read : item.type === tab))
    .sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt) || a.id.localeCompare(b.id));
  const pageCount = Math.max(1, Math.ceil(filtered.length / 10));
  const page = Math.min(pageCount, Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1);
  return { items: filtered.slice((page - 1) * 10, page * 10) as Notification[], total: filtered.length,
    unread: mine.filter((item) => !item.read).length, page, pageCount };
}
