import { expect, test } from "@playwright/test";

test("C2-02 task tabs survive reload, Back and Forward", async ({ page }) => {
  await page.goto("/projects/project-1/tasks/task-1?tab=evidence");
  const evidenceTab = page.getByRole("tab", { name: /^证据/ });
  await expect(evidenceTab).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: /^历史/ }).click();
  await expect(page).toHaveURL(/tab=history/);
  await page.reload();
  await expect(page.getByRole("tab", { name: /^历史/ })).toHaveAttribute("aria-selected", "true");
  await page.goBack();
  await expect(evidenceTab).toHaveAttribute("aria-selected", "true");
  await page.goForward();
  await expect(page.getByRole("tab", { name: /^历史/ })).toHaveAttribute("aria-selected", "true");
});

test("C3-01 combined filters survive reload and clearing preserves the view", async ({ page }) => {
  await page.goto("/projects/project-1/evidence?view=timeline&task=task-1&source=github&status=formal");
  await expect(page.getByLabel("筛选任务")).toHaveValue("task-1");
  await expect(page.getByLabel("筛选来源")).toHaveValue("github");
  await expect(page.getByLabel("筛选证据状态")).toHaveValue("formal");
  await page.getByLabel("筛选来源").selectOption("file");
  await expect(page).toHaveURL(/source=file/);
  await page.reload();
  await expect(page.getByLabel("筛选来源")).toHaveValue("file");
  await page.goBack();
  await expect(page.getByLabel("筛选来源")).toHaveValue("github");
  await page.getByRole("button", { name: "清除筛选" }).click();
  await expect(page).toHaveURL(/evidence\?view=timeline$/);
  await expect(page.getByLabel("筛选任务")).toHaveValue("all");
  await expect(page.getByRole("tab", { name: "时间线" })).toHaveAttribute("aria-selected", "true");
});

test("C2-02 unknown tab falls back safely and inaccessible project is denied", async ({ page }) => {
  await page.goto("/projects/project-1/tasks/task-1?tab=invalid");
  await expect(page.getByRole("tab", { name: /^概览/ })).toHaveAttribute("aria-selected", "true");
  await page.goto("/projects/not-a-project/evidence?source=github");
  await expect(page.getByLabel("筛选来源")).toHaveCount(0);
});
