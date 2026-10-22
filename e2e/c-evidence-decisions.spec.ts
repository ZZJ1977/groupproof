import { expect, test, type Page } from "@playwright/test";
import { seedData } from "../mocks/seed";
import type { EvidenceWithCDecisions } from "../features/c/evidence-decisions";
import type { MockData } from "../types/domain";

type CWorkspace = Omit<MockData, "evidence"> & {
  evidence: (EvidenceWithCDecisions & { sourceSnapshot?: unknown })[];
};
const storageKey = "groupproof-v1-workspace:c-url-fixture";
const readWorkspace = (page: Page): Promise<CWorkspace> => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), storageKey);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ key, data }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(data));
  }, { key: storageKey, data: seedData });
});

test("C3 decisions require reasons, save once on double click, and preserve history after reload", async ({ page }) => {
  await page.goto("/projects/project-1/evidence");
  const row = page.getByRole("row").filter({ hasText: "证据检查页面截图" });
  await expect(row).toContainText("候选证据");
  const before = await readWorkspace(page);
  await row.getByRole("button", { name: "采纳", exact: true }).click();
  await expect(page.getByRole("button", { name: "确认采纳", exact: true })).toBeDisabled();
  await page.getByLabel("采纳原因 *", { exact: true }).fill("截图覆盖验收页面核心标准");
  await page.getByRole("button", { name: "确认采纳", exact: true }).evaluate((button) => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(row).toContainText("正式证据");
  await expect(page.getByText("证据已采纳为本地正式证据，原因已保留；真实验收与通知尚未联动。", { exact: true })).toBeVisible();
  let saved = await readWorkspace(page);
  expect(saved.evidence.find((item) => item.id === "evidence-4")?.cDecisionHistory).toHaveLength(1);
  expect(saved.logs.length).toBe(before.logs.length + 1);
  await row.getByRole("button", { name: "撤回", exact: true }).click();
  await expect(page.getByRole("button", { name: "确认撤回", exact: true })).toBeDisabled();
  await page.getByLabel("撤回原因 *", { exact: true }).fill("新版截图已替代这份结果");
  await page.getByRole("button", { name: "确认撤回", exact: true }).evaluate((button) => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(row).toContainText("已撤回");
  await page.reload();
  await expect(row).toContainText("已撤回");
  await row.locator("summary").click();
  await expect(row).toContainText("截图覆盖验收页面核心标准");
  await expect(row).toContainText("新版截图已替代这份结果");
  saved = await readWorkspace(page);
  expect(saved.evidence.find((item) => item.id === "evidence-4")?.cDecisionHistory).toHaveLength(2);
  expect(saved.logs.length).toBe(before.logs.length + 2);
  expect(saved.verifications).toEqual(before.verifications);
  expect(saved.notifications).toEqual(before.notifications);
  expect(saved.contributions).toEqual(before.contributions);
});

test("C3 failed persistence retains status and reason for a safe retry", async ({ page }) => {
  await page.goto("/projects/project-1/evidence");
  const row = page.getByRole("row").filter({ hasText: "证据检查页面截图" });
  await row.getByRole("button", { name: "采纳", exact: true }).click();
  await page.getByLabel("采纳原因 *", { exact: true }).fill("保留失败后的决策原因");
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    let failOnce = true;
    Storage.prototype.setItem = function (key, value) {
      if (failOnce && key.startsWith("groupproof-v1-workspace:")) { failOnce = false; throw new DOMException("Quota", "QuotaExceededError"); }
      return original.call(this, key, value);
    };
  });
  await page.getByRole("button", { name: "确认采纳", exact: true }).click();
  await expect(page.getByText("保存失败，请重试；当前状态未变更。", { exact: true })).toBeVisible();
  await expect(row).toContainText("候选证据");
  await expect(page.getByLabel("采纳原因 *", { exact: true })).toHaveValue("保留失败后的决策原因");
  expect((await readWorkspace(page)).evidence.find((item) => item.id === "evidence-4")?.cDecisionHistory).toBeUndefined();
  await page.getByRole("button", { name: "确认采纳", exact: true }).click();
  await expect(row).toContainText("正式证据");
  expect((await readWorkspace(page)).evidence.find((item) => item.id === "evidence-4")?.cDecisionHistory).toHaveLength(1);
});

test("C3 changed sources are labelled and cannot be adopted; snapshot remains unchanged", async ({ page }) => {
  await page.goto("/projects/project-1/evidence");
  const row = page.getByRole("row").filter({ hasText: "证据检查页面截图" });
  await expect(row).toBeVisible();
  await page.evaluate((key) => {
    const data = JSON.parse(localStorage.getItem(key)!) as CWorkspace;
    const item = data.evidence.find((evidence) => evidence.id === "evidence-4")!;
    item.sourceChanged = true;
    item.sourceSnapshot = { record: "original screenshot" };
    localStorage.setItem(key, JSON.stringify(data));
  }, storageKey);
  await page.reload();
  await expect(row).toContainText("来源已变化");
  await expect(row.getByRole("button", { name: "采纳", exact: true })).toBeDisabled();
  const item = (await readWorkspace(page)).evidence.find((evidence) => evidence.id === "evidence-4")!;
  expect(item.status).toBe("candidate");
  expect(item.sourceSnapshot).toEqual({ record: "original screenshot" });
});

test("C3 only author leader or course teacher can decide, and unlocked plans block adoption", async ({ page }) => {
  await page.goto("/projects/project-1/evidence");
  const row = page.getByRole("row").filter({ hasText: "证据检查页面截图" });
  await expect(row).toBeVisible();
  await page.evaluate((key) => {
    const data = JSON.parse(localStorage.getItem(key)!) as CWorkspace;
    data.currentUserId = "member-3"; data.currentRole = "student";
    localStorage.setItem(key, JSON.stringify(data));
  }, storageKey);
  await page.reload();
  await expect(row).toBeVisible();
  await expect(row.getByRole("button", { name: "采纳", exact: true })).toHaveCount(0);
  await page.evaluate((key) => {
    const data = JSON.parse(localStorage.getItem(key)!) as CWorkspace;
    data.currentUserId = "teacher-1"; data.currentRole = "teacher";
    localStorage.setItem(key, JSON.stringify(data));
  }, storageKey);
  await page.reload();
  await expect(row.getByRole("button", { name: "采纳", exact: true })).toBeEnabled();
  await page.evaluate((key) => {
    const data = JSON.parse(localStorage.getItem(key)!) as CWorkspace;
    data.projects.find((project) => project.id === "project-1")!.planConfirmed = false;
    localStorage.setItem(key, JSON.stringify(data));
  }, storageKey);
  await page.reload();
  await expect(row.getByRole("button", { name: "采纳", exact: true })).toBeDisabled();
  await expect(row).toContainText("任务计划尚未确认或已解锁");
});
