import { expect, test, type Page } from "@playwright/test";
import { seedData } from "../mocks/seed";
import type { MockData } from "../types/domain";
import type { ManagedActivity } from "../features/c/activity-records";
import type { SourcedEvidence } from "../features/c/evidence-source";

type CWorkspace = Omit<MockData, "github" | "feishu" | "evidence"> & {
  github: ManagedActivity<MockData["github"][number]>[];
  feishu: ManagedActivity<MockData["feishu"][number]>[];
  evidence: SourcedEvidence[];
};
const storageKey = "groupproof-v1-workspace:c-url-fixture";
const readWorkspace = (page: Page): Promise<CWorkspace> => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), storageKey);
async function seed(page: Page, data = seedData) {
  await page.addInitScript(({ key, data }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(data)); }, { key: storageKey, data });
}

test("C4-01 GitHub combined filters and pagination survive reload and Back", async ({ page }) => {
  const fixture = structuredClone(seedData);
  for (let index = 0; index < 13; index++) fixture.github.push({ ...fixture.github[0], id: `c4-gh-${index}`, type: "commit", title: `T-03 C4 activity ${String(index).padStart(2, "0")}`, authorId: "member-2", taskId: undefined, timestamp: new Date().toISOString() });
  await seed(page, fixture);
  await page.goto("/projects/project-1/github");
  await page.getByRole("combobox", { name: "活动类型", exact: true }).selectOption("commit");
  await page.getByRole("combobox", { name: "活动时间", exact: true }).selectOption("7");
  await page.getByRole("combobox", { name: "GitHub 活动作者", exact: true }).selectOption("member-2");
  await page.getByRole("combobox", { name: "GitHub 关联任务筛选", exact: true }).selectOption("unlinked");
  await page.getByRole("textbox", { name: "搜索 GitHub 活动", exact: true }).fill("C4 activity");
  await expect(page.getByRole("row").filter({ hasText: "C4 activity" })).toHaveCount(10);
  const pagination = page.getByRole("navigation", { name: "GitHub 活动分页" });
  await expect(pagination).toContainText("13 条");
  await pagination.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.getByRole("row").filter({ hasText: "C4 activity" })).toHaveCount(3);
  await page.reload();
  await expect(page.getByRole("combobox", { name: "活动类型", exact: true })).toHaveValue("commit");
  await expect(page.getByRole("combobox", { name: "GitHub 活动作者", exact: true })).toHaveValue("member-2");
  await expect(page.getByRole("textbox", { name: "搜索 GitHub 活动", exact: true })).toHaveValue("C4 activity");
  await expect(page.getByRole("row").filter({ hasText: "C4 activity" })).toHaveCount(3);
  await page.goBack();
  await expect(page.getByRole("row").filter({ hasText: "C4 activity" })).toHaveCount(10);
});

test("C4-02 explicit task-number suggestion and manual unlink are saved once", async ({ page }) => {
  const fixture = structuredClone(seedData);
  fixture.github[0].title = "T-03.2 implement activity mapping";
  await seed(page, fixture);
  await page.goto("/projects/project-1/github");
  const row = page.getByRole("row").filter({ hasText: "T-03.2 implement activity mapping" });
  await row.getByRole("button", { name: "关联任务", exact: true }).click();
  await page.getByRole("button", { name: "按编号选择：T-03.2 开发活动映射", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "关联 GitHub 任务", exact: true })).toHaveValue("task-1b");
  await page.getByRole("textbox", { name: "GitHub 关联原因", exact: true }).fill("核对编号后关联具体子任务");
  await page.getByRole("button", { name: "保存任务关联", exact: true }).evaluate((button) => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(row).toContainText("T-03.2 开发活动映射");
  let saved = await readWorkspace(page);
  expect(saved.github.find((item) => item.id === "gh-1")?.cOperationHistory).toHaveLength(1);
  expect(saved.tasks).toEqual(fixture.tasks);
  await page.reload();
  await expect(row).toContainText("T-03.2 开发活动映射");
  await row.getByRole("button", { name: "关联任务", exact: true }).click();
  await page.getByRole("combobox", { name: "关联 GitHub 任务", exact: true }).selectOption("");
  await page.getByRole("textbox", { name: "GitHub 关联原因", exact: true }).fill("需要重新核对任务归属");
  await page.getByRole("button", { name: "保存任务关联", exact: true }).click();
  await expect(row).not.toContainText("T-03.2 开发活动映射");
  saved = await readWorkspace(page);
  expect(saved.github.find((item) => item.id === "gh-1")?.taskId).toBeUndefined();
  expect(saved.github.find((item) => item.id === "gh-1")?.cOperationHistory).toHaveLength(2);
  expect(saved.verifications).toEqual(fixture.verifications);
});

test("C4-03 Feishu group, status and pagination are URL state", async ({ page }) => {
  const fixture = structuredClone(seedData);
  for (let index = 0; index < 12; index++) fixture.feishu.push({ ...fixture.feishu[1], id: `c4-feishu-${index}`, groupName: "C4 项目群", summary: `C4 group note ${index}`, timestamp: new Date().toISOString() });
  await seed(page, fixture);
  await page.goto("/projects/project-1/collaboration");
  await page.getByRole("combobox", { name: "项目群组", exact: true }).selectOption("C4 项目群");
  await page.getByRole("combobox", { name: "关联性筛选", exact: true }).selectOption("candidate");
  await expect(page.getByRole("row").filter({ hasText: "C4 group note" })).toHaveCount(10);
  await page.getByRole("navigation", { name: "飞书记录分页" }).getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await page.reload();
  await expect(page.getByRole("combobox", { name: "项目群组", exact: true })).toHaveValue("C4 项目群");
  await expect(page.getByRole("combobox", { name: "关联性筛选", exact: true })).toHaveValue("candidate");
  await expect(page.getByRole("row").filter({ hasText: "C4 group note" })).toHaveCount(2);
  await page.getByRole("combobox", { name: "关联性筛选", exact: true }).selectOption("ignored");
  await expect(page).not.toHaveURL(/page=/);
  await expect(page.getByRole("row").filter({ hasText: "C4 group note" })).toHaveCount(0);
  await page.goto("/projects/project-1/collaboration#feishu-2");
  await expect(page.getByLabel("定位原始记录", { exact: true })).toContainText("李四补充证据完整性测试截图。");
  await expect(page.locator("#feishu-2")).toHaveCount(1);
});

test("C4-04 ignore restore and adopt preserve source history with one candidate", async ({ page }) => {
  await seed(page);
  await page.goto("/projects/project-1/collaboration");
  const row = page.getByRole("row").filter({ hasText: "李四补充证据完整性测试截图。" });
  await row.getByRole("button", { name: "忽略记录", exact: true }).click();
  await expect(page.getByRole("button", { name: "确认忽略", exact: true })).toBeDisabled();
  await page.getByRole("textbox", { name: "记录处理原因", exact: true }).fill("暂不纳入本阶段材料");
  await page.getByRole("button", { name: "确认忽略", exact: true }).click();
  await expect(row).toContainText("已忽略");
  await page.reload();
  await row.getByRole("button", { name: "恢复待确认", exact: true }).click();
  await page.getByRole("textbox", { name: "记录处理原因", exact: true }).fill("需要重新核对截图材料");
  await page.getByRole("button", { name: "确认恢复", exact: true }).click();
  await expect(row).toContainText("待确认");
  await row.getByRole("button", { name: "采纳记录", exact: true }).click();
  await page.getByRole("combobox", { name: "飞书候选关联任务", exact: true }).selectOption("task-3");
  await page.getByRole("checkbox", { name: /^AC-1 ·/ }).check();
  await page.getByRole("textbox", { name: "记录处理原因", exact: true }).fill("支持证据完整性标准");
  await page.getByRole("button", { name: "确认采纳记录", exact: true }).evaluate((button) => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(page.getByText("记录已采纳并生成本地候选证据，尚未成为正式证据；真实来源服务未接入。", { exact: true })).toBeVisible();
  await expect(row).toContainText("已采纳");
  const saved = await readWorkspace(page);
  const candidates = saved.evidence.filter((item) => item.sourceRecordId === "feishu-2");
  expect(candidates).toHaveLength(1);
  expect(candidates[0].status).toBe("candidate");
  expect(candidates[0].authorId).toBe("member-1");
  expect(candidates[0].sourceSnapshot?.record.authorId).toBe("member-2");
  expect(candidates[0].sourceUrl).toBeUndefined();
  expect(candidates[0].sourceRecordUrl).toBe("/projects/project-1/collaboration#feishu-2");
  expect(saved.feishu.find((item) => item.id === "feishu-2")?.cOperationHistory).toHaveLength(3);
  expect(saved.verifications).toEqual(seedData.verifications);
  expect(saved.notifications).toEqual(seedData.notifications);
  await page.reload();
  await expect(row.getByRole("link", { name: "查看候选", exact: true })).toBeVisible();
});

test("C4 failed adoption preserves all input and source status for one retry", async ({ page }) => {
  await seed(page);
  await page.goto("/projects/project-1/collaboration");
  const row = page.getByRole("row").filter({ hasText: "李四补充证据完整性测试截图。" });
  await row.getByRole("button", { name: "采纳记录", exact: true }).click();
  await page.getByRole("combobox", { name: "飞书候选关联任务", exact: true }).selectOption("task-3");
  await page.getByRole("checkbox", { name: /^AC-1 ·/ }).check();
  await page.getByRole("textbox", { name: "记录处理原因", exact: true }).fill("失败时保留的采纳说明");
  await page.evaluate(() => {
    const original = Storage.prototype.setItem; let failOnce = true;
    Storage.prototype.setItem = function (key, value) { if (failOnce && key.startsWith("groupproof-v1-workspace:")) { failOnce = false; throw new DOMException("Quota", "QuotaExceededError"); } return original.call(this, key, value); };
  });
  await page.getByRole("button", { name: "确认采纳记录", exact: true }).click();
  await expect(page.getByText("保存失败，请重试；当前状态未变更。", { exact: true })).toBeVisible();
  await expect(row).toContainText("待确认");
  await expect(page.getByRole("textbox", { name: "记录处理原因", exact: true })).toHaveValue("失败时保留的采纳说明");
  await expect(page.getByRole("checkbox", { name: /^AC-1 ·/ })).toBeChecked();
  expect((await readWorkspace(page)).evidence.filter((item) => item.sourceRecordId === "feishu-2")).toHaveLength(0);
  await page.getByRole("button", { name: "确认采纳记录", exact: true }).click();
  await expect(row).toContainText("已采纳");
  expect((await readWorkspace(page)).evidence.filter((item) => item.sourceRecordId === "feishu-2")).toHaveLength(1);
});
