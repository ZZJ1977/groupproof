import { expect, test } from "@playwright/test";
import { seedData } from "../mocks/seed";

test("C4-01 GitHub activity links only expose the trusted GitHub origin", async ({ page }) => {
  await page.addInitScript((data) => {
    const key = "groupproof-v1-workspace:c-url-fixture";
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(data));
  }, seedData);
  await page.goto("/projects/project-1/github");
  const activityTable = page.getByRole("table").first();
  const externalLinks = activityTable.locator('a[target="_blank"]');
  expect(await externalLinks.count()).toBeGreaterThan(0);
  for (const href of await externalLinks.evaluateAll((links) => links.map((link) => link.getAttribute("href")))) {
    expect(new URL(href!).origin).toBe("https://github.com");
  }
  await page.evaluate(() => {
    const key = "groupproof-v1-workspace:c-url-fixture";
    const data = JSON.parse(localStorage.getItem(key)!);
    data.github[0].title = "Unsupported activity origin";
    data.github[0].url = "https://github.com.example.test/foreign";
    localStorage.setItem(key, JSON.stringify(data));
  });
  await page.reload();
  const row = page.getByRole("row").filter({ hasText: "Unsupported activity origin" }).first();
  await expect(row).toContainText("来源链接不可用");
  await expect(row.getByRole("link", { name: "Unsupported activity origin", exact: true })).toHaveCount(0);
});
