import assert from "node:assert/strict";
import { seedData } from "../mocks/seed.ts";
import { createCommandRunner } from "../lib/commands/core.ts";
import { notificationPage, setNotificationRead } from "../features/c/notification-actions.ts";

const data = structuredClone(seedData);
const actorId = data.currentUserId;
const context = { actorId, now: "2026-10-11T15:00:00Z", logId: "unused" };
const template = data.notifications[0];
data.notifications = Array.from({ length: 25 }, (_, index) => ({ ...template, id: `notice-${String(index).padStart(2, "0")}`, userId: actorId, type: index % 2 ? "system" : "project", read: false }));
data.notifications.push({ ...template, id: "other", userId: "someone-else", read: false });
assert.equal(notificationPage(data, actorId, "all", 1).items.length, 10);
assert.equal(notificationPage(data, actorId, "all", 3).items.length, 5);
assert.equal(notificationPage(data, actorId, "all", 999).page, 3);
assert.equal(notificationPage(data, actorId, "all", -1).page, 1);
assert.equal(notificationPage(data, actorId, "system", 1).total, 12);
assert.equal(notificationPage(data, actorId, "system", 1).unread, 25);
assert.equal(notificationPage(data, "someone-else", "all", 1).total, 1);
assert.throws(() => setNotificationRead.apply(data, context, { scope: "one", id: "other", read: true }), /只能处理/);
assert.throws(() => setNotificationRead.apply(data, { ...context, actorId: "unknown" }, { scope: "all", read: true }), /当前账户/);
const disabled = structuredClone(data); disabled.users.find((item) => item.id === actorId).status = "disabled";
assert.throws(() => setNotificationRead.apply(disabled, context, { scope: "all", read: true }), /当前账户/);
const all = setNotificationRead.apply(data, context, { scope: "all", read: true });
assert.equal(all.result, 25);
assert.equal(all.data.notifications.find((item) => item.id === "other").read, false);
assert.equal(notificationPage(all.data, actorId, "all", 1).unread, 0);
assert.equal(setNotificationRead.apply(all.data, context, { scope: "all", read: true }).result, 0);
assert.deepEqual(all.data.actionItems, data.actionItems);
assert.equal(data.notifications[0].read, false);
let stored = data; let fail = true; let updated = 0; let saves = 0;
const run = createCommandRunner({ repository: {
  read: async () => stored,
  save: async (next) => { saves += 1; if (fail) throw new Error("quota"); stored = next; },
}, currentActorId: () => actorId, onSaved: () => { updated += 1; } });
assert.equal((await run(setNotificationRead, { scope: "all", read: true })).ok, false);
assert.equal(updated, 0);
assert.equal(notificationPage(stored, actorId, "all", 1).unread, 25);
fail = false;
assert.equal((await run(setNotificationRead, { scope: "all", read: true })).ok, true);
assert.equal(saves, 2);
assert.equal(updated, 1);
assert.equal(notificationPage(stored, actorId, "all", 1).unread, 0);
await run(setNotificationRead, { scope: "one", id: "notice-00", read: false });
assert.equal(notificationPage(stored, actorId, "all", 1).unread, 1);
console.log("C1 notifications: 24 assertions passed");
