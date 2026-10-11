import { expect, test } from "@playwright/test";

test("C2-06 changing source clears all source-specific fields and criteria", async ({ page }) => {
  await page.goto("/projects/project-1/tasks/task-3/submit");
  await page.getByLabel("证据名称 *", { exact: true }).fill("Old GitHub source");
  await page.getByLabel("证据说明 *", { exact: true }).fill("Do not attribute this to Feishu");
  await page.getByPlaceholder("https://github.com/").fill("https://github.com/ZZJ1977/groupproof");
  await page.getByRole("checkbox").first().check();
  await page.getByRole("combobox", { name: "来源类型", exact: true }).selectOption("feishu");
  await expect(page.getByLabel("证据名称 *", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("证据说明 *", { exact: true })).toHaveValue("");
  await expect(page.getByPlaceholder("https://", { exact: true })).toHaveValue("");
  await expect(page.getByRole("checkbox").first()).not.toBeChecked();
});

test("C2-07 candidate persists after reload without becoming formal", async ({ page }) => {
  await page.goto("/projects/project-1/tasks/task-3/submit");
  await page.getByRole("combobox", { name: "来源类型", exact: true }).selectOption("manual");
  await page.getByLabel("证据名称 *", { exact: true }).fill("C regression candidate");
  await page.getByLabel("证据说明 *", { exact: true }).fill("Reproducible manual evidence for this criterion");
  await page.getByRole("checkbox").first().check();
  await page.getByRole("button", { name: "添加候选证据", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: "C regression candidate" })).toContainText("候选证据");
  await page.reload();
  await expect(page.getByRole("row").filter({ hasText: "C regression candidate" })).toHaveCount(1);
  await expect(page.getByRole("row").filter({ hasText: "C regression candidate" })).toContainText("候选证据");
});

test("C2-06 unavailable storage and unstarted task cannot claim a submission", async ({ page }) => {
  await page.goto("/projects/project-1/tasks/task-3/submit");
  await page.getByRole("combobox", { name: "来源类型", exact: true }).selectOption("file");
  await expect(page.getByLabel("选择证据文件")).toBeDisabled();
  await expect(page.getByRole("button", { name: "添加候选证据", exact: true })).toBeDisabled();
  await page.goto("/projects/project-1/tasks/task-4/submit");
  await expect(page.getByRole("button", { name: "添加候选证据", exact: true })).toBeDisabled();
});
