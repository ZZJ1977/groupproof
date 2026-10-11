import { expect, test } from "@playwright/test";
import { seedData } from "../mocks/seed";
import type { FileRecord, MockData } from "../types/domain";

const key = "groupproof-v1-workspace:c-url-fixture";
const fixture = structuredClone(seedData);
const files: FileRecord[] = Array.from({ length: 23 }, (_, index) => ({
  id: `c5-file-${index + 1}`, projectId: "project-1", name: `C5 文档 ${String(index + 1).padStart(2, "0")}.pdf`,
  type: "PDF", source: "项目资料", uploaderId: "member-1", version: 1, status: "current",
  updatedAt: "2026-10-10", size: "1 KB",
}));
fixture.files = [
  ...fixture.files.filter((item) => item.projectId !== "project-1"), ...files,
  { ...files[0], id: "c5-image", name: "C5 页面截图.png", type: "PNG" },
  { ...files[0], id: "c5-old", version: 0, status: "superseded" },
  { ...files[0], id: "c5-foreign", projectId: "project-3", name: "外组保密文件.pdf" },
];
test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ storageKey, data }) => {
    if (!localStorage.getItem(storageKey)) localStorage.setItem(storageKey, JSON.stringify(data));
  }, { storageKey: key, data: fixture });
});

test("C5-01 combined file filters and pagination survive refresh and history", async ({ page }) => {
  await page.goto("/projects/project-1/files?category=documents&q=C5&type=PDF&sort=name&page=2&pageSize=10&origin=review#files");
  const rows = page.getByRole("table", { name: "项目文件列表" }).locator("tbody tr");
  const pager = page.getByRole("navigation", { name: "文件分页" });
  await expect(rows).toHaveCount(10);
  await expect(rows.first()).toContainText("C5 文档 11.pdf");
  await expect(rows.last()).toContainText("C5 文档 20.pdf");
  await expect(pager).toContainText("第 2 / 3 页 · 共 23 个文件");
  await pager.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page).toHaveURL(/page=3/);
  await expect(rows).toHaveCount(3);
  await page.reload();
  await expect(rows.first()).toContainText("C5 文档 21.pdf");
  await expect(pager.getByRole("button", { name: "下一页", exact: true })).toBeDisabled();
  await page.goBack();
  await expect(rows.first()).toContainText("C5 文档 11.pdf");
  await expect(page.getByLabel("搜索文件", { exact: true })).toHaveValue("C5");
  await expect(page.getByLabel("文件类型", { exact: true })).toHaveValue("PDF");
  await expect(page.getByLabel("排序", { exact: true })).toHaveValue("name");
  await page.getByLabel("搜索文件", { exact: true }).fill("C5 文档 23");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("C5 文档 23.pdf");
  const location = new URL(page.url());
  expect(location.searchParams.has("page")).toBe(false);
  expect(location.searchParams.get("origin")).toBe("review");
  expect(location.hash).toBe("#files");
  await page.reload();
  await expect(rows).toHaveCount(1);
});

test("C5-01 category and page size compose; unknown values and empty results stay usable", async ({ page }) => {
  await page.goto("/projects/project-1/files?page=999&pageSize=999&category=unknown&sort=unknown");
  const rows = page.getByRole("table", { name: "项目文件列表" }).locator("tbody tr");
  const pager = page.getByRole("navigation", { name: "文件分页" });
  await expect(page.getByLabel("每页文件数", { exact: true })).toHaveValue("10");
  await expect(pager).toContainText("第 3 / 3 页 · 共 24 个文件");
  await expect(rows).toHaveCount(4);
  await page.getByLabel("每页文件数", { exact: true }).selectOption("20");
  await expect(rows).toHaveCount(20);
  expect(new URL(page.url()).searchParams.has("page")).toBe(false);
  await page.getByRole("navigation", { name: "文件类别" }).getByRole("button", { name: "图片截图", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("C5 页面截图.png");
  await page.getByLabel("文件类型", { exact: true }).selectOption("PDF");
  await expect(rows).toHaveCount(0);
  await expect(page.getByText("没有符合条件的文件", { exact: true })).toBeVisible();
  await expect(pager).toContainText("第 1 / 1 页 · 共 0 个文件");
  await expect(pager.getByRole("button", { name: "上一页", exact: true })).toBeDisabled();
  await expect(pager.getByRole("button", { name: "下一页", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await page.getByRole("navigation", { name: "文件类别" }).getByRole("button", { name: "已归档", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("v0");
  await page.reload();
  await expect(page.getByRole("button", { name: "已归档", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(rows).toHaveCount(1);
});

test("C5-01 project files stay within member visibility, including crafted filters", async ({ page }) => {
  await page.goto("/projects/project-1/files?q=保密&page=2");
  await expect(page.getByRole("table", { name: "项目文件列表" }).locator("tbody tr")).toHaveCount(0);
  await expect(page.getByText("外组保密文件.pdf", { exact: true })).toHaveCount(0);
  await page.evaluate((storageKey) => {
    const data = JSON.parse(localStorage.getItem(storageKey)!) as MockData;
    data.currentUserId = "member-5"; data.currentRole = "student";
    localStorage.setItem(storageKey, JSON.stringify(data));
  }, key);
  await page.goto("/projects/project-1/files?category=all&q=C5&type=PDF");
  await expect(page.getByRole("table", { name: "项目文件列表" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "C5 文档 01.pdf", exact: true })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "文件分页" })).toHaveCount(0);
});
