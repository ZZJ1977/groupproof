import { expect, test, type Page } from "@playwright/test";
import { seedData } from "../mocks/seed";
import type { CourseFileRecord } from "../features/c/course-file-commands";
import type { MockData } from "../types/domain";

const storageKey = "groupproof-v1-workspace:c-url-fixture";
type CourseFileWorkspace = Omit<MockData, "files"> & { files: CourseFileRecord[] };
async function prepare(page: Page, actorId = "teacher-1") {
  const data = structuredClone(seedData);
  data.currentUserId = actorId;
  data.currentRole = data.users.find((user) => user.id === actorId)!.role;
  await page.addInitScript(({ key, data }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(data));
  }, { key: storageKey, data });
}
const readWorkspace = (page: Page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!) as CourseFileWorkspace, storageKey);

test("C5-04 replacement and publication preserve versions and frozen references", async ({ page }) => {
  await prepare(page);
  await page.goto("/teacher/courses/course-1/files");
  await expect(page.getByText("当前仅保存演示元数据，不上传文件字节，不提供真实预览或下载，也不发送通知。冻结项目的原资料引用保持不变。", { exact: true })).toBeVisible();
  const before = await readWorkspace(page);
  await page.getByLabel("替换 课程项目模板.docx v3", { exact: true }).setInputFiles({ name: "更新模板.docx", mimeType: "application/octet-stream", buffer: Buffer.from("metadata fixture") });
  await page.getByLabel("本次文件更新原因", { exact: true }).fill("补充第四版课程要求");
  await page.getByRole("button", { name: "保存演示草稿", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("v4 的演示草稿");
  const rows = page.getByRole("row").filter({ hasText: "课程项目模板.docx" });
  await expect(rows).toHaveCount(2);
  await page.getByLabel("本次文件更新原因", { exact: true }).fill("课程要求已审阅，可以发布");
  await rows.filter({ hasText: "v4" }).getByRole("button", { name: "发布", exact: true }).evaluate((button) => {
    (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click();
  });
  await expect(page.getByRole("status")).toContainText("真实通知未发送");
  await expect(rows).toHaveCount(1);
  const saved = await readWorkspace(page);
  const draft = saved.files.find((file) => file.courseId === "course-1" && file.version === 4)!;
  expect(draft.cCourseFileHistory).toHaveLength(2);
  expect(draft.status).toBe("current");
  expect(saved.files.find((file) => file.id === "file-4")?.status).toBe("superseded");
  expect(saved.courses.find((course) => course.id === "course-1")!.version).toBe(before.courses.find((course) => course.id === "course-1")!.version + 2);
  expect(saved.logs).toHaveLength(before.logs.length + 2);
  for (const key of ["projects", "baselineRevisions", "planRevisions", "courseRuleRevisions", "notifications", "actionItems", "evidence", "verifications"] as const) expect(saved[key]).toEqual(before[key]);
  await page.reload();
  await expect(page.getByText("发布：课程要求已审阅，可以发布", { exact: true })).toBeVisible();
});

test("C5-04 storage failure retains the selected metadata and reason for retry", async ({ page }) => {
  await prepare(page);
  await page.goto("/teacher/courses/course-1/files");
  await page.getByLabel("选择课程资料", { exact: true }).setInputFiles({ name: "新课程说明.pdf", mimeType: "application/pdf", buffer: Buffer.from("metadata fixture") });
  await page.getByLabel("本次文件更新原因", { exact: true }).fill("失败后仍保留的资料原因");
  const before = await readWorkspace(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    let failOnce = true;
    Storage.prototype.setItem = function (key, value) {
      if (failOnce && key.startsWith("groupproof-v1-workspace:")) { failOnce = false; throw new DOMException("Quota", "QuotaExceededError"); }
      return original.call(this, key, value);
    };
  });
  await page.getByRole("button", { name: "保存演示草稿", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "保存失败" })).toBeVisible();
  // The accessible textbox name stays stable when React updates the textarea's text content.
  await expect(page.getByRole("textbox", { name: "本次文件更新原因", exact: true })).toHaveValue("失败后仍保留的资料原因");
  await expect(page.getByText("待保存：新课程说明.pdf（新增草稿）", { exact: true })).toBeVisible();
  expect(await readWorkspace(page)).toEqual(before);
  await page.getByRole("button", { name: "保存演示草稿", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("新课程说明.pdf v1");
  const saved = await readWorkspace(page);
  expect(saved.files.filter((file) => file.name === "新课程说明.pdf")).toHaveLength(1);
  expect(saved.logs).toHaveLength(before.logs.length + 1);
});

test("C5-04 assigned TA can read but cannot upload or publish", async ({ page }) => {
  await prepare(page, "ta-1");
  await page.goto("/teacher/courses/course-1/files");
  await expect(page.getByRole("table")).toContainText("课程项目模板.docx");
  await expect(page.getByText(/当前为只读/)).toBeVisible();
  await expect(page.getByLabel("选择课程资料")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "发布", exact: true })).toHaveCount(0);
});

test("C5-04 unknown course and unrelated teacher cannot read the first course", async ({ page }) => {
  await prepare(page, "teacher-2");
  await page.goto("/teacher/courses/course-1/files");
  await expect(page.getByRole("heading", { name: "无权访问此页面", exact: true })).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  await page.goto("/teacher/courses/not-a-course/files");
  await expect(page.getByRole("heading", { name: "课程不存在", exact: true })).toBeVisible();
  await expect(page.getByText("课程项目模板.docx", { exact: true })).toHaveCount(0);
});
