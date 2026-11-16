import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// No page.route(), mocked fetch, session injection, or demo header. All product
// traffic crosses Next's proxy, real authentication and committed PostgreSQL.
type Fixture = { project: string; task: string; criterion: string; users: Record<string, { id: string; name: string; email: string }> };
const api = "http://127.0.0.1:18007";
const controlHeaders = { "X-C-Browser-Control": process.env.C_BROWSER_CONTROL_TOKEN! };
async function seed(request: APIRequestContext): Promise<Fixture> {
  const response = await request.post(`${api}/__test/seed`, { headers: controlHeaders });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function database(request: APIRequestContext, fixture: Fixture) {
  const response = await request.get(`${api}/__test/state/${fixture.project}`, { headers: controlHeaders });
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function signIn(page: Page, fixture: Fixture, actor: string, target: string) {
  await page.goto(`/login?returnTo=${encodeURIComponent(target)}`);
  await page.getByRole("button", { name: /Google/ }).click();
  await expect(page.getByRole("heading", { name: "Isolated OIDC test issuer" })).toBeVisible();
  await page.getByRole("button", { name: fixture.users[actor].name, exact: true }).click();
  await expect(page).toHaveURL(`http://127.0.0.1:13007${target}`);
  const response = await page.request.get("/api/v1/auth/session");
  const payload = await response.json();
  const session = payload.data ?? payload;
  expect(session.user.id).toBe(fixture.users[actor].id);
  expect(session.authMethod).toBe("google");
  expect(session.canEnterWorkspace).toBe(true);
  return session;
}

test("Google identity persists C evidence and completes D acceptance through the real proxy", async ({ page, request }) => {
  test.setTimeout(180_000);
  const fixture = await seed(request);
  const path = `/projects/${fixture.project}/tasks/${fixture.task}`;
  await signIn(page, fixture, "member", path);
  await expect(page.getByText("真实登录后通过代理保存到 PostgreSQL。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "开始任务", exact: true }).click();
  await page.getByRole("button", { name: "更新进度", exact: true }).click();
  await page.getByRole("spinbutton", { name: "任务进度", exact: true }).fill("100");
  await page.getByRole("textbox", { name: "进度变更原因", exact: true }).fill("真实浏览器完成实现，仍等待验收");
  await page.getByRole("button", { name: "保存进度", exact: true }).click();
  await expect(page.getByText("状态：进行中 · 进度：100%", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("状态：进行中 · 进度：100%", { exact: true })).toBeVisible();
  await page.goto(`${path}/submit`);
  for (const body of ["浏览器实现说明第一版", "浏览器实现说明第二版"]) {
    await page.getByRole("button", { name: "编辑任务说明", exact: true }).click();
    await page.getByRole("textbox", { name: "说明正文", exact: true }).fill(body);
    await page.getByRole("button", { name: "保存说明新版本", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "说明正文", exact: true })).toHaveCount(0);
  }
  await page.getByRole("textbox", { name: "证据标题", exact: true }).fill("真实浏览器候选证据");
  await page.getByRole("textbox", { name: "证据说明", exact: true }).fill("候选内容经真实接口保存");
  await page.getByRole("combobox", { name: "来源类型", exact: true }).selectOption("task_note");
  await page.getByRole("combobox", { name: "来源记录", exact: true }).selectOption({ label: "浏览器真实执行任务 · v2" });
  await page.getByRole("checkbox", { name: "刷新后保留原始证据", exact: true }).check();
  await page.getByRole("button", { name: "保存候选证据", exact: true }).click();
  await expect(page.getByText("候选证据已保存，需经采纳后才是正式证据。", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("真实浏览器候选证据", { exact: true })).toBeVisible();
  const saved = await database(request, fixture);
  expect(saved.task).toMatchObject({ status: "in_progress", progress: 100, version: 2 });
  expect(saved.notes.map((row: { body: string; version: number }) => [row.version, row.body])).toEqual([[1, "浏览器实现说明第一版"], [2, "浏览器实现说明第二版"]]);
  expect(saved.evidence).toEqual([expect.objectContaining({ title: "真实浏览器候选证据", status: "candidate", author: fixture.users.member.id })]);
  expect(saved.criteria).toEqual([fixture.criterion]);
  expect(saved.snapshots).toHaveLength(1);
  expect(JSON.stringify(saved.snapshots[0].content)).toContain("浏览器实现说明第二版");
  expect(saved.progress).toHaveLength(2);
  expect(saved.progress.every((row: { actor: string }) => row.actor === fixture.users.member.id)).toBe(true);
  expect(saved.sessions).toEqual([expect.objectContaining({ method: "google", revoked: false })]);

  // Continue through D's UI with the same real session and C's retained evidence.
  await page.goto(`/projects/${fixture.project}/evidence?evidence=${saved.evidence[0].id}`);
  await page.getByRole("button", { name: "采纳为正式证据", exact: true }).click();
  await page.getByRole("textbox", { name: "证据决定原因", exact: true }).fill("逐条核对说明及来源版本");
  await page.getByRole("button", { name: "确认决定", exact: true }).click();
  await expect(page.getByText("证据已采纳为正式；验收结论需由验收服务决定。", { exact: true })).toBeVisible();
  await page.goto(`${path}/submit`);
  await page.getByRole("button", { name: "检查完整性", exact: true }).click();
  await expect(page.getByRole("heading", { name: "证据完整性检查", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "重新检查", exact: true }).click();
  await expect(page.getByText("检查快照已保存", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "进入验收", exact: true }).click();
  await expect(page.getByText("任务已进入待验收", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "查看验收结果", exact: true }).click();
  await page.getByRole("button", { name: "运行自动验收", exact: true }).click();
  await expect(page.getByText("已保存逐条验收建议", { exact: true })).toBeVisible();
  expect((await database(request, fixture)).task.status).toBe("pending_verification");
  await page.getByRole("textbox", { name: "人工判断原因", exact: true }).fill("人工逐项确认完成");
  await page.getByRole("spinbutton", { name: "我的实际承担比例（%）", exact: true }).fill("100");
  await page.getByRole("button", { name: "确认验收结果", exact: true }).click();
  await expect(page.getByText("人工决定已保存", { exact: true })).toBeVisible();
  expect((await database(request, fixture)).task.status).toBe("completed");
  await page.goto(`${path}?tab=verification`);
  await expect(page.getByText("状态：已完成 · 进度：100%", { exact: true })).toBeVisible();
  await expect(page.getByText("已生成正式成果", { exact: true })).toBeVisible();
});

test("another Google user cannot read or start a foreign task and writes leave the database unchanged", async ({ page, request }) => {
  const fixture = await seed(request);
  const session = await signIn(page, fixture, "outsider", `/projects/${fixture.project}/tasks/${fixture.task}`);
  await expect(page.locator("main").getByRole("alert").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "开始任务", exact: true })).toHaveCount(0);
  const read = await page.request.get(`/api/v1/tasks/${fixture.task}/execution`);
  expect(read.status()).toBe(403);
  const write = await page.request.post(`/api/v1/tasks/${fixture.task}/start`, {
    headers: { "X-CSRF-Token": session.csrfToken, Origin: "http://127.0.0.1:13007" }, data: { expected_version: 0 },
  });
  expect(write.status()).toBe(403);
  const saved = await database(request, fixture);
  expect(saved.task).toMatchObject({ status: "not_started", progress: 0, version: 0 });
  expect(saved.progress).toEqual([]);
  expect(saved.evidence).toEqual([]);
});

test("a valid Google session cannot mutate C without the matching CSRF token and origin", async ({ page, request }) => {
  const fixture = await seed(request);
  const session = await signIn(page, fixture, "member", `/projects/${fixture.project}/tasks/${fixture.task}`);
  await expect(page.getByRole("button", { name: "开始任务", exact: true })).toBeVisible();
  const headers: Record<string, string>[] = [
    { Origin: "http://127.0.0.1:13007" },
    { Origin: "http://127.0.0.1:13007", "X-CSRF-Token": "incorrect-csrf-token" },
    { Origin: "https://untrusted.example", "X-CSRF-Token": session.csrfToken },
  ];
  for (const value of headers) {
    const denied = await page.request.post(`/api/v1/tasks/${fixture.task}/start`, {
      headers: value, data: { expected_version: 0 },
    });
    expect(denied.status()).toBe(403);
    const saved = await database(request, fixture);
    expect(saved.task).toMatchObject({ status: "not_started", progress: 0, version: 0 });
    expect(saved.progress).toEqual([]);
  }
  // The same authenticated browser remains authorized for ordinary reads.
  expect((await page.request.get(`/api/v1/tasks/${fixture.task}/execution`)).status()).toBe(200);
});

test("Admin disable revokes an existing Google session and denies subsequent C reads and writes", async ({ browser, page, request }) => {
  const fixture = await seed(request);
  const memberSession = await signIn(page, fixture, "member", `/projects/${fixture.project}/tasks/${fixture.task}`);
  await expect(page.getByRole("button", { name: "开始任务", exact: true })).toBeVisible();
  const adminContext = await browser.newContext({ baseURL: "http://127.0.0.1:13007", locale: "zh-CN" });
  try {
    const adminPage = await adminContext.newPage();
    await signIn(adminPage, fixture, "admin", `/admin/users?q=${encodeURIComponent(fixture.users.member.email)}`);
    await expect(adminPage.getByRole("button", { name: "查看", exact: true })).toHaveCount(1);
    await adminPage.getByRole("button", { name: "查看", exact: true }).click();
    await adminPage.getByLabel("处理原因", { exact: true }).fill("真实联调核实停用会撤销已有会话");
    const disabled = adminPage.waitForResponse(`**/api/v1/c-admin/users/${fixture.users.member.id}/disable`);
    await adminPage.getByRole("button", { name: "确认停用", exact: true }).click();
    const receipt = await disabled;
    expect(receipt.status()).toBe(200);
    const { data } = await receipt.json();
    expect(data).toMatchObject({ id: fixture.users.member.id, status: "disabled", inboxNotified: expect.any(Boolean) });
    const confirmation = data.inboxNotified
      ? "账号已停用，停用原因已写入该账号的站内收件箱。"
      : "账号已停用，站内通知服务尚未接入。";
    await expect(adminPage.getByText(confirmation, { exact: true })).toBeVisible();
    const read = await page.request.get(`/api/v1/tasks/${fixture.task}/execution`);
    expect(read.status()).toBe(401);
    const write = await page.request.post(`/api/v1/tasks/${fixture.task}/start`, {
      headers: { "X-CSRF-Token": memberSession.csrfToken, Origin: "http://127.0.0.1:13007" }, data: { expected_version: 0 },
    });
    expect(write.status()).toBe(401);
    await page.getByRole("button", { name: "刷新任务", exact: true }).click();
    await expect(page.getByRole("button", { name: "开始任务", exact: true })).toHaveCount(0);
    const saved = await database(request, fixture);
    expect(saved.member.status).toBe("disabled");
    expect(saved.sessions).toEqual([expect.objectContaining({ method: "google", revoked: true })]);
    expect(saved.progress).toEqual([]);
    expect(saved.task.status).toBe("not_started");
    expect(saved.audit).toContain("user.disabled");
  } finally { await adminContext.close(); }
});
