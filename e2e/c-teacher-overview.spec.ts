import { expect, test, type Page } from "@playwright/test";
import { seedData } from "../mocks/seed";

async function asTeacher(page: Page, actorId: "teacher-1" | "teacher-2") {
  const data = structuredClone(seedData);
  data.currentUserId = actorId;
  data.currentRole = "teacher";
  await page.addInitScript(({ value }) => {
    localStorage.setItem("groupproof-v1-workspace:c-url-fixture", JSON.stringify(value));
  }, { value: data });
}

test("D6-01 own course shows task progress, acceptance, risk and recent activity", async ({ page }) => {
  await asTeacher(page, "teacher-1");
  await page.goto("/teacher/courses/course-1");
  await expect(page.getByRole("heading", { name: "课程总览" })).toBeVisible();
  await expect(page.getByText("软件工程 · 2026").first()).toBeVisible();
  const group = page.getByRole("row").filter({ hasText: "GroupProof Team 4" });
  await expect(group).toContainText("76%");
  await expect(group).toContainText("3 / 12");
  await expect(group).toContainText("高风险");
  await expect(group).toContainText("验收结果：partially_passed");
  await expect(page.getByText("人工智能基础 · 2025")).toHaveCount(0);
});

test("D6-01 unrelated teacher and unknown course do not expose data", async ({ page }) => {
  await asTeacher(page, "teacher-2");
  await page.goto("/teacher/courses/course-1");
  await expect(page.getByRole("heading", { name: "无权访问此页面" })).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  await page.goto("/teacher/courses/not-a-course");
  await expect(page.getByRole("heading", { name: "课程不存在" })).toBeVisible();
  await page.goto("/teacher/courses/course-3");
  await expect(page.getByRole("heading", { name: "课程总览" })).toBeVisible();
  await expect(page.getByText("人工智能基础 · 2025").first()).toBeVisible();
});
