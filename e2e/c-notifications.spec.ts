import { expect, test } from "@playwright/test";
import { seedData } from "../mocks/seed";

test.beforeEach(async ({ page }) => {
  const data = structuredClone(seedData);
  data.notifications = Array.from({ length: 21 }, (_, index) => ({ ...seedData.notifications[0], id: `notice-${index}`, userId: data.currentUserId, title: `Test notification ${index}`, read: false }));
  await page.addInitScript((data) => { const key = "groupproof-v1-workspace:c-url-fixture"; if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(data)); }, data);
});

test("C1-02 pagination survives reload and failed mark-all keeps unread state", async ({ page }) => {
  await page.goto("/notifications");
  await expect(page.getByRole("link", { name: /^Test notification/ })).toHaveCount(10);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await page.reload();
  await expect(page.getByLabel("通知分页")).toContainText("第 2/3 页");
  await page.evaluate(() => {
    const original = Storage.prototype.setItem; let fail = true;
    Storage.prototype.setItem = function (key, value) { if (fail && key.startsWith("groupproof-v1-workspace:")) { fail = false; throw new DOMException("quota", "QuotaExceededError"); } return original.call(this, key, value); };
  });
  const markAll = page.getByRole("button", { name: "全部标为已读", exact: true });
  await markAll.click();
  await expect(page.getByRole("alert").filter({ hasText: "保存失败" })).toBeVisible();
  await expect(page.locator("button.gp-tab").filter({ hasText: "未读" })).toContainText("21");
  await markAll.click();
  await expect(page.locator("button.gp-tab").filter({ hasText: "未读" })).toContainText("0");
  await page.reload();
  await expect(markAll).toBeDisabled();
  await page.getByRole("button", { name: "标为未读", exact: true }).first().click();
  await expect(page.locator("button.gp-tab").filter({ hasText: "未读" })).toContainText("1");
});
