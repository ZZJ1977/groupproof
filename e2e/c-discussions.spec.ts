import { expect, test } from "@playwright/test";

test("C6 discussion preview displays development status and Feishu bridge links", async ({ page }) => {
  await page.goto("/projects/project-1/discussions");
  await expect(page.getByRole("heading", { name: "项目讨论区", exact: true })).toBeVisible();
  await expect(page.getByText("功能开发中", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("飞书同步已可用", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "前往飞书协作记录", exact: true })).toHaveAttribute(
    "href",
    "/projects/project-1/collaboration",
  );
  await expect(page.getByRole("link", { name: "配置飞书群接入", exact: true })).toHaveAttribute(
    "href",
    "/projects/project-1/settings#feishu-integration",
  );
});

test("C6 discussion preview switches channels and shows AI progress assistant card", async ({ page }) => {
  await page.goto("/projects/project-1/discussions");
  const mainChannel = page.getByRole("button", { name: /项目主群/ });
  const apiChannel = page.getByRole("button", { name: /需求与接口联调/ });
  const acceptanceChannel = page.getByRole("button", { name: /验收与证据归档/ });

  await expect(mainChannel.first()).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("GroupProof AI 进度助手", { exact: true })).toBeVisible();
  await expect(page.getByText("检测到分工确认与任务推进信号", { exact: true })).toBeVisible();

  await apiChannel.first().click();
  await expect(apiChannel.first()).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("检测到接口契约定稿决策", { exact: true })).toBeVisible();

  await acceptanceChannel.first().click();
  await expect(acceptanceChannel.first()).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("检测到里程碑材料收集提醒", { exact: true })).toBeVisible();
});

test("C6 discussion preview appends ephemeral local messages without persisting on reload", async ({ page }) => {
  await page.goto("/projects/project-1/discussions");
  const input = page.getByLabel("输入预览消息", { exact: true });
  await input.fill("这是一条仅前端预览消息");
  await page.getByRole("button", { name: "发送预览", exact: true }).click();
  await expect(page.getByText("这是一条仅前端预览消息", { exact: true })).toBeVisible();
  await expect(page.getByText("本地预览 · 刷新后不保留", { exact: true })).toBeVisible();
  await expect(input).toHaveValue("");

  await page.reload();
  await expect(page.getByText("这是一条仅前端预览消息", { exact: true })).toHaveCount(0);
});
