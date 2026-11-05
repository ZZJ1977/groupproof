import { expect, test } from "@playwright/test";

// B0: with bworkspace=real every B page shows "接口未接入" instead of demo data.
const project = "00000000-0000-0000-0000-0000000000b1";
const course = "00000000-0000-0000-0000-0000000000c1";
const group = "00000000-0000-0000-0000-0000000000d1";
// Pages 31/32/48 (B-1) and 33/34/36 (B-2) have real pages; see b-courses-real / b-groups-real.
const pages = [
  `/courses/${course}/projects/new`,
  `/courses/${course}/groups/${group}/leave`,
  `/projects/${project}`,
  `/projects/${project}/setup`,
  `/projects/${project}/requirements`,
  `/projects/${project}/planning`,
  `/projects/${project}/tasks`,
  `/projects/${project}/tasks?view=board`,
  `/projects/${project}/tasks?view=list`,
  `/projects/${project}/milestones`,
  `/projects/${project}/milestones/m-1`,
];

for (const path of pages) {
  test(`B0 真实模式 ${path} 显示接口未接入`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByTestId("b-not-connected")).toBeVisible();
    await expect(page.getByRole("heading", { name: "接口未接入" })).toBeVisible();
    // No seed/demo content leaks into real mode.
    await expect(page.locator("main")).not.toContainText("GroupProof Team 4");
    await expect(page.locator("main")).not.toContainText("软件工程 · 2026");
    await expect(page.locator('main a[href*="project-1"], main a[href*="course-1"]')).toHaveCount(0);
  });
}

test("B0 真实模式不影响非 B 页面（证据页仍由 C 负责）", async ({ page }) => {
  await page.goto(`/projects/${project}/evidence`);
  await expect(page.getByTestId("b-not-connected")).toHaveCount(0);
});
