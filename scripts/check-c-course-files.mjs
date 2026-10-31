import assert from "node:assert/strict";
import { seedData } from "../mocks/seed.ts";
import { migrateWorkspace } from "../lib/versioning.ts";
import { createCommandRunner } from "../lib/commands/core.ts";
import { changeCourseFile, courseFileAccess, listCourseFiles } from "../features/c/course-file-commands.ts";

let passed = 0;
const check = (message, actual, expected) => { assert.deepEqual(actual, expected, message); passed += 1; };
function setup(actor = "teacher-1") {
  let data = migrateWorkspace(structuredClone(seedData)).data;
  data.baselineRevisions[0].payload.sourceFileIds.push("file-4");
  data.files.push({ ...data.files.find((file) => file.id === "file-4"), id: "foreign-course-file", courseId: "course-3" });
  const actorState = { id: actor };
  let fail = false; let saves = 0; let cacheWrites = 0;
  const run = createCommandRunner({
    repository: { read: async () => structuredClone(data), save: async (next) => {
      saves += 1; if (fail) { fail = false; throw new Error("quota"); } data = structuredClone(next);
    } },
    currentActorId: () => actorState.id, now: () => "2026-10-12T01:00:00Z",
    onSaved: () => { cacheWrites += 1; },
  });
  return { run, actorState, get data() { return data; }, get saves() { return saves; },
    get cacheWrites() { return cacheWrites; }, failNext() { fail = true; } };
}
const replacement = { action: "replace", courseId: "course-1", fileId: "course-draft-4",
  replacesFileId: "file-4", name: "更新模板.docx", sizeBytes: 5120, mimeType: "application/octet-stream",
  expectedCourseVersion: 2, reason: "调整要求，保存新草稿", idempotencyKey: "course-replace-1" };
const publication = { action: "publish", courseId: "course-1", fileId: replacement.fileId,
  expectedCourseVersion: 3, reason: "完成评审，发布第四版", idempotencyKey: "course-publish-1" };
const file = (s, id) => s.data.files.find((item) => item.id === id);
const course = (s) => s.data.courses.find((item) => item.id === "course-1");

{
  const s = setup(); const initial = structuredClone(s.data);
  const changed = await s.run(changeCourseFile, replacement);
  check("替换新增草稿成功", changed.ok, true);
  check("替换不提前撤换发布版本", [file(s, "file-4").status, file(s, replacement.fileId).status], ["current", "draft"]);
  check("版本历史连续且保留逻辑名称", [changed.result.version, changed.result.name], [4, "课程项目模板.docx"]);
  check("一次保存包括文件版本及日志", [s.saves, s.cacheWrites, course(s).version, s.data.logs.length], [1, 1, 3, initial.logs.length + 1]);
  const duplicate = await s.run(changeCourseFile, replacement);
  check("相同输入重试不新增版本", [duplicate.ok, s.data.files.length, course(s).version], [true, initial.files.length + 1, 3]);
  const published = await s.run(changeCourseFile, publication);
  check("发布切换当前版本", [published.ok, file(s, "file-4").status, file(s, replacement.fileId).status], [true, "superseded", "current"]);
  check("发布历史保留两次真实决定", file(s, replacement.fileId).cCourseFileHistory.map((item) => [item.action, item.reason, item.actorId]), [
    ["replace", replacement.reason, "teacher-1"], ["publish", publication.reason, "teacher-1"],
  ]);
  check("发布只增加一次课程版本和日志", [course(s).version, s.data.logs.length], [4, initial.logs.length + 2]);
  check("相邻其他课程同名资料不变", file(s, "foreign-course-file"), initial.files.find((item) => item.id === "foreign-course-file"));
  for (const key of ["projects", "baselineRevisions", "planRevisions", "courseRuleRevisions", "notifications", "actionItems", "evidence", "verifications", "tasks"]) {
    check(`不改B冻结/A/D引用：${key}`, s.data[key], initial[key]);
  }
  check("刷新迁移不丢命令历史", migrateWorkspace(JSON.parse(JSON.stringify(s.data))).data.files.find((item) => item.id === replacement.fileId).cCourseFileHistory.length, 2);
  for (const patch of [{ reason: "changed" }, { expectedCourseVersion: 4 }, { courseId: "course-2" }, { action: "publish", replacesFileId: undefined, name: undefined, sizeBytes: undefined, mimeType: undefined }]) {
    const result = await s.run(changeCourseFile, { ...replacement, ...patch });
    check("已使用幂等键不接受其他内容", result.ok, false);
  }
  const nextInput = { ...replacement, fileId: "next-draft", replacesFileId: replacement.fileId,
    expectedCourseVersion: 4, idempotencyKey: "next-replace" };
  check("后续替换成功", (await s.run(changeCourseFile, nextInput)).ok, true);
  check("后续发布成功", (await s.run(changeCourseFile, { ...publication, fileId: "next-draft", expectedCourseVersion: 5, idempotencyKey: "next-publish" })).ok, true);
  check("旧发布重放不复活旧版本", (await s.run(changeCourseFile, publication)).result.status, "superseded");
}
for (const actor of ["teacher-2", "ta-1", "admin-1", "member-1", "missing"]) {
  const s = setup(actor); const before = JSON.stringify(s.data);
  check("仅所属教师/TA可读", courseFileAccess(s.data, actor, "course-1").readable, actor === "ta-1");
  check("非所属教师不能写", (await s.run(changeCourseFile, replacement)).error.code, "FORBIDDEN");
  check("拒绝不改变任何数据", JSON.stringify(s.data), before);
}
{
  const s = setup("ta-1");
  course(s).assistantGrants[0].permissions = ["course.settings.update", "course.rules.publish", "course.rules.edit"];
  check("TA课程权限不隐式扩展为文件写权限", courseFileAccess(s.data, "ta-1", "course-1").writable, false);
  check("已归属TA能查看版本", listCourseFiles(s.data, "ta-1", "course-1").length, 1);
  course(s).assistantGrants = [];
  check("撤销TA归属即时拒绝读取", courseFileAccess(s.data, "ta-1", "course-1").readable, false);
}
for (const state of ["disabled", "pending", "unverified", "rejected-teacher", "ended"]) {
  const s = setup(); const actor = s.data.users.find((item) => item.id === "teacher-1");
  if (state === "disabled" || state === "pending") actor.status = state;
  if (state === "unverified") actor.verified = false;
  if (state === "rejected-teacher") actor.teacherStatus = "rejected";
  if (state === "ended") course(s).status = "ended";
  check("重新校验身份与课程只读状态", (await s.run(changeCourseFile, replacement)).error.code, "FORBIDDEN");
}
{
  const s = setup();
  for (const id of ["unknown", undefined]) check("未知课程不会回落首课程", courseFileAccess(s.data, "teacher-1", id).readable, false);
  assert.throws(() => listCourseFiles(s.data, "teacher-1", "unknown"), /课程不存在/); passed += 1;
  for (const replacesFileId of ["foreign-course-file", "file-1", "unknown"]) check("替换拒绝跨课或项目文件", (await s.run(changeCourseFile, { ...replacement, replacesFileId })).error.code, "NOT_FOUND");
  check("不存在课程拒绝", (await s.run(changeCourseFile, { ...replacement, courseId: "unknown" })).error.code, "NOT_FOUND");
  check("过期版本拒绝", (await s.run(changeCourseFile, { ...replacement, expectedCourseVersion: 1 })).error.code, "VERSION_CONFLICT");
  check("已发布不能直接重复发布", (await s.run(changeCourseFile, { ...publication, fileId: "file-4", expectedCourseVersion: 2 })).error.code, "INVALID_STATE");
  for (const patch of [{ reason: " " }, { sizeBytes: 0 }, { sizeBytes: 50 * 1024 * 1024 + 1 }, { name: "../test.docx" }, { name: "test.exe" }, { name: "test.pdf" }, { actorId: "admin-1" }]) {
    check("命令输入严格校验", (await s.run(changeCourseFile, { ...replacement, ...patch })).ok, false);
  }
  const original = JSON.stringify(s.data); s.failNext();
  check("保存失败返回storage error", (await s.run(changeCourseFile, replacement)).error.code, "STORAGE_ERROR");
  check("失败不提前修改版本日志", JSON.stringify(s.data), original);
  check("失败不更新缓存", s.cacheWrites, 0);
  check("同一请求安全重试", (await s.run(changeCourseFile, replacement)).ok, true);
  const beforePublish = JSON.stringify(s.data); s.failNext();
  check("发布失败返回storage error", (await s.run(changeCourseFile, publication)).error.code, "STORAGE_ERROR");
  check("发布失败原正式及草稿均保留", JSON.stringify(s.data), beforePublish);
  check("发布可安全重试", (await s.run(changeCourseFile, publication)).ok, true);
}
{
  const s = setup();
  const results = await Promise.all([s.run(changeCourseFile, replacement), s.run(changeCourseFile,
    { ...replacement, fileId: "competing", idempotencyKey: "competing-request" })]);
  check("并发不同操作有一个CAS冲突", results.map((item) => item.ok ? "ok" : item.error.code), ["ok", "VERSION_CONFLICT"]);
  check("CAS失败不形成重复草稿", s.data.files.filter((item) => item.courseId === "course-1" && item.status === "draft").length, 1);
}
{
  const s = setup(); course(s).status = "draft";
  const upload = { action: "upload", courseId: "course-1", fileId: "fresh-draft", name: "课程说明.pdf",
    sizeBytes: 12, mimeType: "application/pdf", expectedCourseVersion: 2, reason: "准备课程说明", idempotencyKey: "fresh-upload" };
  check("未发布课程可准备资料草稿", (await s.run(changeCourseFile, upload)).ok, true);
  check("新增只保存演示元数据", [file(s, upload.fileId).version, file(s, upload.fileId).status, file(s, upload.fileId).source], [1, "draft", "课程文件（演示元数据）"]);
  check("新增重试只保留一份", (await s.run(changeCourseFile, upload)).ok, true);
  check("重复ID拒绝", (await s.run(changeCourseFile, { ...upload, name: "另一个.pdf", expectedCourseVersion: 3, idempotencyKey: "collision" })).error.code, "VERSION_CONFLICT");
  check("同名新增要求显式替换", (await s.run(changeCourseFile, { ...upload, fileId: "duplicate-name", expectedCourseVersion: 3, idempotencyKey: "duplicate-name" })).error.code, "INVALID_STATE");
  const replaceDraft = { ...upload, action: "replace", replacesFileId: upload.fileId, fileId: "second-draft", expectedCourseVersion: 3, idempotencyKey: "replace-draft" };
  check("替换最新草稿保留旧稿", (await s.run(changeCourseFile, replaceDraft)).ok, true);
  check("草稿替换不删除历史", [file(s, "fresh-draft").status, file(s, "second-draft").version], ["superseded", 2]);
  check("旧草稿不能再发布", (await s.run(changeCourseFile, { ...publication, fileId: "fresh-draft", expectedCourseVersion: 4 })).error.code, "INVALID_STATE");
  course(s).teacherId = "teacher-2"; s.actorState.id = "teacher-2";
  check("原key不得冒用换任教师", (await s.run(changeCourseFile, upload)).error.code, "VERSION_CONFLICT");
}
console.log(`C5-04 course files: ${passed} assertions passed`);
