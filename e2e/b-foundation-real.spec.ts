import { expect, test } from "@playwright/test";

// B0: real mode must not take over pages B does not own. Every B page now has a
// real implementation (B-1 … B-8), each covered by its own b-*-real spec.
const project = "00000000-0000-0000-0000-0000000000b1";

test("B0 真实模式不影响非 B 页面（证据页仍由 C 负责）", async ({ page }) => {
  await page.goto(`/projects/${project}/evidence`);
  await expect(page.getByTestId("b-not-connected")).toHaveCount(0);
});
