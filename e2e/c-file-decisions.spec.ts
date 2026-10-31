import { expect, test } from "@playwright/test";
import { seedData } from "../mocks/seed";
import type { FileWithCDecisions } from "../features/c/file-decisions";
import type { MockData } from "../types/domain";

const storageKey = "groupproof-v1-workspace:c-url-fixture";
const fixture = structuredClone(seedData);
fixture.files.push({ ...fixture.files.find((item) => item.id === "file-2")!, id: "c5-review-draft", version: 2, status: "draft" });
type FileWorkspace = Omit<MockData, "files"> & { files: FileWithCDecisions[] };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ key, data }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(data));
  }, { key: storageKey, data: fixture });
});

test("C5-03 reasoned designation persists once and retains old versions and frozen references", async ({ page }) => {
  await page.goto("/projects/project-1/files");
  const draft = page.getByRole("table", { name: "项目文件列表" }).getByRole("row").filter({ hasText: "Proposal.docx" }).filter({ hasText: "草稿" });
  await draft.getByRole("button", { name: "Proposal.docx", exact: true }).click();
  const before = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!) as FileWorkspace, storageKey);
  await page.getByRole("button", { name: "设为正式", exact: true }).click();
  await expect(page.getByRole("button", { name: "确认设为正式", exact: true })).toBeDisabled();
  await page.getByLabel("设为正式原因 *", { exact: true }).fill("评审已通过，选用第二版");
  await page.getByRole("button", { name: "确认设为正式", exact: true }).evaluate((button) => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(page.getByText("已设为本地正式版本，旧版本、冻结基线引用和原因已保留；真实文件存储与成员通知尚未接入。", { exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "项目文件列表" }).getByRole("row").filter({ hasText: "Proposal.docx" })).toHaveCount(1);
  await page.reload();
  await page.getByRole("button", { name: "Proposal.docx", exact: true }).click();
  await expect(page.getByText(/设为正式 · .*评审已通过，选用第二版/)).toBeVisible();
  const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!) as FileWorkspace, storageKey);
  expect(saved.files.find((item) => item.id === "file-2")?.status).toBe("superseded");
  expect(saved.files.find((item) => item.id === "c5-review-draft")?.version).toBe(2);
  expect(saved.files.find((item) => item.id === "c5-review-draft")?.cDesignationHistory).toHaveLength(1);
  expect(saved.projects.find((item) => item.id === "project-1")?.version).toBe(before.projects.find((item) => item.id === "project-1")!.version + 1);
  expect(saved.logs.length).toBe(before.logs.length + 1);
  expect(saved.baselineRevisions).toEqual(before.baselineRevisions);
  expect(saved.planRevisions).toEqual(before.planRevisions);
  expect(saved.notifications).toEqual(before.notifications);
  await page.getByRole("navigation", { name: "文件类别" }).getByRole("button", { name: "已归档", exact: true }).click();
  await expect(page.getByRole("table", { name: "项目文件列表" }).getByRole("row").filter({ hasText: "Proposal.docx" })).toContainText("v1");
});

test("C5-03 failed storage keeps the draft and reason for a single safe retry", async ({ page }) => {
  await page.goto("/projects/project-1/files");
  const rows = page.getByRole("table", { name: "项目文件列表" }).getByRole("row").filter({ hasText: "Proposal.docx" });
  await rows.filter({ hasText: "草稿" }).getByRole("button", { name: "Proposal.docx", exact: true }).click();
  await page.getByRole("button", { name: "设为正式", exact: true }).click();
  await page.getByLabel("设为正式原因 *", { exact: true }).fill("保存失败后仍保留的版本理由");
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    let failOnce = true;
    Storage.prototype.setItem = function (key, value) {
      if (failOnce && key.startsWith("groupproof-v1-workspace:")) { failOnce = false; throw new DOMException("Quota", "QuotaExceededError"); }
      return original.call(this, key, value);
    };
  });
  await page.getByRole("button", { name: "确认设为正式", exact: true }).click();
  await expect(page.getByText("保存失败，请重试；当前状态未变更。", { exact: true })).toBeVisible();
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "草稿" })).toHaveCount(1);
  await expect(page.getByLabel("设为正式原因 *", { exact: true })).toHaveValue("保存失败后仍保留的版本理由");
  await page.getByRole("button", { name: "确认设为正式", exact: true }).click();
  await expect(rows).toHaveCount(1);
  const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!) as FileWorkspace, storageKey);
  expect(saved.files.find((item) => item.id === "c5-review-draft")?.cDesignationHistory).toHaveLength(1);
});

test("C5-03 course teaching readers and archived project members cannot designate", async ({ page }) => {
  await page.goto("/projects/project-1/files");
  await expect(page.getByRole("table", { name: "项目文件列表" })).toBeVisible();
  await page.evaluate((key) => {
    const data = JSON.parse(localStorage.getItem(key)!) as MockData;
    data.currentUserId = "teacher-1"; data.currentRole = "teacher";
    localStorage.setItem(key, JSON.stringify(data));
  }, storageKey);
  await page.reload();
  const draft = page.getByRole("table", { name: "项目文件列表" }).getByRole("row").filter({ hasText: "Proposal.docx" }).filter({ hasText: "草稿" });
  await draft.getByRole("button", { name: "Proposal.docx", exact: true }).click();
  await expect(page.getByRole("button", { name: "设为正式", exact: true })).toHaveCount(0);
  await page.evaluate((key) => {
    const data = JSON.parse(localStorage.getItem(key)!) as MockData;
    data.currentUserId = "member-1"; data.currentRole = "leader";
    data.projects.find((item) => item.id === "project-1")!.lifecycle = "archived";
    localStorage.setItem(key, JSON.stringify(data));
  }, storageKey);
  await page.reload();
  await draft.getByRole("button", { name: "Proposal.docx", exact: true }).click();
  await expect(page.getByRole("button", { name: "设为正式", exact: true })).toHaveCount(0);
  await expect(page.getByText("当前身份、课程或项目状态不允许上传、替换或设置正式版本。", { exact: true })).toBeVisible();
});
