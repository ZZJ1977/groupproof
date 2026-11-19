import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";

type TestFile = { name: string; mimeType: string; buffer: Buffer };

async function uploadDraft(page: Page, file: TestFile, reason: string) {
  await page.getByLabel("选择文件", { exact: true }).setInputFiles(file);
  await page.getByLabel("版本说明", { exact: true }).fill(reason);
  await page.getByRole("button", { name: "上传并保存草稿", exact: true }).click();
}

async function checkDownload(page: Page, version: number, expected: TestFile) {
  const button = page.getByRole("button", { name: `申请下载 v${version}`, exact: true });
  const article = page.getByRole("article").filter({ has: button });
  await button.click();
  const [download] = await Promise.all([
    page.context().waitForEvent("download", { timeout: 20_000 }),
    article.getByRole("link", { name: "下载文件", exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(expected.name);
  expect(await download.failure()).toBeNull();
  expect(await readFile(await download.path())).toEqual(expected.buffer);
}

export async function verifyProjectFileVersions(page: Page, projectId: string) {
  const run = `C5-02-${randomUUID()}`;
  const revisions = [1, 2].map((n) => ({
    name: `${run}-v${n}.txt`,
    mimeType: "text/plain",
    buffer: Buffer.from(`GroupProof ${run} revision ${n}\r\n${"文件资料".repeat(n)}\n`, "utf8"),
  }));

  // A unique filter keeps the test scoped to its own new logical file even on a busy project.
  const path = `/projects/${projectId}/files?q=${run}`;
  await page.goto(path);
  await expect(page.getByRole("heading", { name: "项目资料", exact: true })).toBeVisible();
  await expect(page, "The browser must stay on the configured test origin and project before uploading.").toHaveURL(path);
  await expect(page.getByRole("button", { name: "查看版本", exact: true })).toHaveCount(0);
  await uploadDraft(page, revisions[0], `${run} initial upload`);
  const newFile = page.getByRole("row").filter({ hasText: revisions[0].name });
  await expect(newFile, "The new file must appear after the signed upload and registration succeed.").toBeVisible();
  await newFile.getByRole("button", { name: "查看版本", exact: true }).click();
  await expect(page.getByRole("group", { name: `上传新版本 · ${revisions[0].name}` })).toBeVisible();
  await uploadDraft(page, revisions[1], `${run} second revision`);
  await expect(page.getByRole("button", { name: "申请下载 v2", exact: true })).toBeVisible();

  // Only this third, unsuccessful PUT is intercepted. Both successful uploads, the receipts,
  // the version writes, and the signed reads use the deployment's actual services.
  const uploadUrl = (url: URL) => url.pathname.includes("/storage/v1/object/upload/sign/")
    && url.pathname.includes(`/project/${projectId}/`);
  let interrupted = false;
  await page.route(uploadUrl, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    interrupted = true;
    await route.abort("connectionfailed");
  });
  await uploadDraft(page, { ...revisions[1], name: `${run}-interrupted.txt` }, `${run} interrupted upload`);
  await expect(page.getByRole("alert").filter({ hasText: "文件传输未完成" })).toBeVisible();
  expect(interrupted).toBe(true);
  await page.unroute(uploadUrl);

  await page.reload();
  await expect(page.getByRole("button", { name: "申请下载 v2", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^申请下载 v\d+$/ })).toHaveCount(2);
  await page.getByRole("button", { name: "申请预览 v1", exact: true }).click();
  const [preview] = await Promise.all([
    page.waitForEvent("popup", { timeout: 20_000 }),
    page.getByRole("link", { name: "打开预览", exact: true }).click(),
  ]);
  await expect(preview.locator("body")).toContainText(`GroupProof ${run} revision 1`);
  await preview.close();
  await checkDownload(page, 1, revisions[0]);
  await checkDownload(page, 2, revisions[1]);
}
