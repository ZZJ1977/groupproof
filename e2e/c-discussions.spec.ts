import { expect, test } from "@playwright/test";

test("C6-01 create supports four same-project references, duplicate click and discard confirmation", async ({ page }) => {
  await page.goto("/projects/project-1/discussions");
  await page.getByRole("button", { name: "新建讨论", exact: true }).click();
  await page.getByLabel("讨论标题", { exact: true }).fill("C6 four references");
  await page.getByLabel("讨论内容", { exact: true }).fill("Keep this source text for the linked objects.");
  await page.getByRole("combobox", { name: "关联任务", exact: true }).selectOption("task-3");
  await page.getByRole("combobox", { name: "关联需求", exact: true }).selectOption("req-1");
  await page.getByRole("combobox", { name: "关联模块", exact: true }).selectOption("module-1");
  await page.getByRole("combobox", { name: "关联里程碑", exact: true }).selectOption("milestone-1");
  await page.getByRole("button", { name: "发布讨论", exact: true }).evaluate((button) => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(page.getByRole("button", { name: "打开讨论：C6 four references", exact: true })).toHaveCount(1);
  await expect(page).toHaveURL(/discussion=discussion-/);
  await page.reload();
  await expect(page.getByRole("button", { name: "打开讨论：C6 four references", exact: true })).toHaveAttribute("aria-pressed", "true");
  const thread = await page.evaluate(() => JSON.parse(localStorage.getItem("groupproof-v1-workspace:c-url-fixture")!).discussions.find((item: { title: string }) => item.title === "C6 four references"));
  expect([thread.taskId, thread.requirementId, thread.moduleId, thread.milestoneId]).toEqual(["task-3", "req-1", "module-1", "milestone-1"]);
  await page.getByRole("button", { name: "新建讨论", exact: true }).click();
  await page.getByLabel("讨论标题", { exact: true }).fill("Unsaved draft");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByLabel("讨论标题", { exact: true })).toHaveValue("Unsaved draft");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByLabel("讨论标题", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "打开讨论：Unsaved draft", exact: true })).toHaveCount(0);
});

test("C6-02 replies stay in their thread with drafts and mentions preserved", async ({ page }) => {
  await page.goto("/projects/project-1/discussions?discussion=discussion-1");
  await page.getByLabel("发表回复", { exact: true }).fill("Thread one draft");
  await page.getByRole("button", { name: "打开讨论：证据引用格式", exact: true }).click();
  await expect(page.getByLabel("发表回复", { exact: true })).toHaveValue("");
  await page.getByLabel("发表回复", { exact: true }).fill("Thread two response");
  await page.getByLabel("提及成员", { exact: true }).selectOption("member-2");
  await page.getByRole("button", { name: "发送", exact: true }).evaluate((button) => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(page.getByLabel("当前讨论回复")).toContainText("Thread two response");
  await expect(page.getByLabel("当前讨论回复")).toContainText("提及：李四");
  await page.getByRole("button", { name: "打开讨论：M2 验收清单确认", exact: true }).click();
  await expect(page.getByLabel("发表回复", { exact: true })).toHaveValue("Thread one draft");
  await expect(page.getByLabel("当前讨论回复")).not.toContainText("Thread two response");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByLabel("当前讨论回复")).toContainText("Thread one draft");
  await page.reload();
  await expect(page).toHaveURL(/discussion=discussion-1/);
  await expect(page.getByLabel("当前讨论回复")).toContainText("Thread one draft");
  await page.getByRole("button", { name: "打开讨论：证据引用格式", exact: true }).click();
  await expect(page.getByLabel("当前讨论回复").getByText("Thread two response @李四", { exact: true })).toHaveCount(1);
  await page.goBack();
  await expect(page.getByRole("button", { name: "打开讨论：M2 验收清单确认", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("C6-03 important discussion persists and produces an immutable local candidate snapshot", async ({ page }) => {
  await page.goto("/projects/project-1/discussions?discussion=discussion-2");
  await page.getByLabel("重要标记原因", { exact: true }).fill("作为证据引用规范的依据");
  await page.getByRole("button", { name: "标记重要", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "标记为重要", exact: true })).toBeChecked();
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "标记为重要", exact: true })).toBeChecked();
  await page.getByRole("combobox", { name: "证据关联任务", exact: true }).selectOption("task-3");
  await page.getByRole("checkbox", { name: /^AC-1 ·/ }).check();
  await page.getByRole("button", { name: "保存候选证据（演示）", exact: true }).evaluate((button) => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(page.getByText("讨论快照已保存为本地候选证据，尚未成为正式证据；真实来源服务与通知未接入。", { exact: true })).toBeVisible();
  await page.getByLabel("发表回复", { exact: true }).fill("Reply added after capture");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByLabel("当前讨论回复")).toContainText("Reply added after capture");
  const candidates = await page.evaluate(() => JSON.parse(localStorage.getItem("groupproof-v1-workspace:c-url-fixture")!).evidence.filter((item: { source: string; sourceRecordId: string }) => item.source === "discussion" && item.sourceRecordId === "discussion-2"));
  expect(candidates).toHaveLength(1);
  expect(candidates[0].status).toBe("candidate");
  expect(candidates[0].sourceUrl).toBeUndefined();
  expect(candidates[0].sourceSnapshot.record.replies).toEqual([]);
  expect(candidates[0].sourceChanged).toBe(true);
  await page.getByRole("link", { name: "查看讨论来源证据", exact: true }).click();
  await expect(page).toHaveURL(/source=discussion/);
  await expect(page.getByRole("row").filter({ hasText: "重要讨论：证据引用格式" })).toContainText("候选证据");
});

test("C6 failed local save retains the create draft and retries only once", async ({ page }) => {
  await page.goto("/projects/project-1/discussions");
  await page.getByRole("button", { name: "新建讨论", exact: true }).click();
  await page.getByLabel("讨论标题", { exact: true }).fill("C6 retry after quota");
  await page.getByLabel("讨论内容", { exact: true }).fill("Must survive failed persistence.");
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    let failOnce = true;
    Storage.prototype.setItem = function (key, value) {
      if (failOnce && key.startsWith("groupproof-v1-workspace:")) { failOnce = false; throw new DOMException("Quota", "QuotaExceededError"); }
      return original.call(this, key, value);
    };
  });
  await page.getByRole("button", { name: "发布讨论", exact: true }).click();
  await expect(page.getByText("保存失败，请重试；当前状态未变更。", { exact: true })).toBeVisible();
  await expect(page.getByLabel("讨论标题", { exact: true })).toHaveValue("C6 retry after quota");
  await expect(page.getByRole("button", { name: "打开讨论：C6 retry after quota", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "发布讨论", exact: true }).click();
  await expect(page.getByRole("button", { name: "打开讨论：C6 retry after quota", exact: true })).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole("button", { name: "打开讨论：C6 retry after quota", exact: true })).toHaveCount(1);
});
