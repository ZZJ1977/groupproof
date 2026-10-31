import { expect, test, type Page, type Route } from "@playwright/test";
import type { components } from "../packages/domain/api.generated";

// HTTP contract fixtures only; no live storage, upload receipt or A session is fabricated.
type Schema = components["schemas"];
const courseId = "00000000-0000-0000-0000-000000000501";
const fileId = "00000000-0000-0000-0000-000000000502";
const v1Id = "00000000-0000-0000-0000-000000000503";
const v2Id = "00000000-0000-0000-0000-000000000504";
const actorId = "00000000-0000-0000-0000-000000000505";
const stamp = "2026-10-12T08:00:00Z";
const path = `/teacher/courses/${courseId}/files`;
const original: Schema["CourseFileDetailDTO"] = {
  id: fileId, course_id: courseId, name: "课程项目说明.pdf", category: "documents",
  latest_version_no: 2, official_version_no: 1, lock_version: 2, created_by: actorId,
  created_at: stamp, updated_at: stamp,
  versions: [
    { id: v2Id, file_id: fileId, version_no: 2, original_name: "课程说明-v2.pdf", extension: "pdf", mime_type: "application/pdf", size_bytes: 2048, content_hash: "b".repeat(64), uploaded_by: actorId, status: "draft", created_at: stamp },
    { id: v1Id, file_id: fileId, version_no: 1, original_name: "课程说明-v1.pdf", extension: "pdf", mime_type: "application/pdf", size_bytes: 1024, content_hash: "a".repeat(64), uploaded_by: actorId, status: "current", created_at: stamp },
  ],
  decisions: [{ id: "00000000-0000-0000-0000-000000000506", version_id: v1Id, actor_id: actorId, action: "published", reason: "保留原课程发布记录", resulting_lock_version: 1, previous_official_version_no: null, created_at: stamp }],
};
const success = (route: Route, data: unknown) => route.fulfill({ json: { data, meta: { request_id: "course-file-fixture" } } });
const failure = (route: Route, status: number) => route.fulfill({ status, json: { error: { code: status === 409 ? "VERSION_CONFLICT" : "UNAVAILABLE", message: "Fixture failure" }, meta: { request_id: "course-file-error" } } });

async function setup(page: Page, student = false) {
  const state = { file: structuredClone(original), listStatus: 200, publishFailure: 0, malformedList: false,
    link: "https://storage.example.test/course.pdf?signature=short-lived", total: 2 };
  const requests: URL[] = [];
  const publications: { key: string | null; input: Schema["PublishCourseFileVersion"] }[] = [];
  await page.route(`**/api/v1/courses/${courseId}/files**`, async (route) => {
    const request = route.request(); const url = new URL(request.url()); requests.push(url);
    const visible = student ? { ...state.file, latest_version_no: 1, versions: state.file.versions.filter((version) => version.status !== "draft") } : state.file;
    if (url.pathname.endsWith("/publish")) {
      const input = request.postDataJSON() as Schema["PublishCourseFileVersion"];
      publications.push({ key: request.headers()["idempotency-key"] ?? null, input });
      if (state.publishFailure) { const status = state.publishFailure; state.publishFailure = 0; return failure(route, status); }
      if (input.expected_version !== state.file.lock_version) return failure(route, 409);
      state.file = { ...state.file, lock_version: state.file.lock_version + 1, official_version_no: 2,
        versions: state.file.versions.map((version) => ({ ...version, status: version.id === input.version_id ? "current" : "superseded" })) };
      return success(route, state.file);
    }
    if (url.pathname.endsWith("/link")) return success(route, { version_id: url.pathname.split("/").at(-2)!, purpose: url.searchParams.get("purpose") === "preview" ? "preview" : "download", url: state.link, expires_at: new Date(Date.now() + 5 * 60_000).toISOString() } satisfies Schema["SignedCourseFileLinkDTO"]);
    if (url.pathname.endsWith(`/${fileId}`)) return success(route, visible);
    if (state.listStatus !== 200) return failure(route, state.listStatus);
    const pageNumber = Number(url.searchParams.get("page") || 1);
    const data: Schema["CourseFilePageDTO"] = { items: visible.versions.filter((version) => version.status !== "superseded").map((version) => ({ ...version, course_id: courseId, name: visible.name, category: visible.category, lock_version: visible.lock_version })), total: student ? 1 : state.total, page: pageNumber, page_size: 10, can_write: !student };
    return state.malformedList ? route.fulfill({ json: { data } }) : success(route, data);
  });
  return { state, requests, publications };
}

async function openDetail(page: Page) {
  await page.getByRole("button", { name: "查看版本", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "申请下载 v1", exact: true })).toBeVisible();
}

test("C5-04 canonical course filters and pagination survive reload without upload inputs", async ({ page }) => {
  const { state, requests } = await setup(page); state.total = 11;
  await page.goto(path);
  await expect(page.getByText(/文件上传和替换暂不可用/)).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await page.getByLabel("课程文件名", { exact: true }).fill("课程说明");
  await page.getByLabel("文件类型", { exact: true }).fill("pdf");
  await page.getByRole("combobox", { name: "资料分类", exact: true }).selectOption("documents");
  await page.getByRole("combobox", { name: "排序", exact: true }).selectOption("name_asc");
  await page.getByRole("button", { name: "查询课程资料", exact: true }).click();
  await expect(page).toHaveURL(/category=documents/);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await page.reload();
  await expect(page.getByLabel("课程文件名", { exact: true })).toHaveValue("课程说明");
  await expect(page.getByText("共 11 条 · 第 2 页", { exact: true })).toBeVisible();
  expect(requests.at(-1)?.searchParams.get("sort")).toBe("name_asc");
  expect(requests.at(-1)?.searchParams.get("file_type")).toBe("pdf");
  await expect(page.locator("main")).not.toContainText(courseId);
  await expect(page.locator("main")).not.toContainText("receipt_id");
});

test("C5-04 student reads only published material and has no publication controls", async ({ page }) => {
  await setup(page, true);
  await page.goto(path); await openDetail(page);
  await expect(page.getByText(/当前课程资料只读/)).toBeVisible();
  await expect(page.getByRole("button", { name: "发布 v2", exact: true })).toHaveCount(0);
  await expect(page.getByText("课程说明-v2.pdf", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "申请下载 v2", exact: true })).toHaveCount(0);
  await expect(page.getByText(/保留原课程发布记录/)).toBeVisible();
});

test("C5-04 failed publication retains reason and retry key while duplicate clicks send once", async ({ page }) => {
  const { state, publications } = await setup(page); state.publishFailure = 503;
  await page.goto(path); await openDetail(page);
  await page.getByRole("button", { name: "发布 v2", exact: true }).click();
  await expect(page.getByRole("button", { name: "确认发布课程资料", exact: true })).toBeDisabled();
  await page.getByLabel("发布原因", { exact: true }).fill("课程要求已审阅");
  await page.getByRole("button", { name: "确认发布课程资料", exact: true }).evaluate((button) => {
    (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click();
  });
  await expect(page.locator("main").getByRole("alert")).toContainText("资料服务暂不可用");
  await expect(page.getByLabel("发布原因", { exact: true })).toHaveValue("课程要求已审阅");
  expect(publications).toHaveLength(1);
  await page.getByRole("button", { name: "确认发布课程资料", exact: true }).click();
  await expect(page.getByText(/课程资料已发布，历史版本和冻结项目原引用均已保留/)).toBeVisible();
  expect(publications).toHaveLength(2);
  expect(publications[0].key).toBeTruthy();
  expect(publications[0]).toEqual(publications[1]);
  expect(state.file.versions.find((version) => version.id === v1Id)?.status).toBe("superseded");
});

test("C5-04 stale publication requires explicit version recheck and keeps the reason", async ({ page }) => {
  const { state, publications } = await setup(page);
  await page.goto(path); await openDetail(page);
  await page.getByRole("button", { name: "发布 v2", exact: true }).click();
  await page.getByLabel("发布原因", { exact: true }).fill("竞争版本仍需保留原因");
  state.file.lock_version = 3;
  await page.getByRole("button", { name: "确认发布课程资料", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("资料已变化");
  await expect(page.getByRole("button", { name: "确认发布课程资料", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "刷新并核对版本", exact: true }).click();
  await expect(page.getByLabel("发布原因", { exact: true })).toHaveValue("竞争版本仍需保留原因");
  await expect(page.getByRole("button", { name: "确认发布课程资料", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "确认发布课程资料", exact: true }).click();
  await expect(page.getByText(/课程资料已发布/)).toBeVisible();
  expect(publications.map((entry) => entry.input.expected_version)).toEqual([2, 3]);
  expect(publications[0].key).not.toBe(publications[1].key);
});

test("C5-04 unsafe signed links never render and a valid retry remains bound to its version", async ({ page }) => {
  const { state } = await setup(page); state.link = "javascript:alert(1)";
  await page.goto(path); await openDetail(page);
  await page.getByRole("button", { name: "申请下载 v1", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toBeVisible();
  await expect(page.getByRole("link", { name: "下载课程资料", exact: true })).toHaveCount(0);
  state.link = "https://storage.example.test/pinned-v1.pdf?signature=trusted";
  await page.getByRole("button", { name: "申请下载 v1", exact: true }).click();
  await expect(page.getByRole("link", { name: "下载课程资料", exact: true })).toHaveAttribute("href", state.link);
  await expect(page.getByRole("link", { name: "下载课程资料", exact: true })).toHaveAttribute("rel", "noopener noreferrer");
});

test("C5-04 denied refresh hides previous lists, detail and signed links", async ({ page }) => {
  const { state } = await setup(page);
  await page.goto(path); await openDetail(page);
  await page.getByRole("button", { name: "申请下载 v1", exact: true }).click();
  await expect(page.getByRole("link", { name: "下载课程资料", exact: true })).toBeVisible();
  state.listStatus = 403;
  await page.getByRole("button", { name: "刷新课程资料", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("原有资料已隐藏");
  await expect(page.getByRole("table", { name: "课程资料列表" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "申请下载 v1", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "下载课程资料", exact: true })).toHaveCount(0);
});

test("C5-04 invalid mock course IDs are never sent to the UUID API", async ({ page }) => {
  const requests: string[] = [];
  await page.route("**/api/v1/courses/**/files**", (route) => { requests.push(route.request().url()); return failure(route, 422); });
  await page.goto("/teacher/courses/course-1/files");
  await expect(page.getByText("课程地址无效", { exact: true })).toBeVisible();
  expect(requests).toHaveLength(0);
});

test("C5-04 malformed API envelopes do not restore local course data", async ({ page }) => {
  const { state } = await setup(page); state.malformedList = true;
  await page.goto(path);
  await expect(page.locator("main").getByRole("alert")).toContainText("课程资料暂不可用");
  await expect(page.getByRole("table", { name: "课程资料列表" })).toHaveCount(0);
});
