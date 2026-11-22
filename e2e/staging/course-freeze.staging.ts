import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { components } from "../../packages/domain/api.generated";
import { stagingUuid } from "./staging-env";

// The B snapshot has a flexible JSON shape. The two IDs must occur together in a
// structured reference; IDs in unrelated materials or free-form text do not count.
function containsVersionReference(node: unknown, fileId: string, versionId: string): boolean {
  if (!node || typeof node !== "object") return false;
  const fields = node as Record<string, unknown>;
  return (fields.file_id === fileId && fields.version_id === versionId)
    || Object.values(fields).some((child) => containsVersionReference(child, fileId, versionId));
}

test("C5-04 the frozen project's own link still opens the published historical bytes", async ({ page, baseURL }) => {
  const projectId = stagingUuid("C5_STAGING_PROJECT_ID");
  const courseId = stagingUuid("C5_STAGING_COURSE_ID");
  const fileId = stagingUuid("C5_STAGING_COURSE_FILE_ID");
  const versionId = stagingUuid("C5_STAGING_FROZEN_VERSION_ID");
  const detailPath = `/api/v1/courses/${courseId}/files/${fileId}`;
  const [baselineResponse, detailResponse] = await Promise.all([
    page.request.get(`/api/v1/projects/${projectId}/baselines/current`),
    page.request.get(detailPath),
  ]);
  expect(baselineResponse.status(), "需要由 B 部署基线路由，并允许该成员读取测试项目").toBe(200);
  expect(detailResponse.status(), "需要可读课程资料的测试账号").toBe(200);
  const baseline = (await baselineResponse.json()).data;
  expect(baseline?.status, "测试项目应已冻结其需求基线").toBe("frozen");
  expect(baseline.snapshot?.project?.id).toBe(projectId);
  expect(containsVersionReference(baseline.snapshot, fileId, versionId),
    "B 的冻结快照应保存选用资料的 file_id 和 version_id").toBe(true);

  const detail: components["schemas"]["CourseFileDetailDTO"] = (await detailResponse.json()).data;
  expect(detail.course_id).toBe(courseId);
  expect(detail.id).toBe(fileId);
  const pinned = detail.versions.find((version) => version.id === versionId);
  const current = detail.versions.find((version) => version.status === "current");
  if (!pinned || pinned.status !== "superseded" || !current) {
    throw new Error("请在冻结后发布内容不同的新版，并保留原已发布版本。");
  }
  expect(pinned.file_id).toBe(fileId);
  expect(current.version_no).toBeGreaterThan(pinned.version_no);
  expect(current.content_hash).not.toBe(pinned.content_hash);
  const publishedAt = (id: string) => Date.parse(detail.decisions.find((decision) =>
    decision.version_id === id && decision.action === "published")?.created_at ?? "");
  const frozenAt = Date.parse(baseline.frozen_at);
  expect(publishedAt(pinned.id)).toBeLessThanOrEqual(frozenAt);
  expect(publishedAt(current.id)).toBeGreaterThanOrEqual(frozenAt);

  await page.goto(`/projects/${projectId}/setup`);
  const entry = page.getByRole("main").locator(`a[href*="file=${fileId}"][href*="version=${versionId}"]`).first();
  await expect(entry, "冻结项目页应提供可点击的资料版本入口").toBeVisible();
  const target = new URL((await entry.getAttribute("href"))!, page.url());
  expect(target.origin).toBe(new URL(baseURL!).origin);
  expect(target.pathname).toBe(`/teacher/courses/${courseId}/files`);
  expect(target.searchParams.getAll("file")).toEqual([fileId]);
  expect(target.searchParams.getAll("version")).toEqual([versionId]);
  let viewer = page;
  if (await entry.getAttribute("target") === "_blank") {
    [viewer] = await Promise.all([page.waitForEvent("popup"), entry.click()]);
  } else {
    await entry.click();
  }
  const selected = viewer.getByRole("article", { name: `引用的课程资料 v${pinned.version_no}`, exact: true });
  await expect(selected).toBeFocused();
  await viewer.reload();
  await expect(selected).toBeFocused();
  await selected.getByRole("button", { name: `申请下载 v${pinned.version_no}`, exact: true }).click();
  const download = selected.getByRole("link", { name: `下载课程资料 v${pinned.version_no}`, exact: true });
  await expect(download).toBeVisible();
  const signedUrl = new URL((await download.getAttribute("href"))!);
  if (signedUrl.protocol !== "https:" || signedUrl.username || signedUrl.password) {
    throw new Error("课程文件未返回有效的 HTTPS 签名链接。");
  }
  // Read from storage without sending the test user's app session to it.
  const response = await fetch(signedUrl, { redirect: "error", signal: AbortSignal.timeout(30_000) })
    .catch(() => { throw new Error("无法从签名地址下载冻结文件。"); });
  expect(response.status).toBe(200);
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(bytes.length).toBe(pinned.size_bytes);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(pinned.content_hash);
});
