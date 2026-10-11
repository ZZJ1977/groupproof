import { expect, test } from "@playwright/test";

test("C1-03 action items navigate to processing pages without a direct complete control", async ({ page }) => {
  await page.goto("/action-items?tab=pending");
  await expect(page.getByRole("link", { name: "查看", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "完成", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "已完成", exact: true }).click();
  await expect(page).toHaveURL(/tab=completed/);
  await page.reload();
  await expect(page.getByRole("button", { name: "已完成", exact: true })).toHaveClass(/active/);
  await page.goBack();
  await expect(page.getByRole("button", { name: "待处理", exact: true })).toHaveClass(/active/);
});

test("C1 daily entry filters survive refresh and home does not fabricate weekly growth", async ({ page }) => {
  await page.goto("/activity?tab=discussion");
  await expect(page.locator("button.gp-tab.active")).toHaveText("讨论");
  await page.reload();
  await expect(page.locator("button.gp-tab.active")).toHaveText("讨论");
  await page.goto("/notifications?tab=system");
  await expect(page.locator("button.gp-tab.active")).toContainText("系统");
  await page.goto("/home");
  await expect(page.getByText("+7%", { exact: true })).toHaveCount(0);
});
