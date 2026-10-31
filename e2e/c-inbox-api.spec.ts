import { expect, test, type Page, type Route } from "@playwright/test";
import type { components } from "../packages/domain/api.generated";

// HTTP contract fixtures only. No live A notification delivery or session is fabricated.
type Schema = components["schemas"];
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const actorId = id(801), projectId = id(802), taskId = id(803), courseId = id(804);
const good = (route: Route, data: unknown) => route.fulfill({ json: { data, meta: { request_id: "inbox-fixture" } } });
const bad = (route: Route, status: number) => route.fulfill({ status, json: { error: { code: status === 409 ? "VERSION_CONFLICT" : "UNAVAILABLE", message: "Fixture failure" }, meta: { request_id: "fixture-error" } } });
const record = (n: number): Schema["NotificationDTO"] => ({ id: id(900 + n), recipient_id: actorId,
  category: n % 2 ? "project" : "course", title: `通知 ${n}`, description: "真实接口契约测试内容",
  created_at: `2026-10-${String(12 - n).padStart(2, "0")}T08:00:00Z`, read_at: n === 0 ? "2026-10-12T08:10:00Z" : null,
  lock_version: n === 0 ? 1 : 0, target: { kind: "task", id: taskId, project_id: projectId, course_id: null },
  href: "https://untrusted.example/ignore-this" });

async function setup(page: Page) {
  const state = { rows: Array.from({ length: 12 }, (_, i) => record(i)), version: 3, readFailure: 0, queryFailure: 0, malformed: false };
  const requests: URL[] = [];
  const writes: { path: string; key: string | null; body: Record<string, unknown> }[] = [];
  await page.route("**/api/v1/me/notifications**", async (route) => {
    const request = route.request(), url = new URL(request.url()); requests.push(url);
    if (request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({ path: url.pathname, key: request.headers()["idempotency-key"] ?? null, body });
      if (state.readFailure) { const status = state.readFailure; state.readFailure = 0; return bad(route, status); }
      if (body.expected_inbox_version !== state.version || body.snapshot_id !== id(state.version)) return bad(route, 409);
      const all = url.pathname.endsWith("/read-all"), notificationId = all ? null : url.pathname.split("/").at(-2)!;
      const before = state.rows.filter((row) => !row.read_at).length;
      const stamp = new Date().toISOString(); let count = 0;
      state.rows = state.rows.map((row) => {
        if ((all || row.id === notificationId) && !row.read_at) { count++; return { ...row, read_at: stamp, lock_version: row.lock_version + 1 }; }
        return row;
      });
      if (count) state.version++;
      return good(route, { recipient_id: actorId, operation: all ? "all" : "single", notification_id: notificationId,
        idempotency_key: request.headers()["idempotency-key"]!, snapshot_id: String(body.snapshot_id),
        expected_version: all ? null : Number(body.expected_version), expected_inbox_version: Number(body.expected_inbox_version),
        resulting_version: all ? null : state.rows.find((row) => row.id === notificationId)!.lock_version,
        resulting_inbox_version: state.version, total_all: state.rows.length, unread_before: before,
        unread_after: before - count, marked_count: count, read_at: stamp } satisfies Schema["NotificationReadReceipt"]);
    }
    if (state.queryFailure) return bad(route, state.queryFailure);
    const category = url.searchParams.get("category") || "all", readState = url.searchParams.get("state") || "all";
    const rows = state.rows.filter((row) => (category === "all" || row.category === category) && (readState === "all" || (readState === "read") === Boolean(row.read_at)));
    const pageNumber = Number(url.searchParams.get("page") || 1), offset = (pageNumber - 1) * 10;
    const payload: Schema["NotificationPageDTO"] = { items: rows.slice(offset, offset + 10), total: rows.length, total_all: state.rows.length,
      unread_total: state.rows.filter((row) => !row.read_at).length, page: pageNumber, page_size: 10, inbox_version: state.version, snapshot_id: id(state.version) };
    return state.malformed ? route.fulfill({ json: { data: payload } }) : good(route, payload);
  });
  return { state, writes, requests };
}

test("C1 notifications combine URL filters and paginate without mistaking page unread for total", async ({ page }) => {
  await setup(page); await page.goto("/notifications");
  await expect(page.getByText("全部通知 12 条 · 未读 11 条", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page).toHaveURL(/page=2/); await page.reload();
  await expect(page.getByText("通知 11", { exact: true })).toBeVisible();
  await expect(page.getByText("全部通知 12 条 · 未读 11 条", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "阅读状态", exact: true }).selectOption("unread");
  await page.getByRole("combobox", { name: "通知类别", exact: true }).selectOption("project");
  await page.getByRole("button", { name: "筛选通知", exact: true }).click();
  await expect(page).toHaveURL(/state=unread/); await expect(page).toHaveURL(/category=project/);
  await expect(page.getByText("共 6 条 · 第 1 页", { exact: true })).toBeVisible();
});

test("C1 failed single read retains unread state and stable key, duplicate click sends once", async ({ page }) => {
  const { state, writes } = await setup(page); state.readFailure = 503;
  await page.goto("/notifications");
  await page.getByRole("button", { name: "标为已读", exact: true }).first().evaluate((button) => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(page.locator("main").getByRole("alert")).toContainText("未更改页面中的已读状态");
  await expect(page.getByText("全部通知 12 条 · 未读 11 条", { exact: true })).toBeVisible();
  expect(writes).toHaveLength(1);
  await page.getByRole("button", { name: "标为已读", exact: true }).first().click();
  await expect(page.getByText("全部通知 12 条 · 未读 10 条", { exact: true })).toBeVisible();
  expect(writes).toHaveLength(2); expect(writes[0]).toEqual(writes[1]);
});

test("C1 all-read confirmation covers all categories and pages and retains failed state", async ({ page }) => {
  const { state, writes } = await setup(page); state.readFailure = 503;
  await page.goto("/notifications?category=project&state=unread");
  await page.getByRole("button", { name: "全部标为已读", exact: true }).click();
  await page.getByRole("button", { name: "确认全部已读", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toBeVisible();
  await expect(page.getByText("共 6 条 · 第 1 页", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "确认全部已读", exact: true }).click();
  await expect(page.getByText("全部通知 12 条 · 未读 0 条", { exact: true })).toBeVisible();
  expect(state.rows.every((row) => row.read_at)).toBe(true); expect(writes[0]).toEqual(writes[1]);
});

test("C1 snapshot conflict blocks stale retries until explicit refresh", async ({ page }) => {
  const { state, writes } = await setup(page); await page.goto("/notifications");
  await expect(page.getByText("全部通知 12 条 · 未读 11 条", { exact: true })).toBeVisible();
  state.version = 4;
  await page.getByRole("button", { name: "标为已读", exact: true }).first().click();
  await expect(page.locator("main").getByRole("alert")).toContainText("通知列表已变化");
  await expect(page.getByRole("button", { name: "标为已读", exact: true }).first()).toBeDisabled();
  await page.getByRole("button", { name: "刷新通知", exact: true }).click();
  await page.getByRole("button", { name: "标为已读", exact: true }).first().click();
  await expect(page.getByText("全部通知 12 条 · 未读 10 条", { exact: true })).toBeVisible();
  expect(writes.map((write) => write.body.expected_inbox_version)).toEqual([3, 4]);
  expect(writes[0].key).not.toBe(writes[1].key);
});

test("C1 denied refresh hides old notification content and controls", async ({ page }) => {
  const { state } = await setup(page); await page.goto("/notifications");
  await expect(page.getByText("通知 1", { exact: true })).toBeVisible(); state.queryFailure = 403;
  await page.getByRole("button", { name: "刷新通知", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("原有数据已隐藏");
  await expect(page.getByText("通知 1", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "全部标为已读", exact: true })).toHaveCount(0);
});

test("C1 notification links ignore arbitrary source URLs", async ({ page }) => {
  const { state } = await setup(page);
  state.rows[1].target = { kind: "task", id: "javascript:alert(1)", project_id: projectId, course_id: null };
  await page.goto("/notifications");
  await expect(page.getByRole("link", { name: "查看相关内容", exact: true }).first()).toHaveAttribute("href", `/projects/${projectId}/tasks/${taskId}`);
  await expect(page.locator('a[href^="https://untrusted.example"]')).toHaveCount(0);
  await expect(page.getByRole("link", { name: "查看相关内容", exact: true })).toHaveCount(9);
});

test("C1 action items use exact approval routes and expose no completion operation", async ({ page }) => {
  const requests: string[] = [];
  const rows: Schema["ActionItemDTO"][] = [
    { category: "member", target: { kind: "member_change", id: id(901), course_id: courseId, project_id: null } },
    { category: "appeal", target: { kind: "appeal", id: id(902), course_id: courseId, project_id: null } },
    { category: "rule", target: { kind: "baseline", id: projectId, project_id: projectId, course_id: null } },
  ].map((entry, index) => ({ ...entry, id: id(1000 + index), recipient_id: actorId, title: `待办 ${index}`, description: "原业务处理",
    status: "pending", priority: "high", created_at: "2026-10-12T08:00:00Z", due_at: null, href: "javascript:alert(1)" })) as Schema["ActionItemDTO"][];
  await page.route("**/api/v1/me/action-items**", (route) => { requests.push(route.request().method()); return good(route, { items: rows, total: 3, page: 1, page_size: 10 } satisfies Schema["ActionItemPageDTO"]); });
  await page.goto("/action-items");
  const links = page.getByRole("link", { name: "前往处理页面", exact: true });
  await expect(links.nth(0)).toHaveAttribute("href", `/teacher/courses/${courseId}/member-changes?request=${id(901)}`);
  await expect(links.nth(1)).toHaveAttribute("href", `/teacher/courses/${courseId}/appeals?appeal=${id(902)}`);
  await expect(links.nth(2)).toHaveAttribute("href", `/projects/${projectId}/setup`);
  await expect(page.getByRole("button", { name: /完成|通过|拒绝/ })).toHaveCount(0);
  expect(requests.every((method) => method === "GET")).toBe(true);
});

test("C1 unavailable or malformed sources show errors rather than empty inbox success", async ({ page }) => {
  const { state } = await setup(page); state.queryFailure = 503; await page.goto("/notifications");
  await expect(page.locator("main").getByRole("alert")).toContainText("服务暂不可用");
  await expect(page.getByText("没有符合条件的通知", { exact: true })).toHaveCount(0);
  state.queryFailure = 0; state.malformed = true;
  await page.getByRole("button", { name: "刷新通知", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("请求未成功");
});
