import assert from "node:assert/strict";
import { seedData } from "../mocks/seed.ts";
import { createCommandRunner } from "../lib/commands/core.ts";
import {
  MAX_FILE_BYTES,
  getFileDownload,
  getFilePreview,
  getFileVersions,
  listProjectFiles,
  replaceProjectFile,
  uploadProjectFile,
  validateUploadSize,
} from "../lib/commands/files.ts";

let passed = 0;
function check(desc, actual, expected) {
  assert.deepEqual(actual, expected, `${desc}：实际 ${JSON.stringify(actual)}，预期 ${JSON.stringify(expected)}`);
  passed += 1;
}
function ok(desc, value) {
  assert.ok(value, desc);
  passed += 1;
}

function memoryRepository(initial) {
  let data = structuredClone(initial);
  return {
    read: async () => structuredClone(data),
    save: async (next) => { data = structuredClone(next); },
    get data() { return data; },
    set data(value) { data = structuredClone(value); },
  };
}

function setup({ actorId = "member-1" } = {}) {
  const repo = memoryRepository(seedData);
  const state = { actor: actorId, logSeq: 0 };
  const run = createCommandRunner({
    repository: repo,
    currentActorId: () => state.actor,
    now: () => "2026-10-06T12:00:00.000Z",
    makeLogId: () => `log-file-${++state.logSeq}`,
  });
  return { repo, state, run };
}

const version = (repo) => repo.data.projects.find((item) => item.id === "project-1").version;
const fileInput = (overrides = {}) => ({
  projectId: "project-1",
  name: "部署说明.md",
  mimeType: "text/markdown",
  sizeBytes: 2048,
  expectedVersion: 0,
  ...overrides,
});

// ── 50MB 边界一致；失败不改变已有 current 版本 ─────────────────────
{
  ok("0 字节允许", (() => { try { validateUploadSize(0); return true; } catch { return false; } })());
  ok("50MB 允许", (() => { try { validateUploadSize(MAX_FILE_BYTES); return true; } catch { return false; } })());
  ok("50MB+1 拒绝", (() => { try { validateUploadSize(MAX_FILE_BYTES + 1); return false; } catch { return true; } })());
  ok("负数/非整数拒绝", (() => { try { validateUploadSize(-1); return false; } catch { return true; } })());

  const { repo, run } = setup();
  const before = JSON.stringify(repo.data.files);
  const oversize = await run(uploadProjectFile, fileInput({ sizeBytes: MAX_FILE_BYTES + 1, expectedVersion: version(repo) }));
  ok("超限上传被拒绝", oversize.ok === false && oversize.error.code === "VALIDATION_ERROR");
  check("失败不改变已有版本", JSON.stringify(repo.data.files), before);

  const badFormat = await run(uploadProjectFile, fileInput({ name: "恶意.exe", expectedVersion: version(repo) }));
  ok("不支持格式被拒绝", badFormat.ok === false && badFormat.error.code === "VALIDATION_ERROR");
  check("格式失败也不改变已有版本", JSON.stringify(repo.data.files), before);
}

// ── 同名替换增加版本；旧版本可查；正式快照引用不变 ──────────────────
{
  const { repo, run } = setup();
  const uploaded = await run(uploadProjectFile, fileInput({ name: "模块设计.docx", mimeType: "application/msword", sizeBytes: 4096, expectedVersion: version(repo) }));
  ok("上传成功", uploaded.ok === true);
  check("元数据保留原始字节", uploaded.result.sizeBytes, 4096);
  check("元数据保留 MIME", uploaded.result.mimeType, "application/msword");
  const baselineBefore = JSON.stringify(repo.data.baselineRevisions.find((item) => item.id === "baseline-project-1-legacy").payload.sourceFileIds);

  const replaced = await run(replaceProjectFile, fileInput({ name: "模块设计.docx", mimeType: "application/msword", sizeBytes: 8192, expectedVersion: version(repo), replacesFileId: uploaded.result.id }));
  ok("替换生成新版本", replaced.ok === true && replaced.result.version === 2);
  check("旧版本标记为历史", repo.data.files.find((item) => item.id === uploaded.result.id).status, "superseded");
  check("当前版本唯一", repo.data.files.filter((item) => item.projectId === "project-1" && item.name === "模块设计.docx" && item.status === "current").length, 1);
  ok("旧版本可查", getFileVersions(repo.data, "member-1", replaced.result.id).map((item) => item.version).sort().join(",") === "1,2");
  check("正式快照仍引用原 fileId", JSON.stringify(repo.data.baselineRevisions.find((item) => item.id === "baseline-project-1-legacy").payload.sourceFileIds), baselineBefore);
}

// ── 跨项目引用/下载权限 ──────────────────────────────────────────
{
  const { repo, run } = setup();
  const cross = await run(replaceProjectFile, fileInput({ name: "课程说明.pdf", mimeType: "application/pdf", sizeBytes: 100, expectedVersion: version(repo), replacesFileId: "file-4" }));
  ok("跨项目替换对象拒绝", cross.ok === false && cross.error.code === "VALIDATION_ERROR");

  const renamed = await run(replaceProjectFile, fileInput({ name: "其他名字.docx", sizeBytes: 100, expectedVersion: version(repo), replacesFileId: "file-2" }));
  ok("替换必须同名", renamed.ok === false && renamed.error.code === "VALIDATION_ERROR");

  const noTarget = await run(replaceProjectFile, fileInput({ expectedVersion: version(repo) }));
  ok("缺少替换对象拒绝", noTarget.ok === false && noTarget.error.code === "VALIDATION_ERROR");
  const withTarget = await run(uploadProjectFile, fileInput({ expectedVersion: version(repo), replacesFileId: "file-2" }));
  ok("上传接口不接受替换对象", withTarget.ok === false && withTarget.error.code === "VALIDATION_ERROR");

  ok("课程公开总览用户不能读取项目资料列表", (() => { try { listProjectFiles(repo.data, "member-21", "project-1"); return false; } catch { return true; } })());
  ok("课程公开总览用户不能下载项目资料", (() => { try { getFileDownload(repo.data, "member-21", "file-1"); return false; } catch { return true; } })());
  ok("成员下载返回明确 Mock 描述", getFileDownload(repo.data, "member-1", "file-1").message.includes("模拟"));
  ok("预览同样标记模拟", getFilePreview(repo.data, "member-1", "file-1").kind === "mock");
}

// ── 部分文件失败逐个反馈；重复提交不重复创建 ───────────────────────
{
  const { repo, run } = setup();
  const first = await run(uploadProjectFile, fileInput({ name: "A.md", expectedVersion: version(repo) }));
  ok("第一个文件成功", first.ok === true);
  const second = await run(uploadProjectFile, fileInput({ name: "B.md", sizeBytes: MAX_FILE_BYTES + 1, expectedVersion: version(repo) }));
  ok("第二个文件单独失败", second.ok === false && second.error.code === "VALIDATION_ERROR");
  const third = await run(uploadProjectFile, fileInput({ name: "C.md", expectedVersion: version(repo) }));
  ok("后续文件不受影响", third.ok === true);
  check("只有成功文件被创建", repo.data.files.filter((item) => ["A.md", "B.md", "C.md"].includes(item.name)).map((item) => item.name), ["A.md", "C.md"]);

  const repeat = await run(uploadProjectFile, fileInput({ name: "D.md", expectedVersion: version(repo) - 1 }));
  ok("重复提交被版本冲突拦截", repeat.ok === false && repeat.error.code === "VERSION_CONFLICT");
  check("重复提交不重复创建", repo.data.files.filter((item) => item.name === "D.md"), []);
}

// ── 归档项目只读；无写资格拒绝 ────────────────────────────────────
{
  const { repo, run } = setup({ actorId: "member-22" });
  const archived = await run(uploadProjectFile, { projectId: "project-4", name: "补充.md", mimeType: "text/markdown", sizeBytes: 10, expectedVersion: repo.data.projects.find((item) => item.id === "project-4").version });
  ok("归档项目不接受资料写入", archived.ok === false && archived.error.code === "INVALID_STATE");

  const peer = setup({ actorId: "member-21" });
  const denied = await peer.run(uploadProjectFile, fileInput({ expectedVersion: version(peer.repo) }));
  ok("无写资格被拒绝", denied.ok === false && denied.error.code === "FORBIDDEN");
}

console.log(`项目资料与文件版本检查通过：${passed} 项断言全部符合预期。`);
