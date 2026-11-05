import { expect, test } from "@playwright/test";

// B0 / B1-01: useUrlFilters keeps the "我的课程" tab in the URL.
test("B0 我的课程 Tab 写入 URL：刷新、复制链接、前进后退都保持一致", async ({ page, context }) => {
  await page.goto("/courses");
  const ended = page.getByRole("tab", { name: "已结束", exact: true });
  await expect(page.getByRole("tab", { name: "全部课程", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "软件工程 · 2026" })).toBeVisible();

  await ended.click();
  await expect(page).toHaveURL(/\/courses\?tab=ended$/);
  await expect(ended).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "人工智能基础 · 2025" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "软件工程 · 2026" })).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("tab", { name: "已结束", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "软件工程 · 2026" })).toHaveCount(0);

  const copied = await context.newPage();
  await copied.goto(page.url());
  await expect(copied.getByRole("tab", { name: "已结束", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(copied.getByRole("heading", { name: "人工智能基础 · 2025" })).toBeVisible();
  await expect(copied.getByRole("heading", { name: "软件工程 · 2026" })).toHaveCount(0);
  await copied.close();

  await page.goBack();
  await expect(page).toHaveURL(/\/courses$/);
  await expect(page.getByRole("tab", { name: "全部课程", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.goForward();
  await expect(page.getByRole("tab", { name: "已结束", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("B0 未知 Tab 值安全回退到全部课程", async ({ page }) => {
  await page.goto("/courses?tab=deleted");
  await expect(page.getByRole("tab", { name: "全部课程", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "软件工程 · 2026" })).toBeVisible();
});

test("B0 默认 mock 模式下 B 页面不显示“接口未接入”", async ({ page }) => {
  await page.goto("/courses");
  await expect(page.getByRole("heading", { name: "我的课程" })).toBeVisible();
  await expect(page.getByTestId("b-not-connected")).toHaveCount(0);
});
